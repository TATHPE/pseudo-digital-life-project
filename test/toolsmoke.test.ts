import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCalls, runToolSmoke, SMOKE_CASES, type SmokeCase } from "../src/toolsmoke.ts";
import type { ChatEvent } from "../src/transport.ts";

const ALLOWED = new Set(["time_now", "fs_read", "memory_search", "fs_list"]);

const C_TIME: SmokeCase = SMOKE_CASES[0]!;
const C_READ: SmokeCase = SMOKE_CASES[1]!;
const C_SEARCH: SmokeCase = SMOKE_CASES[2]!;

// ── 校验器：这是整道闸的核心，必须单独钉死 ──────────────────

test("checkCalls：挑对工具 + 合法 JSON + 必需参数 → 通过", () => {
  assert.deepEqual(checkCalls([{ name: "time_now", args: "{}" }], ALLOWED, C_TIME), { ok: true });
  assert.deepEqual(checkCalls([{ name: "fs_read", args: '{"path":"workspace/smoke-probe.txt"}' }], ALLOWED, C_READ), { ok: true });
  assert.deepEqual(checkCalls([{ name: "memory_search", args: '{"q":"衰减","k":3}' }], ALLOWED, C_SEARCH), { ok: true });
});

test("checkCalls：不调工具（只会说人话）→ E_NO_CALL", () => {
  assert.equal(checkCalls([], ALLOWED, C_TIME).code, "E_NO_CALL");
});

test("checkCalls：编了个不存在的工具 → E_UNKNOWN_TOOL", () => {
  assert.equal(checkCalls([{ name: "read_file", args: "{}" }], ALLOWED, C_READ).code, "E_UNKNOWN_TOOL");
});

test("checkCalls：参数不是 JSON（模型把参数写成散文/带反斜杠）→ E_BAD_ARGS", () => {
  assert.equal(checkCalls([{ name: "fs_read", args: "path=workspace/x.txt" }], ALLOWED, C_READ).code, "E_BAD_ARGS");
  assert.equal(checkCalls([{ name: "fs_read", args: '{"path":' }], ALLOWED, C_READ).code, "E_BAD_ARGS");
  assert.equal(checkCalls([{ name: "fs_read", args: '["workspace/x.txt"]' }], ALLOWED, C_READ).code, "E_BAD_ARGS");
});

test("checkCalls：挑错工具（问时间却去读文件）→ E_WRONG_TOOL", () => {
  const v = checkCalls([{ name: "fs_list", args: '{"path":"workspace"}' }], ALLOWED, C_TIME);
  assert.equal(v.code, "E_WRONG_TOOL");
});

test("checkCalls：参数缺了 / 内容不对 → E_MISSING_ARG / E_BAD_ARG_VALUE", () => {
  assert.equal(checkCalls([{ name: "fs_read", args: "{}" }], ALLOWED, C_READ).code, "E_MISSING_ARG");
  assert.equal(checkCalls([{ name: "fs_read", args: '{"path":"workspace/other.txt"}' }], ALLOWED, C_READ).code, "E_BAD_ARG_VALUE");
  assert.equal(checkCalls([{ name: "memory_search", args: '{"q":"向量"}' }], ALLOWED, C_SEARCH).code, "E_BAD_ARG_VALUE");
});

test("checkCalls：空参数值也算缺失（模型常吐 path: \"\"）", () => {
  assert.equal(checkCalls([{ name: "fs_read", args: '{"path":""}' }], ALLOWED, C_READ).code, "E_MISSING_ARG");
});

// ── 跑批：假模型，验统计与判定 ──────────────────────────────

const schema = [...ALLOWED].map((n) => ({ type: "function" as const, function: { name: n } }));

/** 一个"什么都不会"的模型：只吐文字 */
async function* mute(): AsyncGenerator<ChatEvent, void, void> {
  yield { type: "delta", text: "现在是下午三点。" };
  yield { type: "done", finish: "stop" };
}

/** 一个"会调工具"的模型：按提示挑工具 */
async function* good(messages: unknown[]): AsyncGenerator<ChatEvent, void, void> {
  const text = String((messages[0] as { content: string }).content);
  const call = text.includes("几点")
    ? { id: "1", name: "time_now", args: "{}" }
    : text.includes("读一下")
      ? { id: "2", name: "fs_read", args: '{"path":"workspace/smoke-probe.txt"}' }
      : { id: "3", name: "memory_search", args: '{"q":"衰减"}' };
  yield { type: "tool_calls", calls: [call] };
  yield { type: "done", finish: "tool_calls" };
}

/** 一个"会挑工具但参数写错"的模型：读文件那条永远写成 a.txt（弱模型的典型错法） */
let flip = 0;
async function* sloppy(messages: unknown[]): AsyncGenerator<ChatEvent, void, void> {
  const text = String((messages[0] as { content: string }).content);
  flip++;
  if (text.includes("读一下")) {
    yield { type: "tool_calls", calls: [{ id: "2", name: "fs_read", args: '{"path":"a.txt"}' }] };
  } else if (text.includes("几点")) {
    yield { type: "tool_calls", calls: [{ id: "1", name: "time_now", args: "{}" }] };
  } else {
    yield { type: "tool_calls", calls: [{ id: "3", name: "memory_search", args: '{"q":"衰减"}' }] };
  }
  yield { type: "done", finish: "tool_calls" };
}

test("runToolSmoke：会调工具的模型 → 100%，pass", async () => {
  const r = await runToolSmoke({ chat: (m) => good(m), schema, n: 2, model: "fake-good" });
  assert.equal(r.total, 6);
  assert.equal(r.passed, 6);
  assert.equal(r.pass, true);
  assert.deepEqual(r.byCode, {});
  assert.equal(r.perCase.time!.passed, 2);
});

test("runToolSmoke：只会说话的模型 → 0%，不过，失败全是 E_NO_CALL", async () => {
  const r = await runToolSmoke({ chat: () => mute(), schema, n: 2, model: "fake-mute" });
  assert.equal(r.passed, 0);
  assert.equal(r.pass, false);
  assert.deepEqual(r.byCode, { E_NO_CALL: 6 });
});

test("runToolSmoke：一个用例永远写错参数 → 67%，低于 70% 线，不过", async () => {
  flip = 0;
  const r = await runToolSmoke({ chat: (m) => sloppy(m), schema, n: 2, model: "fake-sloppy" });
  assert.ok(r.rate < 0.7, `rate=${r.rate}`);
  assert.equal(r.pass, false);
  assert.ok((r.byCode.E_BAD_ARG_VALUE ?? 0) >= 1, JSON.stringify(r.byCode));
});

test("runToolSmoke：chat 抛错也计数，不把异常吞成通过", async () => {
  async function* boom(): AsyncGenerator<ChatEvent, void, void> {
    throw new Error("E_PROVIDER: 404 model not found");
    yield { type: "done", finish: "x" };
  }
  const r = await runToolSmoke({ chat: () => boom(), schema, n: 1, model: "fake-boom" });
  assert.equal(r.pass, false);
  assert.equal(r.byCode.E_CALL, 3);
});
