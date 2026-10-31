/**
 * 记忆之间的线（J-5）：抽检与"一句话拆线"。
 *
 * 为什么单独抽出来：这段逻辑原来只写在 `cli/jingjing.ts` 的 `links cut` 里，
 * 面板要能把"抽检"送到眼前（J-5b），就必须走**同一条**实现 ——
 * 否则面板拆的线和 CLI 拆的线会各有一套黑名单，早晚不一致。
 */
import type { DatabaseSync } from "node:sqlite";

export interface LinkRow {
  src_id: number;
  dst_id: number;
  rel: string;
  weight: number;
  why: string | null;
  created_at: string;
  a_text: string;
  b_text: string;
}

const LIVE = "(l.valid_to IS NULL OR julianday(l.valid_to) > julianday(?))";

export function listLinks(db: DatabaseSync, now: Date, limit = 10): LinkRow[] {
  return db
    .prepare(
      `SELECT l.src_id, l.dst_id, l.rel, l.weight, l.why, l.created_at,
              a.text AS a_text, b.text AS b_text
       FROM memory_links l
       JOIN memories a ON a.id = l.src_id
       JOIN memories b ON b.id = l.dst_id
       WHERE ${LIVE}
       ORDER BY l.created_at DESC LIMIT ?`,
    )
    .all(now.toISOString(), limit) as unknown as LinkRow[];
}

/** 最该被人看一眼的线：权重最低（连得最没把握）优先，其次是最新的 */
export function suspiciousLinks(db: DatabaseSync, now: Date, limit = 3, lastId = 0): LinkRow[] {
  return db
    .prepare(
      `SELECT l.src_id, l.dst_id, l.rel, l.weight, l.why, l.created_at,
              a.text AS a_text, b.text AS b_text
       FROM memory_links l
       JOIN memories a ON a.id = l.src_id
       JOIN memories b ON b.id = l.dst_id
       WHERE ${LIVE} AND l.created_at < ?
       ORDER BY l.weight ASC, l.created_at DESC LIMIT ?`,
    )
    .all(now.toISOString(), new Date(lastId).toISOString(), limit) as unknown as LinkRow[];
}

export const linkKey = (srcId: number, dstId: number, rel: string): string => `${srcId}:${dstId}:${rel}`;

/**
 * 拆一根线：作废写止期（历史仍查得到）+ 进黑名单（夜间不再自动接回）+ 留痕。
 * 返回被拆的键。
 */
export function cutLink(db: DatabaseSync, sel: { src_id: number; dst_id: number; rel: string }, now: Date): string {
  db.prepare("UPDATE memory_links SET valid_to=? WHERE src_id=? AND dst_id=? AND rel=?")
    .run(now.toISOString(), sel.src_id, sel.dst_id, sel.rel);

  const key = linkKey(sel.src_id, sel.dst_id, sel.rel);
  const cur = String(
    (db.prepare("SELECT value FROM meta WHERE key='links_blocked'").get() as { value?: string } | undefined)?.value ?? "",
  );
  const set = new Set(cur.split(String.fromCharCode(10)).filter(Boolean));
  set.add(key);
  db.prepare("INSERT INTO meta(key,value) VALUES('links_blocked',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run([...set].join(String.fromCharCode(10)));

  db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
    .run(now.toISOString(), "link_cut", "user", key, "人拆掉了这根线");
  return key;
}

export function isBlocked(db: DatabaseSync, key: string): boolean {
  const cur = String(
    (db.prepare("SELECT value FROM meta WHERE key='links_blocked'").get() as { value?: string } | undefined)?.value ?? "",
  );
  return cur.split(String.fromCharCode(10)).includes(key);
}
