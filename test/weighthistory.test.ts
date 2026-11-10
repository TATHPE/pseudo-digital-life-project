/**
 * E-3b：权重变更要答得出「变过几次 / 从多少到多少 / 谁改的」。
 *
 * 最重要的一条是**反例**：普通衰减 tick 不算变更。weight 是 now 的纯函数，
 * 把 tick 记成事件只会让「变过几次」退化成「过了几天」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember, reinforce, tickDecay, patchMemoryMeta, reweightAll } from "../src/store.ts";
import { weightHistory, formatWeightHistory, WEIGHT_EVENT } from "../src/weighthistory.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-whist-"));
const T0 = new Date("2026-11-01T10:00:00Z");
const plusDays = (d: number) => new Date(T0.getTime() + d * 86400000);
const open = () => openDb(join(H(), "m.db")).db;
const events = (db: ReturnType<typeof open>) =>
  db.prepare("SELECT kind FROM events WHERE kind=?").all(WEIGHT_EVENT) as Array<{ kind: string }>;

test("reinforce：每次真的进装配块都留一条带前后数值的记录", () => {
  const db = open();
  const id = remember(db, { layer: "narrative", kind: "episode", text: "她把备用钥匙放在门后", sensitivity: "shareable", now: T0 });
  assert.equal(reinforce(db, [id], plusDays(1)), 1);
  assert.equal(reinforce(db, [id], plusDays(2)), 1);

  const h = weightHistory(db, id);
  assert.equal(h.count, 2, JSON.stringify(h));
  assert.equal(h.lastCause, "reconsolidate");
  assert.equal(h.changes[0]!.by, "rule:reinforce");
  assert.equal(h.changes[0]!.from.recallCount, 0);
  assert.equal(h.changes[0]!.to.recallCount, 1);
  assert.equal(h.changes[1]!.to.recallCount, 2);
  assert.ok(h.changes[0]!.to.w0! > h.changes[0]!.from.w0!, "w0 要被抬上去");
  assert.equal(h.changes[1]!.from.w0, h.changes[0]!.to.w0, "前后两次必须接得上，不能各记各的");
  assert.ok(h.lastAt && h.changes[0]!.ts < h.lastAt, "按时间升序");
  assert.match(formatWeightHistory(h), /权重变更 2 次/);
});

test("external 来源不因召回而变重 → 也不许留权重事件", () => {
  const db = open();
  const id = remember(db, {
    layer: "narrative", kind: "reading", text: "书里抄来的一句",
    taint: "external", sensitivity: "shareable", now: T0,
  });
  assert.equal(reinforce(db, [id], plusDays(1)), 0);
  assert.equal(weightHistory(db, id).count, 0);
  assert.equal(events(db).length, 0);
});

test("patchMemoryMeta：改权重字段留数值；只改 status/sensitivity 不灌水", () => {
  const db = open();
  const id = remember(db, { layer: "narrative", kind: "episode", text: "一条", now: T0 });
  patchMemoryMeta(db, id, { status: "archived", sensitivity: "local_only" }, "human:panel", plusDays(1));
  assert.equal(weightHistory(db, id).count, 0, "不碰权重就不该记");

  patchMemoryMeta(db, id, { weight: 0.3, importance: 5 }, "human:panel", plusDays(2));
  const h = weightHistory(db, id);
  assert.equal(h.count, 1);
  assert.equal(h.changes[0]!.cause, "meta_patch");
  assert.equal(h.changes[0]!.to.weight, 0.3);
  assert.equal(h.changes[0]!.to.importance, 5);
  assert.ok(h.changes[0]!.from.weight !== 0.3, "改前数值必须留下来，否则答不出「从多少变到多少」");
  // 既有的 memory_meta_changed 不能被动掉（面板/测试都靠它证明走的是闸门）
  assert.ok(db.prepare("SELECT 1 FROM events WHERE kind='memory_meta_changed' AND target=?").get(String(id)));
});

test("tickDecay 不是离散变更：重算了权重，但一条事件都不写", () => {
  const db = open();
  const id = remember(db, { layer: "narrative", kind: "episode", text: "会随时间淡掉的一条", now: T0 });
  const before = (db.prepare("SELECT weight FROM memories WHERE id=?").get(id) as { weight: number }).weight;
  const n = tickDecay(db, plusDays(3));
  assert.equal(n, 1, "这条应该被重算");
  const after = (db.prepare("SELECT weight FROM memories WHERE id=?").get(id) as { weight: number }).weight;
  assert.notEqual(after, before, "权重确实变了 —— 但这是时间推移，不是一次「变更」");
  assert.equal(weightHistory(db, id).count, 0, "记了就答不出「变过几次」了");
  assert.match(formatWeightHistory(weightHistory(db, id)), /普通衰减 tick 不算离散变更/);
});

test("reweightAll：dry-run 一个字都不写；apply 逐条留 reweight 记录", () => {
  const db = open();
  const id = remember(db, { layer: "narrative", kind: "episode", text: "旧行 w0 恒 0.55", now: T0 });
  // 模拟 11-04 之前的老行：w0 写死 0.55，而不是按 importance 推出来的值
  db.prepare("UPDATE memories SET w0=0.55 WHERE id=?").run(id);
  const dry = reweightAll(db, plusDays(1), false);
  assert.equal(dry.dryRun, true);
  assert.ok(dry.changed >= 1, "老行必须被列进计划");
  assert.equal(events(db).length, 0, "dry-run 不许留事件");
  assert.equal(weightHistory(db, id).count, 0);

  const applied = reweightAll(db, plusDays(1), true);
  assert.equal(applied.dryRun, false);
  assert.ok(applied.changed >= 1);
  const h = weightHistory(db, id);
  assert.equal(h.count, 1);
  assert.equal(h.changes[0]!.cause, "reweight");
  assert.ok(h.changes[0]!.from.w0 !== undefined && h.changes[0]!.to.w0 !== undefined);
});

test("老库兼容：没有数值的 memory_meta_changed 单独报 legacyCount，不混进次数", () => {
  const db = open();
  const id = remember(db, { layer: "narrative", kind: "episode", text: "老数据", now: T0 });
  db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
    .run(T0.toISOString(), "memory_meta_changed", "extract:old", String(id), JSON.stringify({ keys: ["weight", "stage"] }));
  db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
    .run(T0.toISOString(), "memory_meta_changed", "extract:old", String(id), JSON.stringify({ keys: ["status"] }));
  const h = weightHistory(db, id);
  assert.equal(h.count, 0, "老事件没数值，不该冒充一次可核对的变更");
  assert.equal(h.legacyCount, 1, "但也不能装作没发生过");
  assert.match(formatWeightHistory(h), /另有 1 条旧版元数据事件/);
});
