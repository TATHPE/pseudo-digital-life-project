/**
 * 自动切档（2026-11-07）：聊天 / 工作由这句话自己判断，不再只靠人点。
 *
 * 规矩（先写测试，再写实现）：
 *   · 判成工作 = 更长的简报 + 更多步数；判错就**每轮多花 2600 tokens**，所以宁可漏判；
 *   · 粘性优先：上一轮是工作、这轮没有明确"聊天"信号 → 保持工作（短句不翻档）；
 *   · 纯函数：不读库、不看时间，方便单测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMode } from "../src/mode.ts";

const chat = (t: string, prev: "chat" | "work" = "chat") => resolveMode(t, { prev, hasTools: true });
const work = (t: string, prev: "chat" | "work" = "chat") => resolveMode(t, { prev, hasTools: true });

test("工作：祈使动词 + 具体宾语", () => {
  assert.equal(work("把这个表的空行删掉").mode, "work");
  assert.equal(work("把配置里的模型改成 qwen2.5").mode, "work");
});

test("工作：出现路径 / 文件名 / 命令", () => {
  assert.equal(work("src/web/server.ts 里那个 403 是哪来的").mode, "work");
  assert.equal(work("跑一下 npm run check").mode, "work");
  assert.equal(work("看一下 data/config.json").mode, "work");
});

test("工作：多步骤", () => {
  assert.equal(work("先读一下 schema，再改 fetch，然后跑测试").mode, "work");
});

test("聊天：问句 / 感受 / 回忆", () => {
  assert.equal(chat("你觉得这个方向行吗？").mode, "chat");
  assert.equal(chat("今天好累").mode, "chat");
  assert.equal(chat("上次说的那个还算数吗").mode, "chat");
});

test("聊天：短句寒暄", () => {
  assert.equal(chat("在吗").mode, "chat");
  assert.equal(chat("嗯嗯").mode, "chat");
});

test("粘性：上一轮工作 + 短句 → 保持工作（不来回跳）", () => {
  const r = resolveMode("好的", { prev: "work", hasTools: true });
  assert.equal(r.mode, "work");
  assert.equal(r.sticky, true);
});

test("粘性：上一轮工作 + 明确聊天信号 → 回聊天", () => {
  assert.equal(resolveMode("今天好累啊", { prev: "work", hasTools: true }).mode, "chat");
});

test("粘性：上一轮聊天 + 明确工作信号 → 切工作", () => {
  assert.equal(resolveMode("帮我把 README 的数字改掉", { prev: "chat", hasTools: true }).mode, "work");
});

test("没有工具（本地兜底）时一律按聊天：工作档没工具等于空转", () => {
  const r = resolveMode("把 data 下最大的文件删掉", { prev: "work", hasTools: false });
  assert.equal(r.mode, "chat");
  assert.match(r.why, /没有工具/);
});

test("判定要能解释：每个结果都带一句为什么", () => {
  for (const q of ["在吗", "把 schema 改了", "好的"]) {
    const r = resolveMode(q, { prev: "chat", hasTools: true });
    assert.ok(typeof r.why === "string" && r.why.length > 2, q + " 缺 why");
  }
});
