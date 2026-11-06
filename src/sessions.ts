/**
 * 会话对象（2026-11-05）：把「一串消息」变成「一次可指认的对话」。
 *
 * 为什么现在补：参考项目（Hermes）的界面之所以能长成「任务详情 + 右侧四标签」，
 * 是因为它底下有 session 对象 —— 能 resume、能 branch、能 interrupt。
 * 我们这边原先只有 inbox 里一条条事件流，没有"这次对话是什么"这个概念，
 * 所以界面只能是一条无限长的时间线。
 *
 * 这一版只做最小的那一层：
 *   · 什么时候开一个新会话：距上次活动超过 gap（默认 4 小时），或上一个已关闭
 *   · 每条消息带上 session id（写进 inbox 事件的 payload，旧数据不受影响）
 *   · 列表 / 详情 / 关闭 / 改名 —— 够界面指认就行
 *
 * 还没有：branch（分叉）、undo、压缩。那些要等有了"每轮的边界"再说。
 */
import type { DatabaseSync } from "node:sqlite";

export interface SessionRow {
  id: string;
  title: string;
  status: "running" | "idle" | "closed";
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  msgs: number;
}

const DDL = [
  "CREATE TABLE IF NOT EXISTS sessions (",
  "  id TEXT PRIMARY KEY,",
  "  title TEXT NOT NULL DEFAULT '',",
  "  status TEXT NOT NULL DEFAULT 'idle',",
  "  created_at TEXT NOT NULL,",
  "  updated_at TEXT NOT NULL,",
  "  closed_at TEXT,",
  "  msgs INTEGER NOT NULL DEFAULT 0",
  ")",
].join(String.fromCharCode(10));

export function ensureSessions(db: DatabaseSync): void {
  try { db.exec(DDL); } catch { /* 只读库等极端情况：不影响对话 */ }
  // 后加的两列：分叉来源、撤回起点。ALTER 失败说明已经有了。
  for (const ddl of ["ALTER TABLE sessions ADD COLUMN parent_id TEXT", "ALTER TABLE sessions ADD COLUMN undo_keep INTEGER"]) {
    try { db.exec(ddl); } catch { /* 已有 */ }
  }
}

function rowOf(r: Record<string, unknown>): SessionRow {
  return {
    id: String(r.id),
    title: String(r.title ?? ""),
    status: (r.status === "running" || r.status === "closed" ? r.status : "idle") as SessionRow["status"],
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    closed_at: r.closed_at == null ? null : String(r.closed_at),
    msgs: Number(r.msgs ?? 0),
  };
}

export const newSessionId = (now: Date): string =>
  "s" + now.toISOString().replace(/[-:T]/g, "").slice(0, 14) + Math.random().toString(36).slice(2, 6);

/**
 * 拿到"这一轮该挂在哪个会话上"：最近一个还热着（gap 内、没关闭）就用它，否则开新的。
 * gapMs 默认 4 小时 —— 隔夜再聊就是新的一次，别把昨天的对话也算进今天。
 */
export function openSession(db: DatabaseSync, now: Date, opts: { gapMs?: number; title?: string } = {}): SessionRow {
  ensureSessions(db);
  const gap = opts.gapMs ?? 4 * 60 * 60 * 1000;
  const last = db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  if (last) {
    const r = rowOf(last);
    const fresh = now.getTime() - new Date(r.updated_at).getTime() < gap;
    if (r.status !== "closed" && fresh) return r;
  }
  const id = newSessionId(now);
  const ts = now.toISOString();
  db.prepare("INSERT INTO sessions(id,title,status,created_at,updated_at,closed_at,msgs) VALUES(?,?,?,?,?,NULL,0)")
    .run(id, String(opts.title ?? "").slice(0, 60), "running", ts, ts);
  return rowOf(db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Record<string, unknown>);
}

export function touchSession(db: DatabaseSync, id: string, patch: { title?: string; status?: SessionRow["status"]; bump?: boolean } = {}, now = new Date()): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined) { sets.push("title=?"); vals.push(String(patch.title).slice(0, 60)); }
  if (patch.status !== undefined) { sets.push("status=?"); vals.push(patch.status); }
  // 用传进来的 now（默认现在）：测试用固定时钟，跨天也不会因为"真实现在"而让会话复用判断出错
  if (patch.bump) { sets.push("msgs=msgs+1", "updated_at=?"); vals.push(now.toISOString()); }
  if (!sets.length) return;
  vals.push(id);
  try { db.prepare("UPDATE sessions SET " + sets.join(",") + " WHERE id=?").run(...(vals as never[])); } catch { /* ignore */ }
}

export function closeSession(db: DatabaseSync, id: string, now: Date): boolean {
  ensureSessions(db);
  const ts = now.toISOString();
  const r = db.prepare("UPDATE sessions SET status='closed', closed_at=?, updated_at=? WHERE id=? AND status<>'closed'").run(ts, ts, id);
  return Number(r.changes ?? 0) > 0;
}

export function listSessions(db: DatabaseSync, limit = 30): SessionRow[] {
  ensureSessions(db);
  const rows = db.prepare("SELECT * FROM sessions ORDER BY COALESCE(closed_at, updated_at) DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowOf);
}

export function getSession(db: DatabaseSync, id: string): SessionRow | null {
  ensureSessions(db);
  const r = db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return r ? rowOf(r) : null;
}

/** 标题没填就从第一句话里取（列表要能认人，不要一列 "s202611050930xx"） */
export function titleFrom(text: string): string {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > 24 ? t.slice(0, 24) + "…" : t;
}

/** 从这次会话分叉：新开一个，记下 parent_id（消息不复制 —— 复制了也不是同一次对话） */
export function branchSession(db: DatabaseSync, id: string, now: Date): SessionRow | null {
  ensureSessions(db);
  const src = db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!src) return null;
  const r = rowOf(src);
  const nid = newSessionId(now);
  const ts = now.toISOString();
  const title = (r.title ? r.title + "（分叉）" : "分叉").slice(0, 60);
  db.prepare("INSERT INTO sessions(id,title,status,created_at,updated_at,closed_at,msgs,parent_id) VALUES(?,?,?,?,?,NULL,0,?)")
    .run(nid, title, "idle", ts, ts, id);
  return rowOf(db.prepare("SELECT * FROM sessions WHERE id=?").get(nid) as Record<string, unknown>);
}

/** 撤回最后一轮：记下「保留前 N 条」，详情接口从 N 之后截断（inbox 追加写、不改历史） */
export function undoSession(db: DatabaseSync, id: string, keep: number): boolean {
  ensureSessions(db);
  const r = db.prepare("UPDATE sessions SET undo_keep=? WHERE id=?").run(Math.max(0, keep), id);
  return Number(r.changes ?? 0) > 0;
}

export function undoKeep(db: DatabaseSync, id: string): number | null {
  try {
    const r = db.prepare("SELECT undo_keep FROM sessions WHERE id=?").get(id) as { undo_keep?: number } | undefined;
    return r && r.undo_keep != null ? Number(r.undo_keep) : null;
  } catch { return null; }
}
