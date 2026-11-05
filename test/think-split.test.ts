import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitThink } from "../src/web/server.ts";

const SERVER = readFileSync(join(process.cwd(), "src/web/server.ts"), "utf8");
const TRANSPORT = readFileSync(join(process.cwd(), "src/transport.ts"), "utf8");
const AGENT = readFileSync(join(process.cwd(), "src/agent.ts"), "utf8");
const BRIEF = readFileSync(join(process.cwd(), "src/brief.ts"), "utf8");

test("思考不许混进正文：推理通道单独走 think", () => {
  assert.ok(TRANSPORT.includes("reasoning_content"), "OpenAI 兼容的 reasoning_content 要读");
  assert.ok(TRANSPORT.includes("d.thinking"), "ollama 的 thinking 要读");
  assert.ok(TRANSPORT.includes('{ type: "think"'), "推理要发成 think 事件");
  assert.ok(AGENT.includes('ev.type === "think"'), "agent 要把 think 转出去");
});

test("拆 <think>：正文只留结论", () => {
  const r = splitThink("<think>先查接口，再补一条命令</think>结论：前十如上。");
  assert.equal(r.text, "结论：前十如上。");
  assert.deepEqual(r.thinks, ["先查接口，再补一条命令"]);
});

test("拆 ```think 块，也认 <thinking>", () => {
  const a = splitThink("```think" + String.fromCharCode(10) + "试试 curl" + String.fromCharCode(10) + "```" + String.fromCharCode(10) + "做完了");
  assert.equal(a.text, "做完了");
  assert.deepEqual(a.thinks, ["试试 curl"]);

  const b = splitThink("<thinking>x</thinking>y");
  assert.equal(b.text, "y");
  assert.deepEqual(b.thinks, ["x"]);
});

test("没有思考块就别改正文（不许误伤）", () => {
  const t = "结论：三件事都没问题。";
  const r = splitThink(t);
  assert.equal(r.text, t);
  assert.equal(r.thinks.length, 0);
});

test("提示词里写明：正文只放结论（P20）", () => {
  assert.ok(BRIEF.includes('"P20"'), "要有 P20 槽");
  assert.ok(BRIEF.includes("正文只放结论"), "要一句话说清楚");
});

test("拆出来的思考进过程、存盘前拆一次", () => {
  assert.ok(SERVER.includes("const sp = splitThink(full)"), "存之前要拆一次");
  assert.ok(SERVER.includes('trace.push({ k: "think", t })'), "拆出来的要进过程");
});
