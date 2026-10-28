import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, timeLine } from "../src/brief.ts";
import { loadPersona } from "../src/persona.ts";
import type { BriefInput, MemoryLine } from "../src/types.ts";

const persona = loadPersona();
const NOW = new Date("2026-11-03T21:10:00");

const mkRecall = (n: number): MemoryLine[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `mem_${i}`, layer: "narrative", kind: "episode", stage: "active",
    weight: 0.7, text: "你提到 importance 影响衰减速率而不是初始权重",
  }));

const base = (over: Partial<BriefInput> = {}): BriefInput => ({
  now: NOW, persona, contracts: [], threads: [], recalled: [],
  user: "在吗", ...over,
});

test("不变量 1：P1–P4 逐字不变 → prefixHash 跨轮稳定", () => {
  const a = buildBrief(base());
  const b = buildBrief(base({ contracts: ["称呼「鲸鲸」"], recalled: mkRecall(5) }));
  assert.equal(a.prefixHash, b.prefixHash);
});

test("不变量 1b：人格变了 → prefixHash 必须变", () => {
  const a = buildBrief(base());
  const b = buildBrief(base({ persona: { ...persona, core: persona.core + "\n新增一句。" } }));
  assert.notEqual(a.prefixHash, b.prefixHash);
});

test("不变量 2：总量 ≤2000，且第 1 轮 ≤ 第 100 轮（不随轮数增长）", () => {
  const t1 = buildBrief(base());
  const t100 = buildBrief(base({
    lastSeenAt: new Date("2026-10-31T17:00:00"),
    contracts: Array.from({ length: 15 }, (_, i) => `契约 ${i}`),
    state: { energy: 0.62, closeness: 0.41, mood: "有点沉" },
    threads: ["a", "b", "c"],
    lastName: "停在「先写 decay.ts」上",
    delta: "你昨天提过论文太多",
    recalled: mkRecall(8),
  }));
  assert.ok(t1.tokens <= 2000, `turn1=${t1.tokens}`);
  assert.ok(t100.tokens <= 2000, `turn100=${t100.tokens}`);
  assert.ok(t1.tokens <= t100.tokens);
});

test("不变量 2b：超长输入被封顶（丢弃而不是溢出）", () => {
  const heavy = buildBrief(base({
    contracts: Array.from({ length: 60 }, (_, i) => `第 ${i} 条契约，内容写得很长很长很长很长很长很长`),
    recalled: Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`, layer: "narrative", kind: "episode", stage: "active",
      weight: 0.7, text: "很长的一段叙事".repeat(12),
    })),
    threads: ["1", "2", "3", "4", "5"],
  }));
  assert.ok(heavy.tokens <= 2000, `heavy=${heavy.tokens}`);
  assert.ok(heavy.dropped.recalled >= 40 - 8, `dropped=${heavy.dropped.recalled}`); // 上限 8 或预算先到
  assert.equal(heavy.dropped.threads, 2);            // 线头上限 3
});

test("不变量 3：11 个槽位固定且有序，空内容也占位", () => {
  const r = buildBrief(base());
  assert.deepEqual(r.slots.map((s) => s.id),
    ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"]);
  assert.deepEqual(r.slots.filter((s) => s.stable).map((s) => s.id), ["P1", "P2", "P3", "P4"]);
});

test("confidence 四态（01 §6.2）", () => {
  assert.equal(buildBrief(base()).confidence, "abstain");
  assert.equal(buildBrief(base({ recalled: mkRecall(1) })).confidence, "need_evidence");
  assert.equal(buildBrief(base({ recalled: mkRecall(3) })).confidence, "answer");
});

test("时间措辞三态（18 §2.3）：断片 / 间隔 / 首次", () => {
  const outage = timeLine(base({
    outage: { from: new Date("2026-10-28T02:14:00"), to: new Date("2026-10-28T07:30:00"), kind: "power" },
  }));
  assert.match(outage, /断电/);
  assert.match(outage, /什么都不经历|什么都没经历/);

  const gap = timeLine(base({ lastSeenAt: new Date("2026-10-31T17:00:00") }));
  assert.match(gap, /距上次对话 3 天 4 小时/);

  const first = timeLine(base());
  assert.ok(!/距上次|断电/.test(first));
});
