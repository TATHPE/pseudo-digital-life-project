import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/agent.ts";

/** 一直要工具、从不停下来的模型：用来钉"步数预算用完时到底发生什么" */
function loopRig() {
  let round = 0;
  const chat = async function* () {
    round++;
    yield { type: "delta", text: `第 ${round} 步` };
    yield { type: "tool_calls", calls: [{ id: `c${round}`, name: "memory_search", args: "{}" }] };
    yield { type: "done", finish: "tool_calls" };
  };
  const tools = {
    schema: () => [],
    list: () => [],
    async run() { return { ok: true, output: "ok", tier: "T0" }; },
  };
  return { chat, tools };
}

test("步数预算用完：明确报 E_MAX_STEPS，而不是静默停下", async () => {
  const { chat, tools } = loopRig();
  const events: Array<{ type: string; message?: string }> = [];
  for await (const ev of runAgent({ chat: chat as never, tools: tools as never, maxSteps: 3 }, "sys", "干点活")) events.push(ev as never);
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "要报错");
  assert.match(String(err!.message), /E_MAX_STEPS/, "要带明确的码，上层据此收尾");
  assert.match(String(err!.message), /3 轮/, "要说清是多少轮");
});

test("面板：撞上限要收尾、换步要保留最长的一段", () => {
  const server = readFileSync(join(process.cwd(), "src/web/server.ts"), "utf8");
  // 收尾：不再把半句话直接存下来
  assert.ok(server.includes("if (hitCap) {"), "要识别撞上限");
  assert.ok(server.includes("步数预算用完了"), "要告诉用户发生了什么");
  assert.ok(server.includes("purpose: \"wrap-up\""), "要用一次无工具调用做总结");
  // 保留最长段：最后一步常常只是碎片
  assert.ok(server.includes("let bestFull"), "要记最长的一段");
  assert.ok(server.includes("if (full.length > bestFull.length) bestFull = full;"), "换步时比较长度");
  assert.ok(server.includes("if (bestFull.length > full.length) full = bestFull;"), "存之前哪段长用哪段");
});

test("步数是预算不是墙：默认放宽，且能被 JJ_MAX_STEPS 覆盖", () => {
  const server = readFileSync(join(process.cwd(), "src/web/server.ts"), "utf8");
  assert.ok(server.includes("JJ_MAX_STEPS"), "要能覆盖");
  assert.ok(server.includes("mode === \"work\" ? (supOn ? 60 : 45)"), "工作模式放宽到 45/60");
  assert.ok(!server.includes("supOn ? 24 : 20"), "旧的 20 步上限要换掉");
});
