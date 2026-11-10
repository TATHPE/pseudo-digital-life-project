/**
 * 装配层基准的离线向量表（2026-11-10）
 *
 * 为什么不是给 CI 一个 fake embedder：fake 是 SHA 哈希造出来的，语义全无。
 * 用它跑 eval:assembly，召回/拒答两列会变成随机数，基准就从「质量闸门」退化成
 * 「这段代码不崩」——那是假装覆盖。CI 要判的恰恰是配额、隐私闸门、P10 窗口
 * 这些**依赖语义排序**的东西，向量必须和本地真 bge-m3 等价。
 *
 * 所以：本机用真模型把夹具里每条记忆、每个问题的 512 维向量算好落盘，
 * CI 查表。表带指纹（模型 + 维度 + 夹具全文哈希）：换模型、改夹具、改维度
 * 而不重生成，verifyVectors 直接判红，绝不静默用旧向量。
 *
 *   node --experimental-strip-types tools/eval-assembly.ts --refresh-embeddings  # 重生成
 *   node --experimental-strip-types tools/eval-assembly.ts --offline             # CI 用
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmbedder, DIM, l2norm, type Embedder } from "../src/embed.ts";

const NL = String.fromCharCode(10);
export const DEFAULT_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "assembly");
export const VECTORS_FILE = "embeddings.json";

export interface VectorTable {
  /** 生成时的模型名，例：bge-m3@512 */
  model: string;
  dim: number;
  /** sha256(模型 + 维度 + 夹具里全部文本)，夹具一改就变 */
  fixtureHash: string;
  /** 文本 → l2 归一化后的向量（6 位小数，够还原 cos 排序） */
  vectors: Record<string, number[]>;
}

export interface MemRowLike { text: string }
export interface CaseLike { q: string }

/** 夹具里所有需要向量的文本：记忆正文 + 每个 case 的问题。顺序无关（会排序） */
export function fixtureTexts(dir = DEFAULT_FIXTURE_DIR): string[] {
  const mems = readFileSync(join(dir, "memories.jsonl"), "utf8").split(NL).filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as MemRowLike).text);
  const cases = readFileSync(join(dir, "cases.jsonl"), "utf8").split(NL).filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as CaseLike).q);
  return [...new Set([...mems, ...cases])].sort();
}

export function hashFor(model: string, dim: number, texts: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ model, dim, texts: [...texts].sort() }))
    .digest("hex").slice(0, 16);
}

export function loadVectors(dir = DEFAULT_FIXTURE_DIR): VectorTable {
  const p = join(dir, VECTORS_FILE);
  if (!existsSync(p)) {
    throw new Error(`E_ASSEMBLY_NO_VECTORS: 缺 ${p}；在本机跑一次 --refresh-embeddings 再提交`);
  }
  return JSON.parse(readFileSync(p, "utf8")) as VectorTable;
}

/** 返回问题列表；空数组 = 这张表和当前夹具/维度完全对得上 */
export function verifyVectors(t: VectorTable, texts: string[], model: string, dim = DIM): string[] {
  const bad: string[] = [];
  if (t.model !== model) bad.push(`模型不符：表 ${t.model} / 当前 ${model}（换模型要重生成）`);
  if (t.dim !== dim) bad.push(`维度不符：表 ${t.dim} / 当前 ${dim}（JJ_EMBED_DIM 变了要重生成）`);
  const want = hashFor(model, dim, texts);
  if (t.fixtureHash !== want) bad.push(`夹具指纹不符：表 ${t.fixtureHash} / 当前 ${want}（改夹具要 --refresh-embeddings）`);
  for (const s of texts) {
    const v = t.vectors[s];
    if (!v) { bad.push(`缺向量：${s.slice(0, 24)}…`); continue; }
    if (v.length !== dim) bad.push(`向量维度 ${v.length} ≠ ${dim}：${s.slice(0, 24)}…`);
  }
  return [...new Set(bad)];
}

/**
 * 查表 embedder：未命中文本**抛错**，不退化到 fake。
 * 静默退化是最危险的——CI 会全绿，但判的是另一套语义。
 */
export function tableEmbedder(t: VectorTable): Embedder {
  return {
    name: `table:${t.model}`, dim: t.dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((s) => {
        const v = t.vectors[s];
        if (!v) throw new Error(`E_ASSEMBLY_VECTOR_MISS: 表里没有「${s.slice(0, 30)}…」，改过夹具就重生成向量表`);
        return l2norm(new Float32Array(v));
      });
    },
  };
}

/** 用真 Ollama 重新生成向量表（本机执行，不进 CI） */
export async function refreshVectors(
  dir = DEFAULT_FIXTURE_DIR,
  o: { baseUrl?: string; model?: string } = {},
): Promise<{ table: VectorTable; count: number }> {
  const model = o.model ?? "bge-m3";
  const embed = createEmbedder("ollama", {
    ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
    model,
  });
  const texts = fixtureTexts(dir);
  const vs = await embed.embed(texts);
  if (vs.length !== texts.length) throw new Error("E_ASSEMBLY_EMBED_COUNT");
  const vectors: Record<string, number[]> = {};
  for (let i = 0; i < texts.length; i++) {
    const v = vs[i]!;
    // 6 位小数：float32 的精度本就到此为止，省一半体积且排序完全不变
    vectors[texts[i]!] = Array.from(v, (x) => Number(x.toFixed(6)));
  }
  const name = `${model}@${DIM}`;
  const table: VectorTable = {
    model: name, dim: DIM, fixtureHash: hashFor(name, DIM, texts), vectors,
  };
  writeFileSync(join(dir, VECTORS_FILE), JSON.stringify(table));
  return { table, count: texts.length };
}
