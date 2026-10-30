/**
 * 索引身份（C-2）
 *
 * 为什么需要它：embedding 模型一换，**旧向量和新向量不可比**（不同模型的前 512 维
 * 没有共同语义）。而 `memories.embedding` / `chunks.embedding` 里存的是旧模型算的，
 * 换了模型不重建就等于把两套坐标系混在一起排序 —— 检索会**悄悄变差，且不报错**。
 *
 * 两个 meta 键分工：
 *   embed_model        —— 当前配置的 embedding 模型（serve 启动 / models use 时写）
 *   embed_index_model  —— **库里现有向量是哪一版模型算出来的**（只有 reembed 成功才写）
 *
 * 两者不一致 = 索引过期。`/health` 报 `embed-index-stale`，检索结果里也会标一句。
 */
import type { DatabaseSync } from "node:sqlite";

export const CUR_KEY = "embed_model";
export const BUILT_KEY = "embed_index_model";

export interface IndexState {
  /** 当前配置的模型（如 ollama:bge-m3） */
  current: string | null;
  /** 现有向量的模型 */
  built: string | null;
  /** 带向量的行数（memories + chunks） */
  vectors: number;
  /** 是否过期：有向量、且两边的模型名不同 */
  stale: boolean;
}

export function readMeta(db: DatabaseSync, key: string): string | null {
  const r = db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value?: string } | undefined;
  return r?.value ?? null;
}

function countVectors(db: DatabaseSync): number {
  const a = (db.prepare("SELECT count(*) c FROM memories WHERE embedding IS NOT NULL").get() as { c?: number })?.c ?? 0;
  const b = (db.prepare("SELECT count(*) c FROM chunks WHERE embedding IS NOT NULL").get() as { c?: number })?.c ?? 0;
  return Number(a) + Number(b);
}

export function indexState(db: DatabaseSync, currentOverride?: string | null): IndexState {
  // 优先用调用方从**配置**推导出来的模型（meta.embed_model 只是启动时留的痕迹，
  // 而且历史上有过“启动写的是 defaultConfig 而不是 resolveConfig”的问题）
  const current = currentOverride ?? readMeta(db, CUR_KEY);
  const built = readMeta(db, BUILT_KEY);
  let vectors = 0;
  try { vectors = countVectors(db); } catch { /* 表还没建好 */ }
  // 没有向量就谈不上"不一致"（新库/清空后）；有向量但没记录过模型 → 算过期（保守）
  const stale = vectors > 0 && built !== current;
  return { current, built, vectors, stale };
}

/**
 * 库里还没有任何向量时，直接盖戳：没有"旧向量"可矛盾，
 * 否则新装的库只要写进第一条记忆就会一直显示 stale（假警报）。
 */
export function ensureIndexModel(db: DatabaseSync, current: string): void {
  const built = readMeta(db, BUILT_KEY);
  if (built) return;
  let vectors = 0;
  try { vectors = countVectors(db); } catch { return; }
  if (vectors === 0) markIndexBuilt(db, current);
}

/** 重建成功后调用：这把向量现在归这个模型管 */
export function markIndexBuilt(db: DatabaseSync, model: string): void {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(BUILT_KEY, model);
}

/** 写当前模型（serve 启动 / models use 用） */
export function setCurrentModel(db: DatabaseSync, model: string): void {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(CUR_KEY, model);
}
