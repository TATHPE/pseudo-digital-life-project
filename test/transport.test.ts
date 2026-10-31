import { test } from "node:test";
import assert from "node:assert/strict";
import { createTransport, createChatTransport, routerFrom, assertAllLoopback, isLoopback, hostOf, EndpointError } from "../src/transport.ts";
import { createRouter, PrivacyError, type RoleConfig } from "../src/provider.ts";
import { at } from "../src/assert.ts";

const CFG: Partial<Record<any, RoleConfig>> = {
  embed:    { kind: "local", provider: "ollama", model: "bge-m3" },
  route:    { kind: "local", provider: "ollama", model: "qwen2.5:1.5b" },
  extract:  { kind: "local", provider: "ollama", model: "qwen2.5:1.5b" },
  salience: { kind: "local", provider: "ollama", model: "qwen2.5:1.5b" },
  conflict: { kind: "local", provider: "ollama", model: "qwen2.5:1.5b" },
  express:  { kind: "cloud", provider: "anthropic", model: "claude-sonnet-4-6" },
};

/** 记录被调用的 fetch；返回固定 JSON */
function stubFetch(payload: unknown, ok = true) {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok, status: ok ? 200 : 400, json: async () => payload, text: async () => JSON.stringify(payload) } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("本地角色：请求落在回环，span 记录 host 与字节", async () => {
  const { impl, calls } = stubFetch({ message: { content: "嗯。" }, prompt_eval_count: 10, eval_count: 2 });
  const t = createTransport(createRouter(CFG), { fetchImpl: impl });
  const r = await t.complete("route", [{ role: "user", content: "在吗" }], { containsMemory: false, purpose: "intent" });
  assert.equal(r.text, "嗯。");
  assert.equal(at(calls, 0).url, "http://127.0.0.1:11434/api/chat");
  assert.equal(t.spans().length, 1);
  assert.equal(at(t.spans(), 0).host, "127.0.0.1");
  assert.ok(at(t.spans(), 0).bytesOut > 0);
  assert.deepEqual(assertAllLoopback(t.spans()), []);
});

test("隐私闸门：cloud 角色 + 记忆原文 → 抛错，且**一次请求都没发**", async () => {
  const { impl, calls } = stubFetch({ content: [{ text: "不该发生" }] });
  const t = createTransport(createRouter(CFG), { fetchImpl: impl });
  await assert.rejects(
    () => t.complete("express", [{ role: "user", content: "你记得吗" }], { containsMemory: true }),
    (e: any) => e instanceof PrivacyError,
  );
  assert.equal(calls.length, 0, "守卫必须在 fetch 之前");
  assert.equal(t.spans().length, 0);
});

test("本地角色 + 记忆原文 → 放行（这是设计允许的路径）", async () => {
  const { impl } = stubFetch({ message: { content: "ok" } });
  const t = createTransport(createRouter(CFG), { fetchImpl: impl });
  const r = await t.complete("extract", [{ role: "user", content: "抽取：你提到衰减" }], { containsMemory: true });
  assert.equal(r.text, "ok");
});

test("endpoint 与 kind 不一致 → E_BAD_ENDPOINT", async () => {
  const { impl } = stubFetch({ message: { content: "x" } });
  const bad = { ...CFG, extract: { ...CFG.extract!, baseUrl: "https://api.openai.com" } } as any;
  const t = createTransport(createRouter(bad), { fetchImpl: impl });
  await assert.rejects(() => t.complete("extract", [{ role: "user", content: "x" }], { containsMemory: false }),
    (e: any) => e instanceof EndpointError);
});

test("embed 走 /api/embed 批量，返回条数与输入一致", async () => {
  const { impl, calls } = stubFetch({ embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]] });
  const t = createTransport(createRouter(CFG), { fetchImpl: impl });
  const vs = await t.embed("embed", ["记忆衰减", "两阶段检索"], { containsMemory: true });
  assert.equal(vs.length, 2);
  assert.equal(at(vs, 0).length, 3);
  assert.equal(at(calls, 0).url, "http://127.0.0.1:11434/api/embed");
  assert.deepEqual(at(calls, 0).body.input, ["记忆衰减", "两阶段检索"]);
});

test("提供方报错 → span.ok=false 且抛出", async () => {
  const { impl } = stubFetch({ error: "boom" }, false);
  const t = createTransport(createRouter(CFG), { fetchImpl: impl });
  await assert.rejects(() => t.complete("route", [{ role: "user", content: "x" }], { containsMemory: false }), /E_PROVIDER: 400/);
  assert.equal(t.spans().length, 1);
  assert.equal(at(t.spans(), 0).ok, false);
});

test("hostOf / isLoopback 的边界", () => {
  assert.equal(hostOf("http://127.0.0.1:11434/api/chat"), "127.0.0.1");
  assert.ok(isLoopback("http://localhost:11434"));
  assert.ok(isLoopback("http://[::1]:11434"));
  assert.ok(!isLoopback("https://api.anthropic.com"));
  assert.ok(!isLoopback("not a url"));
});

test("流式调用会把真实 usage 抛出来（记帐用，不估）", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"在"},"index":0}]}',
    "",
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":37,"completion_tokens":5}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const body = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); },
  });
  const seen: any[] = [];
  const stub = (async () => ({ ok: true, status: 200, body } as any)) as any;
  const t = createChatTransport(createRouter(CFG), {
    fetchImpl: stub,
    onUsage: (u) => seen.push(u),
  });
  const out: string[] = [];
  for await (const ev of t.chat("express", [{ role: "user", content: "hi" }], {
    containsMemory: false, purpose: "t", maxTokens: 16,
  })) if (ev.type === "delta") out.push(ev.text);

  assert.equal(out.join(""), "在");
  assert.equal(seen.length, 1, "应该回调一次");
  assert.deepEqual(
    { role: seen[0].role, provider: seen[0].provider, in: seen[0].inTokens, out: seen[0].outTokens },
    { role: "express", provider: "anthropic", in: 37, out: 5 },   // provider 跟着角色配置走
  );
});

test("流里没有 usage 时不编造：onUsage 一次都不调", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}' + "\n\ndata: [DONE]\n\n";
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } });
  let called = 0;
  const t = createChatTransport(createRouter(CFG), {
    fetchImpl: (async () => ({ ok: true, status: 200, body } as any)) as any,
    onUsage: () => { called++; },
  });
  for await (const _ of t.chat("express", [{ role: "user", content: "hi" }], { containsMemory: false })) { /* drain */ }
  assert.equal(called, 0, "拿不到真实 token 就不写账（否则「今日花费」是假读数）");
});

test("云端失败 → 本地兜底，且必须留一条 notice（不假装是云端在答）", async () => {
  const { withFallback } = await import("../src/agent.ts");
  // primary：立刻抛（模拟 401）
  async function* broken() { throw new Error("E_PROVIDER: 401"); yield 0 as never; }
  async function* local() { yield { type: "delta" as const, text: "本地回答" }; yield { type: "done" as const, finish: "stop" }; }

  const got: any[] = [];
  for await (const ev of withFallback(() => broken(), () => local())) got.push(ev);
  assert.equal(got[0].type, "notice", "先告诉用户换成本地了");
  assert.match(String(got[0].text), /本地/);
  assert.equal(got.filter((e) => e.type === "delta").map((e) => e.text).join(""), "本地回答");
});

test("已经吐过字就不再切换（否则两段话会拼成一句假话）", async () => {
  const { withFallback } = await import("../src/agent.ts");
  async function* half() { yield { type: "delta" as const, text: "说到一半" }; throw new Error("boom"); }
  async function* local() { yield { type: "delta" as const, text: "不该出现" }; }
  const got: any[] = [];
  await assert.rejects(async () => {
    for await (const ev of withFallback(() => half(), () => local())) got.push(ev);
  }, /boom/);
  assert.equal(got.map((e) => e.text).join(""), "说到一半");
});

test("没有本地兜底时，错误原样抛（不吞）", async () => {
  const { withFallback } = await import("../src/agent.ts");
  async function* broken() { throw new Error("E_PROVIDER: 401"); yield 0 as never; }
  await assert.rejects(async () => {
    for await (const _ of withFallback(() => broken(), null)) { /* drain */ }
  }, /401/);
});

// ── 闸门抓到的真 bug：Ollama 的 tool arguments 是对象，不是 JSON 字符串 ──────
test("ollama 流式：function.arguments 是对象时也要还原成合法 JSON", async () => {
  const { createChatTransport } = await import("../src/transport.ts");
  const ndjson = [
    JSON.stringify({ message: { content: "", tool_calls: [{ function: { name: "time_now", arguments: {} } }] } }),
    JSON.stringify({ message: { content: "" }, done: true, done_reason: "stop" }),
  ].join(String.fromCharCode(10)) + String.fromCharCode(10);

  const fetchImpl = (async () => new Response(ndjson, { status: 200, headers: { "content-type": "application/x-ndjson" } })) as never;
  const t = createChatTransport(routerFrom({ ...CFG, night: CFG.route } as never), { fetchImpl });
  const events = [];
  for await (const ev of t.chat("route" as never, [{ role: "user", content: "几点了" }], { containsMemory: false, purpose: "t" })) events.push(ev);

  const calls = events.find((e) => e.type === "tool_calls") as { calls: Array<{ name: string; args: string }> } | undefined;
  assert.ok(calls, "应当解析出 tool_calls");
  assert.equal(calls!.calls[0]!.name, "time_now");
  assert.equal(calls!.calls[0]!.args, "{}", "对象要序列化成 JSON 文本，而不是 [object Object]");
  assert.doesNotThrow(() => JSON.parse(calls!.calls[0]!.args));
});
