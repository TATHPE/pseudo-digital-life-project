/**
 * 补向量（2026-11-03）：写入路径不建向量 → /health 的 embed-index-incomplete 只涨不落。
 * 这个函数是水龙头：启动后 / 闲时整理后把缺的补上。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { indexState } from "../src/embedindex.ts";
import { fillMissingEmbeddings } from "../src/fillvec.ts";

const fake = (n = 8) => ({
  name: "fake", dim: n,
  async embed(texts: string[]) { return texts.map((t) => new Float32Array(n).fill((t.length % 7) / 7)); },
});

test("只补缺的：有向量的不动，补完 missing 归零", async () => {
  const home = mkdtempSync(join(tmpdir(), "jj-fv-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    const withVec = remember(db, { text: "已经有向量的一条", kind: "episode", layer: "narrative", importance: 3, embedding: new Float32Array(8).fill(0.5) });
    remember(db, { text: "缺向量的一条", kind: "episode", layer: "narrative", importance: 3 });
    remember(db, { text: "缺向量的另一条", kind: "episode", layer: "narrative", importance: 3 });

    assert.equal(indexState(db).missing, 2, "两条缺");
    const before = (db.prepare("SELECT embedding e FROM memories WHERE id=?").get(withVec) as { e: Uint8Array }).e;

    const r = await fillMissingEmbeddings(db, fake() as never);
    assert.equal(r.filled, 2);
    assert.equal(r.missing, 0, "补完不缺了");

    const after = (db.prepare("SELECT embedding e FROM memories WHERE id=?").get(withVec) as { e: Uint8Array }).e;
    assert.deepEqual([...after], [...before], "已有向量的一条不许被重算");
  } finally { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test("没有 embedder 时如实报，不假装补齐", async () => {
  const home = mkdtempSync(join(tmpdir(), "jj-fv2-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    remember(db, { text: "缺向量", kind: "episode", layer: "narrative", importance: 3 });
    const r = await fillMissingEmbeddings(db, null);
    assert.equal(r.filled, 0);
    assert.equal(r.missing, 1);
    assert.equal(r.error, "E_NO_EMBEDDER");
  } finally { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
});
