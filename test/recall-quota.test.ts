/**
 * P1 落地回归（2026-11-09）：层配额 + rerank NONE 保守回退。
 *
 * 背景：夜间抽取产出的 contract 层初始权重恒为 1、永不衰减（store.ts:60），
 * 在固定 k=6 窗口里会系统性挤掉叙事证据；本地 7B 重排回 NONE 时又把整轮召回清空，
 * 答案变成「我没有相关记录」的错误否认。P1 在 24 题抽样上量到：
 *   pool 15/24 → quota 17/24（净 +2、零退化），证据命中 51% → 55%。
 *
 * 这里把产品代码里的两个机制钉住，并用可配开关验证「关掉就回到旧行为」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { createEmbedder } from "../src/embed.ts";
import { applyLayerQuota, recallForBrief } from "../src/recall.ts";
import { buildBrief } from "../src/brief.ts";
import { loadPersona } from "../src/persona.ts";
import type { MemoryLine } from "../src/types.ts";

type Row = { id: number; layer: "narrative" | "contract" };

/** 临时改环境变量，跑完一定恢复——别污染同进程里其它测试 */
async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ── 1. 纯函数：层配额的选择规则 ────────────────────────────────
test("层配额：契约占满前排时，把名额让给后面的叙事，且保持原排名", () => {
  const ordered: Row[] = [
    { id: 1, layer: "contract" }, { id: 2, layer: "contract" }, { id: 3, layer: "contract" },
    { id: 4, layer: "contract" }, { id: 5, layer: "contract" },
    { id: 6, layer: "narrative" }, { id: 7, layer: "narrative" },
    { id: 8, layer: "narrative" }, { id: 9, layer: "narrative" },
  ];
  const { chosen } = applyLayerQuota(ordered, (id) => ordered.find((x) => x.id === id)!.layer, 6, 2);
  assert.equal(chosen.length, 6, "窗口大小不因配额改变");
  assert.equal(chosen.filter((x) => x.layer === "contract").length, 2, "契约最多 2 条");
  assert.equal(chosen.filter((x) => x.layer === "narrative").length, 4, "四条叙事被让进窗口");
  assert.deepEqual(chosen.map((x) => x.id), [1, 2, 6, 7, 8, 9], "仍按原排名顺序，不重排相关度");
});

test("层配额：叙事不够时用被跳过的契约补位，别让窗口变空", () => {
  const ordered: Row[] = [
    { id: 1, layer: "contract" }, { id: 2, layer: "contract" }, { id: 3, layer: "contract" },
    { id: 4, layer: "contract" }, { id: 5, layer: "contract" }, { id: 6, layer: "narrative" },
  ];
  const { chosen } = applyLayerQuota(ordered, (id) => ordered.find((x) => x.id === id)!.layer, 6, 2);
  assert.equal(chosen.length, 6, "补位后仍是 6 条，一条不少");
  assert.equal(new Set(chosen.map((x) => x.id)).size, 6, "不能重复塞同一条");
  assert.ok(chosen.some((x) => x.id === 3) && chosen.some((x) => x.id === 4), "被跳过的契约按原排名补回来");
  assert.deepEqual(chosen.map((x) => x.id), [1, 2, 3, 4, 5, 6], "补位后仍按原排名");
});

test("层配额：cap<0 关闭 / cap=0 不让任何契约优先", () => {
  const ordered: Row[] = [
    { id: 1, layer: "contract" }, { id: 2, layer: "contract" },
    { id: 3, layer: "narrative" }, { id: 4, layer: "narrative" },
  ];
  const layerOf = (id: number) => ordered.find((x) => x.id === id)!.layer;
  const off = applyLayerQuota(ordered, layerOf, 3, -1);
  assert.deepEqual(off.chosen.map((x) => x.id), [1, 2, 3], "关闭时就是原样取前 k 条");
  assert.equal(off.skipped.length, 0);
  const zero = applyLayerQuota(ordered, layerOf, 3, 0);
  assert.deepEqual(zero.chosen.map((x) => x.id), [1, 3, 4], "叙事不够，被跳过的契约按原排名补位");
});

// ── 2. 集成：真实库上配额把叙事证据让进窗口 ────────────────────
async function rig() {
  const home = mkdtempSync(join(tmpdir(), "jj-p2-"));
  const db = openDb(join(home, "m.db")).db;
  const emb = createEmbedder("fake");
  const q = "夜班交接清单";
  const rows: Array<{ layer: "narrative" | "contract"; kind: string; text: string }> = [];
  for (let i = 0; i < 8; i++) rows.push({ layer: "contract", kind: "promise", text: `契约${i}：${q} 的第 ${i} 条固定约定` });
  for (let i = 0; i < 4; i++) rows.push({ layer: "narrative", kind: "episode", text: `叙事${i}：${q} 那晚实际发生的事 ${i}` });
  // embed() 是异步、remember() 是同步：先批量算好向量再逐条写入
  const vecs = await emb.embed(rows.map((r) => r.text));
  rows.forEach((r, i) => remember(db, {
    layer: r.layer, kind: r.kind, text: r.text, sensitivity: "shareable", embedding: vecs[i]!,
  }));
  return { home, db, emb, q };
}

test("召回装配：开启配额后叙事条数上升、契约条数下降，窗口仍是 6", async () => {
  const { home, db, emb, q } = await rig();
  try {
    const off = await withEnv({ JJ_CONTRACT_CAP: "-1", JJ_RECALL_POOL_K: undefined }, () =>
      recallForBrief(db, emb, q, { memK: 6, docK: 0, rerankMode: "off", home }));
    const on = await withEnv({ JJ_CONTRACT_CAP: "2", JJ_RECALL_POOL_K: undefined }, () =>
      recallForBrief(db, emb, q, { memK: 6, docK: 0, rerankMode: "off", home }));
    const cOff = off.recalled.filter((x) => x.layer === "contract").length;
    const nOff = off.recalled.filter((x) => x.layer !== "contract").length;
    const cOn = on.recalled.filter((x) => x.layer === "contract").length;
    const nOn = on.recalled.filter((x) => x.layer !== "contract").length;
    assert.equal(off.recalled.length, 6);
    assert.equal(on.recalled.length, 6, "窗口大小不变");
    assert.ok(cOn < cOff, `契约要变少：${cOff} → ${cOn}`);
    assert.ok(nOn > nOff, `叙事要变多：${nOff} → ${nOn}`);
    assert.ok(cOn <= 2, `契约不能超过上限，实际 ${cOn}`);
    assert.ok((on.meta.memPool ?? 0) > (off.meta.memPool ?? 0), "配额开时候选池要更大，否则叙事补不进来");
    assert.equal(on.rerankNone, false, "没跑重排就不该标低置信");
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

// ── 3. rerank NONE 保守回退 ─────────────────────────────────────
test("NONE 回退：模型说「都没有」时保留候选而不是清空整轮召回", async () => {
  const { home, db, emb, q } = await rig();
  const noneFn = async (_home: string, _query: string, hits: Array<{ id: number; text: string; score: number }>) =>
    ({ order: [] as typeof hits, none: true, ran: true, ms: 0 });
  try {
    const kept = await withEnv({ JJ_RERANK_NONE_FALLBACK: "1" }, () =>
      recallForBrief(db, emb, q, { memK: 6, docK: 0, home, rerankFn: noneFn }));
    assert.ok(kept.recalled.length > 0, "召回不能被 NONE 清空");
    assert.equal(kept.rerankNone, true, "要把「重排说没有」如实标出去");

    const old = await withEnv({ JJ_RERANK_NONE_FALLBACK: "0" }, () =>
      recallForBrief(db, emb, q, { memK: 6, docK: 0, home, rerankFn: noneFn }));
    assert.equal(old.recalled.length, 0, "关掉开关就回到旧行为（清空）");
    assert.equal(old.rerankNone, true);
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

test("confidence：NONE 回退把 answer 降为 need_evidence，但不动 abstain", () => {
  const base = {
    now: new Date("2026-11-03T21:10:00"), persona: loadPersona(), contracts: [], threads: [], user: "在吗",
  };
  const lines: MemoryLine[] = [1, 2, 3].map((i): MemoryLine => ({
    id: `mem:${i}`, layer: "narrative", kind: "episode", stage: "active", weight: 0.7,
    text: `叙事证据 ${i}`, sensitivity: "shareable", source: "memory",
  }));
  const sure = buildBrief({ ...base, recalled: lines });
  assert.equal(sure.confidence, "answer", "三条叙事本来是 answer");
  const low = buildBrief({ ...base, recalled: lines, rerankNone: true });
  assert.equal(low.confidence, "need_evidence", "重排说没有时不许假装确定");
  const empty = buildBrief({ ...base, recalled: [], rerankNone: true });
  assert.equal(empty.confidence, "abstain", "真的没召回仍要能拒答，不能被改掉");
});
