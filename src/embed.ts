/**
 * Embedding（13 §2 role: embed）
 * 默认 512 维（D-B）；`ollama` 走 127.0.0.1:11434，`fake` 用确定性哈希（测试/基准用）。
 */
import { createHash } from "node:crypto";

export const DIM = 512;

export type EmbedProvider = "ollama" | "fake";

export interface Embedder {
  name: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function l2norm(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / n;
  return v;
}

/** 确定性假向量：同一文本永远同一向量，用于检索逻辑与性能基准 */
export function fakeEmbed(text: string, dim = DIM): Float32Array {
  const v = new Float32Array(dim);
  let h = createHash("sha256").update(text).digest();
  for (let i = 0; i < dim; i++) {
    if (i > 0 && i % 32 === 0) h = createHash("sha256").update(h).digest();
    v[i] = ((h[i % 32] ?? 0) / 255) * 2 - 1;
  }
  return l2norm(v);
}

/**
 * 本地 embedding 的调用统计（2026-11-03）。
 *
 * 用户的原话：「本地 LLM 在我这里完全未知，我根本就不知道它在干什么，它的工作状态完全未知」。
 * 查下来是真的：usage 表里只有云端的记录，本地 embed 一条都没有 —— 而它**每轮检索都在跑**。
 * 这个计数器不写库（每次检索写一行会把库撑爆），/health 与面板读它显示。
 */
export const embedStats = { calls: 0, texts: 0, ms: 0, lastAt: "", failed: 0 };

function noteEmbed(n: number, ms: number, ok: boolean): void {
  if (ok) { embedStats.calls += 1; embedStats.texts += n; embedStats.ms += ms; }
  else embedStats.failed += 1;
  embedStats.lastAt = new Date().toISOString();
}

export function createEmbedder(kind: EmbedProvider, opts: { model?: string; baseUrl?: string } = {}): Embedder {
  if (kind === "fake") {
    return { name: "fake", dim: DIM, async embed(texts) { return texts.map((t) => fakeEmbed(t)); } };
  }
  const base = opts.baseUrl ?? "http://127.0.0.1:11434";
  const model = opts.model ?? "bge-m3";
  const doEmbed = async (texts: string[]): Promise<Float32Array[]> => {
    // 批量走 /api/embed（一次请求多条）；老版本 Ollama 没有该端点时回落到 /api/embeddings
    const r = await fetch(`${base}/api/embed`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
    });
    if (r.ok) {
      const j = (await r.json()) as { embeddings?: number[][] };
      if (j.embeddings?.length === texts.length) {
        return j.embeddings.map((v) => l2norm(new Float32Array(v.slice(0, DIM))));
      }
    }
    const out: Float32Array[] = [];
    for (const t of texts) {
      const rr = await fetch(`${base}/api/embeddings`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: t }),
      });
      if (!rr.ok) throw new Error(`E_EMBED: ${rr.status} ${await rr.text().catch(() => "")}`);
      const j = (await rr.json()) as { embedding: number[] };
      out.push(l2norm(new Float32Array(j.embedding.slice(0, DIM))));
    }
    return out;
  };
  return {
    name: `${model}@${DIM}`, dim: DIM,
    async embed(texts) {
      const t0 = Date.now();
      try {
        const out = await doEmbed(texts);
        noteEmbed(texts.length, Date.now() - t0, true);
        return out;
      } catch (e) {
        noteEmbed(texts.length, Date.now() - t0, false);
        throw e;
      }
    },
  };
}

export async function probe(kind: EmbedProvider): Promise<{ ok: boolean; dim?: number; err?: string }> {
  try {
    const e = createEmbedder(kind);
    const vs = await e.embed(["探测"]);
    const v = vs[0];
    if (!v) return { ok: false, err: "E_EMPTY_EMBEDDING" };
    return { ok: true, dim: v.length };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}
