/**
 * 「本地模型只管理记忆」这条边界，写成**结构**（用户 2026-10-31 再次确认）。
 *
 * 三个含义，逐个落到代码：
 *  ① 本地模型**不参与对话**（`express` 是云端角色；配成本地就当"对话不可用"）
 *  ② 本地模型**能调的工具只有记忆类**（`MEMORY_ONLY_TOOLS`：只读 + 记忆写入，没有 fs/shell/网络）
 *  ③ 夜间整理走的也是这一份白名单（同一个常量，不复制第二份）
 *
 * 为什么不能只靠提示词：一条"你只负责管理记忆"的句子，7B 会当成建议。
 * 这里做的是 —— **执行侧**也只给它这些工具（`tools.ts` 的 allow 在 run 时校验）。
 */

/** 本地模型允许的能力：全部围绕记忆，且**不含** fs.write / shell / 网络 */
export const MEMORY_ONLY_TOOLS = [
  "memory.search",
  "memory.remember",
  "doc.search",
  "doc.list",
  "time.now",
  "fs.list",     // 只列目录（只读）：用于找到该读哪份资料
  "fs.read",     // 只读
] as const;

/** 夜间整理用的白名单 = 记忆白名单减去写入（夜间写入由确定性代码做，不经模型） */
export const NIGHT_TOOLS = MEMORY_ONLY_TOOLS.filter((t) => t !== "memory.remember") as unknown as readonly string[];

export const isMemoryTool = (name: string): boolean =>
  (MEMORY_ONLY_TOOLS as readonly string[]).includes(name);

/** 这个 role 是不是本地模型（拿不准按云端处理，保守） */
export function isLocalRole(role: { kind?: string } | undefined): boolean {
  return role?.kind === "local";
}
