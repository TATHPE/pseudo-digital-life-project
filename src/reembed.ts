/**
 * 重建向量索引（C-2）
 *
 * 用途只有一个：**换了 embedding 模型之后，把库里所有向量重算一遍**。
 *
 * 三条纪律：
 *  1. **不动正文**：只写 `memories.embedding` / `chunks.embedding`（和派生的 vec0 表），
 *     绝不碰 text / kind / weight —— 这是"派生数据可重建"的边界。
 *  2. **全成或全不成**：整批写在**一个事务**里，任何一条失败就回滚，
 *     库里仍然是旧索引（旧的至少自洽），并把原因写进 `meta.reembed_error`。
 *  3. **只在成功后盖戳**：`embed_index_model` 只有重建真的成功才更新 ——
 *     否则"索引过期"这个状态会被自己抹掉。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "./embed.ts";
import { markIndexBuilt, indexState } from "./embedindex.ts";

export interface ReembedReport {
  ok: boolean;
  memories: number;
  chunks: number;
  ms: number;
  from: string | null;
  to: string;
  vec?: "rebuilt" | "skipped";
  error?: string;
}

export interface ReembedDeps {
  db: DatabaseSync;
  embedder: Embedder;
  /** 目标模型名（写进 embed_index_model），如 ollama:bge-m3 */
  model: string;
  /** 每批多少条（默认 24） */
  batch?: number;
}

export async function reembed(deps: ReembedDeps): Promise<ReembedReport> {
  const t0 = Date.now();
  const db = deps.db;
  const batch = Math.max(1, deps.batch ?? 24);
  const before = indexState(db);

  const mems = db.prepare("SELECT id, text FROM memories WHERE text IS NOT NULL ORDER BY id").all() as Array<{ id: number; text: string }>;
  // 软删除的块（忘掉的文档）不重算：它们已经不参与召回，重算只是白花时间
  const chunks = db.prepare("SELECT id, text FROM chunks WHERE deleted_at IS NULL").all() as Array<{ id: number; text: string }>;

  // 先算完再写：中途失败时库里一行都没动，不存在"一半新一半旧"
  const memVecs = new Map<number, Float32Array>();
  const chunkVecs = new Map<number, Float32Array>();
  try {
    for (let i = 0; i < mems.length; i += batch) {
      const slice = mems.slice(i, i + batch);
      const vs = await deps.embedder.embed(slice.map((m) => m.text));
      slice.forEach((m, k) => { const v = vs[k]; if (v) memVecs.set(m.id, v); });
    }
    for (let i = 0; i < chunks.length; i += batch) {
      const slice = chunks.slice(i, i + batch);
      const vs = await deps.embedder.embed(slice.map((c) => c.text));
      slice.forEach((c, k) => { const v = vs[k]; if (v) chunkVecs.set(c.id, v); });
    }
  } catch (e) {
    const msg = `E_EMBED: ${String((e as Error).message ?? e).slice(0, 160)}`;
    recordError(db, msg);
    return { ok: false, memories: 0, chunks: 0, ms: Date.now() - t0, from: before.built, to: deps.model, error: msg };
  }

  // 写库：一个事务，失败整体回滚
  const updM = db.prepare("UPDATE memories SET embedding=? WHERE id=?");
  const updC = db.prepare("UPDATE chunks SET embedding=? WHERE id=?");
  let vecState: "rebuilt" | "skipped" = "rebuilt";
  db.exec("BEGIN");
  try {
    for (const [id, v] of memVecs) updM.run(new Uint8Array(v.buffer.slice(0)), id);
    for (const [id, v] of chunkVecs) updC.run(new Uint8Array(v.buffer.slice(0)), id);
    // 派生的 vec0 表：能重建就重建，扩展没加载就跳过（不影响 BLOB 主路径）
    try {
      db.prepare("DELETE FROM vec_memories").run();
      const ins = db.prepare("INSERT INTO vec_memories(memory_id,embedding) VALUES(?,?)");
      for (const [id, v] of memVecs) ins.run(BigInt(id), new Uint8Array(v.buffer.slice(0)));
    } catch {
      vecState = "skipped";
    }
    markIndexBuilt(db, deps.model);
    db.prepare("DELETE FROM meta WHERE key='reembed_error'").run();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    const msg = `E_WRITE: ${String((e as Error).message ?? e).slice(0, 160)}`;
    recordError(db, msg);
    return { ok: false, memories: 0, chunks: 0, ms: Date.now() - t0, from: before.built, to: deps.model, error: msg };
  }

  return {
    ok: true, memories: memVecs.size, chunks: chunkVecs.size, ms: Date.now() - t0,
    from: before.built, to: deps.model, vec: vecState,
  };
}

function recordError(db: DatabaseSync, msg: string): void {
  try {
    db.prepare("INSERT INTO meta(key,value) VALUES('reembed_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(msg);
    db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,0)")
      .run(new Date().toISOString(), "reembed_failed", "user", "index", msg.slice(0, 200));
  } catch { /* 记录失败不阻断 */ }
}
