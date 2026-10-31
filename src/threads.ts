/**
 * 线索层（借自衔枝 Twig 的 thread 概念，但**不新建表**）。
 *
 * 它要回答的问题：**"这件事发展到了哪一步"**，而不是"哪几条聊天记录最像"。
 * 「我妈下周三生日，记得提醒我买蛋糕」不是一条事实，是一根**还没闭合的线**。
 *
 * 为什么不加表：现有结构已经够用 ——
 *   · 线索本体 = `memories.kind='promise'`（承诺/待办）
 *   · 闭合     = `valid_to`（有止期 = 已了结，历史仍查得到）
 *   · 上下文   = `memory_links`（同一件事的新旧版本）+ `quote`（原话）
 * 加一张 threads 表只会让"同一条线有两个真相"，这是本项目最忌的那种重复。
 *
 * 判据全在代码里（闸门先于模型）：
 *   ① kind='promise' 且 status='active'       —— 只认承诺，不认泛泛的经历
 *   ② valid_to 为空                            —— 有止期就是已经了结
 *   ③ superseded_by 为空                       —— 被新版本取代的旧条不算线
 *   ④ taint 必须是 trusted                     —— 外部来的内容不能变成"它欠你的事"
 */
import type { DatabaseSync } from "node:sqlite";

export interface Thread {
  id: number;
  text: string;
  quote: string | null;
  /** 立下多久了（天）。超过 7 天的会标 aging：值得追一句 */
  ageDays: number;
  aging: boolean;
  /** 这条线当时的理由（为什么记成承诺） */
  why: string | null;
  weight: number;
}

/** 默认几天没闭合算"该追一下了" */
export const AGING_DAYS = 7;

export function openThreads(db: DatabaseSync, now = new Date(), limit = 20): Thread[] {
  const rows = db
    .prepare(
      `SELECT id, text, quote, source_ref AS why, weight, created_at, taint, valid_to
       FROM memories
       WHERE status='active' AND kind='promise' AND valid_to IS NULL AND superseded_by IS NULL
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(limit) as unknown as Array<{
      id: number; text: string; quote: string | null; why: string | null;
      weight: number; created_at: string; taint: string | null; valid_to: string | null;
    }>;

  const t = now.getTime();
  return rows
    // ④ 外部内容不能变成"它欠你的事"：结构性排除，不是扣分
    .filter((r) => (r.taint ?? "trusted") === "trusted")
    .map((r) => {
      const ageDays = Math.max(0, Math.floor((t - Date.parse(r.created_at)) / 86400000));
      return {
        id: r.id,
        text: r.text,
        quote: r.quote,
        why: r.why,
        weight: r.weight,
        ageDays,
        aging: ageDays >= AGING_DAYS,
      };
    });
}

/**
 * 了结一根线：写止期（**不删**，历史仍查得到），并留一条事件。
 * 与"忘记"是两件事：忘记是这条不该再出现，了结是这件事办完了。
 */
export function closeThread(db: DatabaseSync, id: number, note: string, now = new Date()): boolean {
  const cur = db.prepare("SELECT kind, valid_to FROM memories WHERE id=? AND status='active'")
    .get(id) as { kind: string; valid_to: string | null } | undefined;
  if (!cur) return false;
  if (cur.valid_to) return false;                 // 已经了结过，重复点不该再写一遍
  const ts = now.toISOString();
  db.prepare("UPDATE memories SET valid_to=?, updated_at=? WHERE id=?").run(ts, ts, id);
  db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
    .run(ts, "thread_closed", "user", String(id), String(note || "人说了结了").slice(0, 200));
  return true;
}
