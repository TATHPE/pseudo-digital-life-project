/**
 * 搬家协议（19 §7.4 / 09 §5）：**quiesce → export → 校验 → import → 补跑**
 *
 * 为什么不能直接 `cp -r data/`：
 *  ① `memory.db` 有 WAL，进程还在跑时拷出来可能是**半截事务**。
 *     → 用 `VACUUM INTO` 导出一份一致的**单文件**快照（不带你没提交的 -wal）。
 *  ② 拷完没人知道少没少东西。→ 每个文件记 sha256 + 字节数，import 前**全量校验**。
 *  ③ 搬完时间就过去了。→ import 后立刻 `tickDecay` 补算（01 §4.1：锚点没动，一次跳步即可）。
 *
 * 一条硬规矩：**`secrets/` 不出门**（13 §3）。
 *   Windows DPAPI 密文与**本机用户**绑定，搬到另一台机器解不开——带过去只会制造"看起来搬成了"的假象。
 *   所以导出默认排除它，并在清单里写明原因；目标机重新 `jingjing auth set` 一次即可。
 *
 * 导入是**原子的**：先解到 `.staging/`，校验通过才把旧 home 改名成 `home.bak-<ts>`、再把新 home 换进去。
 * 半路失败时旧 home 原封不动（`rename` 是原子的，拷贝不是）。
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import { openDb } from "./db.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import { tickDecay } from "./store.ts";
import { markCleanShutdown } from "./boot.ts";
import { readEvents } from "./journal.ts";

export const HANDOFF_VERSION = 1;

/** 要带走的东西（顺序即拷贝顺序） */
export const INCLUDE = [
  "memory.db", "inbox", "persona", "eval", "life", "deploy",
  "policy.csv", "config.json", "workspace", "trash",
] as const;

/** 明确不带的，以及为什么（清单里会写出来，别让人猜） */
export const EXCLUDED: Array<{ path: string; why: string }> = [
  { path: "secrets/", why: "DPAPI/libsecret 密文与本机用户绑定，搬到别的机器解不开；目标机重新 auth set 一次" },
  { path: "tokens/", why: "一次性令牌，过期即废，搬过去没有意义" },
  { path: "pending/", why: "待确认卡片带原机的 cwd 与指纹，搬过去必然不匹配" },
  { path: "snapshots/", why: "写前快照，体积大且可再生成" },
  { path: "memory.db-wal", why: "已被 VACUUM INTO 折叠进 memory.db" },
  { path: "memory.db-shm", why: "同上" },
];

export interface FileEntry { sha256: string; bytes: number }

export interface HandoffManifest {
  v: number;
  created_at: string;
  source: { host: string; platform: string; arch: string; node: string; schema: number };
  files: Record<string, FileEntry>;
  counts: { memories: number; contracts: number; chunks: number; events: number; audit: number; releases: number };
  excluded: Array<{ path: string; why: string }>;
  /** 没拷的软链/目录联接（红队会建 workspace/up 这种东西） */
  skipped?: string[];
  note: string;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const toPosix = (p: string) => p.split(sep).join("/");

/** a 在 b 里面（含等于） */
function inside(a: string, b: string): boolean {
  const r = relative(normalize(b), normalize(a));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/**
 * 拷贝一棵树，**跳过符号链接/目录联接**并记下来。
 *
 * 这个函数是被真实事故逼出来的：`data/workspace/up` 是红队 #4 建的目录联接（→ `data/..`），
 * `cpSync` 会顺着它一路拷到仓库根，而导出目录本身又在 `data/` 里……
 * 于是它把自己也拷进去、再拷、再拷，最后死在 MAX_PATH 上。
 */
function copyTree(src: string, dest: string, rel: string, skipped: string[]): void {
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) { skipped.push(r); continue; }
    if (e.isDirectory()) { mkdirSync(d, { recursive: true }); copyTree(s, d, r, skipped); }
    else if (e.isFile()) cpSync(s, d, { dereference: false });
  }
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;          // 软链不搬（可能指到 home 外）
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push(p);
    }
  };
  if (existsSync(root)) rec(root);
  return out.sort();
}

/** 导出时用只读连接算统计；打不开就记 0（不阻止导出，manifest 里如实是 0） */
function countsOf(dbFile: string): HandoffManifest["counts"] {
  const zero = { memories: 0, contracts: 0, chunks: 0, events: 0, audit: 0, releases: 0 };
  if (!existsSync(dbFile)) return zero;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const n = (sql: string) => {
      try { return Number((db!.prepare(sql).get() as { c?: number })?.c ?? 0); } catch { return 0; }
    };
    return {
      memories: n("SELECT count(*) c FROM memories WHERE status='active'"),
      contracts: n("SELECT count(*) c FROM memories WHERE layer='contract' AND status='active'"),
      chunks: n("SELECT count(*) c FROM chunks"),
      events: n("SELECT count(*) c FROM events"),
      audit: n("SELECT count(*) c FROM exec_audit"),
      releases: 0,
    };
  } catch { return zero; } finally { try { db?.close(); } catch { /* ignore */ } }
}

export interface ExportReport {
  ok: true;
  outDir: string;
  files: number;
  bytes: number;
  /** 故意没拷的软链/目录联接（红队会建这些） */
  skipped: string[];
  manifest: HandoffManifest;
}

/**
 * 导出。调用方应当先停掉面板（quiesce）——但即使不停，
 * `VACUUM INTO` 给出的仍是一致快照（它是一次读事务），只是 inbox 尾部可能多几条。
 */
export function exportHome(home: string, outDir: string, now = new Date()): ExportReport {
  if (!existsSync(join(home, "memory.db"))) throw new Error("E_NO_HOME: 这个目录里没有 memory.db");
  // 导出目录不能落在被导出的树里：那样拷到一半就把自己卷进去了（实测过）
  if (inside(outDir, home) || inside(home, outDir)) {
    throw new Error(`E_EXPORT_INSIDE_HOME: 导出目录不能与 home 嵌套（${outDir} vs ${home}）`);
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`E_EXPORT_DIR_NOT_EMPTY: ${outDir}（换一个目录，不要把两家的东西混在一起）`);
  }
  mkdirSync(outDir, { recursive: true });

  // ① 库：一致性快照（不带 -wal）
  const dbSrc = join(home, "memory.db");
  const dbOut = join(outDir, "memory.db");
  const db = new DatabaseSync(dbSrc);
  let counts: HandoffManifest["counts"];
  try {
    counts = countsOf(dbSrc);
    rmSync(dbOut, { force: true });
    db.exec("VACUUM INTO '" + toPosix(dbOut).split("'").join("''") + "'");
  } finally { db.close(); }

  // ② 其余目录与文件（跳过软链/联接，并记下跳过什么）
  const skipped: string[] = [];
  for (const rel of INCLUDE) {
    if (rel === "memory.db") continue;
    const src = join(home, rel);
    if (!existsSync(src)) continue;
    const dest = join(outDir, rel);
    try {
      if (statSync(src).isDirectory()) { mkdirSync(dest, { recursive: true }); copyTree(src, dest, rel, skipped); }
      else cpSync(src, dest, { dereference: false });
    } catch (e) {
      // 单个目录失败不要中盘：记下原因，剩下的接着导
      skipped.push(`${rel}（${String((e as Error).message ?? e).slice(0, 80)}）`);
    }
  }

  // ③ 清单
  const files: Record<string, FileEntry> = {};
  for (const abs of walkFiles(outDir)) {
    const rel = toPosix(relative(outDir, abs));
    if (rel === "manifest.json") continue;
    const buf = readFileSync(abs);
    files[rel] = { sha256: sha256(buf), bytes: buf.byteLength };
  }
  const releasesDir = join(outDir, "deploy", "releases");
  counts.releases = existsSync(releasesDir)
    ? readdirSync(releasesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0;

  const manifest: HandoffManifest = {
    v: HANDOFF_VERSION,
    created_at: now.toISOString(),
    source: { host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown", platform: process.platform, arch: process.arch, node: process.versions.node, schema: SCHEMA_VERSION },
    files,
    counts,
    excluded: EXCLUDED,
    skipped,
    note: "导入后 secrets/ 需要重新 auth set；tokens/pending/snapshots 有意不带；软链/目录联接被跳过（见 skipped）。",
  };
  atomicWriteFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const total = Object.values(files).reduce((n, f) => n + f.bytes, 0);
  return { ok: true, outDir, files: Object.keys(files).length, bytes: total, skipped, manifest };
}

export interface VerifyResult { ok: boolean; problems: string[]; manifest: HandoffManifest | null }

/** 校验导出目录：清单在不在、每个文件的 sha256/字节数对不对、有没有清单外的文件 */
export function verifyExport(dir: string): VerifyResult {
  const mp = join(dir, "manifest.json");
  if (!existsSync(mp)) return { ok: false, problems: ["缺 manifest.json"], manifest: null };
  let manifest: HandoffManifest;
  try { manifest = JSON.parse(readFileSync(mp, "utf8")) as HandoffManifest; }
  catch { return { ok: false, problems: ["manifest.json 解析失败"], manifest: null }; }

  const problems: string[] = [];
  if (manifest.v !== HANDOFF_VERSION) problems.push(`版本 ${manifest.v} ≠ ${HANDOFF_VERSION}`);

  for (const [rel, want] of Object.entries(manifest.files)) {
    const abs = safeJoin(dir, rel);
    if (!abs) { problems.push(`路径越界：${rel}`); continue; }
    if (!existsSync(abs)) { problems.push(`缺文件：${rel}`); continue; }
    const buf = readFileSync(abs);
    if (buf.byteLength !== want.bytes) problems.push(`字节数不符：${rel}（${buf.byteLength} ≠ ${want.bytes}）`);
    else if (sha256(buf) !== want.sha256) problems.push(`内容被改：${rel}`);
  }
  for (const abs of walkFiles(dir)) {
    const rel = toPosix(relative(dir, abs));
    if (rel === "manifest.json") continue;
    if (!(rel in manifest.files)) problems.push(`清单外的文件：${rel}`);
  }
  return { ok: problems.length === 0, problems, manifest };
}

/** join 之后再确认没跑出根目录（清单是纯文本，可能被手工改过） */
function safeJoin(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const abs = normalize(join(root, rel));
  const r = relative(root, abs);
  if (r.startsWith("..") || isAbsolute(r)) return null;
  return abs;
}

export interface ImportReport {
  ok: true;
  files: number;
  backup: string | null;
  decayed: number;
  inbox: { events: number; quarantined: number; corrupted: number };
  counts: HandoffManifest["counts"];
}

/**
 * 导入。流程：校验 → 解到 staging → 旧 home 改名备份 → staging 换进来 → 补跑。
 * 任一步失败都抛错，且旧 home 保持原样（rename 原子；拷贝不是——所以先拷到 staging）。
 */
export function importHome(
  srcDir: string, home: string, o: { force?: boolean; now?: Date } = {},
): ImportReport {
  const v = verifyExport(srcDir);
  if (!v.ok) throw new Error(`E_EXPORT_CORRUPT: ${v.problems.slice(0, 5).join("；")}`);
  const manifest = v.manifest!;

  const exists = existsSync(home) && readdirSync(home).length > 0;
  if (exists && !o.force) throw new Error(`E_TARGET_NOT_EMPTY: ${home}（加 --force 会先把旧目录改名备份）`);

  const staging = `${home}.staging-${Date.now()}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  let backup: string | null = null;
  try {
    for (const rel of Object.keys(manifest.files)) {
      const from = safeJoin(srcDir, rel)!;
      const to = safeJoin(staging, rel)!;
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
    }
    if (exists) {
      backup = `${home}.bak-${(o.now ?? new Date()).toISOString().replace(/[:.]/g, "-")}`;
      renameSync(home, backup);
    } else if (existsSync(home)) {
      // 空目录：Windows 上 rename 到一个已存在的目录会 EPERM（POSIX 空目录可以），直接删掉再换
      rmSync(home, { recursive: true, force: true });
    }
    mkdirSync(dirname(home), { recursive: true });
    renameSync(staging, home);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    if (backup && !existsSync(home)) { try { renameSync(backup, home); } catch { /* 尽力还原 */ } }
    throw e;
  }

  // 补跑：库升到当前 schema + 衰减跳一步（锚点没动，跨多久都可以一次算完）
  const d = openDb(join(home, "memory.db"));
  let decayed = 0;
  try { decayed = tickDecay(d.db, o.now ?? new Date()); } finally { d.db.close(); }

  // 搬家后第一次启动不该被当成"断电"：写 clean 标记
  markCleanShutdown(home);
  const inbox = readEvents(join(home, "inbox"));
  return {
    ok: true, files: Object.keys(manifest.files).length, backup, decayed,
    inbox: { events: inbox.events.length, quarantined: inbox.quarantined, corrupted: inbox.corrupted },
    counts: manifest.counts,
  };
}

/** 给 CLI 用：导出目录的默认位置。**必须在 home 之外**（exports 自己不能被卷进去） */
export function defaultExportDir(home: string, now = new Date()): string {
  return join(dirname(normalize(home)), "exports", `${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}`);
}
