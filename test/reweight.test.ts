import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember, getRow } from "../src/store.ts";
import { createEmbedder } from "../src/embed.ts";
import { w0FromImportance, DECAY_PARAMS_VERSION } from "../src/decay.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-e2-"));
const emb = createEmbedder("fake");

test("E-2 w0 由 importance 推导：终于有方差；契约层仍为 1；1↔5 有界", () => {
  assert.equal(w0FromImportance(3, "narrative"), 0.59, "默认 3 → 0.59（接近旧的 0.55，不把旧库相对位置打乱）");
  assert.equal(w0FromImportance(1, "narrative"), 0.35);
  assert.equal(w0FromImportance(5, "narrative"), 0.83);
  assert.equal(w0FromImportance(3, "contract"), 1, "契约层永远是 1，不进公式");
  // 越界要夹住，不许“重要度 99”变成无限权重
  assert.equal(w0FromImportance(99, "narrative"), 0.83);
  assert.equal(w0FromImportance(-5, "narrative"), 0.35);
  assert.equal(DECAY_PARAMS_VERSION, 2, "改了行为必须 bump");
});

test("E-2 写库时真的用上了：importance 3/5 两条 w0 不同", async () => {
  const d = openDb(join(H(), "m.db"));
  const v = (await emb.embed(["x"]))[0]!;
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "普通的一条", importance: 3, embedding: v });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "很重要的一条", importance: 5, embedding: v });
  const ra = getRow(d.db, a)!, rb = getRow(d.db, b)!;
  assert.equal(ra.w0, 0.59);
  assert.equal(rb.w0, 0.83);
  assert.ok(rb.weight > ra.weight, "起点权重应该有差别（以前两条都是 0.55）");
});

test("E-2 显式传 w0 仍然优先（不让推导覆盖调用方的决定）", async () => {
  const d = openDb(join(H(), "m.db"));
  const v = (await emb.embed(["x"]))[0]!;
  const id = remember(d.db, { layer: "narrative", kind: "episode", text: "手动权重", importance: 5, w0: 0.2, embedding: v });
  assert.equal(getRow(d.db, id)!.w0, 0.2);
});

test("E-3 scored_by 写进库：人 / 规则 / 工具各有署名", async () => {
  const d = openDb(join(H(), "m.db"));
  const v = (await emb.embed(["x"]))[0]!;
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "人写的", scoredBy: "human:cli", embedding: v });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "抽取的", scoredBy: "extract:qwen2.5:7b", embedding: v });
  const c = remember(d.db, { layer: "narrative", kind: "episode", text: "默认的", embedding: v });
  const sb = (id: number) => (d.db.prepare("SELECT scored_by FROM memories WHERE id=?").get(id) as { scored_by: string }).scored_by;
  assert.equal(sb(a), "human:cli");
  assert.equal(sb(b), "extract:qwen2.5:7b");
  assert.equal(sb(c), "system", "没写明也要有个署名，不许留空");
});
