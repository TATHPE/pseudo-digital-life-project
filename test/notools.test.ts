/**
 * 本地兜底那一轮：**必须有工具就给工具、没工具就别说能动手**（2026-11-07）。
 *
 * 探针实测到的幻觉：简报写着「完全权限：能读能写能跑命令」，但调用没给 schema
 * → 模型编了一段 "npm test 结果 25/30 通过"。修法是让两边一致：
 *   · noTools → schema 为空、C-1/C-2 那两条回路关掉；
 *   · 简报里的权限行也要写"本次没有工具"（server 侧负责，这里只测 agent 这半边）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agent.ts";

const fakeTools = {
  schema: () => [{ type: "function", function: { name: "fs_read", description: "读文件", parameters: {} } }],
  list: () => [{ name: "fs_read" }],
  call: async () => ({ ok: true, out: "" }),
} as never;

/** 一个只回一句话的 chat 假实现，顺手记下它收到了什么 schema */
function fakeChat(record: { schema?: unknown; passes: number }) {
  return async function* (messages: unknown[], schema: unknown) {
    record.passes++;
    record.schema = schema;
    yield { type: "delta" as const, text: "好的" };
    yield { type: "done" as const, finish: "stop" };
  };
}

async function drain(gen: AsyncGenerator<{ type: string }, void, void>) {
  for await (const _ of gen) { /* 消费掉 */ }
}

test("有工具时：schema 照常给出去", async () => {
  const rec: { schema?: unknown; passes: number } = { passes: 0 };
  await drain(runAgent({ chat: fakeChat(rec) as never, tools: fakeTools, maxSteps: 2 }, "sys", "帮我读一下 a.txt"));
  assert.ok(Array.isArray(rec.schema) && (rec.schema as unknown[]).length > 0);
});

test("noTools：schema 必须是空数组（不给它调用的机会）", async () => {
  const rec: { schema?: unknown; passes: number } = { passes: 0 };
  await drain(runAgent({ chat: fakeChat(rec) as never, tools: fakeTools, maxSteps: 2, noTools: true }, "sys", "帮我读一下 a.txt"));
  assert.deepEqual(rec.schema, []);
});

test("noTools：不再讨计划（C-2 那两条回路关掉）", async () => {
  const rec: { schema?: unknown; passes: number } = { passes: 0 };
  const events: string[] = [];
  for await (const ev of runAgent(
    { chat: fakeChat(rec) as never, tools: fakeTools, maxSteps: 2, noTools: true },
    "sys",
    "先列个计划，然后把这个项目的测试跑一遍并告诉我数量",
  )) events.push(ev.type);
  // 一轮就收尾；没有「先列步骤」的 notice
  assert.equal(rec.passes, 1, "没有工具时不该为了讨计划多跑一轮");
  assert.equal(events.filter((t) => t === "notice").length, 0);
});

test("P15 只有一个生产者：本地这一档由 powersLine 说话", async () => {
  const { powersLine } = await import("../src/supergrant.ts");
  const noTools = powersLine("unused", "full", false, { noTools: true });
  assert.match(noTools, /本次没有工具/);
  assert.match(noTools, /只能说话/);
  // 有工具时仍然是原来的权限句（没被这条覆盖掉）
  const normal = powersLine("unused", "full", false);
  assert.doesNotMatch(normal, /本次没有工具/);
});
