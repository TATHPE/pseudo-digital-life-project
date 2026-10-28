import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { estimateTokens } from "../src/tokens.ts";

test("空串为 0", () => assert.equal(estimateTokens(""), 0));

test("单调性：越长的文本 token 不减少", () => {
  const base = "鲸鲸记得你上次说过的话。";
  assert.ok(estimateTokens(base + base) > estimateTokens(base));
});

/**
 * 标定用例：对标 tiktoken/cl100k_base 的实测值（2026-10-27）。
 * 若改了系数，这里会失败——这是有意的。
 */
const CALIB: Array<[string, number]> = [
  ["persona/core.md", 215],
  ["persona/voice.md+values.md", 427],
  ["persona/tools.md", 115],   // 英文/代码多，用来卡住「按词算」这条
  ["README.md", 5109],       // 中英混排大文本：旧系数在这里也偏 15%
];

test("标定：估算与 cl100k 实测偏差 ≤15%", () => {
  for (const [file, real] of CALIB) {
    if (file.includes("+")) continue;
    if (!existsSync(file)) continue;
    const est = estimateTokens(readFileSync(file, "utf8"));
    const err = (est - real) / real;
    assert.ok(Math.abs(err) <= 0.15, `${file}: est=${est} real=${real} (${(err * 100).toFixed(1)}%)`);
  }
});
