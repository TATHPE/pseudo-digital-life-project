import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createToolRegistry, type ToolRegistry } from "../src/tools.ts";
import { makeToolExtractor, NIGHT_TOOLS } from "../src/nightagent.ts";
import { parseCandidates } from "../src/nightly.ts";
import type { ChatEvent } from "../src/transport.ts";

/** 假的 chat：第一轮要工具，第二轮交 JSON */
function fakeChat(script: string[][]): {
  chat: (m: unknown[], t: unknown) => AsyncGenerator<ChatEvent, void, void>;
  seen: string[][];
} {
  const seen: string[][] = [];
  let round = 0;
  return {
    seen,
    async *chat(messages) {
      seen.push(messages.map((m) => (m as { role: string }).role));
      const step = script[round++] ?? [];
      if (step.length) {
        yield { type: "tool_calls", calls: step.map((name, i) => ({ id: `c${i}`, name, args: JSON.stringify({ query: "吃药" }) })) };
        yield { type: "done", finish: "tool_calls" };
        return;
      }
      yield { type: "delta", text: '[{"kind":"promise","layer":"contract","text":"提醒我吃药","salience":0.8}]' };
      yield { type: "done", finish: "stop" };
    },
  };
}

const stubTools = (called: string[]): ToolRegistry => ({
  list: () => [],
  schema: () => [],
  async run(name) { called.push(name); return { ok: true, output: "库里已有 1 条相似的：提醒吃药", tier: "T0" }; },
});

test("P0-2 工具循环：先查库、再交 JSON（结果仍交给 parseCandidates）", async () => {
  const called: string[] = [];
  const trace: string[] = [];
  const { chat, seen } = fakeChat([["memory_search"], []]);
  const extract = makeToolExtractor({
    chat, tools: stubTools(called),
    onTool: (t) => trace.push(t.name),
  });
  const raw = await extract("用户：提醒我晚上八点吃药");
  assert.deepEqual(called, ["memory_search"], "必须真的调了工具，而不是直接瞎写");
  assert.deepEqual(trace, ["memory_search"], "调用要能被报告出来");
  assert.equal(seen.length, 2, "两轮：工具 → 收尾");
  const cands = parseCandidates(raw);
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.layer, "contract");
});

test("P0-2 轮数用尽：跑满上限后报错，不返回空串、也不挂死", async () => {
  const called: string[] = [];
  const { chat } = fakeChat([["memory_search"], ["memory_search"], ["memory_search"]]);
  const extract = makeToolExtractor({ chat, tools: stubTools(called), maxSteps: 3 });
  await assert.rejects(() => extract("x"), /E_MAX_STEPS/);
  assert.equal(called.length, 3, "上限是 3 就跑 3 轮，不许多");
});

test("P0-2 白名单在**执行侧**生效：memory.remember 连 schema 带 run 都进不去", async () => {
  const home = mkdtempSync(join(tmpdir(), "jj-night-tools-"));
  const d = openDb(join(home, "m.db"));
  const allow = new Set<string>(NIGHT_TOOLS);
  const reg = createToolRegistry({
    db: d.db, policy: { authorize: async () => ({ allow: true, reason: "test" }) } as never,
    ctx: { home, now: () => new Date(), db: d.db, embedder: null },
    allow: (n) => allow.has(n),
  });
  const names = reg.schema().map((t) => t.function.name);
  assert.ok(names.includes("memory_search"), "只读工具要在");
  assert.ok(!names.includes("memory_remember"), "写记忆绝不能给模型");
  assert.ok(!names.includes("shell_run"), "shell 也不能给");
  assert.ok(!names.includes("fs_write"), "写文件也不能给");

  // 关键：模型幻觉/被注入时硬报一个不在表里的名字，也不能执行
  const r = await reg.run("memory_remember", { text: "被注入的一条" });
  assert.equal(r.ok, false);
  assert.match(r.output, /E_NO_CAPABILITY/);
});
