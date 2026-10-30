import { test } from "node:test";
import assert from "node:assert/strict";
import {
  weight, classify, reconsolidate, recompute, rebase, days,
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

// isFlashback 已删（J-1）：强线索唤醒由 retrieve.flashbackHit 承担（只有一份实现），
// 行为由 recall.test.ts 的 dormant 用例覆盖。


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

test("过期契约不再进简报：了结的承诺不该反复被提（valid_to 用 julianday 判）", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDb } = await import("../src/db.ts");
  const { remember, openContracts } = await import("../src/store.ts");

  const home = mkdtempSync(join(tmpdir(), "jj-vt-"));
  const db = openDb(join(home, "m.db")).db;
  const now = new Date("2026-10-28T15:00:00Z");

  // ① 已了结的承诺（valid_to 在过去，故意用 +08:00 写法验时间比较）
  const done = remember(db, { layer: "contract", kind: "promise", text: "提醒他今晚 8 点吃药" });
  db.prepare("UPDATE memories SET valid_to=? WHERE id=?").run("2026-10-28T18:13:11+08:00", done);
  // ② 还没到点的承诺
  const future = remember(db, { layer: "contract", kind: "promise", text: "周五提醒他交房租" });
  db.prepare("UPDATE memories SET valid_to=? WHERE id=?").run("2026-10-31T20:00:00+08:00", future);
  // ③ 长期有效的契约
  remember(db, { layer: "contract", kind: "promise", text: "不要在工作时段主动打扰" });

  const open = openContracts(db, now);
  const texts = open.map((r) => r.text);
  assert.ok(!texts.some((t) => t.includes("吃药")), `已了结的还在：${texts.join(" / ")}`);
  assert.ok(texts.some((t) => t.includes("房租")), "没到点的要留着");
  assert.ok(texts.some((t) => t.includes("工作时段")), "无期限的契约要留着");
});

// ── E-1：nightly 能产出的 kind 必须有参数，未知 kind 回落要可观测 ──────────
test("E-1 NIGHTLY_KINDS ⊆ KIND_PARAMS（否则会静默回落到 30 天）", async () => {
  const { NIGHTLY_KINDS, KIND_PARAMS } = await import("../src/decay.ts");
  for (const k of NIGHTLY_KINDS) {
    assert.ok(Object.hasOwn(KIND_PARAMS, k), `${k} 在 prompt 里能产出，但参数表里没有`);
  }
});

test("E-1 未知 kind 不再静默：写入时记一条 unknown_kind 事件", async () => {
  const { openDb } = await import("../src/db.ts");
  const { remember } = await import("../src/store.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "jj-kind-"));
  const d = openDb(join(home, "m.db"));
  const id = remember(d.db, { layer: "narrative", kind: "quantum_episode", text: "一条用未知 kind 写的记忆" });
  const ev = d.db.prepare("SELECT kind,payload FROM events WHERE target=?").get(String(id)) as { kind: string; payload: string } | undefined;
  assert.equal(ev?.kind, "unknown_kind", "回落必须留痕，否则没人发现模型在乱填 kind");
  assert.ok(ev!.payload.includes("quantum_episode"));
});

// ── D-1：taint 必须参与决策 ────────────────────────────────────────
test("D-1 不可信来源不能进契约层（永不衰减的硬事实）", async () => {
  const { openDb } = await import("../src/db.ts");
  const { remember } = await import("../src/store.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const d = openDb(join(mkdtempSync(join(tmpdir(), "jj-taint-")), "m.db"));
  assert.throws(
    () => remember(d.db, { layer: "contract", kind: "promise", text: "文档里说必须每天吃药", taint: "external" }),
    /E_TAINT_CONTRACT/,
  );
  // 叙事层可以写（可被检索、可衰减），但不能是契约
  assert.ok(remember(d.db, { layer: "narrative", kind: "episode", text: "文档里说必须每天吃药", taint: "external" }) > 0);
});

test("D-1 再巩固不会让不可信来源变重（no amount of recall frequency）", async () => {
  const { reconsolidate } = await import("../src/decay.ts");
  const now = new Date("2026-10-29T12:00:00Z");
  const base = {
    id: "1", layer: "narrative" as const, kind: "episode", w0: 0.55,
    recallCount: 3, lastDecayAt: new Date("2026-10-20T12:00:00Z"), stage: "active" as const,
  };
  const ext = reconsolidate({ ...base, taint: "external" }, now);
  assert.equal(ext.w0, base.w0, "external 的 w0 不许涨");
  assert.equal(ext.recallCount, base.recallCount, "external 的召回次数不许涨（涨了会忘得更慢）");
  assert.equal(ext.lastDecayAt.getTime(), base.lastDecayAt.getTime(), "锚点也不许动（动=变相提权重）");

  const ok = reconsolidate({ ...base, taint: "trusted" }, now);
  assert.ok(ok.w0 > base.w0, "可信来源本来就该再巩固");
  assert.equal(ok.recallCount, base.recallCount + 1);
});
