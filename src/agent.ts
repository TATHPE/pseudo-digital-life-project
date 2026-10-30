/**
 * 工具循环（agent loop）：模型 → 工具 → 模型 … → 回答。
 * 只做一件事：把"能聊天"变成"能做事"，其它（权限、审计）交给 tools/transport。
 */
import type { ChatEvent } from "./transport.ts";
import type { ToolRegistry } from "./tools.ts";

export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; id: string; name: string; args: string }
  | { type: "tool_result"; id: string; name: string; result: string; ms: number }
  | { type: "phase"; step: number; note: string }
  | { type: "done"; steps: number; finish: string }
  | { type: "error"; message: string }
  | { type: "notice"; text: string };

/**
 * 云端失败 → 本地兜底（13 §5 的降级链，之前 fallbackChain 写了却从没被调用）。
 *
 * 两条纪律：
 *  - **已经吐过字就不再切换**：两段话拼在一起会变成一句假话
 *  - 切换时必须留一条 notice，否则用户会以为云端在答（"不假装" 的第一条）
 */
export async function* withFallback(
  primary: () => AsyncGenerator<ChatEvent, void, void>,
  backup: (() => AsyncGenerator<ChatEvent, void, void>) | null,
  notice = "云端不可用，这条用本地模型回答",
): AsyncGenerator<ChatEvent, void, void> {
  let spoke = false;
  try {
    for await (const ev of primary()) { if (ev.type === "delta") spoke = true; yield ev; }
    return;
  } catch (e) {
    if (spoke || !backup) throw e;
    yield { type: "notice", text: notice };
    yield* backup();
  }
}

export interface ChatFn {
  (messages: unknown[], tools: ReturnType<ToolRegistry["schema"]>): AsyncGenerator<ChatEvent, void, void>;
}

export interface AgentDeps {
  chat: ChatFn;
  tools: ToolRegistry;
  maxSteps?: number;
  /** 单个工具输出给模型的长度上限（11 §3：别把上下文撑爆） */
  maxToolChars?: number;
}

type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export async function* runAgent(deps: AgentDeps, system: string, user: string): AsyncGenerator<AgentEvent, void, void> {
  const maxSteps = deps.maxSteps ?? 6;
  const cap = deps.maxToolChars ?? 4000;
  const messages: Msg[] = [{ role: "system", content: system }, { role: "user", content: user }];
  const schema = deps.tools.schema();

  for (let step = 1; step <= maxSteps; step++) {
    let text = "";
    let calls: Array<{ id: string; name: string; args: string }> = [];
    let finish = "stop";
    try {
      for await (const ev of deps.chat(messages, schema)) {
        if (ev.type === "delta") { text += ev.text; yield { type: "delta", text: ev.text }; }
        // notice 必须传出去：它是“云端不行了，这条用本地模型答”的唯一标记。
        // 以前这里把它吞了 —— 面板上永远看不到降级，等于“静默降级”。
        else if (ev.type === "notice") yield { type: "notice", text: ev.text };
        else if (ev.type === "tool_calls") calls = ev.calls;
        else if (ev.type === "done") finish = ev.finish;
      }
    } catch (e) {
      yield { type: "error", message: String((e as Error).message ?? e).slice(0, 300) };
      return;
    }
    if (!calls.length) { yield { type: "done", steps: step, finish }; return; }

    messages.push({
      role: "assistant", content: text,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
    });

    for (const c of calls) {
      yield { type: "tool", id: c.id, name: c.name, args: c.args };
      const t0 = Date.now();
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.args || "{}") as Record<string, unknown>; }
      catch { args = {}; }
      const res = await deps.tools.run(c.name, args);
      let out = res.output;
      if (out.length > cap) out = out.slice(0, cap) + `…（已截断，共 ${out.length} 字符）`;
      yield { type: "tool_result", id: c.id, name: c.name, result: out, ms: Date.now() - t0 };
      messages.push({ role: "tool", tool_call_id: c.id, content: out });
    }
    yield { type: "phase", step, note: `第 ${step} 轮工具完成，继续` };
  }
  yield { type: "error", message: `E_MAX_STEPS: 超过 ${maxSteps} 轮，停止（避免空转）` };
}
