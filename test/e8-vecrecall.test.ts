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

test("索引覆盖率要自己报出来：模型没换，也可能有记忆没向量（E-11 的真根因）", async () => {
  // 实测事故（2026-11-03）：活库 157 条 active 记忆里只有 29 条有向量（18%），
  // 但 indexState 只比模型名 → 一直报"索引已是最新"。
  // 于是"我妈生日那件事搜不到"被误诊成改写/阈值问题，真正的病是那些记忆没向量。
  const { openDb } = await import("../src/db.ts");
  const { remember } = await import("../src/store.ts");
  const { indexState } = await import("../src/embedindex.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const home = mkdtempSync(join(tmpdir(), "jj-cov-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    // 三条记忆，只有一条有向量
    const vec = new Float32Array(8).fill(0.1);
    remember(db, { text: "有向量的一条", kind: "episode", layer: "narrative", importance: 3, embedding: vec });
    remember(db, { text: "没向量的第一条", kind: "episode", layer: "narrative", importance: 3 });
    remember(db, { text: "没向量的第二条", kind: "episode", layer: "narrative", importance: 3 });

    const st = indexState(db);
    assert.equal(st.vectors, 1, "只数到一条有向量");
    assert.equal(st.missing, 2, "缺的两条必须报出来");
    assert.equal(st.stale, false, "模型没换 → 不是 stale（这正是被误诊的原因）");

    // 建好之后 missing 归零
    db.prepare("UPDATE memories SET embedding=? WHERE embedding IS NULL").run(new Uint8Array(vec.buffer));
    assert.equal(indexState(db).missing, 0, "补齐后不再报缺");
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
