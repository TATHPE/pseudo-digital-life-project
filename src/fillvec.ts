/**
 * 补向量：只补**缺的**，不重建全部（2026-11-03）。
 *
 * 起因：`/health` 报 `embed-index-incomplete:33`，33 条全是 `source_ref='startup'`
 * 那个启动补账写下的记忆 —— `remember()` 只有传了 embedding 才写向量，而那条路径不传。
 * 于是**每次启动只要空档 >24h 就多一条没向量的记忆**，覆盖率只降不升。
 *
 * 上次我手动 `reembed` 补了一次，那只是把水舀出去，没关水龙头。
 * 这个函数是水龙头：写入之后把缺的补上。
 *
 * 三条边界：
 *  · 只处理 embedding IS NULL 的 active 记忆（不碰已有向量）
 *  · 批量、有上限（一次最多 200 条，避免把一整轮对话卡住）
 *  · 失败不抛错：补不上就留着，`/health` 会继续报 —— 不假装补齐了
 */
import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "./embed.ts";
import { indexState } from "./embedindex.ts";

export interface FillReport {
  /** 补了多少条 */
  filled: number;
  /** 还剩多少条缺 */
  missing: number;
  /** 失败原因（有就是没补全） */
  error?: string;
}

/**
 * 把缺向量的记忆补上。给 serve 启动后 / 闲时整理后调用。
 * 注意：**不阻塞调用方**是调用方的事（这里是 async，await 它就等）。
 */
export async function fillMissingEmbeddings(
  db: DatabaseSync,
  embedder: Embedder | null,
  opts: { limit?: number; batch?: number } = {},
): Promise<FillReport> {
  const limit = Math.max(1, opts.limit ?? 200);
  const batch = Math.max(1, opts.batch ?? 16);
  const before = indexState(db).missing;
  if (!before) return { filled: 0, missing: 0 };
  if (!embedder) return { filled: 0, missing: before, error: "E_NO_EMBEDDER" };

  const rows = db.prepare(
    "SELECT id, text FROM memories WHERE status='active' AND embedding IS NULL AND text IS NOT NULL ORDER BY id DESC LIMIT ?",
  ).all(limit) as Array<{ id: number; text: string }>;
  if (!rows.length) return { filled: 0, missing: before };

  let filled = 0;
  try {
    for (let i = 0; i < rows.length; i += batch) {
      const slice = rows.slice(i, i + batch);
      const vs = await embedder.embed(slice.map((r) => r.text));
      db.exec("BEGIN");
      try {
        const upd = db.prepare("UPDATE memories SET embedding=? WHERE id=?");
        let vec = false;
        try {
          // vec0 表存在才写；扩展没加载就只写 BLOB 主路径（检索兜底会用它）
          db.prepare("SELECT count(*) c FROM vec_memories LIMIT 1").get();
          vec = true;
        } catch { vec = false; }
        const insVec = vec ? db.prepare("INSERT OR REPLACE INTO vec_memories(memory_id, embedding) VALUES(?,?)") : null;
        slice.forEach((r, k) => {
          const v = vs[k];
          if (!v) return;
          const bytes = new Uint8Array(v.buffer.slice(0));
          upd.run(bytes, r.id);
          if (insVec) { try { insVec.run(BigInt(r.id), bytes); } catch { /* vec 写失败不算致命 */ } }
          filled++;
        });
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    }
  } catch (e) {
    return { filled, missing: indexState(db).missing, error: String((e as Error)?.message ?? e).slice(0, 120) };
  }
  return { filled, missing: indexState(db).missing };
}
