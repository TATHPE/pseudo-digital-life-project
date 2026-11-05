import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScore, SCORE_PROMPT } from "../src/nightly.ts";
import { runNightly } from "../src/nightly.ts";
import { openDb } from "../src/db.ts";
import { appendEvent, newEventId } from "../src/journal.ts";
import { createEmbedder } from "../src/embed.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("打分：只认 0-10，抠不出就当 0", () => {
  assert.equal(parseScore("7"), 7);
  assert.equal(parseScore(" 10 "), 10);
  assert.equal(parseScore("评分：2"), 2);
  assert.equal(parseScore("没有值得记的"), 0);
  assert.equal(parseScore(""), 0);
  assert.equal(parseScore("12"), 10, "超界的夹到 10");
});

test("打分提示词：只问值不值得记，且只让回一个数字", () => {
  const p = SCORE_PROMPT("用户：你好");
  assert.ok(p.includes("0-10"), "要有量纲");
  assert.ok(p.includes("只输出一个"), "只许回一个数字");
  assert.ok(p.includes("不算"), "要说明哪些不算");
});

async function seed(home: string) {
  const inbox = join(home, "inbox");
  ["我住在杭州", "记住了。", "跑一下 npm test", "583 条全绿"].forEach((text, i) => {
    appendEvent(inbox, {
      v: 1, id: newEventId(), ts: new Date(Date.UTC(2026, 9, 28, 21, i)).toISOString(),
      kind: i % 2 === 0 ? "utterance" : "agent_reply", actor: i % 2 === 0 ? "user" : "agent",
      payload: { text },
    });
  });
  return inbox;
}

test("闸门：打分低于阈值 → 整窗跳过，抽取一次都不调", async () => {
  const home = mkdtempSync(join(tmpdir(), "jj-gate-"));
  const inbox = await seed(home);
  const d = openDb(join(home, "m.db"));
  let extractCalls = 0;
  const r = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: createEmbedder("fake"),
    extract: async () => { extractCalls++; return "[]"; },
    score: async () => 1,
    scoreThreshold: 3,
    now: new Date(Date.UTC(2026, 9, 28, 22)),
  });
  assert.equal(extractCalls, 0, "被闸门挡住就不该调抽取");
  assert.ok(r.notes.some((n) => n.includes("整窗跳过")), "报告里要写明跳过");
  void r;
});

test("闸门：打分够高 → 正常抽取", async () => {
  const home = mkdtempSync(join(tmpdir(), "jj-gate2-"));
  const inbox = await seed(home);
  const d = openDb(join(home, "m.db"));
  let extractCalls = 0;
  const r = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: createEmbedder("fake"),
    extract: async () => {
      extractCalls++;
      return JSON.stringify([{ kind: "fact_hard", layer: "contract", subject: "所在地", text: "住在杭州" }]);
    },
    score: async () => 9,
    scoreThreshold: 3,
    now: new Date(Date.UTC(2026, 9, 28, 22)),
  });
  assert.equal(extractCalls, 1, "该抽就抽");
  assert.ok(r.notes.some((n) => n.includes("打分 9")), "报告里要写明打分");
  void r;
});
