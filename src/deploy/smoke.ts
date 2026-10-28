/**
 * 冒烟 20 项（18 §4.3 / §4.5，99 §5.1）
 *
 * 分两组，各 10 项：
 *   ① 能启动 / 库可读 / 指纹一致（1–10）—— 目标：坏版本在**切槽之前**就被拦下
 *   ② 人格回归（11–20）—— 目标：人格载荷是"可用的"，不是"有文件的"
 *
 * 与文档的一处**有意偏离**（写给下一个人）：
 *   18 §4.3 写的是"人格回归 10 问"，本实现测的是人格的**不变量**（齐全/非空/无控制字符/
 *   无密钥/无主机绝对路径/无软链/预算）而不是真去问 10 个问题。原因：
 *   模型回答不确定、要花钱、离线跑不了 —— 把它放进发布闸，会让"发布"变成"有时通过"。
 *   真问题留给 `jingjing eval --model`（显式付费）与面板里的人工验收。
 *
 * 全部同步、零网络、只读数据库：冒烟一秒内跑完，因为它会被每次发版调用。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { SCHEMA_VERSION } from "../schema.ts";
import { PERSONA_FILES } from "../persona.ts";
import { readEvents } from "../journal.ts";
import { estimateTokens } from "../tokens.ts";
import { coreFpFromDb, type CoreFp } from "./fingerprint.ts";
import { releaseDir, readManifest } from "./slot.ts";

/** 17 §2 / brief.ts：稳定前缀（P1–P4）1400，总预算 2000 */
const PREFIX_BUDGET = 1400;
const TOTAL_BUDGET = 2000;

export interface SmokeRow {
  n: number;
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeReport {
  pass: boolean;
  rows: SmokeRow[];
  failed: string[];
  /** 本版人格指纹（同样内容 → 同样值，用来回答"这版人格变了没"） */
  personaHash: string;
}

export interface SmokeOpts {
  home: string;
  /** 默认 home/memory.db */
  dbFile?: string;
  /** 指定要冒烟的版本；不给就冒烟当前 live home */
  release?: string | null;
}

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const ABS_PATH = /(^|[\s"'`(])([A-Za-z]:[\\/]|\/(home|Users|root|opt|var|etc|mnt)\/)/;
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|api[_-]?key\s*[=:]\s*\S{12,})/i;

function walk(dir: string): Array<{ rel: string; symlink: boolean }> {
  const out: Array<{ rel: string; symlink: boolean }> = [];
  const rec = (d: string, prefix: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.push({ rel, symlink: true });
      else if (e.isDirectory()) rec(p, rel);
      else out.push({ rel, symlink: false });
    }
  };
  if (existsSync(dir)) rec(dir, "");
  return out;
}

export function runSmoke(opts: SmokeOpts): SmokeReport {
  const home = opts.home;
  const dbFile = opts.dbFile ?? join(home, "memory.db");
  const release = opts.release ?? null;
  const rows: SmokeRow[] = [];
  const add = (n: number, name: string, ok: boolean, detail: string) =>
    rows.push({ n, name, ok, detail });

  // ── ① 能启动 / 库可读 / 指纹一致 ──────────────────────────────
  let db: DatabaseSync | null = null;
  let fp: CoreFp = { schema: "?", tool: "?", embed: "?" };
  try {
    db = new DatabaseSync(dbFile, { readOnly: true, allowExtension: true });
    add(1, "db.open", true, dbFile);
  } catch (e) {
    add(1, "db.open", false, String(e).slice(0, 120));
  }

  if (db) {
    try {
      const v = Object.values(db.prepare("PRAGMA quick_check").get() as Record<string, string>)[0];
      add(2, "db.quick_check", v === "ok", String(v));
    } catch (e) {
      add(2, "db.quick_check", false, String(e).slice(0, 120));
    }

    try {
      const ver = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined)?.value;
      // schema 指纹由代码推导，这里只校验"库里的版本号 == 代码里的版本号"
      add(3, "db.schema_version", ver === String(SCHEMA_VERSION), `库 ${ver ?? "缺失"} / 代码 v${SCHEMA_VERSION}`);
    } catch (e) {
      add(3, "db.schema_version", false, String(e).slice(0, 120));
    }

    try {
      // 加载 vec 扩展只是让 vec0 的虚表可查；失败不算致命，但表必须可读
      try { db.loadExtension((createRequire(import.meta.url)("sqlite-vec") as { getLoadablePath(): string }).getLoadablePath()); } catch { /* 无扩展也能读普通表 */ }
      const c = (db.prepare("SELECT count(*) c FROM vec_memories").get() as { c: number }).c;
      add(4, "db.vec_readable", typeof c === "number", `${c} 条向量`);
    } catch (e) {
      add(4, "db.vec_readable", false, String(e).slice(0, 120));
    }

    try {
      const c = (db.prepare("SELECT count(*) c FROM chunks_fts WHERE chunks_fts MATCH ?").get("记忆") as { c: number }).c;
      add(5, "db.fts", typeof c === "number", `bigram 命中 ${c} 行`);
    } catch (e) {
      add(5, "db.fts", false, String(e).slice(0, 120));
    }

    try {
      const c = (db.prepare("SELECT count(*) c FROM memories").get() as { c: number }).c;
      add(6, "db.memories", typeof c === "number", `${c} 条记忆`);
    } catch (e) {
      add(6, "db.memories", false, String(e).slice(0, 120));
    }

    try {
      fp = coreFpFromDb(db);
    } catch { /* 指纹读不到，下面的比对会失败 */ }
  } else {
    for (const [n, name] of [[2, "db.quick_check"], [3, "db.schema_version"], [4, "db.vec_readable"],
      [5, "db.fts"], [6, "db.memories"]] as Array<[number, string]>) {
      add(n, name, false, "库打不开，跳过");
    }
  }

  try {
    const r = readEvents(join(home, "inbox"));
    add(7, "inbox", r.corrupted === 0, `${r.events.length} 事件 / 坏 ${r.corrupted}`);
  } catch (e) {
    add(7, "inbox", false, String(e).slice(0, 120));
  }

  let expected: CoreFp | null = null;
  if (release) {
    try { expected = readManifest(home, release).coreFp; }
    catch (e) { add(8, "fp.schema", false, `清单读不到：${String(e).slice(0, 80)}`); }
  }
  const fpRow = (n: number, key: keyof CoreFp, label: string) => {
    if (!expected) { add(n, label, true, `${fp[key]}（未指定版本，仅记录）`); return; }
    const ok = expected[key] === fp[key];
    add(n, label, ok, ok ? fp[key] : `${expected[key]} → ${fp[key]}`);
  };
  fpRow(8, "schema", "fp.schema");
  fpRow(9, "tool", "fp.tool");
  fpRow(10, "embed", "fp.embed");

  // ── ② 人格回归 10 项 ─────────────────────────────────────────
  const pdir = release ? join(releaseDir(home, release), "persona") : join(home, "persona");
  const texts: Record<string, string> = {};
  for (const f of PERSONA_FILES) {
    const p = join(pdir, f + ".md");
    texts[f] = existsSync(p) ? readFileSync(p, "utf8") : "";
  }
  const missing = PERSONA_FILES.filter((f) => !texts[f]).map((f) => f + ".md");
  add(11, "persona.files", missing.length === 0, missing.length ? `缺 ${missing.join(",")}` : `6 个文件齐全 @ ${pdir}`);

  add(12, "persona.nonempty", PERSONA_FILES.every((f) => (texts[f] ?? "").trim().length > 0), "六块都非空");

  const core = texts.core ?? "";
  add(13, "persona.core_size", core.trim().length >= 40, `core ${core.trim().length} 字`);

  const ctrl = Object.entries(texts).flatMap(([f, t]) =>
    [...t].filter((ch) => ch.charCodeAt(0) < 32 && ch !== "\n" && ch !== "\t" && ch !== "\r").map(() => f));
  add(14, "persona.controls", ctrl.length === 0, ctrl.length ? `控制字符出现在 ${[...new Set(ctrl)].join(",")}` : "无控制字符");

  const enc = Object.entries(texts).filter(([, t]) => t.includes("\uFFFD")).map(([f]) => f);
  add(15, "persona.encoding", enc.length === 0, enc.length ? `U+FFFD 出现在 ${enc.join(",")}` : "UTF-8 干净");

  const sec = Object.entries(texts).filter(([, t]) => SECRET.test(t)).map(([f]) => f);
  add(16, "persona.no_secret", sec.length === 0, sec.length ? `疑似密钥出现在 ${sec.join(",")}` : "无密钥形状");

  const abs = Object.entries(texts).filter(([, t]) => ABS_PATH.test(t)).map(([f]) => f);
  add(17, "persona.no_host_path", abs.length === 0, abs.length ? `绝对路径出现在 ${abs.join(",")}` : "无主机绝对路径");

  const links = existsSync(pdir) ? walk(pdir).filter((x) => x.symlink) : [];
  add(18, "persona.no_symlink", links.length === 0, links.length ? `软链 ${links.map((x) => x.rel).join(",")}` : "无软链/目录联接");

  const prefix = ["core", "boundaries", "evidence", "tools"].map((f) => texts[f] ?? "").join("\n\n");
  const prefixTok = estimateTokens(prefix);
  add(19, "persona.budget_prefix", prefixTok <= PREFIX_BUDGET, `P1–P4 ${prefixTok} / ${PREFIX_BUDGET} tok`);

  const totalTok = PERSONA_FILES.reduce((n, f) => n + estimateTokens(texts[f] ?? ""), 0);
  add(20, "persona.budget_total", totalTok <= TOTAL_BUDGET, `六块合计 ${totalTok} / ${TOTAL_BUDGET} tok`);

  if (db) { try { (db as DatabaseSync).close(); } catch { /* ignore */ } }

  const failed = rows.filter((r) => !r.ok).map((r) => r.name);
  const personaHash = sha(PERSONA_FILES.map((f) => texts[f] ?? "").join("\u0000"));
  return { pass: failed.length === 0, rows, failed, personaHash };
}

