import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agent.ts";

/**
 * 这个文件钉的是一条**协议级**约束（踩过真的 400）：
 *
 *   An assistant message with 'tool_calls' must be followed by tool messages
 *   responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)
 *
 * 触发条件很具体：模型一次回多个 tool_calls，其中某个失败 → 旧代码**当场**插一条
 * `user` 提醒 → 后面的 tool 消息被挤到 user 之后 → 下一次请求 400。
 */

type Msg = { role: string; content?: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string };

/** 收集每次 chat 收到的 messages（深拷贝），用来断言序列 */
function rig(opts: { calls: Array<{ id: string; name: string; args?: string }>; fail?: string[]; onRun?: (name: string) => void }) {
  const seen: Msg[][] = [];
  let round = 0;
  const chat = async function* (messages: Msg[]) {
    seen.push(JSON.parse(JSON.stringify(messages)));
    round++;
    if (round === 1) {
      yield { type: "delta", text: "我先查两样东西" };
      yield { type: "tool_calls", calls: opts.calls.map((c) => ({ id: c.id, name: c.name, args: c.args ?? "{}" })) };
      yield { type: "done", finish: "tool_calls" };
      return;
    }
    yield { type: "delta", text: "好了" };
    yield { type: "done", finish: "stop" };
  };
  const tools = {
    schema: () => [],
    list: () => [],
    async run(name: string) {
      opts.onRun?.(name);
      if (opts.fail?.includes(name)) throw new Error("boom");
      return { ok: true, output: "ok:" + name, tier: "T0" };
    },
  } as never;
  return { seen, deps: { chat, tools, maxSteps: 3, guards: false } as never };
}

test("多个 tool_calls：每个都有对应的 tool 消息，且连续（中间不插 user）", async () => {
  const { seen, deps } = rig({ calls: [{ id: "a1", name: "t_one" }, { id: "a2", name: "t_two" }, { id: "a3", name: "t_three" }] });
  for await (const _ of runAgent(deps, "sys", "把三样都查一下")) { /* 消费掉 */ }
  assert.equal(seen.length, 2, "应该请求两次（工具一轮 + 收尾一轮）");
  const second = seen[1]!;
  // 找 assistant(tool_calls) 的位置
  const ai = second.findIndex((m) => m.role === "assistant" && m.tool_calls);
  assert.ok(ai >= 0, "第二轮请求里要有那条 assistant(tool_calls)");
  const ids = second[ai]!.tool_calls!.map((c) => c.id);
  const after = second.slice(ai + 1, ai + 1 + ids.length);
  assert.deepEqual(after.map((m) => m.role), ids.map(() => "tool"), "assistant 之后必须紧跟同样数量的 tool");
  assert.deepEqual(after.map((m) => m.tool_call_id), ids, "每个 tool_call_id 都要被回填");
});

test("工具抛异常也回填 tool 消息（少一条就是 400）", async () => {
  const { seen, deps } = rig({ calls: [{ id: "b1", name: "t_ok" }, { id: "b2", name: "t_boom" }], fail: ["t_boom"] });
  for await (const _ of runAgent(deps, "sys", "试试两个")) { /* 消费掉 */ }
  const second = seen[1]!;
  const ai = second.findIndex((m) => m.role === "assistant" && m.tool_calls);
  const tools = second.slice(ai + 1).filter((m) => m.role === "tool");
  assert.equal(tools.length, 2, "两个 tool 消息一条都不能少");
  const boom = tools.find((m) => m.tool_call_id === "b2")!;
  assert.match(String(boom.content), /E_TOOL_FAILED/, "失败也要有内容，不能空着");
});

test("失败后的 user 提醒放在所有 tool 消息之后", async () => {
  const { seen, deps } = rig({ calls: [{ id: "c1", name: "t_boom" }, { id: "c2", name: "t_ok" }], fail: ["t_boom"] });
  const events: string[] = [];
  for await (const ev of runAgent(deps, "sys", "先读再改，改完跑一次验证")) {
    events.push(ev.type);
  }
  const second = seen[1]!;
  const ai = second.findIndex((m) => m.role === "assistant" && m.tool_calls);
  const tail = second.slice(ai + 1);
  const firstUser = tail.findIndex((m) => m.role === "user");
  const lastTool = tail.map((m) => m.role).lastIndexOf("tool");
  assert.ok(lastTool >= 0, "要有 tool 消息");
  if (firstUser >= 0) {
    assert.ok(firstUser > lastTool, "user 提醒必须在所有 tool 消息之后（旧实现在这里踩了 400）");
  }
  assert.ok(events.includes("tool_result"), "要吐出 tool_result");
});
