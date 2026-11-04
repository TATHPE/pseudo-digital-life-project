import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { appendEvent, newEventId } from "../src/journal.ts";
import { startup } from "../src/startup.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-start-"));

test("久未写入 + 非正常关闭 → 记 outage + 写一条叙事记忆", () => {
  const home = H(), inbox = join(home, "inbox");
  const old = new Date("2026-10-28T02:14:00Z");
  appendEvent(inbox, { v: 1, id: newEventId(), ts: old.toISOString(), kind: "utterance", actor: "user", payload: { text: "睡前一句" } });
  const d = openDb(join(home, "m.db"));
  const r = startup({ db: d.db, inboxDir: inbox, home, cleanLastShutdown: false, now: new Date("2026-10-28T07:30:00Z") });
  assert.ok(r.outage, "应检测到缺口");
  assert.equal(r.recorded, true);
  const mem = d.db.prepare("SELECT text,kind,salience FROM memories WHERE source_kind='agent'").get() as any;
  assert.match(mem.text, /断电|关机|进程被杀/);
  assert.match(mem.text, /5 小时 16 分/);
  assert.equal(mem.kind, "episode");
  assert.ok(mem.salience >= 0.5);
});

test("幂等：同一个 outage 第二次启动不重复记", () => {
  const home = H(), inbox = join(home, "inbox");
  appendEvent(inbox, { v: 1, id: newEventId(), ts: "2026-10-28T02:14:00Z", kind: "utterance", actor: "user", payload: {} });
  const d = openDb(join(home, "m.db"));
  const now = new Date("2026-10-28T07:30:00Z");
  const a = startup({ db: d.db, inboxDir: inbox, home, cleanLastShutdown: false, now });
  const b = startup({ db: d.db, inboxDir: inbox, home, cleanLastShutdown: false, now });
  assert.equal(a.recorded, true);
  assert.equal(b.recorded, false, "第二次不该重复记");
  assert.equal((d.db.prepare("SELECT count(*) c FROM outages").get() as any).c, 1);
  assert.equal((d.db.prepare("SELECT count(*) c FROM memories WHERE source_kind='agent'").get() as any).c, 1);
});

test("同一段断片又醒一次：只推结束时间，不写第二条记忆（2026-11-04 实测的重复来源）", () => {
  const home = H(), inbox = join(home, "inbox");
  // 一次断片之后**没有任何新对话**就又被打断：from_ts 相同，to_ts 每次不同
  appendEvent(inbox, { v: 1, id: newEventId(), ts: "2026-10-28T02:14:00Z", kind: "utterance", actor: "user", payload: {} });
  const d = openDb(join(home, "m.db"));
  const a = startup({ db: d.db, inboxDir: inbox, home, cleanLastShutdown: false, now: new Date("2026-10-28T07:30:00Z") });
  const b = startup({ db: d.db, inboxDir: inbox, home, cleanLastShutdown: false, now: new Date("2026-10-28T08:10:00Z") });
  assert.equal(a.recorded, true);
  assert.equal(b.recorded, false, "同一段空档不该再记一条");
  assert.equal((d.db.prepare("SELECT count(*) c FROM memories WHERE source_kind='agent'").get() as any).c, 1);
  const o = d.db.prepare("SELECT from_ts,to_ts FROM outages").all() as Array<{ from_ts: string; to_ts: string }>;
  assert.equal(o.length, 1, "outages 也该只有一行");
  assert.equal(o[0]!.to_ts, "2026-10-28T08:10:00.000Z", "结束时间要推到最近一次醒来");
});

test("正常关闭：不报断电，但仍补算衰减", () => {
  const home = H(), inbox = join(home, "inbox");
  appendEvent(inbox, { v: 1, id: newEventId(), ts: "2026-10-20T02:14:00Z", kind: "utterance", actor: "user", payload: {} });
  const d = openDb(join(home, "m.db"));
  d.db.prepare(`INSERT INTO memories(layer,kind,text,text_bigram,last_decay_at,created_at,updated_at)
    VALUES('narrative','episode','旧事','旧 事','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z')`).run();
  const r = startup({ db: d.db, inboxDir: inbox, home, cleanLastShutdown: true, now: new Date("2026-10-28T09:00:00Z") });
  assert.equal(r.outage?.kind, "restart");
  assert.ok(r.decayed >= 1, "应补算衰减");
  const w = (d.db.prepare("SELECT weight FROM memories").get() as any).weight;
  assert.ok(w < 0.35, "57 天没动应已跌出 active：" + w);
});

test("首次启动（没有任何事件）不报 outage", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const r = startup({ db: d.db, inboxDir: join(home, "inbox"), home, cleanLastShutdown: false, now: new Date() });
  assert.equal(r.outage, null);
});
