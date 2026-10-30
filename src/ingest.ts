/**
 * 摄入管道（02 §5.1 转换 → §5.2 分块 → §5.3 幂等）
 *
 * 一句话：**文件 → 规范化 markdown → 块 → 索引**，每一步都可重放。
 *
 * 三条纪律：
 *  ① **转换是子进程，不是 eval**：markitdown 走 `python -X utf8 -c`，路径放在 `sys.argv[1]`，
 *     绝不把路径拼进命令串（T3 那一课的同一个教训）。
 *  ② **幂等靠 sha256**：文件没变就秒回 `skipped`；变了就写新的一批、旧块标 `deleted_at`，
 *     不原地改——这样"昨天那版说了什么"还能回答（02 §5.3）。
 *  ③ **索引可丢弃**：真源是 `data/sources/` 的原文件与 `data/markdown/` 的规范化文本，
 *     `documents`/`chunks` 随时能重建。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { atomicWriteFile } from "./fsx.ts";
import { bigramText } from "./text.ts";
import { resolvePython, pythonHint } from "./pyenv.ts";
import { chunkMarkdown, embedInput } from "./chunk.ts";
import type { Embedder } from "./embed.ts";

/** 本来就是纯文本：直接读，少一个失败点 */
const PASSTHROUGH = new Set([".md", ".markdown", ".txt"]);
/** 交给 markitdown */
const CONVERTIBLE = new Set([
  ".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm", ".epub",
  ".csv", ".json", ".xml", ".rtf", ".ipynb",
]);

const MAX_BYTES = 32 * 1024 * 1024;

/** 支持的扩展名（上传接口与 CLI 共用这一份，别抄两遍） */
export const SUPPORTED_EXTS: ReadonlySet<string> = new Set([...PASSTHROUGH, ...CONVERTIBLE]);
export const MAX_INGEST_BYTES = MAX_BYTES;

export const sourcesDir = (home: string) => join(home, "sources");
export const markdownDir = (home: string) => join(home, "markdown");

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const docId = (sha: string) => `doc_${sha.slice(0, 16)}`;
const posix = (p: string) => p.split("\\").join("/");

function mimeOf(ext: string): string {
  const m: Record<string, string> = {
    ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".html": "text/html", ".htm": "text/html", ".epub": "application/epub+zip",
    ".csv": "text/csv", ".json": "application/json", ".xml": "application/xml",
  };
  return m[ext] ?? "application/octet-stream";
}

export interface ConvertResult { markdown: string; converter: string }

/**
 * 转成 markdown。**路径进 argv，不进命令串**。
 * `enable_plugins=False`（缩小攻击面）、强制 UTF-8（18 §5.1 第 1 条的老坑）。
 */
export function convertToMarkdown(file: string, env: Record<string, string | undefined> = process.env): ConvertResult {
  const ext = extname(file).toLowerCase();
  if (PASSTHROUGH.has(ext)) return { markdown: readFileSync(file, "utf8"), converter: "passthrough" };
  if (!CONVERTIBLE.has(ext)) {
    throw new Error(`E_UNSUPPORTED: ${ext || "(无扩展名)"}（支持 ${[...PASSTHROUGH, ...CONVERTIBLE].join(" ")}）`);
  }

  const py = resolvePython({ env });
  if (!py) throw new Error("E_NO_PYTHON: " + pythonHint());

  const script = [
    "import sys",
    "from markitdown import MarkItDown",
    "md = MarkItDown(enable_plugins=False)",
    "out = md.convert(sys.argv[1]).markdown",
    "sys.stdout.buffer.write(out.encode('utf-8'))",
  ].join(String.fromCharCode(10));

  const r = spawnSync(py.cmd, [...py.args, "-X", "utf8", "-c", script, file], {
    encoding: "buffer", timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: { ...env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } as NodeJS.ProcessEnv,
  });
  if (r.error) throw new Error(`E_CONVERT: ${String((r.error as Error).message).slice(0, 120)}`);
  if (r.status !== 0) {
    const err = Buffer.from(r.stderr ?? []).toString("utf8").trim().split(String.fromCharCode(10)).slice(-3).join(" ");
    throw new Error(`E_CONVERT: ${err.slice(0, 200) || `exit ${r.status}`}`);
  }
  const text = Buffer.from(r.stdout ?? []).toString("utf8");
  if (text.includes("\uFFFD")) throw new Error("E_ENCODING: 转换结果不是干净 UTF-8");
  return { markdown: text, converter: "markitdown" };
}

export interface IngestOpts {
  home: string;
  /** 相对路径的基准（默认 home/sources） */
  root?: string;
  scope?: string;
  title?: string;
  now?: Date;
  embedder?: Embedder | null;
  /** 文件没变也重跑（重建索引用） */
  force?: boolean;
  /** 敏感度：默认 local_only（02 §10.1：磁盘/文档摄入不出网）；要分享得显式标 */
  sensitivity?: "local_only" | "shareable";
}

export interface IngestResult {
  file: string;
  docId: string | null;
  title: string;
  chunks: number;
  tokens: number;
  skipped: boolean;
  deduped: number;
  degraded: string[];
  ms: number;
}

function titleOf(md: string, fallback: string): string {
  const h1 = md.match(/^\s*#\s+(.+)$/m);
  return (h1?.[1] ?? fallback).trim().slice(0, 200);
}

/** 单个文件摄入（幂等：同样内容第二次直接 skipped） */
export async function ingestFile(db: DatabaseSync, file: string, o: IngestOpts): Promise<IngestResult> {
  const t0 = Date.now();
  const now = o.now ?? new Date();
  const degraded: string[] = [];
  const rel = posix(relative(o.root ?? sourcesDir(o.home), file));
  const fallbackTitle = o.title ?? basename(file);

  const st = statSync(file);
  if (st.size > MAX_BYTES) throw new Error(`E_TOO_BIG: ${(st.size / 1048576).toFixed(1)}MB > 32MB`);
  const raw = readFileSync(file);
  const sha = sha256(raw);

  if (!o.force) {
    const existing = db.prepare("SELECT id,title FROM documents WHERE sha256=? AND deleted_at IS NULL").get(sha) as
      { id: string; title: string } | undefined;
    if (existing) {
      return { file: rel, docId: existing.id, title: existing.title ?? fallbackTitle, chunks: 0, tokens: 0, skipped: true, deduped: 0, degraded, ms: Date.now() - t0 };
    }
  }

  // ① 转换
  const { markdown, converter } = convertToMarkdown(file);
  if (!markdown.trim()) throw new Error("E_EMPTY: 转换结果是空的");

  // ② 规范化文本落盘（索引可重建的中间产物）
  const id = docId(sha);
  const mdPath = join(markdownDir(o.home), `${id}.md`);
  mkdirSync(markdownDir(o.home), { recursive: true });
  atomicWriteFile(mdPath, markdown);

  // ③ 分块
  const docTitle = titleOf(markdown, fallbackTitle);
  const { chunks, dropped, stats } = chunkMarkdown(markdown);

  // ④ 向量（章节路径进 embedding 输入，正文单独存 —— 02 §5.2）
  const vectors: Array<Float32Array | null> = new Array(chunks.length).fill(null);
  if (chunks.length) {
    if (!o.embedder) degraded.push("no_embedder");
    else {
      try {
        const inputs = chunks.map((c) => embedInput({ scope: o.scope, title: docTitle, headingPath: c.headingPath, text: c.text }));
        for (let i = 0; i < inputs.length; i += 16) {
          const got = await o.embedder.embed(inputs.slice(i, i + 16));
          got.forEach((v, j) => { vectors[i + j] = v; });
        }
      } catch (e) {
        degraded.push(`E_EMBED: ${String((e as Error).message ?? e).slice(0, 80)}`);
      }
    }
  }

  // ⑤ 写库：同 rel_path 的上一份标 deleted_at（不原地改），新的一批插进去
  const old = db.prepare("SELECT id FROM documents WHERE rel_path=? AND sha256<>? AND deleted_at IS NULL")
    .all(rel, sha) as Array<{ id: string }>;
  if (old.length) {
    const ts = now.toISOString();
    for (const od of old) {
      const live = db.prepare("SELECT id FROM chunks WHERE doc_id=? AND deleted_at IS NULL").all(od.id) as Array<{ id: number }>;
      for (const c of live) db.prepare("DELETE FROM chunks_fts WHERE rowid=?").run(BigInt(c.id));
      db.prepare("UPDATE chunks SET deleted_at=? WHERE doc_id=? AND deleted_at IS NULL").run(ts, od.id);
      db.prepare("UPDATE documents SET deleted_at=? WHERE id=?").run(ts, od.id);
    }
  }

  const sensitivity = o.sensitivity === "shareable" ? "shareable" : "local_only";
  db.prepare(
    `INSERT INTO documents(id,uri,sha256,title,md_path,created_at,deleted_at,rel_path,mime,bytes,converter,meta_json,n_chunks,sensitivity)
     VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)
     ON CONFLICT(sha256) DO UPDATE SET deleted_at=NULL, n_chunks=excluded.n_chunks,
       title=excluded.title, md_path=excluded.md_path, meta_json=excluded.meta_json`,
  ).run(id, `file:${rel}`, sha, docTitle, mdPath, now.toISOString(), rel,
    mimeOf(extname(file).toLowerCase()), st.size, converter,
    JSON.stringify({ blocks: stats.blocks, sections: stats.sections, avgTokens: stats.avgTokens }), chunks.length,
    sensitivity);

  let inserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const v = vectors[i];
    const r = db.prepare(
      `INSERT INTO chunks(doc_id,ord,heading_path,text,text_bigram,n_tokens,sha256,embedding,deleted_at)
       VALUES(?,?,?,?,?,?,?,?,NULL)`,
    ).run(id, c.ord, c.headingPath, c.text, bigramText(c.text + " " + c.headingPath), c.nTokens, c.sha256,
      v ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null);
    db.prepare("INSERT INTO chunks_fts(rowid, text_bigram, heading_path) VALUES(?,?,?)")
      .run(BigInt(Number(r.lastInsertRowid)), bigramText(c.text + " " + c.headingPath), c.headingPath);
    inserted++;
  }

  return {
    file: rel, docId: id, title: docTitle, chunks: inserted,
    tokens: chunks.reduce((n, c) => n + c.nTokens, 0),
    skipped: false, deduped: dropped, degraded, ms: Date.now() - t0,
  };
}

/** 递归收集可摄入的文件（跳过点开头的） */
export function collectFiles(p: string): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) rec(abs);
      else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase();
        if (PASSTHROUGH.has(ext) || CONVERTIBLE.has(ext)) out.push(abs);
      }
    }
  };
  if (existsSync(p)) {
    if (statSync(p).isDirectory()) rec(p);
    else out.push(p);
  }
  return out.sort();
}

export interface BatchResult {
  results: IngestResult[];
  total: { files: number; chunks: number; skipped: number; failed: number };
}

/** 批量摄入（失败的文件不中断整批：单条失败记在 results 里） */
export async function ingestFiles(db: DatabaseSync, files: string[], o: IngestOpts): Promise<BatchResult> {
  const results: IngestResult[] = [];
  for (const f of files) {
    try {
      results.push(await ingestFile(db, f, o));
    } catch (e) {
      results.push({
        file: posix(relative(o.root ?? sourcesDir(o.home), f)), docId: null, title: basename(f),
        chunks: 0, tokens: 0, skipped: false, deduped: 0,
        degraded: [String((e as Error).message ?? e).slice(0, 160)], ms: 0,
      });
    }
  }
  return {
    results,
    total: {
      files: results.length,
      chunks: results.reduce((n, r) => n + r.chunks, 0),
      skipped: results.filter((r) => r.skipped).length,
      failed: results.filter((r) => r.degraded.some((d) => d.startsWith("E_"))).length,
    },
  };
}

export const ingestPath = (db: DatabaseSync, p: string, o: IngestOpts): Promise<BatchResult> =>
  ingestFiles(db, collectFiles(p), o);

export interface DocRow {
  id: string;
  title: string;
  rel_path: string | null;
  chunks: number;
  bytes: number | null;
  converter: string | null;
  created_at: string;
  sensitivity: "local_only" | "shareable";
}

export function listDocs(db: DatabaseSync, limit = 100): DocRow[] {
  const rows = db.prepare(
    `SELECT id, title, rel_path, n_chunks AS chunks, bytes, converter, created_at,
            COALESCE(sensitivity, 'local_only') AS sensitivity
       FROM documents WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id), title: String(r.title ?? ""), rel_path: r.rel_path ? String(r.rel_path) : null,
    chunks: Number(r.chunks ?? 0), bytes: r.bytes === null || r.bytes === undefined ? null : Number(r.bytes),
    converter: r.converter ? String(r.converter) : null, created_at: String(r.created_at),
    sensitivity: r.sensitivity === "shareable" ? "shareable" : "local_only",
  }));
}

/** 改一篇文档的敏感度（面板里的“可发送 / 仅本地”开关） */
export function setDocSensitivity(
  db: DatabaseSync, id: string, value: "local_only" | "shareable", now = new Date(),
): boolean {
  const r = db.prepare("UPDATE documents SET sensitivity=? WHERE id=? AND deleted_at IS NULL")
    .run(value === "shareable" ? "shareable" : "local_only", id);
  void now;
  return Number(r.changes) > 0;
}

/** 忘掉一篇文档：块与文档标 deleted_at，FTS 行真删（不让它再被召回） */
export function forgetDoc(db: DatabaseSync, id: string, now = new Date()): number {
  const live = db.prepare("SELECT id FROM chunks WHERE doc_id=? AND deleted_at IS NULL").all(id) as Array<{ id: number }>;
  for (const c of live) db.prepare("DELETE FROM chunks_fts WHERE rowid=?").run(BigInt(c.id));
  db.prepare("UPDATE chunks SET deleted_at=? WHERE doc_id=? AND deleted_at IS NULL").run(now.toISOString(), id);
  db.prepare("UPDATE documents SET deleted_at=? WHERE id=?").run(now.toISOString(), id);
  return live.length;
}
