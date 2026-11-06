/**
 * 对话界面只呈现最终回答（2026-11-03，用户要求）。
 *
 * 之前的做法是「先显示再撤回」：靠文本末尾匹配把过程那段从正文里删掉。
 * 模型多一个空格就撤不掉，正文里留半句话 —— 用户看到的就是「先一段、后又一段」。
 * 现在改成按 step 归类：某一步被判为过程，它的 delta 整段不进正文。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/agent.ts";

test("agent 的 delta / think 都要带 step（前端据此整段归类）", async () => {
  const tools = {
    schema: () => [{ type: "function", function: { name: "fs_list", description: "x", parameters: { type: "object", properties: {} } } }],
    call: async () => "ok",
    list: () => [{ name: "fs_list" }],
  };
  let turn = 0;
  const chat = async function* () {
    turn++;
    if (turn === 1) {
      yield { type: "delta", text: "我先看一眼。" };
      yield { type: "tool_calls", calls: [{ id: "c1", name: "fs_list", args: "{}" }] };
      yield { type: "done", finish: "tool_calls" };
    } else {
      yield { type: "delta", text: "结论。" };
      yield { type: "done", finish: "stop" };
    }
  };
  const seen: Array<{ type: string; step?: number; text?: string }> = [];
  for await (const ev of runAgent({ chat, tools, guards: false, maxSteps: 3 } as never, "s", "u")) seen.push(ev as never);

  const deltas = seen.filter((e) => e.type === "delta");
  assert.ok(deltas.length >= 2);
  assert.ok(deltas.every((e) => typeof e.step === "number"), "每个 delta 都要有 step");
  const think = seen.find((e) => e.type === "think");
  assert.ok(think && typeof think.step === "number", "think 也要带 step");
  // 过程那一步的 delta 与 think 的 step 必须一致（否则剔除不到）
  assert.equal(deltas[0]!.step, think!.step, "第一段 delta 与 think 同一步");
  assert.notEqual(deltas[deltas.length - 1]!.step, think!.step, "最终回答是另一步");
});

