import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { appendEvent, newEventId, readEvents } from "../src/journal.ts";
import { beat, decide, findReason, inQuietHours, recentIntents, DEFAULT_PROFILE, type Prof } from "../src/heartbeat.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-beat-"));
const at = (h: number, m = 0) => new Date(2026, 9, 28, h, m, 0);   // 本地时间
const P: Prof = { ...DEFAULT_PROFILE };

function fresh() {
  const home = H();
  const d = openDb(join(home, "m.db"));
  return { home, db: d.db, inbox: join(home, "inbox") };
}

test("静默时段：跨零点（23:30–08:00）", () => {
  assert.equal(inQuietHours(23 * 60 + 40, P), true);
  assert.equal(inQuietHours(2 * 60, P), true);
  assert.equal(inQuietHours(7 * 60 + 59, P), true);
  assert.equal(inQuietHours(8 * 60, P), false);
  assert.equal(inQuietHours(12 * 60, P), false);
  assert.equal(inQuietHours(23 * 60 + 29, P), false);
});

test("没有理由 → 不发，并记录这次没发的原因", async () => {
  const { db, inbox } = fresh();
  const r = await beat({ db, inboxDir: inbox, now: at(10) });
  assert.equal(r.decision.send, false);
  assert.equal(r.decision.gate, "no_reason");
  const rows = recentIntents(db);
  assert.equal(rows[0]!.decision, "drop");
  assert.equal(rows[0]!.gate, "no_reason");
});

test("理由优先级：到期承诺 > 周年 > 沉默", () => {
  const { db } = fresh();
  remember(db, { layer: "contract", kind: "promise", text: "提醒他交房租", now: at(9) });
  db.prepare("UPDATE memories SET valid_to=? WHERE kind='promise'").run(at(10).toISOString());
  remember(db, { layer: "narrative", kind: "episode", text: "去年今天开始写鲸鲸", now: new Date(2025, 9, 28, 9) });
  const r = findReason(db, at(10), P);
  assert.equal(r.kind, "promise_due");
  assert.match(r.text, /交房租/);
});

test("到期的承诺 → 发出去，并写进 inbox（标记 proactive）", async () => {
  const { db, inbox } = fresh();
  remember(db, { layer: "contract", kind: "promise", text: "提醒他交房租", now: at(9) });
  db.prepare("UPDATE memories SET valid_to=? WHERE kind='promise'").run(at(9, 30).toISOString());
  const r = await beat({ db, inboxDir: inbox, now: at(10) });
  assert.equal(r.decision.send, true);
  assert.equal(r.decision.reason.kind, "promise_due");
  const { events } = readEvents(inbox);
  const reply = events.find((e) => e.kind === "agent_reply")!;
  assert.equal((reply.payload as any).proactive, true);
  assert.match((reply.payload as any).reason, /交房租/);
});

test("单日配额：第 4 次被 cap 拦下", async () => {
  const { db, inbox } = fresh();
  for (let i = 0; i < 3; i++) {
    db.prepare(`INSERT INTO intents(ts,decision,reason_kind,reason_text,message) VALUES(?,?,?,?,?)`)
      .run(at(9, i * 5).toISOString(), "send", "explicit", "手工造的", "你好");
  }
  remember(db, { layer: "contract", kind: "promise", text: "提醒他交房租", now: at(9) });
  db.prepare("UPDATE memories SET valid_to=? WHERE kind='promise'").run(at(9).toISOString());
  const d = decide(db, at(10), P);
  assert.equal(d.send, false);
  assert.equal(d.gate, "cap");
  assert.equal(d.ctx.sentToday, 3);
});

test("最小间隔：刚说完 10 分钟又想说 → gap 拦下；过了 90 分钟放行", () => {
  const { db } = fresh();
  remember(db, { layer: "contract", kind: "promise", text: "提醒他交房租", now: at(8) });
  db.prepare("UPDATE memories SET valid_to=? WHERE kind='promise'").run(at(8).toISOString());
  db.prepare(`INSERT INTO intents(ts,decision,reason_kind,reason_text,message) VALUES(?,?,?,?,?)`)
    .run(at(9, 50).toISOString(), "send", "explicit", "刚说过", "在吗");
  assert.equal(decide(db, at(10), P).gate, "gap");
  assert.equal(decide(db, at(11, 30), P).send, true);
});

test("静默时段优先于理由：就算承诺到期也不发", () => {
  const { db } = fresh();
  remember(db, { layer: "contract", kind: "promise", text: "提醒他交房租", now: at(8) });
  db.prepare("UPDATE memories SET valid_to=? WHERE kind='promise'").run(at(8).toISOString());
  assert.equal(decide(db, at(1), P).gate, "quiet");
});

test("沉默太久 → silence 理由（低优先级）", async () => {
  const { db, inbox } = fresh();
  appendEvent(inbox, { v: 1, id: newEventId(), ts: at(9).toISOString(), kind: "utterance", actor: "user", payload: { text: "早" } });
  // 3 天后：走 beat（从 inbox 读最后一条）
  const r = await beat({ db, inboxDir: inbox, now: new Date(2026, 9, 31, 10), dryRun: true });
  assert.equal(r.decision.reason.kind, "silence");
  assert.match(r.decision.reason.text, /3 天/);
});

test("起草失败：理由仍然成立，退回模板发出去，并记录 draftError", async () => {
  const { db, inbox } = fresh();
  remember(db, { layer: "contract", kind: "promise", text: "提醒他交房租", now: at(9) });
  db.prepare("UPDATE memories SET valid_to=? WHERE kind='promise'").run(at(9).toISOString());
  const r = await beat({ db, inboxDir: inbox, now: at(10), draft: async () => { throw new Error("E_MODEL_DOWN"); } });
  assert.equal(r.decision.send, true);
  assert.match(String(r.draftError), /E_MODEL_DOWN/);
  assert.match(String(r.message), /promise_due/);
  assert.equal(readEvents(inbox).events.length, 1, "仍然要发出去");
});
