import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NB = readFileSync(join(process.cwd(), "src/web/ui/notebook.js"), "utf8");
const SERVER = readFileSync(join(process.cwd(), "src/web/server.ts"), "utf8");

test("推理是逐 token 来的：面板要把碎片合并成一条，不能一垛「想 我 / 想 搜」", () => {
  // 用户截图：过程面板里几十行「想 一 个 字」，读不了。
  assert.ok(NB.includes("function thinkAppend"), "要有合并函数");
  assert.ok(NB.includes("last.k === kind"), "连续同类才接上");
  assert.ok(NB.includes("thinkAppend(TRACE, 'think'"), "右栏也要合并");

  // 服务端同理：不能每个 token push 一条 trace
  assert.ok(SERVER.includes("let thinkBuf"), "服务端要攒着");
  assert.ok(SERVER.includes("const flushThink"), "要整段落成一条");
  const thinkLine = SERVER.split(String.fromCharCode(10)).find((l) => l.includes('ev.type === "think"')) || "";
  assert.ok(thinkLine.includes("thinkBuf += ev.text"), "think 分支要攒进缓冲");
  assert.ok(!thinkLine.includes("trace.push"), "think 分支不许自己 push");
  assert.ok(SERVER.includes("flushThink();"), "动手/结果/报错/收尾前要先落一条");
});

test("工具行不许把名字写两遍（memory_search memory_search (q/k)）", () => {
  assert.ok(NB.includes("function toolLine"), "要有工具行拼装");
  assert.ok(NB.includes("a.indexOf(n) === 0"), "args 已经带名字就别再加前缀");
});

test("推理不进正文的兜底还在（splitThink + think 通道）", () => {
  assert.ok(SERVER.includes("function splitThink"), "服务端要拆 <think> 块");
  assert.ok(SERVER.includes("reasoning_content") === false, "通道在 transport 里");
});
