import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOOT_PREFIX, formatBootLine, parseBootLine, parseBootLines, summarizeBootTiming,
  type BootTiming,
} from "../tools/boot-timing.ts";

const sample: BootTiming = { listen: 123, desk: 130, health: 145, mcp: 980, mcpOk: true };
const line = "[boot] listen=123ms desk=130ms health=145ms mcp=980ms mcpOk=true";

test("formatBootLine 产出稳定的规范格式", () => {
  assert.equal(formatBootLine(sample), line);
  assert.ok(line.startsWith(BOOT_PREFIX));
});

test("parseBootLine 解析正常行（mcpOk=true / false 两种）", () => {
  assert.deepEqual(parseBootLine(line), sample);
  const bad = formatBootLine({ listen: 1, desk: 2, health: 3, mcp: 4, mcpOk: false });
  assert.deepEqual(parseBootLine(bad), { listen: 1, desk: 2, health: 3, mcp: 4, mcpOk: false });
});

test("parseBootLine 对畸形行返回 null（不靠猜，逐字段都要合法）", () => {
  const malformed = [
    "[boot] listen=123ms desk=130ms health=145ms mcp=980ms",                 // 缺 mcpOk
    "[boot] listen=123ms desk=130ms health=145ms mcp=980ms mcpOk=yes",        // mcpOk 非布尔
    "[boot] listen=123 desk=130ms health=145ms mcp=980ms mcpOk=true",         // listen 缺 ms
    "[boot] desk=130ms listen=123ms health=145ms mcp=980ms mcpOk=true",       // 字段顺序错
    "[boot] listen=-1ms desk=130ms health=145ms mcp=980ms mcpOk=true",        // 负数
    "[boot] listen=1.5ms desk=130ms health=145ms mcp=980ms mcpOk=true",       // 小数
    "[boot] listen=abc desk=130ms health=145ms mcp=980ms mcpOk=true",         // 非数字
    "listen=123ms desk=130ms health=145ms mcp=980ms mcpOk=true",              // 缺 [boot] 前缀
    "[health] ok",                                                              // 别的日志行
    "",                                                                         // 空行
  ];
  for (const l of malformed) assert.equal(parseBootLine(l), null, `畸形行不该被解析：${l}`);
});

test("parseBootLines 跳过缺失/畸形行，只留合法 [boot] 行", () => {
  const log = [
    "[1793975878] start: exe=Some(...)",
    line,
    "[boot] 这行是坏的",
    "",
    "[1793975879] healthy port=6366",
    formatBootLine({ listen: 200, desk: 210, health: 230, mcp: 1200, mcpOk: false }),
  ].join("\n");
  const got = parseBootLines(log);
  assert.equal(got.length, 2);
  assert.equal(got[0]!.mcpOk, true);
  assert.equal(got[1]!.mcp, 1200);
});

test("parseBootLines 没有任何 [boot] 行 → 空数组（观测层据此写『无打点数据』）", () => {
  const log = ["[1] start: x", "[2] healthy", "[3] spawn ok"].join("\n");
  assert.deepEqual(parseBootLines(log), []);
  assert.equal(summarizeBootTiming(parseBootLines(log)), null, "无样本不伪造 p50/p95");
});

test("summarizeBootTiming 统计四段 p50/p95 与 mcpOk 计数", () => {
  const xs: BootTiming[] = [
    { listen: 10, desk: 20, health: 30, mcp: 100, mcpOk: true },
    { listen: 20, desk: 30, health: 40, mcp: 200, mcpOk: true },
    { listen: 30, desk: 40, health: 50, mcp: 300, mcpOk: false },
  ];
  const s = summarizeBootTiming(xs)!;
  assert.equal(s.samples, 3);
  assert.equal(s.mcpOk, 2);
  assert.equal(s.mcpFailed, 1);
  assert.equal(s.listen.p50, 20);
  assert.equal(s.mcp.p95, 300);
  assert.equal(s.mcp.max, 300);
});
