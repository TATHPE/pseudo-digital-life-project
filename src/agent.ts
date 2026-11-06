/**
 * 工具循环（agent loop）：模型 → 工具 → 模型 … → 回答。
 * 只做一件事：把"能聊天"变成"能做事"，其它（权限、审计）交给 tools/transport。
 */
import type { ChatEvent } from "./transport.ts";
import type { ToolRegistry } from "./tools.ts";
import {
  newGuard, noteToolResult, isError, canRetry, needPlan, needVerify, spendNudge,
  PLAN_NUDGE, PLAN_ACT_NUDGE, verifyNudge, retryNudge,
} from "./agentguard.ts";

export type AgentEvent =
  | { type: "think"; text: string; step?: number }
  | { type: "delta"; text: string; step?: number }
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
  /**
   * C-1/C-2/C-3 三条回路规矩（默认开）。
   * 结构化抽取（夜间整理）必须关掉：它要的是「先查库再交 JSON」，
   * 不是「先列步骤、改完自己验」——那会把两轮变成三轮。
   */
  guards?: boolean;
}

type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export async function* runAgent(deps: AgentDeps, system: string, user: string): AsyncGenerator<AgentEvent, void, void> {
  const maxSteps = deps.maxSteps ?? 6;
  const guards = deps.guards !== false;
  const cap = deps.maxToolChars ?? 4000;
  const messages: Msg[] = [{ role: "system", content: system }, { role: "user", content: user }];
  const schema = deps.tools.schema();
  const guard = newGuard();

  // C-2：像任务就先讨一个步骤清单（只讨一次）
  if (guards && needPlan(guard, user) && spendNudge(guard)) {
    messages.push({ role: "user", content: PLAN_NUDGE });
    yield { type: "notice", text: "先列步骤（C-2）" };
  }

  for (let step = 1; step <= maxSteps; step++) {
    let text = "";
    let calls: Array<{ id: string; name: string; args: string }> = [];
    let finish = "stop";
    try {
      for await (const ev of deps.chat(messages, schema)) {
        if (ev.type === "delta") { text += ev.text; yield { type: "delta", text: ev.text, step }; }
        // 推理通道原样转出去（面板归到「过程」），不进 text —— 否则正文里全是「我先…再…」
        else if (ev.type === "think") yield { type: "think", text: ev.text, step };
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
    if (!calls.length) {
      // C-1：动过东西却没验，就不许收尾 —— 补一次；补过还不验，就**如实说没验**
      // C-2 后半段：列完计划就停 = 没干活。推它一把（只推一次）
      if (guards && guard.planned && !guard.planActed && spendNudge(guard)) {
        guard.planActed = true;
        yield { type: "notice", text: "计划列完了，让它开始执行（C-2）" };
        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user", content: PLAN_ACT_NUDGE });
        continue;
      }
      if (guards && needVerify(guard) && spendNudge(guard)) {
        guard.nudgedVerify = true;
        yield { type: "notice", text: "改完了但没验证，我让它先验一次（C-1）" };
        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user", content: verifyNudge(guard.mutated) });
        continue;
      }
      if (guard.mutated.length && !guard.verified) {
        // 催过还不验：把这件事说在明面上，别让用户以为验过了
        yield { type: "notice", text: "注意：这次改动**没有验证**（它自己说的）" };
      }
      yield { type: "done", steps: step, finish };
      return;
    }

    // 「边想边说」分离（2026-11-03）。
    //
    // 模型在同一条消息里既说话又调工具时，那段话是**过程**（"我先看一眼…""错误读懂了…"），
    // 不是给用户看的回答。实测用户看到的就是这些过程混在答复里，还以为回答不完整。
    //
    // 判据是结构性的，不看措辞：**带 tool_calls 的那一步说的话 = 过程**；
    // 最后一步没有 tool_calls 的 = 回答。前端据此把刚才流式显示的那段撤回、移进右栏。
    // 带 step：前端按「第几步」整段归类 —— 这一段的 delta 全部不进正文。
    // 之前靠「文本末尾匹配」撤回，模型多一个空格就撤不掉，正文里留半句话。
    if (text.trim()) yield { type: "think", text, step };

    messages.push({
      role: "assistant", content: text,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
    });

    // 协议硬约束：assistant(tool_calls) 之后，**每一个** tool_call_id 都要有一条 tool 消息，
    // 而且它们必须**连续**（中间不能插 user）。所以这一圈只做两件事：跑工具、回填 tool。
    const nudges: string[] = [];
    for (const c of calls) {
      yield { type: "tool", id: c.id, name: c.name, args: c.args };
      const t0 = Date.now();
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.args || "{}") as Record<string, unknown>; }
      catch { args = {}; }
      let out = "";
      let ok = false;
      try {
        const res = await deps.tools.run(c.name, args);
        ok = res.ok;
        out = res.output;
      } catch (e) {
        // 工具自己炸了也要**回一条 tool 消息** —— 少一条就是 400（实测踩到）
        ok = false;
        out = "E_TOOL_FAILED: " + String((e as Error).message ?? e).slice(0, 300);
      }
      if (out.length > cap) out = out.slice(0, cap) + `…（已截断，共 ${out.length} 字符）`;
      noteToolResult(guard, c.name, ok, out);
      yield { type: "tool_result", id: c.id, name: c.name, result: out, ms: Date.now() - t0 };
      messages.push({ role: "tool", tool_call_id: c.id, content: out });
      // C-3：错误当作输入。**先攒着**，等所有 tool 消息都回填完再发。
      if (guards && (!ok || isError(out))) {
        if (canRetry(guard, c.name, out)) {
          yield { type: "notice", text: `${c.name} 报错，让它补一次（C-3）` };
          nudges.push(retryNudge(c.name, out, false));
        } else {
          yield { type: "notice", text: `${c.name} 又失败了，这一次不再补` };
        }
      }
    }
    // 到这里 tool 序列已经完整；现在才允许插一条 user 提醒
    for (const n of nudges) messages.push({ role: "user", content: n });
    yield { type: "phase", step, note: `第 ${step} 轮工具完成，继续` };
  }
  // 撞上限不是「出错」，是「预算用完了」：上层据此做收尾，而不是硬截断。
  yield { type: "error", message: `E_MAX_STEPS: 超过 ${maxSteps} 轮，停止（避免空转）` };
}
