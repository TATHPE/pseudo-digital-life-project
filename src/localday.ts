/**
 * 本地日界（2026-11-14）：全仓「今天」一律走这里，不再各写各的 UTC 切片。
 *
 * `new Date().toISOString().slice(0, 10)` 取的是 **UTC 日**，东八区要早上 8 点才换日：
 * 凌晨 0–8 点的主动发言计数、每日配额、inbox / 版本文件名都会算到「昨天」头上，
 * 而同一个决策里的时分（`getHours()`）和 SQL 的 `localtime` 又是本地时区 ——
 * 一次判断混两套口径。需要「今天的时间区间」做 SQL 比较时用 `budget.ts` 的 `dayRange()`。
 */
export function localDay(t: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** ISO 时间戳 → 本地日。库里混着 `...Z` 与 `...+08:00` 两种写法都吃得下 */
export function localDayOf(ts: string): string {
  return localDay(new Date(ts));
}
