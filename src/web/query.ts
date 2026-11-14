/**
 * 查询参数里的整数（2026-11-14）
 *
 * 起因：`/api/memories?limit=abc` 返回 500 `datatype mismatch`。
 * 因为 `Math.min(200, Math.max(1, Number("abc")))` 是 NaN，
 * NaN 直接绑进 SQLite 的 LIMIT 就报 datatype mismatch。
 * 这里统一「拿不到就回默认值」，别让 NaN 走到 SQL。
 */
export function intParam(
  url: URL,
  name: string,
  def: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
