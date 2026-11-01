/**
 * 钩子（hooks）—— `docs/11` 六类能力里最后一块。
 *
 * 它是什么：**在某个事件点，跑一件已经注册过的事**。
 *   after_turn    一轮对话结束之后
 *   before_night  夜间整理之前
 *   after_night   夜间整理之后
 *
 * 它不是什么（三条边界，和 standing / 常驻指令同一套思路）：
 *   1. **只收模板，不收任意命令**：`data/hooks.json` 里写的是 `shell.run` 的模板 id + 参数槽，
 *      不接受 `command: "rm -rf /"`。想要任意命令请走 `shell.exec`（那要 super 或 full 窗口）。
 *   2. **每次触发都走 execute**：policy + 审计一条不少；失败只记错误，绝不改任务/权限。
 *   3. **不塞进程内定时器**：钩子只挂在"已经发生的事件"上，不制造自己的时间轴。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execute, type ExecDeps } from "./execute.ts";

export type HookEvent = "after_turn" | "before_night" | "after_night";
export const HOOK_EVENTS: HookEvent[] = ["after_turn", "before_night", "after_night"];

export interface Hook {
  id: string;
  event: HookEvent;
  /** shell.run 的模板 id（必须是我们注册过的） */
  template: string;
  slots?: Record<string, string>;
  enabled: boolean;
  /** 为什么装它（≥4 字） */
  because: string;
}

export const hooksPath = (home: string): string => join(home, "hooks.json");

/** 读配置；坏文件 = 没有钩子（不静默装一堆不认识的东西） */
export function loadHooks(home: string): Hook[] {
  try {
    if (!existsSync(hooksPath(home))) return [];
    const j = JSON.parse(readFileSync(hooksPath(home), "utf8")) as { hooks?: Hook[] };
    return (j.hooks ?? []).filter((h) =>
      h && typeof h.id === "string" && HOOK_EVENTS.includes(h.event) && typeof h.template === "string");
  } catch { return []; }
}

export interface FireResult {
  ran: Array<{ id: string; ok: boolean; ms: number; code?: string }>;
  errors: string[];
}

/**
 * 触发某个事件点上的所有钩子。
 * **永不抛**：钩子失败不该让"一轮对话"或"一次夜间整理"跟着失败。
 */
export async function fireHooks(
  home: string, event: HookEvent, deps: ExecDeps,
): Promise<FireResult> {
  const out: FireResult = { ran: [], errors: [] };
  const hooks = loadHooks(home).filter((h) => h.event === event && h.enabled !== false);
  for (const h of hooks) {
    const t0 = Date.now();
    try {
      // approved:true —— 钩子是**人写在 hooks.json 里的**，等于预先批过；
      // 但 policy 与审计照走（不是绕过闸门，是提前授权）。
      const r = await execute(deps, "shell.run", { template: h.template, ...(h.slots ? { slots: h.slots } : {}) }, { approved: true });
      out.ran.push({ id: h.id, ok: r.ok, ms: Date.now() - t0, ...(r.code ? { code: r.code } : {}) });
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 160);
      out.errors.push(h.id + ": " + msg);
      out.ran.push({ id: h.id, ok: false, ms: Date.now() - t0 });
    }
  }
  return out;
}
