/**
 * 离线补账（学 whale-card）：关机超过 24 小时，醒来补一条真记忆。
 * 之前只有简报里的一句提示 —— 事后被问"你上次什么时候醒的"，她答不上来，因为库里没这条。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { noteGap, GAP_MS } from "../src/gapnote.ts";

test("睡了 3 天 → 补一条真记忆；只写观察得到的事，不编「这期间我做了什么」", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-gap-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    const now = new Date("2026-11-03T09:00:00Z");
    const last = new Date(now.getTime() - 3 * 24 * 3600_000);

    const r = noteGap(db, now, last);
    assert.equal(r.written, true);

    const row = db.prepare("SELECT text,kind,layer FROM memories WHERE id=?").get(r.id!) as { text: string; kind: string; layer: string };
    assert.match(row.text, /我睡了 3 天/);
    assert.match(row.text, /记忆是空的/, "要如实说那段时间没有记忆");
    assert.ok(!/想|决定|做了/.test(row.text.replace("这期间的记忆是空的", "")), "不许编期间的想法：" + row.text);
    assert.equal(row.kind, "episode");
    assert.equal(row.layer, "narrative");
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("正常关闭（不到 24 小时）不补；同一段空档只补一次", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-gap2-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    const now = new Date("2026-11-03T09:00:00Z");

    // 2 小时：不写
    assert.equal(noteGap(db, now, new Date(now.getTime() - 2 * 3600_000)).written, false);
    assert.equal((db.prepare("SELECT count(*) c FROM memories").get() as { c: number }).c, 0);

    // 3 天：写一条
    const last = new Date(now.getTime() - GAP_MS * 3);
    assert.equal(noteGap(db, now, last).written, true);
    // 同一个 lastSeen 再跑：水位已经推过去了，不重复
    assert.equal(noteGap(db, now, last).written, false);
    assert.equal((db.prepare("SELECT count(*) c FROM memories").get() as { c: number }).c, 1);

    // 之后又睡了 3 天：该补第二次
    const later = new Date(now.getTime() + GAP_MS * 3);
    assert.equal(noteGap(db, later, now).written, true);
    assert.equal((db.prepare("SELECT count(*) c FROM memories").get() as { c: number }).c, 2);
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
