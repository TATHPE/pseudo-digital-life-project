import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsWelcome } from "../src/web/server.ts";
import { skipSetup, startSetup, readSession } from "../src/setup.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-welcome-"));

test("引导页：没开始过要给（这是第一屏）", () => {
  assert.equal(needsWelcome(H()), true);
});

test("引导页：开始过但没跑完 → 还要给", () => {
  const home = H();
  startSetup(home);
  assert.equal(needsWelcome(home), true);
});

test("引导页：点了「先用着」之后不再每次启动都拦（2026-11-05）", () => {
  const home = H();
  startSetup(home);
  const s = skipSetup(home);
  assert.equal(s.status, "skipped");
  assert.equal(readSession(home)?.status, "skipped");
  assert.equal(needsWelcome(home), false, "跳过过的 home 不该再进引导页");
});
