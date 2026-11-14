import { test } from "node:test";
import assert from "node:assert/strict";
import { step, DEFAULTS, describe, loadState, saveState, advance, advanceWithSnapshot, stateSnapshot, RULES, type SelfState } from "../src/state.ts";
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

test("状态可回放：每次状态变化落一条，loadState 取最新", () => {
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

// 追加式状态快照（2026-11-14，学自 dsh-world）：只在变化时才落库 + 追加一行
test("stateSnapshot：没变化返回 null；变化逐字段列出并声明「以最新一条为准」", () => {
  assert.equal(stateSnapshot(DEFAULTS, { ...DEFAULTS }), null);
  const s = stateSnapshot(DEFAULTS, { ...DEFAULTS, energy: 0.5, mood: "有点沉" });
  assert.ok(s);
  assert.equal(s!.changes.length, 2);
  assert.match(s!.text, /energy 0\.700 → 0\.500/);
  assert.match(s!.text, /以最新一条为准，之前那条不再算数/);
  assert.equal(stateSnapshot(DEFAULTS, { ...DEFAULTS, energy: 0.7 + 1e-9 }), null, "浮点噪声不算变化");
});

test("advanceWithSnapshot：状态没变不落新行，变了才追加", () => {
  const db = openDb(":memory:").db;
  const count = () => (db.prepare("SELECT count(*) c FROM self_state").get() as { c: number }).c;
  const first = advanceWithSnapshot(db, { turns: 1 }, new Date("2026-10-28T10:00:00Z"));
  assert.ok(first.snapshot, "第一轮应该产生快照");
  assert.equal(count(), 1);

  const same = advanceWithSnapshot(db, { turns: 0, silenceDays: 0 }, new Date("2026-10-28T10:01:00Z"));
  assert.equal(same.snapshot, null);
  assert.equal(count(), 1, "状态没变就不该追加行（历史里每行都得是一次变化）");
  assert.equal(loadState(db).closeness, first.state.closeness);

  const changed = advanceWithSnapshot(db, { turns: 3 }, new Date("2026-10-28T10:02:00Z"));
  assert.ok(changed.snapshot);
  assert.equal(count(), 2);
});
