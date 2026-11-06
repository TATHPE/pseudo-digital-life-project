import { test } from "node:test";
import assert from "node:assert/strict";
import { openSession, touchSession, closeSession, listSessions, getSession, titleFrom } from "../src/sessions.ts";
import { openDb } from "../src/db.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fresh = () => openDb(join(mkdtempSync(join(tmpdir(), "jj-sess-")), "m.db")).db;

test("会话：4 小时内的连续对话算同一次，隔久了就开新的", () => {
  const db = fresh();
  const t0 = new Date("2026-11-05T10:00:00Z");
  const a = openSession(db, t0, { title: "第一句" });
  const b = openSession(db, new Date("2026-11-05T12:00:00Z"));
  assert.equal(a.id, b.id, "两小时后还是同一次");

  const c = openSession(db, new Date("2026-11-05T20:00:00Z"));
  assert.notEqual(c.id, a.id, "隔了十小时 = 新的一次");
  assert.equal(listSessions(db).length, 2);
});

test("会话：关掉之后下一句一定开新的（哪怕只隔一分钟）", () => {
  const db = fresh();
  const t0 = new Date("2026-11-05T10:00:00Z");
  const a = openSession(db, t0);
  assert.equal(closeSession(db, a.id, t0), true);
  assert.equal(closeSession(db, a.id, t0), false, "重复关不该返回 true");

  const b = openSession(db, new Date("2026-11-05T10:01:00Z"));
  assert.notEqual(b.id, a.id);
  assert.equal(getSession(db, a.id)?.status, "closed");
});

test("会话：标题从第一句话取，太长要截断", () => {
  assert.equal(titleFrom("  在吗  "), "在吗");
  const long = "这是一句很长很长的话用来测试标题会不会被截断到二十四个字以内对吧";
  const t = titleFrom(long);
  assert.ok(t.length <= 25, "最多 24 字 + 省略号，实际 " + t.length);
  assert.ok(t.endsWith("…"));
});

test("会话：消息数会累加，列表按最近活动排序", () => {
  const db = fresh();
  const t0 = new Date("2026-11-05T10:00:00Z");
  const a = openSession(db, t0, { title: "A" });
  touchSession(db, a.id, { bump: true }, t0);
  touchSession(db, a.id, { bump: true }, t0);
  assert.equal(getSession(db, a.id)?.msgs, 2);

  const b = openSession(db, new Date("2026-11-05T20:00:00Z"), { title: "B" });
  const list = listSessions(db);
  assert.equal(list[0]!.id, b.id, "最近的排最前");
  assert.equal(list.length, 2);
  void t0;
});
