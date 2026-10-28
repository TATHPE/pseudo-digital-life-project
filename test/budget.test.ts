import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { record, spentToday, checkBudget, estimateCost } from "../src/budget.ts";

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
