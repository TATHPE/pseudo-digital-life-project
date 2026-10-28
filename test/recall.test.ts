import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { createEmbedder } from "../src/embed.ts";
import { ingestFile, setDocSensitivity, listDocs } from "../src/ingest.ts";
import { recallForBrief, omissionNote } from "../src/recall.ts";
import { buildBrief } from "../src/brief.ts";
import { loadPersona } from "../src/persona.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-recall-"));

async function rig() {
  const home = H();
  mkdirSync(join(home, "sources"), { recursive: true });
  const db = openDb(join(home, "memory.db")).db;
  const emb = createEmbedder("fake");
  // 一条 shareable 记忆（聊天里说过）+ 一条 local_only（磁盘摄入）
  remember(db, { layer: "narrative", kind: "episode", text: "我们聊过记忆衰减的锚点问题", sensitivity: "shareable", embedding: (await emb.embed(["我们聊过记忆衰减的锚点问题"]))[0]! });
  remember(db, { layer: "narrative", kind: "episode", text: "磁盘上有一份不能外发的衰减笔记", sensitivity: "local_only", embedding: (await emb.embed(["磁盘上有一份不能外发的衰减笔记"]))[0]! });
  // 两篇文档：一篇默认（local_only），一篇显式 shareable
  writeFileSync(join(home, "sources", "衰减.md"), "# 衰减\n\n权重按拉伸指数下降，重要性影响速率。" + "细节".repeat(40));
  writeFileSync(join(home, "sources", "公开.md"), "# 公开\n\n这份文档的作者同意外发，讲的是同一个衰减话题。" + "细节".repeat(40));
  const d1 = await ingestFile(db, join(home, "sources", "衰减.md"), { home, embedder: emb });
  const d2 = await ingestFile(db, join(home, "sources", "公开.md"), { home, embedder: emb, sensitivity: "shareable" });
  return { home, db, emb, d1, d2 };
}

test("隐私闸门：local_only 的记忆与文档都不进简报，只报个数", async () => {
  const { db, emb } = await rig();
  const r = await recallForBrief(db, emb, "衰减 锚点", {});
  const ids = r.recalled.map((x) => x.id).join(" ");
  assert.ok(ids.includes("mem:"), "shareable 记忆应该进来");
  assert.ok(!r.recalled.some((x) => x.text.includes("不能外发")), "local_only 记忆泄漏了");
  assert.ok(r.omittedMem >= 1, "应该如实报告还有本地记忆没发");
  // 默认 local_only 的文档块不该出现
  assert.ok(!r.recalled.some((x) => x.source === "doc" && x.text.includes("拉伸指数")), "默认 local_only 的文档泄漏了");
  assert.ok(r.omittedDocs >= 1, `omittedDocs=${r.omittedDocs}`);
});

test("隐私闸门：显式标 shareable 的文档块会进 P10，且带 doc: 引用", async () => {
  const { db, emb, d2 } = await rig();
  const r = await recallForBrief(db, emb, "衰减 话题", {});
  const docs = r.recalled.filter((x) => x.source === "doc");
  assert.equal(docs.length, 1, JSON.stringify(r.recalled.map((x) => x.id)));
  assert.match(docs[0]!.id, /^doc:doc_[0-9a-f]{16}#\d+$/);
  assert.ok(String(docs[0]!.id).startsWith(`doc:${d2.docId}`));
  assert.equal(docs[0]!.sensitivity, "shareable");
});

test("面板改敏感度后，召回立刻跟着变（不用重新摄入）", async () => {
  const { db, emb, d1 } = await rig();
  const before = (await recallForBrief(db, emb, "拉伸指数", {})).recalled.filter((x) => x.source === "doc" && String(x.id).startsWith(`doc:${d1.docId}`));
  assert.equal(before.length, 0);

  assert.equal(setDocSensitivity(db, String(d1.docId ?? ""), "shareable"), true);
  const after = (await recallForBrief(db, emb, "拉伸指数", {})).recalled.filter((x) => x.source === "doc" && String(x.id).startsWith(`doc:${d1.docId}`));
  assert.equal(after.length, 1, "标为可发送之后应该能被召回到简报里");
  assert.equal(listDocs(db).find((d) => d.id === d1.docId)!.sensitivity, "shareable");
});

test("P10 渲染：文档块用「文档 · 章节」标签，和我自己的记忆区分开", async () => {
  const { db, emb, d2 } = await rig();
  const r = await recallForBrief(db, emb, "衰减 话题", {});
  const brief = buildBrief({
    now: new Date("2026-11-03T21:10:00"), persona: loadPersona(), contracts: [], threads: [],
    recalled: r.recalled, user: "在吗",
  });
  const p10 = brief.text.split(String.fromCharCode(10)).filter((l) => l.includes("cite:"));
  assert.ok(p10.some((l) => l.includes("[文档")), p10.join(" | "));
  assert.ok(p10.some((l) => l.includes("契约") || l.includes("叙事")), "记忆行还是原来的格式");
  assert.ok(p10.some((l) => l.includes(String(d2.docId))), "文档块要带 doc: 引用");
  // 预算不变：仍是 ≤2000
  assert.ok(brief.tokens <= 2000, `tokens=${brief.tokens}`);
});

test("omissionNote：没有遗漏就不写一句话（别在提示里制造噪声）", () => {
  assert.equal(omissionNote(0, 0), "");
  assert.match(omissionNote(2, 0), /2 条本地记忆/);
  assert.match(omissionNote(0, 3), /3 段本地文档/);
  assert.match(omissionNote(1, 2), /1 条本地记忆、2 段本地文档/);
});
