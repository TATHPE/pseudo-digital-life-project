/**
 * 浮现时机（J-4）
 *
 * 为什么要有它：我们之前的“什么时候想起”**只有一种触发** —— 用户发消息，然后按查询召回。
 * 那正是那篇样本批评的「查完就走」。它把触发换成了**时机**（人回来了 / 换话题 / 隔夜首句 /
 * 对方不好受），而时机不是分数。
 *
 * 三条纪律：
 *  1. **挑时机，不是提频率**：每轮都查 = 把“查完就走”从一天一次变成一秒一次。
 *  2. **有上限**：每天 ≤ 2 条；同一根线（link）7 天内不重复。
 *  3. **判据要说得出来**：返回 reason，面板/日志里能看见“这次为什么浮”。
 */
import type { DatabaseSync } from "node:sqlite";
import { bigrams } from "./text.ts";

export interface SurfaceInput {
  now: Date;
  /** 上一条消息的时间（跨天/跨会话都算） */
  lastMsgAt: Date | null;
  /** 上一句用户说的话（判“换话题”） */
  prevText: string;
  /** 这一句 */
  text: string;
  /** 今天是不是第一次开口 */
  firstOfDay: boolean;
}

export interface SurfaceDecision {
  ok: boolean;
  /** 说得出来的时机名；不浮现时为 null */
  trigger: string | null;
  /** 为什么（含被上限挡下的原因） */
  reason: string;
}

export const SURFACE_LIMITS = { perDay: 2, gapMs: 10 * 60 * 1000, topicMaxJaccard: 0.1, linkCooldownMs: 7 * 86400_000 } as const;

/** 纯判定：不读写库，便于测 */
export function decideSurface(i: SurfaceInput, usedToday: number): SurfaceDecision {
  if (usedToday >= SURFACE_LIMITS.perDay) return { ok: false, trigger: null, reason: `今天已经浮过 ${usedToday} 条（上限 ${SURFACE_LIMITS.perDay}）` };

  const gap = i.lastMsgAt ? i.now.getTime() - i.lastMsgAt.getTime() : Infinity;
  if (gap >= SURFACE_LIMITS.gapMs) {
    return { ok: true, trigger: "人回来了", reason: gap === Infinity ? "第一次对话" : `距上一条 ${Math.round(gap / 60000)} 分钟` };
  }
  if (i.firstOfDay) return { ok: true, trigger: "隔夜第一句", reason: "今天第一次开口" };
  if (i.prevText && jaccard(i.prevText, i.text) <= SURFACE_LIMITS.topicMaxJaccard) {
    return { ok: true, trigger: "换了话题", reason: "与本轮上文几乎不共享词" };
  }
  // 情绪判据：**这是四条里最弱的一条**，只是字面线索，不装作读懂了情绪
  if (/(难过|不开心|烦|累|崩|撑不住|不想活)/.test(i.text)) {
    return { ok: true, trigger: "对方不太对劲", reason: "字面情绪线索（弱判据）" };
  }
  return { ok: false, trigger: null, reason: "没有到该浮的时机" };
}

export interface SurfacePick { id: number; text: string; quote?: string | null; why: string; from: number }

/**
 * 挑一条“沉着但有线”的记忆浮上来。
 * 只挑：dormant + 至少一根有效边 + 这条线 7 天内没浮过。
 */
export function pickSurface(db: DatabaseSync, now: Date): SurfacePick | null {
  const log = readLog(db);
  const cooled = (key: string) => {
    const last = log.find((x) => x.key === key);
    return !last || now.getTime() - Date.parse(last.ts) >= SURFACE_LIMITS.linkCooldownMs;
  };
  const rows = db.prepare(`
    SELECT m.id, m.text, m.quote, m.stage, l.src_id, l.dst_id, l.why
    FROM memories m
    JOIN memory_links l ON (l.src_id = m.id OR l.dst_id = m.id)
    WHERE m.status='active' AND m.stage='dormant'
      AND (l.valid_to IS NULL OR julianday(l.valid_to) > julianday(?))
      AND l.why IS NOT NULL AND l.why <> ''
    ORDER BY m.weight ASC, l.weight DESC
    LIMIT 40`).all(now.toISOString()) as Array<{
      id: number; text: string; quote?: string | null; stage: string; src_id: number; dst_id: number; why: string;
    }>;
  for (const r of rows) {
    const key = `${Math.min(r.src_id, r.id)}-${Math.max(r.dst_id, r.id)}`;
    if (!cooled(key)) continue;
    return { id: r.id, text: r.text, quote: r.quote ?? null, why: String(r.why).slice(0, 20), from: r.id === r.src_id ? r.dst_id : r.src_id };
  }
  return null;
}

export function noteSurfaced(db: DatabaseSync, now: Date, pick: SurfacePick): void {
  const log = readLog(db);
  log.push({ ts: now.toISOString(), key: `${Math.min(pick.from, pick.id)}-${Math.max(pick.from, pick.id)}` });
  const keep = log.slice(-40);
  db.prepare("INSERT INTO meta(key,value) VALUES('surface_log',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(keep));
  try {
    db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
      .run(now.toISOString(), "surfaced", "agent", String(pick.id), `${pick.why} → ${pick.text.slice(0, 40)}`);
  } catch { /* ignore */ }
}

/** 本地日期（YYYY-MM-DD）。库里时间戳混着 Z 与 +08:00，按 UTC 切会把一天算错 */
function localDay(t: Date): string {
  return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** 今天已经浮过几条（按本地日期切） */
export function usedToday(db: DatabaseSync, now: Date): number {
  const day = localDay(now);
  return readLog(db).filter((x) => localDay(new Date(x.ts)) === day).length;
}

function readLog(db: DatabaseSync): Array<{ ts: string; key: string }> {
  try {
    const r = db.prepare("SELECT value FROM meta WHERE key='surface_log'").get() as { value?: string } | undefined;
    if (!r?.value) return [];
    const j = JSON.parse(r.value) as Array<{ ts: string; key: string }>;
    return Array.isArray(j) ? j.filter((x) => x && typeof x.ts === "string") : [];
  } catch { return []; }
}

function jaccard(a: string, b: string): number {
  const A = new Set(bigrams(a)), B = new Set(bigrams(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
