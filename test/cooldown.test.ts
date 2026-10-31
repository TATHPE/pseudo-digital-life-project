import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, isCooldownWorthy, gate, recordFailure, recordSuccess, reset, COOLDOWN } from "../src/cooldown.ts";

test("D-2 分类：只把'确定是它坏了'的算进冷却", () => {
  assert.equal(classifyFailure("E_PROVIDER: 401 Unauthorized"), "auth");
  assert.equal(classifyFailure("E_PROVIDER: 403 Forbidden"), "auth");
  assert.equal(classifyFailure("E_PROVIDER: 429 rate limit"), "rate");
  assert.equal(classifyFailure("E_PROVIDER: 503 Service Unavailable"), "server");
  assert.equal(classifyFailure("fetch failed"), "network");
  assert.equal(classifyFailure("随便什么错"), "other");

  assert.equal(isCooldownWorthy("auth"), true);
  assert.equal(isCooldownWorthy("rate"), true);
  assert.equal(isCooldownWorthy("server"), true);
  assert.equal(isCooldownWorthy("network"), false, "断网不该冷却（网络回来了也还被拖着）");
  assert.equal(isCooldownWorthy("other"), false);
});

test("D-2 连续 3 次才冷却；冷却期内 gate 拦住并给得出原因", () => {
  reset();
  const t0 = 1_000_000;
  assert.equal(recordFailure("deepseek", "E_PROVIDER: 401 nope", t0).justCooled, undefined);
  assert.equal(recordFailure("deepseek", "E_PROVIDER: 401 nope", t0 + 1).justCooled, undefined);
  const third = recordFailure("deepseek", "E_PROVIDER: 401 nope", t0 + 2);
  assert.equal(third.justCooled, true, "第 3 次进入冷却");

  const g = gate("deepseek", t0 + 3);
  assert.equal(g.blocked, true);
  assert.match(String(g.reason), /已暂停 5 分钟/);
  assert.match(String(g.reason), /凭据无效/);

  // 5 分钟后自动恢复
  assert.equal(gate("deepseek", t0 + 2 + COOLDOWN.ms + 1).blocked, false);
});

test("D-2 网络类失败不累计；成功一次就清零", () => {
  reset();
  const t0 = 2_000_000;
  for (let i = 0; i < 10; i++) recordFailure("deepseek", "fetch failed", t0 + i);
  assert.equal(gate("deepseek", t0 + 20).blocked, false, "断网 10 次也不该冷却");

  recordFailure("deepseek", "E_PROVIDER: 429 x", t0);
  recordFailure("deepseek", "E_PROVIDER: 429 x", t0 + 1);
  recordSuccess("deepseek");
  recordFailure("deepseek", "E_PROVIDER: 429 x", t0 + 2);
  assert.equal(gate("deepseek", t0 + 3).blocked, false, "成功清掉了计数，不该到阈值");
});

test("D-2 冷却按 provider 分开：一个坏了不连坐另一个", () => {
  reset();
  const t0 = 3_000_000;
  for (let i = 0; i < 3; i++) recordFailure("deepseek", "E_PROVIDER: 401 x", t0 + i);
  assert.equal(gate("deepseek", t0 + 5).blocked, true);
  assert.equal(gate("anthropic", t0 + 5).blocked, false);
});
