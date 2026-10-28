import { test } from "node:test";
import assert from "node:assert/strict";
import { step, DEFAULTS, describe, loadState, saveState, advance, RULES, type SelfState } from "../src/state.ts";
import { openDb } from "../src/db.ts";

test("交互：closeness 缓慢上升，energy 下降，且单轮不跳变", () => {
  const a = step(DEFAULTS, { turns: 1 });
  assert.ok(a.closeness > DEFAULTS.closeness);
  assert.ok(a.closeness - DEFAULTS.closeness <= RULES.maxTurnDelta + 1e-9);
  assert.ok(a.energy < DEFAULTS.energy);
  const b = step(DEFAULTS, { turns: 20 });
  assert.ok(b.closeness - DEFAULTS.closeness <= RULES.maxTurnDelta + 1e-9, "轮数再多也不许跳变");
});

test("边界：不越界 [0,1]", () => {
  let s: SelfState = { energy: 1, closeness: 1, mood: null, attention: null };
  for (let i = 0; i < 50; i++) s = step(s, { turns: 3 });
  assert.ok(s.closeness <= 1 && s.energy >= 0);
  let t: SelfState = { energy: 0, closeness: 0, mood: null, attention: null };
  for (let i = 0; i < 50; i++) t = step(t, { night: true, silenceDays: 5 });
  assert.ok(t.closeness >= 0 && t.energy <= 1);
});

test("长时间沉默：closeness 会退（关系需要维护）", () => {
  const a = step({ ...DEFAULTS, closeness: 0.6 }, { turns: 0, silenceDays: 10 });
  assert.ok(a.closeness < 0.6);
});

test("夜间：energy 回升", () => {
  const a = step({ ...DEFAULTS, energy: 0.2 }, { night: true, silenceDays: 1 });
  assert.ok(a.energy > 0.2);
});

test("状态可回放：每次 advance 落一条，loadState 取最新", () => {
  const db = openDb(":memory:").db;
  advance(db, { turns: 1 }, new Date("2026-10-28T10:00:00Z"));
  const s2 = advance(db, { turns: 5 }, new Date("2026-10-28T11:00:00Z"));
  assert.equal(loadState(db).closeness, s2.closeness);
  const n = (db.prepare("SELECT count(*) c FROM self_state").get() as { c: number }).c;
  assert.equal(n, 2);
});

test("describe 是一句话，不是仪表盘", () => {
  const s = describe({ energy: 0.2, closeness: 0.1, mood: "有点沉" });
  assert.match(s, /累/);
  assert.match(s, /不太熟/);
  assert.ok(!/\d/.test(s), "不该出现数字：" + s);
});

test("saveState 会四舍五入到 3 位（避免浮点噪声）", () => {
  const db = openDb(":memory:").db;
  saveState(db, { energy: 0.123456, closeness: 0.654321, mood: null, attention: null });
  const r = db.prepare("SELECT energy,closeness FROM self_state").get() as { energy: number; closeness: number };
  assert.equal(r.energy, 0.123);
  assert.equal(r.closeness, 0.654);
});
