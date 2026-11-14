/**
 * 心跳与主动性（01 §10）。
 *
 * 原则："没有正当理由就不发"比任何模型选择都影响体验。
 * 所以 decide() 是**纯函数**：只看时间、记忆、状态、配额，不看模型心情。
 * 模型只负责把决定好的"理由"写成一句人话（draft），不负责决定要不要说。
 */
import type { DatabaseSync } from "node:sqlite";
import { appendEvent, newEventId, readEvents } from "./journal.ts";
import { loadState, advance } from "./state.ts";
import { dayRange } from "./budget.ts";
import { localDay, localDayOf } from "./localday.ts";

export type ReasonKind = "promise_due" | "anniversary" | "silence" | "explicit" | "none";
export type Gate = "quiet" | "cap" | "gap" | "no_reason";

export interface Prof { quietStart: number; quietEnd: number; dailyCap: number; minGapMin: number; silenceDays: number }
export const DEFAULT_PROFILE: Prof = { quietStart: 23 * 60 + 30, quietEnd: 8 * 60, dailyCap: 3, minGapMin: 90, silenceDays: 3 };

export interface Reason {
  kind: ReasonKind;
  text: string;
  memoryRef?: number | null;
  urgency: number;   // 0..1，用于同类排序
}

export interface Decision {
  send: boolean;
  reason: Reason;
  gate?: Gate;
  /** 便于审计：这次判断用了哪些输入 */
  ctx: { localMinutes: number; sentToday: number; lastSentAt: string | null; gapMin: number | null };
}

export interface HistoryRow { ts: string; decision: string; reason_kind: string }

const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

export function inQuietHours(min: number, p: Prof): boolean {
  // 跨零点区间（23:30–08:00）
  return p.quietStart > p.quietEnd ? min >= p.quietStart || min < p.quietEnd : min >= p.quietStart && min < p.quietEnd;
}

/** 找理由：优先级短路，第一个成立的就用（01 §10.2） */
export function findReason(db: DatabaseSync, now: Date, p: Prof, lastEventTs: string | null = null): Reason {
  // ① 到期的承诺（contract/promise，valid_to 是约定时间）
  // 用 julianday 比较而不是字符串比较：库里可能同时存在
  // `...Z`（toISOString）与 `...+08:00`（本地时区）两种写法，字典序会判错。
  const promise = db.prepare(
    `SELECT id,text,valid_to FROM memories
     WHERE status='active' AND layer='contract' AND kind='promise' AND valid_to IS NOT NULL
       AND julianday(valid_to) <= julianday(?) ORDER BY julianday(valid_to) ASC LIMIT 1`,
  ).get(now.toISOString()) as { id: number; text: string; valid_to: string } | undefined;
  if (promise) return { kind: "promise_due", text: `到点了：${promise.text}`, memoryRef: promise.id, urgency: 1 };

  // ② 用户明确要求过的事（todo）
  const todo = db.prepare(
    `SELECT id,text,valid_to FROM memories
     WHERE status='active' AND kind='todo' AND (valid_to IS NULL OR julianday(valid_to) <= julianday(?))
     ORDER BY id ASC LIMIT 1`,
  ).get(now.toISOString()) as { id: number; text: string } | undefined;
  if (todo) return { kind: "explicit", text: `你让我记得：${todo.text}`, memoryRef: todo.id, urgency: 0.9 };

  // ③ 时间节点：去年今天写下的事（简版周年）
  const mmdd = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const anni = db.prepare(
    `SELECT id,text,created_at FROM memories
     WHERE status='active' AND strftime('%m-%d', created_at, 'localtime')=?
     ORDER BY importance DESC LIMIT 1`,
  ).get(mmdd) as { id: number; text: string; created_at: string } | undefined;
  // 排除「今天刚写下的」：SQL 按 localtime 取 mm-dd，这里也得按本地日比，别混 UTC 日期。
  if (anni && localDayOf(anni.created_at) !== localDay(now)) {
    return { kind: "anniversary", text: `一年前的今天：${anni.text}`, memoryRef: anni.id, urgency: 0.6 };
  }

  // ④ 长时间沉默（低优先：只有真的很久没说话才用它）
  //    最后的对话时间由调用方从 inbox 读出后传进来——decide 本身不做 IO
  if (lastEventTs) {
    const days = (now.getTime() - new Date(lastEventTs).getTime()) / 86400000;
    if (days >= p.silenceDays) {
      return { kind: "silence", text: `已经 ${Math.floor(days)} 天没说话了`, memoryRef: null, urgency: 0.3 };
    }
  }

  return { kind: "none", text: "没有正当理由", memoryRef: null, urgency: 0 };
}

export function decide(db: DatabaseSync, now: Date, p: Prof = DEFAULT_PROFILE, lastEventTs: string | null = null): Decision {
  const localMinutes = minutesOfDay(now);
  // 每日配额按本地 0 点切：以前 `substr(ts,1,10)` 配 UTC 日期，东八区凌晨会把昨天算进来，
  // 而同一函数里的 localMinutes 又是本地时区 —— 一个决策混两套口径。
  const { start, end } = dayRange(now);
  const sentToday = (db.prepare(
    `SELECT count(*) c FROM intents WHERE decision='send'
       AND julianday(ts) >= julianday(?) AND julianday(ts) < julianday(?)`,
  ).get(start, end) as { c: number }).c;
  const lastSent = (db.prepare(
    `SELECT ts FROM intents WHERE decision='send' ORDER BY ts DESC LIMIT 1`,
  ).get() as { ts: string } | undefined)?.ts ?? null;
  const gapMin = lastSent ? Math.floor((now.getTime() - new Date(lastSent).getTime()) / 60000) : null;
  const reason = findReason(db, now, p, lastEventTs);
  const ctx = { localMinutes, sentToday, lastSentAt: lastSent, gapMin };

  const drop = (gate: Gate): Decision => ({ send: false, reason, gate, ctx });

  if (inQuietHours(localMinutes, p)) return drop("quiet");
  if (sentToday >= p.dailyCap) return drop("cap");
  if (gapMin !== null && gapMin < p.minGapMin) return drop("gap");
  if (reason.kind === "none") return drop("no_reason");
  return { send: true, reason, ctx };
}

export interface BeatDeps {
  db: DatabaseSync;
  inboxDir: string;
  now?: Date;
  profile?: Prof;
  /** 把理由写成一句人话；不给就用模板（离线也能跑） */
  draft?: (r: Reason) => Promise<string>;
  dryRun?: boolean;
}

export interface BeatResult {
  decision: Decision;
  message: string | null;
  intentId: number | null;
  /** 起草失败时记下来（理由有效，只是没润色成"人话"） */
  draftError?: string;
}

/** 一次心跳：判定 → （可选）起草 → 记录意图（发/不发都记） */
export async function beat(deps: BeatDeps): Promise<BeatResult> {
  const now = deps.now ?? new Date();
  const p = deps.profile ?? DEFAULT_PROFILE;
  const lastEventTs = (() => {
    const { events } = readEvents(deps.inboxDir);
    return events.length ? events[events.length - 1]!.ts : null;
  })();
  const d = decide(deps.db, now, p, lastEventTs);

  let message: string | null = null;
  let draftError: string | undefined;
  if (d.send) {
    const template = `（${d.reason.kind}）${d.reason.text}`;
    if (deps.draft) {
      try { message = (await deps.draft(d.reason)).trim() || template; }
      catch (e) { draftError = String(e).slice(0, 120); message = template; }
    } else {
      message = template;
    }
  }

  let intentId: number | null = null;
  if (!deps.dryRun) {
    const r = deps.db.prepare(
      `INSERT INTO intents(ts,decision,reason_kind,reason_text,memory_ref,message,gate)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(now.toISOString(), d.send ? "send" : "drop", d.reason.kind, d.reason.text,
      d.reason.memoryRef ?? null, message, d.gate ?? null);
    intentId = Number(r.lastInsertRowid);

    if (d.send && message) {
      appendEvent(deps.inboxDir, {
        v: 1, id: newEventId(), ts: now.toISOString(), kind: "agent_reply", actor: "agent",
        payload: { text: message, proactive: true, reason: d.reason.text },
      });
      advance(deps.db, { turns: 1, silenceDays: 0 }, now);
    }
  }
  return { decision: d, message, intentId, ...(draftError ? { draftError } : {}) };
}

/** 为什么最近没说话——审计用 */
export function recentIntents(db: DatabaseSync, limit = 10): Array<{
  ts: string; decision: string; reason_kind: string; gate: string | null; reason_text: string;
}> {
  return db.prepare(
    `SELECT ts,decision,reason_kind,gate,reason_text FROM intents ORDER BY id DESC LIMIT ?`,
  ).all(limit) as never;
}
