/**
 * 超级权限（2026-11-01，用户要的）：
 *
 * > 「这个权限可以完全接管电脑，也可以随意修改记忆和人格。」
 *
 * 它和「完全权限（full）」不是一回事：
 *   · full  = 任意 argv + 整个 home，但记忆核心（memory.db / persona / secrets / inbox / trash / snapshots）
 *             和硬禁名单（删/磁盘/系统/下载/壳）仍然拒 —— 那是"在这个家里什么都能做"。
 *   · super = 连家门的锁也给你：可以改记忆库本体、改人格、删系统文件、关机、装软件、跑任意解释器。
 *
 * 四条硬约束（写进代码，不靠自觉）：
 *   1. **模型永远开不了它**：只有 `POST /api/super` 能开，且在设置里、要手输确认词。
 *      对话里没有路径，`taint=external` 的内容更碰不到。
 *   2. **开关留痕**：开/关都写 `super.json` 的 if/since/because + inbox 事件。
 *   3. **两条永不放开**（删了连回滚的底都没了）：
 *        · 删 `trash/`（回收站）
 *        · 删 `snapshots/`（写前快照）
 *      以及**格式化磁盘**（format/mkfs/diskpart）—— 那不是"接管电脑"，那是把电脑弄没。
 *   4. **持久**（用户要"接管"，不是"临时一次"），但每次越过旧边界都会在审计里记 `super`。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";

export interface SuperState {
  enabled: boolean;
  /** 什么时候开的 */
  since?: string;
  /** 为什么开的（人写的一句话，≥4 字） */
  because?: string;
}

export const superPath = (home: string): string => join(home, "super.json");

/** 开着也不放开的三样：它们是"兜底本身"或"把电脑弄没" */
export const SUPER_STILL_DENY = ["format", "mkfs", "diskpart"] as const;
/** 这两个目录下的东西，super 也不许删（只挡删除类动词） */
export const SUPER_KEEP_DIRS = ["trash", "snapshots"] as const;

const cache = new Map<string, { stamp: number; state: SuperState }>();

export function readSuper(home: string): SuperState {
  const p = superPath(home);
  let stamp = 0;
  try { stamp = existsSync(p) ? readFileSync(p, "utf8").length + (Date.now() & 0) : 0; } catch { stamp = 0; }
  // 用内容长度当"戳"不够：同长度改内容会漏。改为每次读（文件极小，几十字节）
  void stamp;
  try {
    if (!existsSync(p)) return { enabled: false };
    const j = JSON.parse(readFileSync(p, "utf8")) as SuperState;
    return { enabled: j.enabled === true, ...(j.since ? { since: j.since } : {}), ...(j.because ? { because: j.because } : {}) };
  } catch {
    return { enabled: false };   // 文件坏了 = 没开（不给自己开后门）
  }
}

export function superEnabled(home: string): boolean {
  return readSuper(home).enabled;
}

export function writeSuper(home: string, st: SuperState): SuperState {
  atomicWriteFile(superPath(home), JSON.stringify(st, null, 2) + String.fromCharCode(10));
  cache.delete(home);
  return st;
}

export type SuperResult = { ok: true; state: SuperState } | { ok: false; code: string; why: string };

/** 开：必须给一句理由（≥4 字），并手输确认词由调用方校验 */
export function enableSuper(home: string, input: { because?: string; now?: Date }): SuperResult {
  const because = String(input.because ?? "").trim();
  if (because.length < 4) return { ok: false, code: "E_NO_REASON", why: "写一句为什么（≥4 个字）—— 这条会进审计" };
  const now = input.now ?? new Date();
  return { ok: true, state: writeSuper(home, { enabled: true, since: now.toISOString(), because }) };
}

/** 关：一句话都不用说，随时能收回 */
export function disableSuper(home: string): SuperResult {
  return { ok: true, state: writeSuper(home, { enabled: false }) };
}

/** 路径是不是"改了也没得回滚"的那两样（trash / snapshots） */
export function isRescuePath(home: string, target: string): boolean {
  const n = String(target ?? "").replace(/\\/g, "/").toLowerCase();
  const h = String(home ?? "").replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
  const rel = n.startsWith(h + "/") ? n.slice(h.length + 1) : n;
  const bare = rel.startsWith("data/") ? rel.slice(5) : rel;
  return SUPER_KEEP_DIRS.some((d) => bare === d || bare.startsWith(d + "/") || bare.includes("/" + d + "/"));
}

/** 二进制是不是"格式化磁盘"那一类（super 也不放开） */
export function isDiskFormatting(bin: string): boolean {
  const b = String(bin ?? "").toLowerCase().replace(/\.exe$/, "");
  return SUPER_STILL_DENY.some((x) => b === x || b.startsWith(x));
}
