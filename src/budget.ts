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

export function spentToday(db: DatabaseSync, now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  const row = db.prepare("SELECT coalesce(sum(usd),0) s FROM usage WHERE substr(ts,1,10)=?").get(day) as { s: number };
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
