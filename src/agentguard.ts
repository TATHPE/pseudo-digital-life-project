/**
 * Agent 回路的三条硬规矩（C-1 / C-3 / C-2）。
 *
 * 为什么要它们：7B 有工具，但它的默认行为是「调一个工具 → 说一句像总结的话 → 结束」。
 * 那不是 agent，那是"会写文件的模型"。三条规矩都是**确定性的**，不指望提示词：
 *
 *  C-1 **改完自己验**：这次调用里只要动过东西（fs.write / fs.mkdir / shell.run…），
 *      就不许直接收尾 —— 必须先跑一次验证，跑不了就**明说没验**（不许假装验过）。
 *  C-3 **错误当作输入**：工具报错不是终点，是下一步的输入；同名工具允许**补一次**。
 *  C-2 **先列步骤**：看起来像任务（改/加/修/跑…）时，第一轮先让它写 1–5 步，每步带"怎么验"。
 *
 * 三条都只改**上下文**（往 messages 里补一句），不绕过任何闸门 —— 权限仍然走 execute。
 */

/** 会改东西的工具：名字前缀/精确名 */
const MUTATING = new Set([
  "fs.write", "fs.mkdir", "fs.move", "fs.trash", "fs.restore",
  "shell.run", "shell.exec",
  "memory.remember", "proposal.create", "doc.ingest", "doc.forget",
]);

export const isMutating = (name: string): boolean => MUTATING.has(name);

/** 验证类工具：跑脚本 / 跑测试 / 读结果 */
const VERIFYING = new Set(["shell.run", "shell.exec"]);

export const isVerifying = (name: string): boolean =>
  VERIFYING.has(name) || name.startsWith("project.") || name === "memory.search";

/** 看起来像任务（不是打招呼/闲聊/问事实） */
const TASK_HINT = /改|加|修|删|重构|实现|跑|测|查一下|看一|读一|写一|补|接上|拆|整理|迁移|升级|挪|移|换|合并|拆分|调整|检查|验证|装|部署|优化|清|删掉|去掉/;

export const looksLikeTask = (text: string): boolean => {
  const t = String(text ?? "").trim();
  if (t.length < 4) return false;
  if (!TASK_HINT.test(t)) return false;
  // 纯提问（"是什么/为什么/怎么"）不算任务，避免每次问答都被逼列计划
  if (/^(什么|为什么|怎么|如何|能不能|是不是|有没有).{0,30}[？?]?$/.test(t)) return false;
  return true;
};

export interface GuardState {
  /** 这次对话里动过哪些工具 */
  mutated: string[];
  /** 验证过没有 */
  verified: boolean;
  /** 每个工具名已经补试过几次 */
  retries: Record<string, number>;
  /** 这次回答里已经催过几次（计划/补试/验证合计，防轮次爆炸） */
  nudges: number;
  /** 计划提示发过没有（只发一次） */
  planned: boolean;
  /** 列完步骤之后有没有真的开始做（C-2 的后半段：列完不许停） */
  planActed: boolean;
  /** 验证催促发过没有（最多一次，之后就是如实报告"没验"） */
  nudgedVerify: boolean;
}

export const newGuard = (): GuardState => ({ mutated: [], verified: false, retries: {}, planned: false, planActed: false, nudgedVerify: false, nudges: 0 });

export function noteToolResult(g: GuardState, name: string, ok: boolean, output: string): void {
  if (ok && isMutating(name)) {
    if (!g.mutated.includes(name)) g.mutated.push(name);
    // 动过东西之后，"验证过"要重新算 —— 改完再改，前面的验证不算数
    g.verified = false;
  }
  if (ok && isVerifying(name)) g.verified = true;
  void output;
}

/** 只有可恢复的错误值得补一次；其余补也没用，只会把轮次烧光 */
const RECOVERABLE = /E_NOT_FOUND|E_PATH_DENIED|E_NO_CANDIDATES|E_BAD_ARGV|E_OUT_OF_PROJECT|E_EMPTY/;
export const isRecoverable = (output: string): boolean => RECOVERABLE.test(String(output ?? ""));

/** 一次回答里所有「催一下」的总预算 */
export const MAX_NUDGES = 3;

export const isError = (output: string): boolean => /(^|\s)(E_[A-Z0-9_]+|E_DENIED|E_VERB)\b/.test(String(output ?? ""));

/** C-3：同名工具只补一次 */
export function canRetry(g: GuardState, name: string, output = ""): boolean {
  if (g.nudges >= MAX_NUDGES) return false;
  if (!isRecoverable(output)) return false;
  const n = g.retries[name] ?? 0;
  if (n >= 1) return false;
  g.retries[name] = n + 1;
  g.nudges++;
  return true;
}

/** 计划/验证也该吃同一份预算 */
export function spendNudge(g: GuardState): boolean {
  if (g.nudges >= MAX_NUDGES) return false;
  g.nudges++;
  return true;
}

/** C-2：该不该先讨计划 */
export function needPlan(g: GuardState, userText: string): boolean {
  if (g.planned) return false;
  // **不该讨就别标记**：标记了会在收尾时误发「开始执行」，模型就到处乱翻（踩过）
  if (!looksLikeTask(userText)) return false;
  g.planned = true;
  return true;
}

/** C-1：该不该拦住收尾、要求先验一次 */
export function needVerify(g: GuardState): boolean {
  return g.mutated.length > 0 && !g.verified && !g.nudgedVerify;
}

export const PLAN_ACT_NUDGE = [
  "开始执行。",
  "一步一步来：每步做完先看一眼结果，再决定下一步；做完最后一步再跑你写的那条验证。",
  "不要只复述计划。",
].join(String.fromCharCode(10));

export const PLAN_NUDGE = [
  "先别动手。用**最多 5 行**列出步骤，每行一句，最后一行写「怎么验」（跑什么命令/看什么结果）。",
  "只列步骤，不要解释。列完我会让你开始。",
].join(String.fromCharCode(10));

export const verifyNudge = (mutated: string[]): string =>
  [
    `你刚动过：${mutated.join(", ")}。**必须先验证再收尾。**`,
    "验证方式（任选其一，能用哪个用哪个）：",
    "  · shell.run 跑 node.run_script（脚本放 workspace/，里面跑测试或最小复现）",
    "  · project.read 读回改过的文件，确认内容真的写进去了",
    "如果确实没法验证，就直接说「没验证，原因是 …」——不许说「已完成」。",
  ].join(String.fromCharCode(10));

export const retryNudge = (name: string, output: string, hadMsg: boolean): string =>
  [
    `调用 ${name} 失败了：`,
    String(output ?? "").slice(0, 300),
    "",
    hadMsg ? "先读懂错误里说的下一步，然后**再试一次**（同一个工具只补一次）。" : "先读懂错误，再试一次。",
  ].join(String.fromCharCode(10));
