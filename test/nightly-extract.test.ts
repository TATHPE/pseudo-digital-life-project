import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCandidates, verbatimGate, normalizeForQuote, EXTRACT_PROMPT } from "../src/nightly.ts";

const T = [
  "用户：以后别叫我助手，叫名字就行",
  "鲸鲸：好。",
  "用户：我一般十点以后才看消息，早上别叫我",
  "鲸鲸：记下了。",
].join(String.fromCharCode(10));

test("抽取：新模板 {facts:[…]} 也要认得（老裸数组继续兼容）", () => {
  const facts = parseCandidates(JSON.stringify({
    facts: [{ kind: "boundary", layer: "contract", subject: "称呼", text: "不要叫他助手", quote: "以后别叫我助手，叫名字就行" }],
  }));
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.quote, "以后别叫我助手，叫名字就行");

  const legacy = parseCandidates(JSON.stringify([{ kind: "episode", layer: "narrative", text: "x" }]));
  assert.equal(legacy.length, 1, "老形状也要能读");
});

test("核对闸门：quote 必须在原文里逐字出现，找不到就丢", () => {
  const ok = parseCandidates(JSON.stringify({
    facts: [{ kind: "boundary", layer: "contract", text: "不要叫他助手", quote: "以后别叫我助手，叫名字就行" }],
  }));
  const fake = parseCandidates(JSON.stringify({
    facts: [{ kind: "fact_hard", layer: "contract", text: "库里有 185 条记忆", quote: "库里有 185 条记忆" }],
  }));
  const g = verbatimGate([...ok, ...fake], T);
  assert.equal(g.kept.length, 1, "只留得住真出现的那条");
  assert.equal(g.dropped, 1);
  assert.equal(g.kept[0]!.text, "不要叫他助手");
});

test("核对闸门：空白和标点差异不算不同，省略号按段核对", () => {
  assert.equal(normalizeForQuote("以后 别叫我助手，叫名字就行"), normalizeForQuote("以后别叫我助手叫名字就行"));
  const split = parseCandidates(JSON.stringify({
    facts: [{ kind: "preference_hard", layer: "narrative", text: "她早上不想被打扰", quote: "我一般十点以后才看消息…早上别叫我" }],
  }));
  const g = verbatimGate(split, T);
  assert.equal(g.kept.length, 1, "省略号两段都在原文里，要留下");
});

test("核对闸门：没给 quote 的一律不留（宁可少记，不许编）", () => {
  const noQuote = parseCandidates(JSON.stringify({ facts: [{ kind: "episode", layer: "narrative", text: "她喜欢下雨天" }] }));
  const g = verbatimGate(noQuote, T);
  assert.equal(g.kept.length, 0);
  assert.equal(g.dropped, 1);
});

test("提示词：要求原样抄、要求 quote、没有就给空数组", () => {
  const p = EXTRACT_PROMPT("用户：你好");
  assert.ok(p.includes("原样抄"), "要写明只许抄原文");
  assert.ok(p.includes("quote"), "要有 quote 字段");
  assert.ok(p.includes("facts"), "要有 facts 模板");
  assert.ok(!p.includes(String.fromCharCode(96)), "不许出现反引号（会被拼进模板字符串）");
});

test("兼容：整批没有 quote 时跳过核对，但要在报告里说一句（不能静默放行）", async () => {
  const { runNightly } = await import("../src/nightly.ts");
  const { openDb } = await import("../src/db.ts");
  const { appendEvent, newEventId } = await import("../src/journal.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "jj-vg-"));
  const inbox = join(home, "inbox");
  ["我住在杭州", "记住了。"].forEach((text, i) => appendEvent(inbox, {
    v: 1, id: newEventId(), ts: new Date(Date.UTC(2026, 9, 28, 21, i)).toISOString(),
    kind: i % 2 === 0 ? "utterance" : "agent_reply", actor: i % 2 === 0 ? "user" : "agent",
    payload: { text },
  }));
  const d = openDb(join(home, "m.db"));
  const { createEmbedder } = await import("../src/embed.ts");
  const r = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: createEmbedder("fake"),
    extract: async () => JSON.stringify([{ kind: "fact_hard", layer: "contract", subject: "所在地", text: "住在杭州" }]),
    now: new Date(Date.UTC(2026, 9, 28, 22)),
  } as never);
  assert.ok(JSON.stringify(r).includes("跳过核对"), "报告里要写明核对被跳过");
});
