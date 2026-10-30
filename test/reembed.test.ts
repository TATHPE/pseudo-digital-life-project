import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { createEmbedder, fakeEmbed } from "../src/embed.ts";
import { reembed } from "../src/reembed.ts";
import { indexState, markIndexBuilt } from "../src/embedindex.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-reembed-"));
const emb = createEmbedder("fake");

async function seed(home: string) {
  const d = openDb(join(home, "m.db"));
  for (const t of ["我喜欢喝乌龙茶", "周三下午要交稿", "别叫我助理"]) {
    const v = (await emb.embed([t]))[0]!;
    remember(d.db, { layer: "narrative", kind: "episode", text: t, embedding: v });
  }
  return d;
}

test("C-2 换模型没重建 → 索引标记为过期（有向量、两边模型名不同）", async () => {
  const home = H();
  const d = await seed(home);
  markIndexBuilt(d.db, "ollama:bge-m3");
  assert.equal(indexState(d.db, "ollama:bge-m3").stale, false, "同一个模型不算过期");
  const st = indexState(d.db, "ollama:other");
  assert.equal(st.stale, true, "换了模型就是过期");
  assert.equal(st.vectors, 3);
});

test("C-2 空库不算过期（否则新装用户永远看到假警报）", async () => {
  const d = openDb(join(H(), "m.db"));
  const st = indexState(d.db, "ollama:bge-m3");
  assert.equal(st.vectors, 0);
  assert.equal(st.stale, false);
});

test("C-2 reembed：重算所有向量、盖戳、正文一字不动", async () => {
  const home = H();
  const d = await seed(home);
  markIndexBuilt(d.db, "ollama:old-model");
  const before = d.db.prepare("SELECT id,text,kind,weight FROM memories ORDER BY id").all();
  const oldVec = (d.db.prepare("SELECT embedding FROM memories WHERE id=1").get() as { embedding: Uint8Array }).embedding;

  // 换一个"模型"来算：fake 是确定性的，用同一个 embedder 重算会得到一模一样的字节
  const emb2 = { name: "fake-b", dim: 512, embed: async (ts: string[]) => ts.map((t) => fakeEmbed(t + " v2")) };
  const r = await reembed({ db: d.db, embedder: emb2 as never, model: "ollama:bge-m3" });
  assert.equal(r.ok, true);
  assert.equal(r.memories, 3);
  assert.equal(r.from, "ollama:old-model");
  assert.equal(r.to, "ollama:bge-m3");

  const after = d.db.prepare("SELECT id,text,kind,weight FROM memories ORDER BY id").all();
  assert.deepEqual(after, before, "重建只换向量，绝不碰正文/类型/权重");
  const newVec = (d.db.prepare("SELECT embedding FROM memories WHERE id=1").get() as { embedding: Uint8Array }).embedding;
  assert.notDeepEqual(Buffer.from(newVec), Buffer.from(oldVec), "向量确实被重算了");
  assert.equal(indexState(d.db, "ollama:bge-m3").stale, false, "成功后不再过期");
});

test("C-2 reembed 失败：整体回滚，旧索引保留、不留半新半旧", async () => {
  const home = H();
  const d = await seed(home);
  markIndexBuilt(d.db, "ollama:old-model");
  const before = d.db.prepare("SELECT id, embedding FROM memories ORDER BY id").all();

  const bad = { name: "bad", dim: 512, embed: async () => { throw new Error("E_EMBED_DOWN"); } };
  const r = await reembed({ db: d.db, embedder: bad as never, model: "ollama:new-model" });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /E_EMBED/);

  const after = d.db.prepare("SELECT id, embedding FROM memories ORDER BY id").all();
  assert.deepEqual(
    after.map((x) => Buffer.from((x as { embedding: Uint8Array }).embedding)),
    before.map((x) => Buffer.from((x as { embedding: Uint8Array }).embedding)),
    "失败必须一行都没改",
  );
  const st = indexState(d.db, "ollama:new-model");
  assert.equal(st.stale, true, "失败后仍然是过期状态，不许假装成功");
  const err = d.db.prepare("SELECT value FROM meta WHERE key='reembed_error'").get() as { value: string } | undefined;
  assert.ok(err?.value.includes("E_EMBED"), "失败原因要留在库里");
});
