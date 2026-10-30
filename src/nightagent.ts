/**
 * 夜间整理的「工具循环」抽取器（P0-2）
 *
 * 为什么要它：之前 `night` 是一次性长 prompt —— 模型只看得到今天这段对话，
 * **看不到库里已经有什么**，于是必然重复写、也认不出冲突。它唯一的动作是"猜"。
 *
 * 接上工具之后它才可能"核对"：先 `memory_search` 看看这条是不是已经有了，
 * 必要时 `doc_search` 捞原文，然后再交出 JSON。这就是 `docs/22` G-5 那句
 * 「瓶颈是能看到多少，不是多聪明」的落地。
 *
 * 三条硬约束：
 *  1. **只给只读工具**。写入永远走 parseCandidates → remember()（确定性闸门：去重、
 *     契约层拒收 external、supersede）。绝不把 `memory.remember` 交给它 ——
 *     否则模型可以直接改库，night 就变成了第二个执行路径。
 *  2. **轮数有上限**（默认 6），超了就带着现有信息收尾，不许空转。
 *  3. **每次工具调用都要能被报告出来**（trace），否则"它到底查了什么"只能靠猜。
 */
import type { ChatEvent } from "./transport.ts";
import type { ToolRegistry } from "./tools.ts";
import { runAgent } from "./agent.ts";

/** 夜间整理允许用的能力：全是只读。加东西之前先问「它会不会因此能改库」 */
export const NIGHT_TOOLS = [
  "memory.search",
  "doc.search",
  "doc.list",
  "time.now",
  "fs.list",
  "fs.read",
] as const;

export interface ToolTrace {
  name: string;
  args: string;
  result: string;
  ms: number;
}

export interface ToolExtractorOpts {
  chat: (messages: unknown[], tools: ReturnType<ToolRegistry["schema"]>) => AsyncGenerator<ChatEvent, void, void>;
  tools: ToolRegistry;
  /** 最多几轮工具调用（默认 6） */
  maxSteps?: number;
  /** 每次工具调用结束后回调（报告 / 日志用） */
  onTool?: (t: ToolTrace) => void;
}

export const NIGHT_SYSTEM = [
  "你是记忆抽取器，负责在夜间整理今天的对话。",
  "你可以调用**只读**工具先核对：",
  "  · memory_search —— 库里是不是已经有类似的一条（避免重复、避免把已经说清的事再记一遍）",
  "  · doc_search / doc_list —— 需要原文时查",
  "  · time_now —— 需要今天日期时查",
  "不要用工具写任何东西：写入由调用方完成。",
  "",
  "核对完之后，只输出一个 JSON 数组，不要解释、不要代码围栏以外的文字。",
  "每条：{\"kind\":…,\"layer\":\"narrative|contract\",\"subject\":…,\"text\":…,\"salience\":0到1,\"reason\":…}",
  "宁缺毋滥：如果今天没有值得长期记住的东西，输出 []。",
].join(String.fromCharCode(10));

/**
 * 把一次抽取变成「模型 → 只读工具 → 模型 → JSON」。
 * 返回模型最后那段文本（交给 parseCandidates 解析，宽松解析已经能容忍围栏与废话）。
 */
export function makeToolExtractor(o: ToolExtractorOpts): (prompt: string) => Promise<string> {
  const maxSteps = o.maxSteps ?? 6;
  return async (prompt: string): Promise<string> => {
    let text = "";
    let failure = "";
    const agent = runAgent({ chat: o.chat, tools: o.tools, maxSteps }, NIGHT_SYSTEM, prompt);
    for await (const ev of agent) {
      if (ev.type === "delta") text += ev.text;
      else if (ev.type === "tool_result") {
        o.onTool?.({ name: ev.name, args: "", result: ev.result, ms: ev.ms });
      } else if (ev.type === "error") {
        failure = ev.message;
      }
    }
    // 空手而归 + 有错 → 必须抛。否则上层会把“抽取失败”当成“今天没什么可记的”，
    // 然后推进游标 —— 那批对话就永久丢了（实测：模型不支 chat 时 38 条被跳过）。
    if (!text.trim() && failure) throw new Error(`E_EXTRACT: ${failure}`);
    return text;
  };
}
