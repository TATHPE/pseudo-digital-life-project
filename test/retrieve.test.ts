import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { search } from "../src/retrieve.ts";
import { createEmbedder } from "../src/embed.ts";

const emb = createEmbedder("fake");

async function seed(n: number) {
  const d = openDb(":memory:");
  const texts = [
    "重要性应该影响衰减速率而不是初始权重",
    "两阶段检索先出候选再算向量",
    "断电之后要补算衰减并写一条 outage 记忆",
    "契约层记忆永不衰减只能显式变更",
    "深夜只说一句在就好",
  ];
  for (let i = 0; i < n; i++) {
    const t = `第 ${i} 条：${texts[i % texts.length]}`;
    const v = (await emb.embed([t]))[0];
    remember(d.db, { layer: "narrative", kind: "episode", text: t, embedding: v });
  }
  return d;
}

test("中文 bigram 召回：能命中子串（unicode61 做不到，12 §9.1）", async () => {
  const d = await seed(50);
  const { hits, meta } = await search(d.db, emb, "衰减速率", { k: 3 });
  assert.ok(hits.length > 0, `no hits, meta=${JSON.stringify(meta)}`);
  assert.match(hits[0]?.text ?? "", /衰减速率|重要性/);
});

test("两阶段：候选数远小于全库", async () => {
  const d = await seed(200);
  const { meta } = await search(d.db, emb, "两阶段检索", { candidates: 50 });
  assert.ok(meta.candidates <= 50);
  assert.ok(meta.degraded.length === 0, JSON.stringify(meta.degraded));
});

test("无 embedder 时降级为纯词法，不失败", async () => {
  const d = await seed(30);
  const { hits, meta } = await search(d.db, null, "断电 补算", { k: 3 });
  assert.ok(meta.degraded.includes("no_embedder"));
  assert.ok(hits.length > 0);
});

test("MMR：同质结果里挤进一条不同说法（去冗余）", async () => {
  const d = openDb(":memory:");
  const variants = [
    "契约层记忆永不衰减只能显式变更",
    "契约层记忆永不衰减只能显式变更",
    "契约层记忆永不衰减只能显式变更",
    "契约层记忆永不衰减只能显式变更",
    "显式变更才是契约层的合法更新方式，衰减对它完全无效",
  ];
  for (const [i, t] of variants.entries()) {
    const v = (await emb.embed([t]))[0];
    remember(d.db, { layer: "narrative", kind: "episode", text: t + ` #${i}`, embedding: v });
  }
  const { hits } = await search(d.db, emb, "契约层 显式变更 衰减", { k: 3, mmrLambda: 0.5 });
  const kinds = new Set(hits.map((h) => (h.text.includes("合法更新") ? "variant" : "dup")));
  assert.equal(kinds.size, 2, `hits=${hits.map((h) => h.text).join(" | ")}`);
});

// ── 三道闸（01 §6）：按 stage 走不同门，不是一刀切阈值 ─────────
import { remember as remember2, tickDecay } from "../src/store.ts";

async function seedAged(days: number, texts: string[]) {
  const d = openDb(":memory:");
  const now = new Date(Date.now() - days * 86_400_000);
  for (const t of texts) {
    const v = (await emb.embed([t]))[0]!;
    remember2(d.db, { layer: "narrative", kind: "episode", text: t, embedding: v, now });
  }
  tickDecay(d.db, new Date());
  return d;
}

test("active 直接注入；fading 需话题命中；dormant 只在强线索唤醒", async () => {
  const fresh = await seedAged(0, ["断电之后要补算衰减"]);
  const a = await search(fresh.db, emb, "断电 补算", { k: 3 });
  assert.equal(a.hits[0]?.via, "active");

  // 60 天 → fading（w≈0.20）；话题命中则注入
  const aged = await seedAged(60, ["断电之后要补算衰减", "杭州三月的天气适合搬家"]);
  const b = await search(aged.db, emb, "断电 补算 衰减", { k: 3 });
  assert.ok(b.hits.some((h) => h.via === "fading" && /断电/.test(h.text)), JSON.stringify(b.hits));
  assert.ok(b.hits.every((h) => h.stage !== "dormant"));

  // 300 天 → dormant；强线索（专名/实体）才唤醒
  const old = await seedAged(300, ["杭州三月的天气适合搬家"]);
  const c = await search(old.db, emb, "杭州", { k: 3 });
  assert.ok(c.hits.some((h) => h.via === "flashback"), `期望 flashback，实得 ${JSON.stringify(c.hits.map((h) => [h.via, h.text]))}`);
  // 唤醒后权重临时抬到 ≥0.5，但不写库
  const w = c.hits.find((h) => h.via === "flashback")!.weight;
  assert.ok(w >= 0.5);
});

test("没有候选 → 明确说自己没有（degraded=no_candidates）", async () => {
  const aged = await seedAged(60, ["杭州三月的天气适合搬家"]);
  const r = await search(aged.db, emb, "token 估算", { k: 3 });
  assert.equal(r.hits.length, 0);
  assert.ok(r.meta.degraded.includes("no_candidates"), JSON.stringify(r.meta.degraded));
});

test("fading 的相关度门可调：抬高到 0.99 即排除（= 话题不够沾边就不注入）", async () => {
  const aged = await seedAged(60, ["杭州三月的天气适合搬家"]);
  const loose = await search(aged.db, emb, "杭州三月", { k: 3, fadingRelevance: 0.0 });
  const strict = await search(aged.db, emb, "杭州三月", { k: 3, fadingRelevance: 0.99 });
  assert.ok(loose.hits.length > 0);
  assert.equal(strict.hits.length, 0);
  assert.ok(strict.meta.degraded.includes("all_below_threshold"), JSON.stringify(strict.meta.degraded));
});

test("flashback 每轮上限 2 条", async () => {
  const d = await seedAged(300, ["杭州", "杭州西湖", "杭州搬迁", "杭州天气"].map((s) => s + "的旧事"));
  const r = await search(d.db, emb, "杭州", { k: 8, flashbackCap: 2 });
  assert.ok(r.hits.filter((h) => h.via === "flashback").length <= 2);
});
