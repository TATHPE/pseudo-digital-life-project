import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { search } from "../src/retrieve.ts";
import { l2norm } from "../src/embed.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-e8-"));

/** 受控 embedder：同组文本同向量（模拟"语义相近但用词完全不同"） */
function groupedEmb(groups: string[][]) {
  const dim = 512;
  const vecOf = (text: string) => {
    const g = groups.findIndex((grp) => grp.some((x) => text.includes(x)));
    const v = new Float32Array(dim);
    if (g >= 0) v.fill(1 / Math.sqrt(dim));
    else { v[0] = 1; }
    return l2norm(v);
  };
  return { name: "grouped", dim, async embed(texts: string[]) { return texts.map(vecOf); } };
}

test("E-8 词面完全不重合也能召回（FTS 0 命中，靠向量）", async () => {
  const emb = groupedEmb([["称呼", "叫名字"]]);   // 「怎么称呼」和「叫名字」同组
  const d = openDb(join(H(), "m.db"));
  const id = remember(d.db, {
    layer: "contract", kind: "boundary", text: "不要叫我助手，直接叫名字",
    embedding: (await emb.embed(["不要叫我助手，直接叫名字"]))[0]!, sensitivity: "shareable",
  });

  const q = "她不喜欢我怎么称呼";
  // 先确认这真的是纯向量题：FTS 一个都命中不了
  const fts = d.db.prepare("SELECT count(*) c FROM memories_fts WHERE memories_fts MATCH ?")
    .get("称呼" + String.fromCharCode(32) + "呼我") as { c: number };
  assert.equal(fts.c, 0, "构造前提：字面上撞不上");

  const r = await search(d.db, emb, q, { k: 5 });
  assert.ok(r.hits.some((h) => h.id === id), "要靠向量把它召回来");
  assert.ok((r.meta.vecHits ?? 0) >= 1, "meta 里要能看到向量召回了几个");
});

test("E-8 向量召回不会把无关条目塞进来（cos < 0.55 不进候选）", async () => {
  const emb = groupedEmb([["称呼", "叫名字"]]);
  const d = openDb(join(H(), "m.db"));
  const hit = remember(d.db, {
    layer: "narrative", kind: "episode", text: "不要叫我助手，直接叫名字",
    embedding: (await emb.embed(["不要叫我助手，直接叫名字"]))[0]!, sensitivity: "shareable",
  });
  // 正交向量 → cos 0 → 不该进候选
  const other = remember(d.db, {
    layer: "narrative", kind: "episode", text: "今天下午去买了点菜",
    embedding: (await emb.embed(["完全无关的一段话"]))[0]!, sensitivity: "shareable",
  });

  const r = await search(d.db, emb, "她不喜欢我怎么称呼", { k: 5 });
  const ids = r.hits.map((h) => h.id);
  assert.ok(ids.includes(hit));
  assert.ok(!ids.includes(other), "无关条目不能被向量的假近邻带进来");
});

test("E-8 没有 embedder 时不炸，退化为纯词法（并显式标记降级）", async () => {
  const emb = groupedEmb([["称呼", "叫名字"]]);
  const d = openDb(join(H(), "m.db"));
  const id = remember(d.db, {
    layer: "narrative", kind: "episode", text: "不要叫我助手，直接叫名字",
    embedding: (await emb.embed(["不要叫我助手，直接叫名字"]))[0]!, sensitivity: "shareable",
  });
  const r = await search(d.db, null, "助手", { k: 5 });
  assert.ok(r.hits.some((h) => h.id === id), "纯词法也该命中（字面重合）");
  assert.ok(r.meta.degraded.includes("no_embedder"));
});

test("E-8 词法 + 向量都命中时，两条路的名次都能查到（meta/命中字段）", async () => {
  const emb = groupedEmb([["称呼", "叫名字", "助手"]]);
  const d = openDb(join(H(), "m.db"));
  const id = remember(d.db, {
    layer: "narrative", kind: "episode", text: "不要叫我助手，直接叫名字",
    embedding: (await emb.embed(["不要叫我助手，直接叫名字"]))[0]!, sensitivity: "shareable",
  });
  const r = await search(d.db, emb, "助手", { k: 5 });
  const h = r.hits.find((x) => x.id === id)!;
  assert.ok(h.bm25Rank !== undefined, "FTS 名次要留着（可解释）");
  assert.ok(h.cosine !== undefined && h.cosine > 0.9, "向量分数也要留着");
});
