import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { record, spentToday, checkBudget, estimateCost, dayRange } from "../src/budget.ts";

const db = () => openDb(join(mkdtempSync(join(tmpdir(), "jj-b-")), "m.db")).db;

test("记账：cached_tokens 单独记，不混进 in_tokens", () => {
  const d = db();
  record(d, { ts: new Date().toISOString(), role: "express", provider: "deepseek", model: "deepseek-chat", inTokens: 1000, cachedTokens: 800, outTokens: 100, usd: 0.001 });
  const row = d.prepare("SELECT * FROM usage").get() as any;
  assert.equal(row.in_tokens, 1000);
  assert.equal(row.cached_tokens, 800);
});

test("成本估算：缓存命中远比新鲜便宜", () => {
  const fresh = estimateCost("deepseek", "deepseek-chat", { inTokens: 1_000_000, outTokens: 0 });
  const cached = estimateCost("deepseek", "deepseek-chat", { inTokens: 1_000_000, cachedTokens: 1_000_000, outTokens: 0 });
  assert.ok(cached < fresh / 3, `cached=${cached} fresh=${fresh}`);
});

test("预算闸：超限时按 onExceed 动作", () => {
  const d = db();
  record(d, { ts: new Date().toISOString(), role: "express", provider: "deepseek", model: "deepseek-chat", inTokens: 0, cachedTokens: 0, outTokens: 0, usd: 3 });
  assert.equal(spentToday(d), 3);
  assert.equal(checkBudget(d, 2, "degrade_local").allowed, false);
  assert.equal(checkBudget(d, 2, "degrade_local").action, "degrade_local");
  assert.equal(checkBudget(d, 2, "notify_only").allowed, true);
  assert.equal(checkBudget(d, 5, "block").allowed, true);
});

test("今日花费按本机日界算，不按 UTC（2026-11-14）", () => {
  const d = db();
  // 用本地时间构造，避免测试本身依赖机器时区
  const now = new Date(2026, 10, 14, 3, 0, 0);          // 本地 11-14 03:00
  const startOfToday = new Date(2026, 10, 14, 0, 0, 0, 0);
  const lateYesterday = new Date(startOfToday.getTime() - 30 * 60_000);  // 本地 11-13 23:30
  const earlyToday = new Date(startOfToday.getTime() + 30 * 60_000);     // 本地 11-14 00:30
  const mk = (ts: Date, usd: number) => record(d, { ts: ts.toISOString(), role: "express", provider: "deepseek", model: "m", inTokens: 0, cachedTokens: 0, outTokens: 0, usd });
  mk(lateYesterday, 5);
  mk(earlyToday, 2);

  // 日界就是本地 0 点
  const r = dayRange(now);
  assert.equal(r.start, startOfToday.toISOString(), "起点应是本地零点");
  assert.equal(r.end, new Date(2026, 10, 15, 0, 0, 0, 0).toISOString(), "终点应是明天零点");

  assert.equal(spentToday(d, now), 2, "只算本地今天那笔；以前按 UTC 日会连昨天 23:30 一起算成 7");
  // 同一天的晚些时候再看，答案不变（仍是今天那笔）
  assert.equal(spentToday(d, new Date(2026, 10, 14, 23, 59, 0)), 2);
});
