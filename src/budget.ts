/** 记账与预算闸（13 §6）：cached_tokens 必须单独记，否则看不出缓存有没有生效 */
import type { DatabaseSync } from "node:sqlite";

export interface UsageRow {
  ts: string; role: string; provider: string; model: string;
  inTokens: number; cachedTokens: number; outTokens: number; usd: number;
}

/** 粗略单价（$/1M tok），只用于预算护栏，不追求精确 */
const PRICE: Record<string, { in: number; cached: number; out: number }> = {
  "deepseek:deepseek-chat": { in: 0.27, cached: 0.07, out: 1.1 },
  "deepseek:deepseek-reasoner": { in: 0.55, cached: 0.14, out: 2.19 },
  // 2026-10-31 官方 /models 新增的两档：价格我们**没有从官方文档确认过**，
  // 所以先按 chat 的档位估算，并在注释里标明这不是官方价 —— 编一个精确数字更糟。
  "deepseek:deepseek-flash": { in: 0.27, cached: 0.07, out: 1.1 },
  "deepseek:deepseek-v4-pro": { in: 0.55, cached: 0.14, out: 2.19 },
  "anthropic:claude-sonnet-4-6": { in: 3, cached: 0.3, out: 15 },
  "anthropic:claude-opus-4-6": { in: 15, cached: 1.5, out: 75 },
};

export function estimateCost(provider: string, model: string, u: { inTokens?: number; cachedTokens?: number; outTokens?: number }): number {
  const p = PRICE[`${provider}:${model}`] ?? { in: 1, cached: 0.25, out: 4 };
  const inTok = u.inTokens ?? 0, cached = u.cachedTokens ?? 0, out = u.outTokens ?? 0;
  const fresh = Math.max(0, inTok - cached);
  return (fresh * p.in + cached * p.cached + out * p.out) / 1e6;
}

export function record(db: DatabaseSync, r: UsageRow): void {
  db.prepare(`INSERT INTO usage(ts,role,provider,model,in_tokens,cached_tokens,out_tokens,usd)
              VALUES(?,?,?,?,?,?,?,?)`)
    .run(r.ts, r.role, r.provider, r.model, r.inTokens, r.cachedTokens, r.outTokens, r.usd);
}

/**
 * 「今天」的日界按**本机时区**算（2026-11-14）。
 * 以前用 `toISOString().slice(0,10)` 取 UTC 日：东八区等于早上 8 点换日 ——
 * 凌晨 4 点看「今日花费」，会把昨天白天的钱一起算进来（实测差 $0.50），
 * 每日预算也会提前 8 小时清零。
 */
export function dayRange(now = new Date()): { start: string; end: string } {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  return {
    start: new Date(y, m, d, 0, 0, 0, 0).toISOString(),
    end: new Date(y, m, d + 1, 0, 0, 0, 0).toISOString(),
  };
}

export function spentToday(db: DatabaseSync, now = new Date()): number {
  const { start, end } = dayRange(now);
  const row = db.prepare("SELECT coalesce(sum(usd),0) s FROM usage WHERE ts >= ? AND ts < ?").get(start, end) as { s: number };
  return row.s;
}

export type OnExceed = "degrade_local" | "block" | "notify_only";

export function checkBudget(
  db: DatabaseSync, dailyUsd: number, onExceed: OnExceed, now = new Date(),
): { allowed: boolean; spent: number; action: OnExceed | null } {
  const spent = spentToday(db, now);
  if (spent <= dailyUsd) return { allowed: true, spent, action: null };
  return { allowed: onExceed === "notify_only", spent, action: onExceed };
}
