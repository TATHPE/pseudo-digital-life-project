/** 本地日界（2026-11-14）：与 budget.dayRange 同口径，且不吃 UTC 换日的亏 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { localDay, localDayOf } from "../src/localday.ts";
import { dayRange } from "../src/budget.ts";

test("localDay 用本地日历字段，不是 UTC 切片", () => {
  const d = new Date(2026, 9, 28, 2, 0, 0);
  assert.equal(localDay(d), "2026-10-28");
  assert.equal(localDayOf(d.toISOString()), localDay(d), "`...Z` 时间戳也要算本地日");
  assert.equal(localDayOf("2026-10-28T02:00:00+08:00"), localDay(new Date("2026-10-28T02:00:00+08:00")));
});

test("dayRange 的边界与 localDay 同一口径", () => {
  const d = new Date(2026, 9, 28, 2, 0, 0);
  const { start, end } = dayRange(d);
  assert.equal(new Date(start).getTime(), new Date(2026, 9, 28, 0, 0, 0).getTime());
  assert.equal(new Date(end).getTime(), new Date(2026, 9, 29, 0, 0, 0).getTime());
  assert.equal(localDay(new Date(start)), "2026-10-28");
  // 本地昨天 23 点落不进今天，本地今天凌晨落得进
  const y = new Date(2026, 9, 27, 23, 0, 0).getTime();
  const t = new Date(2026, 9, 28, 1, 0, 0).getTime();
  assert.ok(y < Date.parse(start));
  assert.ok(t >= Date.parse(start) && t < Date.parse(end));
});
