/**
 * 离线向量表的契约（2026-11-10）：CI 没有 Ollama，但判的必须是同一套语义。
 * 这些测试守的不是「文件存在」，而是「表和夹具/模型/维度三者不允许悄悄错开」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DIM } from "../src/embed.ts";
import {
  DEFAULT_FIXTURE_DIR, fixtureTexts, hashFor, loadVectors,
  tableEmbedder, verifyVectors, type VectorTable,
} from "../tools/assembly-vectors.ts";

const MODEL = `bge-m3@${DIM}`;

function clone(t: VectorTable): VectorTable {
  return JSON.parse(JSON.stringify(t)) as VectorTable;
}

test("仓里的向量表与当前夹具/模型/维度完全一致", () => {
  const t = loadVectors();
  const texts = fixtureTexts();
  assert.deepEqual(verifyVectors(t, texts, MODEL, DIM), [], "有不一致就跑 --refresh-embeddings 并把表一起提交");
  assert.equal(t.model, MODEL);
  assert.equal(t.dim, DIM);
  assert.ok(texts.length >= 30, `夹具文本应有 30+ 条，实际 ${texts.length}`);
  assert.equal(Object.keys(t.vectors).length, texts.length, "表里不该有多余或缺失的文本");
});

test("夹具文本覆盖记忆正文与所有 case 问题", () => {
  const texts = fixtureTexts(DEFAULT_FIXTURE_DIR);
  assert.ok(texts.includes("备用钥匙换了位置，现在挂在门后第三颗钉子上"));
  assert.ok(texts.includes("麒麟座第七码头的潮汐表在哪"));
  assert.ok(texts.includes("我们上次一起去的那个雪山小镇叫什么"));
});

test("指纹：同一批文本稳定，改一个字就变（不许静默用旧向量）", () => {
  const a = ["甲", "乙"];
  assert.equal(hashFor(MODEL, DIM, a), hashFor(MODEL, DIM, ["乙", "甲"]), "顺序不该影响指纹");
  assert.notEqual(hashFor(MODEL, DIM, a), hashFor(MODEL, DIM, ["甲", "乙丙"]));
  assert.notEqual(hashFor(MODEL, DIM, a), hashFor("别的模型@512", DIM, a));
  assert.notEqual(hashFor(MODEL, DIM, a), hashFor(MODEL, 1024, a));
});

test("verifyVectors 抓得住四类错配", () => {
  const t = clone(loadVectors());
  const texts = fixtureTexts();
  assert.ok(verifyVectors({ ...t, model: "别的模型@512" }, texts, MODEL, DIM).some((x) => x.includes("模型不符")));
  assert.ok(verifyVectors({ ...t, dim: DIM + 1 }, texts, MODEL, DIM).some((x) => x.includes("维度不符")));
  assert.ok(verifyVectors({ ...t, fixtureHash: "deadbeef" }, texts, MODEL, DIM).some((x) => x.includes("指纹不符")));
  const missing = clone(t);
  delete missing.vectors[texts[0]!];
  assert.ok(verifyVectors(missing, texts, MODEL, DIM).some((x) => x.includes("缺向量")));
});

test("查表 embedder：已知文本给归一化向量，未知文本抛错而不是退化到 fake", async () => {
  const t = loadVectors();
  const emb = tableEmbedder(t);
  const first = fixtureTexts()[0]!;
  const [v] = await emb.embed([first]);
  assert.ok(v, "应返回向量");
  assert.equal(v.length, DIM);
  const norm = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-5, `应该是单位向量，实际 ${norm}`);
  await assert.rejects(() => emb.embed(["夹具里绝对没有的一句话"]), /E_ASSEMBLY_VECTOR_MISS/);
});
