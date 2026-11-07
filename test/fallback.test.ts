/**
 * 云端失败 → 本地顶上（2026-11-07）。
 * 三条规矩各一条测试：上下文照旧、工具不给、先留 notice。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withFallback } from "../src/agent.ts";

type Ev = { type: string; text?: string };

const collect = async (gen: AsyncGenerator<Ev, void, void>) => {
  const got: Ev[] = [];
  for await (const ev of gen) got.push(ev);
  return got;
};

test("降级：本地拿得到 messages（人格/召回/最近几轮都在）", async () => {
  const messages = [
    { role: "system", content: "【人格】你叫阿澜" },
    { role: "user", content: "我上次说的那个预算表" },
  ];
  let seen: unknown[] | null = null;
  async function* cloud() { throw new Error("E_PROVIDER: 401"); yield 0 as never; }
  async function* local(m: unknown[]) {
    seen = m;
    yield { type: "delta" as const, text: "本地说" };
  }
  const got = await collect(withFallback(messages, [{ name: "fs_read" }], (_m, _t) => cloud(), (m) => local(m)) as AsyncGenerator<Ev, void, void>);
  assert.deepEqual(seen, messages, "上下文必须原样传给本地");
  assert.equal(got.filter((e) => e.type === "delta").map((e) => e.text).join(""), "本地说");
});

test("降级：先留 notice，且文案说清「只能对话」", async () => {
  async function* cloud() { throw new Error("E_PROVIDER: 401"); yield 0 as never; }
  async function* local() { yield { type: "delta" as const, text: "嗯" }; }
  const got = await collect(withFallback([], [], () => cloud(), () => local()) as AsyncGenerator<Ev, void, void>);
  assert.equal(got[0]!.type, "notice", "第一件事是告诉用户");
  assert.match(String(got[0]!.text), /本地/);
  assert.match(String(got[0]!.text), /只能对话/);
});

test("降级：已经吐过字就不换（半句换模型 = 两个人说的话）", async () => {
  async function* half() { yield { type: "delta" as const, text: "说到一半" }; throw new Error("boom"); }
  async function* local() { yield { type: "delta" as const, text: "不该出现" }; }
  const got: Ev[] = [];
  await assert.rejects(async () => {
    for await (const ev of withFallback([], [], () => half(), () => local()) as AsyncGenerator<Ev, void, void>) got.push(ev);
  }, /boom/);
  assert.equal(got.map((e) => e.text).join(""), "说到一半");
});

test("降级：没有本地角色时错误原样抛（不假装答了）", async () => {
  async function* cloud() { throw new Error("E_NO_MODEL: 没有本地对话模型"); yield 0 as never; }
  await assert.rejects(async () => {
    await collect(withFallback([], [], () => cloud(), null) as AsyncGenerator<Ev, void, void>);
  }, /E_NO_MODEL/);
});
