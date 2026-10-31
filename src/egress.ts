/**
 * H-7：代码外发的**按次授权**。
 *
 * 问题：当表达模型在云端时，读源码 == 把代码发出去。原来的形态只有两个极端 ——
 * 要么全禁（默认），要么 `JJ_PROJECT_EGRESS=1` 全放行。**中间没有"就这一次"。**
 *
 * 三条设计：
 *  ① **默认拒**，并且拒绝时**说清是哪条路径**（否则人不知道自己在批什么）
 *  ② 人可以在面板上：「只这一次」/「10 分钟内都行」/「拒绝」
 *     —— 一次性额度用完就回到拒绝；窗口到点也回到拒绝
 *  ③ **逐条审计**：批的每一次读都写 `exec_audit`（走的是同一条执行路径，不是旁路）
 *
 * 为什么放在**内存**里：这是"我现在正看着"的授权，进程退了就该没了，
 * 落盘就等于给人偷偷续期的机会。
 */
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { atomicWriteFile } from "./fsx.ts";

interface EgressGrant {
  /** 一次性放行的路径（读一次就消耗） */
  once: Set<string>;
  /** 时间窗（毫秒时间戳）；0 = 没有窗口 */
  until: number;
  /** 窗口的来由，给面板显示 */
  because: string;
}

export interface EgressStatus {
  /** 现在能不能读代码 */
  open: boolean;
  /** 窗口到期时间（ISO）；没有窗口就是 null */
  until: string | null;
  /** 还剩几次一次性额度 */
  once: number;
  /** 是不是被环境变量强制打开了（无人值守模式） */
  forced: boolean;
  /** 最近被拒的路径（面板据此问人） */
  pending: Array<{ path: string; at: string; verb: string }>;
}

const SESSION_MS = Number.POSITIVE_INFINITY;
const store = new Map<string, EgressGrant>();

/**
 * 待批列表**落盘**：会话窗口放内存（人看着才算数），但「它想读这个」这条记录要跨进程 ——
 * 否则在 CLI 里被拒的读，面板上就不会问你。
 */
type PendingRow = { path: string; at: string; verb: string };
const pendingPath = (home: string): string => join(home, "egress-pending.json");
function readPending(home: string): Map<string, { at: string; verb: string }> {
  const out = new Map<string, { at: string; verb: string }>();
  try {
    for (const r of JSON.parse(readFileSync(pendingPath(home), "utf8")) as PendingRow[]) {
      out.set(key(r.path), { at: r.at, verb: r.verb });
    }
  } catch { /* 没有就是没有 */ }
  return out;
}
function writePending(home: string, m: Map<string, { at: string; verb: string }>): void {
  const rows: PendingRow[] = [...m.entries()].map(([path, v]) => ({ path, at: v.at, verb: v.verb }));
  try { atomicWriteFile(pendingPath(home), JSON.stringify(rows, null, 2)); } catch { /* 写不下不该挡住拒绝 */ }
}

const key = (p: string): string => normalize(String(p ?? "")).replace(/\\/g, "/").toLowerCase();

const get = (home: string): EgressGrant => {
  let g = store.get(home);
  if (!g) { g = { once: new Set(), until: 0, because: "" }; store.set(home, g); }
  return g;
};

/** 环境变量强制模式（无人值守）；默认关 */
export const forcedByEnv = (env: Record<string, string | undefined> = process.env): boolean =>
  env.JJ_PROJECT_EGRESS === "1";

/**
 * 判定这次读能不能外发。
 * 返回 `{ok:false}` 时**不抛异常**，由调用方决定怎么报（要带路径与补救办法）。
 */
export function checkEgress(
  home: string, path: string, opts: { env?: Record<string, string | undefined>; now?: Date } = {},
): { ok: true; via: "env" | "once" | "window" } | { ok: false; code: string; path: string } {
  const p = key(path);
  if (forcedByEnv(opts.env ?? process.env)) return { ok: true, via: "env" };
  const g = get(home);
  const now = (opts.now ?? new Date()).getTime();
  if (g.once.has(p)) { g.once.delete(p); return { ok: true, via: "once" }; }
  if (g.until > now) return { ok: true, via: "window" };
  return { ok: false, code: "E_NEEDS_EGRESS", path };
}

/** 记一笔"它想读这个但被拒了"（面板据此问人；同一路径只留最新一条） */
export function noteEgressRequest(home: string, path: string, verb: string, now = new Date()): void {
  const m = readPending(home);
  m.set(key(path), { at: now.toISOString(), verb });
  writePending(home, m);
}

/** 人点了「只这一次」 */
export function allowOnce(home: string, path: string): void {
  const g = get(home);
  g.once.add(key(path));
  const m = readPending(home);
  m.delete(key(path));
  writePending(home, m);
}

/** 人点了「10 分钟内都行」：一扇短窗，到点自动关 */
export function allowFor(home: string, ms: number, because: string): { until: string } {
  const g = get(home);
  const ttl = Math.min(60 * 60_000, Math.max(30_000, ms));
  g.until = Date.now() + ttl;
  g.because = String(because ?? "").slice(0, 120);
  // 开窗等于把所有待批的都批了：人已经说了「这段时间可以」
  writePending(home, new Map());
  return { until: new Date(g.until).toISOString() };
}

/** 立刻关掉（一次性额度也清掉） */
export function revokeEgress(home: string): void {
  store.set(home, { once: new Set(), until: 0, because: "" });
}

export function egressStatus(home: string, opts: { env?: Record<string, string | undefined>; now?: Date } = {}): EgressStatus {
  const g = get(home);
  const now = (opts.now ?? new Date()).getTime();
  const pending = [...readPending(home).entries()]
    .map(([path, v]) => ({ path, at: v.at, verb: v.verb }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8);
  const forced = forcedByEnv(opts.env ?? process.env);
  return {
    open: forced || g.until > now || g.once.size > 0,
    until: g.until > now ? new Date(g.until).toISOString() : null,
    once: g.once.size,
    forced,
    pending,
  };
}

/** 测试用：会话级状态清空 */
export function _resetEgress(home?: string): void {
  store.clear();
  if (home) writePending(home, new Map());
}
void SESSION_MS;
