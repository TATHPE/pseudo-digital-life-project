import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsWelcome } from "../src/web/server.ts";
import { skipSetup, skipOneStep, startSetup, readSession } from "../src/setup.ts";

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

test("单步跳过：只推进指针，不执行那一步（2026-11-19）", () => {
  const home = H();
  const s0 = startSetup(home);
  assert.equal(s0.step, "detect");
  const s1 = skipOneStep(home, "detect");
  assert.equal(s1.step, "ollama", "跳过 detect 应该到 ollama");
  assert.equal(s1.log[0]!.ok, false, "如实记为跳过，不假装成功");
  assert.match(s1.log[0]!.note, /跳过/);
  const s2 = skipOneStep(home, "ollama");
  assert.equal(s2.step, "embed", "从当前步骤 ollama 跳过，应该到 embed");
  assert.equal(s2.log.length, 2);
});

test("单步跳过只走专用接口，不再误调 run（2026-11-19）", () => {
  const NB = readFileSync(new URL("../src/web/welcome.ts", import.meta.url), "utf8");
  assert.ok(NB.includes("action:'skipStep'"), "前端必须发 skipStep，不能是 run+confirm");
  assert.ok(!NB.includes("action:'run',step:step,confirm:true"), "旧的假跳过不能残留");
  assert.ok(NB.includes("data-theme='hermes'"), "hermes 主题也要在引导页定义");
  assert.ok(NB.includes("id='morebtn'"), "破坏性操作收进「更多」菜单");
  assert.ok(NB.includes("aria-live='polite'"), "状态变化要能播报给读屏");
});
