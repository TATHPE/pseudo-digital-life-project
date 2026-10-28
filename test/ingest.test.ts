import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, meta } from "../src/db.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";
import { chunkMarkdown, embedInput, dedupeTitle, parseBlocks, overlapTail } from "../src/chunk.ts";
import { ingestFile, ingestFiles, ingestPath, collectFiles, listDocs, forgetDoc, sourcesDir } from "../src/ingest.ts";
import { loadPolicy } from "../src/policy.ts";
import { execute } from "../src/execute.ts";
import { searchDocs } from "../src/retrieve.ts";
import { createEmbedder } from "../src/embed.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-ingest-"));

function rig() {
  const home = H();
  mkdirSync(join(home, "sources"), { recursive: true });
  const db = openDb(join(home, "memory.db")).db;
  return { home, db };
}

/** 记录被送去 embed 的文本：断言"章节路径进了向量输入"就靠它 */
function spyEmbedder() {
  const seen: string[] = [];
  const inner = createEmbedder("fake");
  return {
    seen,
    embedder: {
      async embed(inputs: string[]) { seen.push(...inputs); return inner.embed(inputs); },
    } as unknown as import("../src/embed.ts").Embedder,
  };
}

const SAMPLE = [
  "# 记忆动力学",
  "",
  "这个项目要做的不是数据库加检索，而是会忘的记忆。",
  "",
  "## 衰减",
  "",
  "权重按拉伸指数下降。重要性影响速率，不影响初始权重。",
  "",
  "```ts",
  "// 这一整块不许被切开",
  "const w = w0 * Math.exp(-Math.pow(d / tau, beta));",
  "const x = 1;",
  "```",
  "",
  "## 检索",
  "",
  "| 阶段 | 手段 |",
  "|---|---|",
  "| 1 | BM25 |",
  "| 2 | cosine |",
  "",
  "先出候选，再算向量。",
].join("\n");

// ── 分块 ────────────────────────────────────────────────────

test("分块：标题栈进 heading_path，代码块与表格永不切开", () => {
  const { chunks } = chunkMarkdown(SAMPLE);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0]!.headingPath, "记忆动力学");
  assert.ok(chunks.some((c) => c.headingPath === "记忆动力学 > 衰减"));
  assert.ok(chunks.some((c) => c.headingPath === "记忆动力学 > 检索"));

  const code = chunks.find((c) => c.text.includes("Math.exp"))!;
  assert.match(code.text, /```ts[\s\S]*const x = 1;[\s\S]*```/, "代码块被切开了");

  const table = chunks.find((c) => c.text.includes("BM25"))!;
  assert.match(table.text, /\| 阶段 \| 手段 \|[\s\S]*\| 2 \| cosine \|/, "表格被切开了");
});

test("分块：目标/上限/下限/重叠都按 02 §5.2 的数值走", () => {
  // 每句都不一样：句子完全相同的话，块级 sha256 去重会把它们真的删掉（那是正确行为，但不是这里要测的）
  const md = "# T\n\n" + Array.from({ length: 40 }, (_, i) =>
    "第" + i + "句：这段话用来把段落撑长，每一句的内容都不一样。").join("");
  const { chunks } = chunkMarkdown(md, { target: 300, max: 400, min: 80, overlap: 0.15 });
  assert.ok(chunks.length >= 3, `块太少：${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.nTokens <= 400, `超过硬上限：${c.nTokens}`);
  }
  // 重叠：第二块开头应该能在第一块结尾里找到（同一章节内）
  const [a, b] = [chunks[0]!.text, chunks[1]!.text];
  const head = b.slice(0, 12);
  assert.ok(a.includes(head), `第二块开头没和第一块重叠：${JSON.stringify(head)}`);
});

test("分块：小于下限的块向后合并（目录碎片不单独成块）", () => {
  const md = ["# 目录", "", "一、", "", "二、", "", "# 正文", "", "正文在这里，" + "很长".repeat(200)].join("\n");
  const { chunks } = chunkMarkdown(md);
  assert.ok(!chunks.some((c) => c.headingPath === "目录" && c.nTokens < 80 && c.text.trim().length < 10));
});

test("分块：块级 sha256 去重，重复段落只留首个", () => {
  const dup = "重复的段落，内容一模一样，应该在块级被去掉。".repeat(6);
  const md = `# T\n\n${dup}\n\n中间隔一段不同的话让它们不在一个块里。\n\n${dup}`;
  const r = chunkMarkdown(md, { target: 100, max: 140 });
  assert.ok(r.dropped >= 1, `dropped=${r.dropped}`);
  assert.equal(new Set(r.chunks.map((c) => c.sha256)).size, r.chunks.length);
});

test("embedding 输入：章节路径进向量，H1 与标题重复时只留一份", () => {
  const input = embedInput({ title: "记忆动力学", headingPath: "记忆动力学 > 衰减", text: "正文" });
  assert.ok(input.includes("global/记忆动力学 › 衰减"));
  assert.ok(input.endsWith("---\n正文"));
  assert.equal(dedupeTitle("记忆动力学 > 衰减", "记忆动力学"), "衰减");
  assert.equal(dedupeTitle("别的 > 衰减", "记忆动力学"), "别的 > 衰减");
});

test("parseBlocks：没闭合的代码围栏也要保留（宁可留下，不要静默丢弃）", () => {
  const blocks = parseBlocks("# T\n\n```ts\n永远不会闭合\n");
  const code = blocks.find((b) => b.kind === "code");
  assert.ok(code && code.text.includes("永远不会闭合"));
});

test("overlapTail：尽量落在句末，不从半句开始", () => {
  const t = "第一句话。第二句话。第三句话。";
  const tail = overlapTail(t, 0.5);
  assert.ok(!tail.startsWith("句"), tail);
  assert.ok(t.endsWith(tail));
});

// ── 摄入 ────────────────────────────────────────────────────

test("摄入：写 documents/chunks，块可 FTS 检索，第二次秒回 skipped", async () => {
  const { home, db } = rig();
  const f = join(home, "sources", "记忆动力学.md");
  writeFileSync(f, SAMPLE);
  const spy = spyEmbedder();

  const r1 = await ingestFile(db, f, { home, embedder: spy.embedder, now: new Date("2026-10-28T12:00:00Z") });
  assert.equal(r1.skipped, false);
  assert.ok(r1.chunks >= 3);
  assert.match(String(r1.docId), /^doc_[0-9a-f]{16}$/);
  assert.equal(r1.title, "记忆动力学");
  // 章节路径确实进了 embedding 输入
  assert.ok(spy.seen.some((s) => s.includes("记忆动力学 › 衰减")), "章节路径没进向量输入");
  // 正文里不该带章节前缀（返回时正文要干净）
  const first = db.prepare("SELECT text FROM chunks WHERE doc_id=? ORDER BY ord LIMIT 1").get(r1.docId) as { text: string };
  assert.ok(!first.text.startsWith("global/"), first.text.slice(0, 40));

  // FTS 能命中
  const hit = db.prepare("SELECT count(*) c FROM chunks_fts WHERE chunks_fts MATCH ?").get("\"衰减\"") as { c: number };
  assert.ok(hit.c > 0);

  const r2 = await ingestFile(db, f, { home, embedder: spy.embedder });
  assert.equal(r2.skipped, true, "同样内容第二次应该 skipped");
  assert.equal(r2.chunks, 0);
  assert.equal((db.prepare("SELECT count(*) c FROM chunks WHERE deleted_at IS NULL").get() as { c: number }).c, r1.chunks);
});

test("摄入：内容变了 → 新的一批 + 旧块标 deleted_at（不原地改）", async () => {
  const { home, db } = rig();
  const f = join(home, "sources", "a.md");
  writeFileSync(f, "# a\n\n第一版的内容，关于衰减。" + "补充".repeat(60));
  const r1 = await ingestFile(db, f, { home, embedder: createEmbedder("fake") });

  writeFileSync(f, "# a\n\n第二版的内容，关于检索与向量。" + "补充".repeat(60));
  const r2 = await ingestFile(db, f, { home, embedder: createEmbedder("fake") });
  assert.notEqual(r1.docId, r2.docId, "内容变了应该是新文档");

  const live = db.prepare("SELECT count(*) c FROM chunks WHERE deleted_at IS NULL AND doc_id=?").get(r2.docId) as { c: number };
  assert.equal(live.c, r2.chunks);
  const dead = db.prepare("SELECT count(*) c FROM chunks WHERE deleted_at IS NOT NULL AND doc_id=?").get(r1.docId) as { c: number };
  assert.equal(dead.c, r1.chunks, "旧块应该还在（只是标了时间），便于回滚");
  // 旧文档标删
  const oldDoc = db.prepare("SELECT deleted_at FROM documents WHERE id=?").get(r1.docId) as { deleted_at: string | null };
  assert.ok(oldDoc.deleted_at);
  // 旧块也不该再被检索到（FTS 行已删）
  const oldHit = db.prepare("SELECT count(*) c FROM chunks_fts WHERE chunks_fts MATCH ?").get("\"第一版\"") as { c: number };
  assert.equal(oldHit.c, 0);
  assert.equal(listDocs(db).length, 1);
});

test("摄入：忘掉一篇文档后，块检索与列表都不再返回它", async () => {
  const { home, db } = rig();
  const f = join(home, "sources", "b.md");
  writeFileSync(f, "# b\n\n这一段讲向量索引与召回。" + "细节".repeat(80));
  const r = await ingestFile(db, f, { home, embedder: createEmbedder("fake") });
  assert.equal(listDocs(db).length, 1);

  const n = forgetDoc(db, String(r.docId));
  assert.equal(n, r.chunks);
  assert.equal(listDocs(db).length, 0);
  const hit = db.prepare("SELECT count(*) c FROM chunks_fts WHERE chunks_fts MATCH ?").get("\"向量\"") as { c: number };
  assert.equal(hit.c, 0);
});

test("摄入：不支持的类型直接拒，且不写库", async () => {
  const { home, db } = rig();
  const f = join(home, "sources", "x.bin");
  writeFileSync(f, "binary");
  await assert.rejects(() => ingestFile(db, f, { home }), /E_UNSUPPORTED/);
  assert.equal((db.prepare("SELECT count(*) c FROM documents").get() as { c: number }).c, 0);
});

test("批量：一个文件失败不影响其他文件（错误进 results，不炸整批）", async () => {
  const { home, db } = rig();
  writeFileSync(join(home, "sources", "good.md"), "# 好\n\n正文。" + "内容".repeat(80));
  writeFileSync(join(home, "sources", "bad.md"), "");   // 空文件 → E_EMPTY
  const files = collectFiles(join(home, "sources"));
  assert.equal(files.length, 2, "collectFiles 应该收两个");
  const r = await ingestFiles(db, files, { home, embedder: createEmbedder("fake") });
  assert.ok(r.total.files >= 1);
});

test("目录摄入：递归、跳过点文件、相对路径落到 sources/ 下", async () => {
  const { home, db } = rig();
  mkdirSync(join(home, "sources", "子目录"), { recursive: true });
  writeFileSync(join(home, "sources", "子目录", "c.md"), "# c\n\n子目录里的文档。" + "内容".repeat(60));
  writeFileSync(join(home, "sources", ".hidden.md"), "# 不该进");
  const r = await ingestPath(db, join(home, "sources"), { home, embedder: createEmbedder("fake") });
  assert.equal(r.total.files, 1);
  const row = db.prepare("SELECT rel_path FROM documents LIMIT 1").get() as { rel_path: string };
  assert.equal(row.rel_path, "子目录/c.md");
  assert.ok(existsSync(join(home, "markdown")), "规范化 markdown 要落盘（索引可重建）");
});

// ── 检索 ────────────────────────────────────────────────────

test("块检索：两阶段 + 引用格式 doc:<id>#<ord>，且能按章节名命中", async () => {
  const { home, db } = rig();
  const f = join(home, "sources", "记忆动力学.md");
  writeFileSync(f, SAMPLE);
  const doc = await ingestFile(db, f, { home, embedder: createEmbedder("fake") });

  const r = await searchDocs(db, createEmbedder("fake"), "再巩固 锚点", { k: 3 });
  // 这段样例里没有"再巩固"，但"衰减"必须有
  const r2 = await searchDocs(db, createEmbedder("fake"), "衰减 权重", { k: 3 });
  assert.ok(r2.hits.length >= 1, JSON.stringify(r.meta));
  const h = r2.hits[0]!;
  assert.equal(h.docId, doc.docId);
  assert.match(h.cite, /^doc:doc_[0-9a-f]{16}#\d+$/);
  assert.equal(h.title, "记忆动力学");
  assert.ok(h.text.includes("拉伸指数") || h.headingPath.includes("衰减"));
  assert.ok(r2.meta.candidates >= 1);
});

test("块检索：文档被忘掉后搜不到", async () => {
  const { home, db } = rig();
  const f = join(home, "sources", "d.md");
  writeFileSync(f, "# d\n\n关于契约层永不衰减的一段话。" + "内容".repeat(60));
  const doc = await ingestFile(db, f, { home, embedder: createEmbedder("fake") });
  assert.ok((await searchDocs(db, createEmbedder("fake"), "契约层", {})).hits.length >= 1);
  forgetDoc(db, String(doc.docId));
  assert.equal((await searchDocs(db, createEmbedder("fake"), "契约层", {})).hits.length, 0);
});

test("doc.search / doc.list 是 T0，走 execute 能直接调（不用确认）", async () => {
  const { home, db } = rig();
  const f = join(home, "sources", "e.md");
  writeFileSync(f, "# e\n\n领地是它自己划的圈。" + "内容".repeat(80));
  await ingestFile(db, f, { home, embedder: createEmbedder("fake") });

  const policy = await loadPolicy(home);
  const ctx = { home, now: () => new Date(), db, embedder: createEmbedder("fake") };
  const s = await execute({ db, policy, ctx }, "doc.search", { q: "领地" });
  assert.equal(s.ok, true, s.output);
  assert.match(s.output, /doc:doc_[0-9a-f]{16}#\d+/);

  const l = await execute({ db, policy, ctx }, "doc.list", {});
  assert.equal(l.ok, true);
  assert.match(l.output, /e\b|e ｜/);
  assert.equal(l.tier, "T0");
});

// ── 迁移 ────────────────────────────────────────────────────

test("schema v7：v6 老库补上 documents/chunks 的新列", () => {
  const home = H();
  const f = join(home, "old.db");
  const old = new DatabaseSync(f);
  old.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  old.exec("CREATE TABLE documents (id TEXT PRIMARY KEY, uri TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE," +
    " title TEXT, md_path TEXT, created_at TEXT NOT NULL, deleted_at TEXT);");
  old.exec("CREATE TABLE chunks (id INTEGER PRIMARY KEY, doc_id TEXT NOT NULL, ord INTEGER NOT NULL," +
    " heading_path TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, text_bigram TEXT NOT NULL DEFAULT ''," +
    " n_tokens INTEGER NOT NULL DEFAULT 0, sha256 TEXT);");
  old.prepare("INSERT INTO meta(key,value) VALUES('schema_version','6')").run();
  old.close();

  const d = openDb(f);
  assert.equal(meta(d.db, "schema_version"), String(SCHEMA_VERSION));
  const docCols = (d.db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["rel_path", "mime", "bytes", "converter", "meta_json", "n_chunks"]) {
    assert.ok(docCols.includes(c), `documents 缺 ${c}`);
  }
  const chunkCols = (d.db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(chunkCols.includes("embedding"));
  assert.ok(chunkCols.includes("deleted_at"));
  d.db.close();
  void readFileSync; void sourcesDir;
});
