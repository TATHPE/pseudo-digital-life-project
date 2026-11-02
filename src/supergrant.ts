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
/**
 * 开。2026-11-01 用户定：**确认步骤取消**（不手输确认词、不强制写理由）——
 * 一句"太麻烦"就够了，安全感应该来自"能一眼看见状态 + 一键收回 + 全程留痕"，
 * 不是多敲两个字。理由有就记，没有就记成（没写理由）。
 */
export function enableSuper(home: string, input: { because?: string; now?: Date } = {}): SuperResult {
  const because = String(input.because ?? "").trim().slice(0, 120) || "（没写理由）";
  const now = input.now ?? new Date();
  return { ok: true, state: writeSuper(home, { enabled: true, since: now.toISOString(), because }) };
}

/** 关：一句话都不用说，随时能收回 */
export function disableSuper(home: string): SuperResult {
  return { ok: true, state: writeSuper(home, { enabled: false }) };
}

/**
 * 她现在的手脚，写成**她看得懂的一句话**（进简报 P15）。
 * 关键是要说"能做什么"，而不是"你有 write 权限"—— 后者模型看不懂。
 */
export function powersLine(home: string, preset: string, egressOpen: boolean): string {
  const parts: string[] = [];
  const sup = superEnabled(home);
  if (sup) {
    parts.push("超级权限开着：可以跑任意命令（含 node -e 与 shell 管道）、读写整个磁盘、直接改记忆库与人格。");
    // 用户 2026-11-01 明确要这条：别让她绕道写 .ps1，super 下直接 -Command 就行
    const shellHint = process.platform === "win32"
      ? "想在 Windows 上跑 PowerShell 命令（Get-ChildItem / Select-String / 管道）：直接用 shell_exec 调 powershell -NoProfile -NonInteractive -Command \"<命令>\"，不需要先写脚本文件。"
      : "想跑 bash 命令（含管道）：直接用 shell_exec 调 bash -lc \"<命令>\"，不需要先写脚本文件。";
    parts.push(shellHint);
    parts.push("只有两件事仍然不行：格式化磁盘、删 trash/ 与 snapshots/（那是回滚的底）。");
  } else if (preset === "full") {
    parts.push("完全权限：可以跑任意命令、在整个 home 里操作；记忆核心与删/系统/下载/壳仍然拒。");
  } else if (preset === "write") {
    parts.push("工作区权限：注册过的模板能跑（`shell.templates` 看有哪些），文件能在家目录里读写；记忆核心、任意命令仍然拒。");
    parts.push("要跑没注册过的命令，请在设置里开「完全权限」或「超级权限」 —— 别对用户说「我做不到」，说「需要你开一下权限」。");
  } else if (preset === "read") {
    parts.push("只读：能查能看，不能写、不能跑会改东西的命令。");
  } else {
    parts.push("逐次确认：每个动作都要人点一次；要连续干活，请在输入框旁换成「完全权限」。");
  }
  parts.push(egressOpen ? "代码外发：会话内开放（读源码不会卡在授权上）。" : "代码外发：关着（读项目文件会被 E_NEEDS_EGRESS 挡，得让人批一次）。");
  parts.push("做之前先说一句要做什么；做完报结果与证据（哪条命令、什么输出）。");
  return "【我现在的权限】" + parts.join(" ");
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
