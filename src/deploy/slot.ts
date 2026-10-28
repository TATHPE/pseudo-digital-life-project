/**
 * A/B 双槽（18 §4.3 / §4.5，99 §5.1）
 *
 * 磁盘布局（home = data/）：
 *   deploy/releases/<id>/manifest.json   这一版的清单：三重指纹 + 每个文件的 sha256 + 为什么改
 *   deploy/releases/<id>/persona/*.md    载荷（人格 = ② 参数类，核心代码永不自改 18 §4.2）
 *   deploy/releases/<id>/skills/**       载荷（③ 技能类）
 *   deploy/releases/<id>/record.md       "我变了"的记录（18 §4.4）
 *   deploy/current -> releases/<id>      给外部工具（systemd / 人）看的软链
 *   deploy/state.json                    ← **事实源**：active / prev / history / failures / freeze
 *
 * 为什么事实源是 state.json 而不是软链：
 *   Windows 建目录软链要管理员或开发者模式，junction 又不能跨卷；一条悬空的 `current`
 *   会让"启动即挂"。所以软链只做装饰（尽力而为），判断一律读 state.json。
 *   这与本项目的一贯原则一致：事实源要能被**原子写**，符号链接不能。
 *
 * 载荷里**没有** policy.csv 与核心代码：发布不能带权限变更，也不能换脑子（18 §4.2）。
 */
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, cpSync, symlinkSync, unlinkSync,
} from "node:fs";
import { join, sep } from "node:path";
import { atomicWriteFile } from "../fsx.ts";
import { seedPersona } from "../persona.ts";
import { coreFpFromHome, type CoreFp } from "./fingerprint.ts";

/** 一版载荷里允许出现的目录（顺序稳定，便于哈希） */
export const PAYLOAD_DIRS = ["persona", "skills"] as const;

/** 会被"应用到 live home"的目录（skills 目前还没有消费者，先只应用 persona） */
export const APPLIED_DIRS = ["persona"] as const;

export interface Manifest {
  id: string;
  createdAt: string;
  /** 18 §4.4：没有理由的改动不算成长，只算版本升级 */
  because: string;
  parentId: string | null;
  coreFp: CoreFp;
  /** 载荷文件 → sha256（relpath 一律正斜杠） */
  files: Record<string, string>;
}

export interface HistEntry {
  at: string;
  from: string | null;
  to: string;
  /** install | promote | rollback | auto-rollback */
  why: string;
}

export interface Attempt {
  id: string;
  at: string;
  pid: number;
  boot: string;
}

export interface DeployState {
  active: string | null;
  prev: string | null;
  /** 已经**应用到 live home** 的版本；等于 active 说明不需要再复制 */
  applied: string | null;
  history: HistEntry[];
  failures: Record<string, number>;
  /** 连续失败次数：≥ maxStreak → 冻结自我更新（防抖动） */
  failStreak: number;
  freezeUntil: string | null;
  lastAttempt: Attempt | null;
  lastHealthy: { id: string; at: string } | null;
}

const HISTORY_CAP = 50;

export const deployRoot = (home: string) => join(home, "deploy");
export const releasesDir = (home: string) => join(deployRoot(home), "releases");
export const releaseDir = (home: string, id: string) => join(releasesDir(home), id);
export const manifestPath = (home: string, id: string) => join(releaseDir(home, id), "manifest.json");
export const statePath = (home: string) => join(deployRoot(home), "state.json");
export const currentLink = (home: string) => join(deployRoot(home), "current");

const ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;

/** id 会拼进路径 → 必须先验形状，否则 state.json 里一个 `../..` 就是路径穿越 */
export function assertReleaseId(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`E_BAD_RELEASE_ID: ${JSON.stringify(id)}`);
  return id;
}

export function freshState(): DeployState {
  return {
    active: null, prev: null, applied: null, history: [],
    failures: {}, failStreak: 0, freezeUntil: null,
    lastAttempt: null, lastHealthy: null,
  };
}

export function readState(home: string): DeployState {
  const p = statePath(home);
  if (!existsSync(p)) return freshState();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // 不静默重建：静默重建 = 回滚保护消失而没人知道（"看起来有"的那种失败）
    throw new Error("E_DEPLOY_STATE: state.json 解析失败");
  }
  const s = raw as Partial<DeployState>;
  return {
    active: s.active ?? null,
    prev: s.prev ?? null,
    applied: s.applied ?? null,
    history: Array.isArray(s.history) ? s.history : [],
    failures: s.failures && typeof s.failures === "object" ? s.failures : {},
    failStreak: Number(s.failStreak ?? 0) || 0,
    freezeUntil: s.freezeUntil ?? null,
    lastAttempt: s.lastAttempt ?? null,
    lastHealthy: s.lastHealthy ?? null,
  };
}

/** 启动路径用这个：state 坏了也要能起来（核心代码永不自改，最坏情况只是没有回滚保护） */
export function readStateSafe(home: string): { state: DeployState; corrupt: boolean } {
  try {
    return { state: readState(home), corrupt: false };
  } catch {
    return { state: freshState(), corrupt: true };
  }
}

export function writeState(home: string, s: DeployState): void {
  if (s.history.length > HISTORY_CAP) s.history = s.history.slice(-HISTORY_CAP);
  atomicWriteFile(statePath(home), JSON.stringify(s, null, 2) + "\n");
}

export function hasRelease(home: string, id: string): boolean {
  try {
    assertReleaseId(id);
  } catch { return false; }
  return existsSync(manifestPath(home, id));
}

export function readManifest(home: string, id: string): Manifest {
  assertReleaseId(id);
  const p = manifestPath(home, id);
  if (!existsSync(p)) throw new Error(`E_NO_RELEASE: ${id}`);
  return JSON.parse(readFileSync(p, "utf8")) as Manifest;
}

export function listReleases(home: string): string[] {
  const dir = releasesDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && ID_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** 20261028-153012-a1b2（时间在前 → 字典序 = 时间序） */
export function newReleaseId(now = new Date(), salt = Math.random().toString(36).slice(2, 6)): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${salt}`;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

const relOf = (root: string, abs: string) => abs.slice(root.length + 1).split(sep).join("/");

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push(p);
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) rec(root);
  return out.sort();
}

/** 载荷的文件清单（manifest.json / record.md 不算载荷，所以不会被自己的哈希绕进去） */
export function hashPayload(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const sub of PAYLOAD_DIRS) {
    const root = join(dir, sub);
    for (const abs of walkFiles(root)) files[relOf(dir, abs)] = sha256(readFileSync(abs));
  }
  return files;
}

export interface InstallOpts {
  /** 必填：18 §4.4 —— 写不出理由，就不该发版 */
  because: string;
  now?: Date;
  id?: string;
  parentId?: string | null;
}

/**
 * 从 live home 打一版快照（A 槽的"当前状态"就是这个形状）。
 * 幂等性不做：同一个 id 已存在 → E_RELEASE_EXISTS（宁可失败，不要覆盖一版历史）。
 */
export function installRelease(home: string, opts: InstallOpts): Manifest {
  const now = opts.now ?? new Date();
  const because = opts.because.trim();
  if (!because) throw new Error("E_DEPLOY_NO_REASON");
  const id = assertReleaseId(opts.id ?? newReleaseId(now));
  const dir = releaseDir(home, id);
  if (existsSync(dir)) throw new Error(`E_RELEASE_EXISTS: ${id}`);

  seedPersona(home); // 保证六个文件齐全（persona.ts 的回落逻辑才不会在快照里丢块）
  mkdirSync(dir, { recursive: true });
  for (const sub of PAYLOAD_DIRS) {
    const src = join(home, sub);
    if (existsSync(src)) cpSync(src, join(dir, sub), { recursive: true });
  }
  // versions/ 是运行时历史，不进载荷：否则每发一版都把历史翻一倍
  rmSync(join(dir, "persona", "versions"), { recursive: true, force: true });

  const parent = opts.parentId === undefined
    ? (readStateSafe(home).state.active ?? null)
    : opts.parentId;

  atomicWriteFile(join(dir, "record.md"), recordMd({ id, at: now, because, parent }));

  const manifest: Manifest = {
    id, createdAt: now.toISOString(), because, parentId: parent,
    coreFp: coreFpFromHome(home), files: hashPayload(dir),
  };
  atomicWriteFile(manifestPath(home, id), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

function recordMd(o: { id: string; at: Date; because: string; parent: string | null }): string {
  return [
    `# ${o.at.toISOString()} · release ${o.id}`,
    "",
    "## 改了什么",
    "",
    `人格/技能快照（上一版：${o.parent ?? "无"}）。核心代码不在载荷内（18 §4.2）。`,
    "",
    "## 为什么改（作者填写，L3 判据的原始素材）",
    "",
    o.because,
    "",
    "## 回滚",
    "",
    `node src/cli/deploy.ts rollback`,
    "",
  ].join("\n");
}

export interface VerifyResult {
  ok: boolean;
  missing: string[];
  changed: string[];
  extra: string[];
}

/** 载荷完整性：文件少一个、改一个字节，都不许应用（18 §4.5 数据兼容） */
export function verifyRelease(home: string, id: string): VerifyResult {
  const m = readManifest(home, id);
  const dir = releaseDir(home, id);
  const actual = hashPayload(dir);
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [rel, want] of Object.entries(m.files)) {
    const got = actual[rel];
    if (got === undefined) missing.push(rel);
    else if (got !== want) changed.push(rel);
  }
  const extra = Object.keys(actual).filter((rel) => !(rel in m.files));
  return { ok: missing.length === 0 && changed.length === 0, missing, changed, extra };
}

/**
 * 把某一版的载荷复制到 live home（幂等：内容相同就不写）。
 * 为什么是"复制回来"而不是"从软链读"：persona.ts 一直读 home/persona，
 * 换成软链读会让"面板改了但没发版"的行为悄悄变掉。
 */
export function applyRelease(home: string, id: string): { written: string[] } {
  const m = readManifest(home, id);
  const v = verifyRelease(home, id);
  if (!v.ok) throw new Error(`E_RELEASE_CORRUPT: ${id} missing=${v.missing.join(",")} changed=${v.changed.join(",")}`);
  const dir = releaseDir(home, id);
  const written: string[] = [];
  for (const [rel, want] of Object.entries(m.files)) {
    const sub = rel.split("/")[0] ?? "";
    if (!(APPLIED_DIRS as readonly string[]).includes(sub)) continue;
    const src = join(dir, ...rel.split("/"));
    const dest = join(home, ...rel.split("/"));
    if (existsSync(dest) && sha256(readFileSync(dest)) === want) continue;
    atomicWriteFile(dest, readFileSync(src));
    written.push(rel);
  }
  const st = readState(home);
  st.applied = id;
  writeState(home, st);
  return { written };
}

/** 切槽：只改 state.json + 装饰软链；真正的文件复制在下次启动的 applyRelease */
export function activate(home: string, id: string, why: string, now = new Date()): DeployState {
  assertReleaseId(id);
  if (!hasRelease(home, id)) throw new Error(`E_NO_RELEASE: ${id}`);
  const st = readState(home);
  if (st.active === id) return st;
  st.prev = st.active;
  st.active = id;
  st.applied = null;
  st.lastAttempt = null; // 新槽，观察窗口重新计时
  st.history.push({ at: now.toISOString(), from: st.prev, to: id, why });
  writeState(home, st);
  linkCurrent(home, id);
  return st;
}

/**
 * 回滚目标 = **最近一次真正跑通过（healthy）的版本**。
 * 不用 history 的 from：回滚 A→B→A 会来回弹；lastHealthy 只会指向"启动成功过"的那一版。
 *
 * 两个排除条件（都是实测咬到的）：
 *   - 不选失败的那个 id 本身（不然"回滚"变成原地跳）
 *   - 不选 **已经有失败记录** 的版本（不然 mutate 演练后，手动 rollback 会选回那个故意弄坏的 B）
 */
export function rollbackTarget(home: string, failedId: string): string | null {
  const st = readState(home);
  const untrusted = (id: string) => (st.failures[id] ?? 0) > 0;
  const cands = [st.lastHealthy?.id ?? null, st.prev, st.active];
  for (const c of cands) {
    if (!c || c === failedId) continue;
    if (untrusted(c)) continue;
    if (hasRelease(home, c)) return c;
  }
  // 兜底：全新安装时 lastHealthy 还没写过，用清单里的 parentId
  try {
    const parent = readManifest(home, failedId).parentId;
    if (parent && parent !== failedId && !untrusted(parent) && hasRelease(home, parent)) return parent;
  } catch { /* 清单读不到就没有兜底 */ }
  return null;
}

/** 装饰用软链：失败一律忽略（Windows 权限/跨卷都会成功不了，不影响正确性） */
export function linkCurrent(home: string, id: string): boolean {
  const link = currentLink(home);
  const target = releaseDir(home, id);
  try {
    if (existsSync(link)) unlinkSync(link);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

/** 保留最近 N 版 + 所有被引用的版本（active/prev/applied/lastHealthy/parent） */
export function pruneReleases(home: string, keep = 5): string[] {
  const st = readStateSafe(home).state;
  const all = listReleases(home);
  const live = new Set<string>(
    [st.active, st.prev, st.applied, st.lastHealthy?.id, st.history.at(-1)?.from]
      .filter((x): x is string => Boolean(x)),
  );
  const removed: string[] = [];
  const byTime = [...all].sort().reverse();
  byTime.forEach((id, i) => {
    if (live.has(id) || i < keep) return;
    rmSync(releaseDir(home, id), { recursive: true, force: true });
    removed.push(id);
  });
  return removed;
}
