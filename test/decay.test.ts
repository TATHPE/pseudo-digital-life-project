import { test } from "node:test";
import assert from "node:assert/strict";
import {
  weight, classify, reconsolidate, recompute, rebase, isFlashback, days,
  paramsFor, lambdaFrom, accessBoost, T, type MemoryDynamics,
} from "../src/decay.ts";

const T0 = new Date("2026-01-01T00:00:00Z");
const at = (d: number) => new Date(T0.getTime() + d * 86_400_000);
const mk = (over: Partial<MemoryDynamics> = {}): MemoryDynamics => ({
  id: "m1", layer: "narrative", kind: "episode", w0: 0.55,
  recallCount: 0, lastDecayAt: T0, stage: "active", ...over,
});

test("λ 由半衰期与 β 反算（λ = ln2 / t½^β）", () => {
  const p = paramsFor("episode");
  const l = lambdaFrom(p);
  // 在 t = t½ 处，w 应约为 0.5（忽略地板与 accessBoost）
  const w = Math.exp(-l * Math.pow(p.halfLifeDays, p.beta));
  assert.ok(Math.abs(w - 0.5) < 1e-9, `w@t½=${w}`);
});

test("单调递减且不低于地板", () => {
  let prev = 1;
  for (const d of [0, 1, 7, 30, 90, 365, 3650]) {
    const w = weight(mk(), at(d));
    assert.ok(w <= prev + 1e-12, `d=${d} 上升了`);
    assert.ok(w >= paramsFor("episode").floor - 1e-12, `d=${d} 低于地板 ${w}`);
    prev = w;
  }
});

test("β<1 形状：前段快、后段长尾（vs β=1 的纯指数）", () => {
  const stretched = weight(mk(), at(90));
  const pure = weight({ ...mk(), kind: "contract" }, at(90)); // contract 短路 =1，仅作对照占位
  assert.equal(pure, 1);
  // 与手算的纯指数对比：β=0.85 时 90 天保留应高于同半衰期的纯指数
  const l = Math.LN2 / Math.pow(30, 1);
  const idx = 0.05 + 0.95 * 0.55 * Math.exp(-l * 90);
  assert.ok(stretched > idx, `stretched=${stretched} index=${idx}`);
});

test("契约层恒为 1，且不经公式", () => {
  const m = mk({ layer: "contract", kind: "promise", w0: 0.1, lastDecayAt: new Date("2000-01-01") });
  assert.equal(weight(m, at(10000)), 1);
  assert.equal(recompute(m, at(10000)).stage, "active");
  assert.equal(classify(0.01, "dormant", "contract"), "active");
});

test("双阈值滞后：0.35–0.55 带内不转移（防夜间震荡）", () => {
  assert.equal(classify(0.40, "active"), "active");
  assert.equal(classify(0.40, "fading"), "fading");
  assert.equal(classify(T.activeIn, "fading"), "active");
  assert.equal(classify(T.activeOut - 1e-9, "active"), "fading");
  assert.equal(classify(0.20, "fading"), "fading");
  assert.equal(classify(T.fadingOut - 1e-9, "fading"), "dormant");
  assert.equal(classify(T.fadingIn, "dormant"), "fading");
});

test("再巩固：w0 渐近逼近 1、recall 计数增加、阶段回升", () => {
  const m = mk({ w0: 0.5, recallCount: 3, lastDecayAt: at(-10) });
  const r1 = reconsolidate(m, at(0));
  assert.ok(r1.w0 > m.w0 && r1.w0 < 1);
  assert.equal(r1.recallCount, 4);
  const m2 = reconsolidate(r1, at(0));
  assert.ok(m2.w0 > r1.w0);
  assert.ok(m2.w0 - r1.w0 < r1.w0 - m.w0, "应是渐近而非线性");
});

test("常想起的忘得更慢（λeff 与 accessBoost 同向）", () => {
  const once = weight(mk({ recallCount: 1 }), at(60));
  const often = weight(mk({ recallCount: 20 }), at(60));
  assert.ok(often > once, `${often} > ${once}`);
  assert.ok(accessBoost(1000) <= 1.6);
});

test("flashback：只有 dormant 且强线索才唤醒", () => {
  const m = { stage: "dormant" as const, text: "你说过三月要去杭州出差" };
  assert.ok(isFlashback(m, { entities: ["杭州"] }));
  assert.ok(!isFlashback(m, { entities: ["上海"] }));
  assert.ok(!isFlashback({ ...m, stage: "active" }, { entities: ["杭州"] }));
  assert.ok(isFlashback(m, { anniversary: true }));
});

test("锚点语义：w 只取决于 (w0, now−锚点)，tick 不移动锚点 → 不会复活", () => {
  const m = mk({ recallCount: 3 });
  const w63 = weight(m, at(63));
  // 同一条记忆，无论中间"tick"过多少次（锚点不变），结果都一样
  const w63again = weight({ ...m }, at(63));
  assert.equal(w63, w63again);

  // 反例：如果有人把锚点挪到"上次 tick"，下次就会用 d=1 重算出高权重（记忆复活）
  const resurrected = weight({ ...m, lastDecayAt: at(62) }, at(63));
  assert.ok(resurrected > w63 * 1.5, `复活未被检出：${resurrected} vs ${w63}`);
});

test("rebase 只在参数变更时用：压回 w0 后立刻取权重应回到原值", () => {
  const m = mk({ recallCount: 2, lastDecayAt: at(-90) });
  const before = weight(m, at(0));
  const rb = rebase(m, at(0));
  const after = weight({ ...m, w0: rb.w0, lastDecayAt: at(0) }, at(0));
  assert.ok(Math.abs(after - before) < 1e-3, `after=${after} before=${before}`);
});
