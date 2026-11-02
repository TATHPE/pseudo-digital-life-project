import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newGuard, noteToolResult, isMutating, isVerifying, isError, canRetry,
  needPlan, needVerify, looksLikeTask, retryNudge, verifyNudge, isRecoverable, MAX_NUDGES,
} from "../src/agentguard.ts";
import { runAgent } from "../src/agent.ts";
type ChatEvent = { type: string; [k: string]: unknown };
import type { ToolRegistry } from "../src/tools.ts";

/** 假 chat：按剧本吐 tool_calls / 文本 */
function scripted(steps: Array<{ calls?: Array<{ name: string; args: string }>; text?: string }>) {
  let i = 0;
  return async function* (): AsyncGenerator<ChatEvent, void, void> {
    const s = steps[i++] ?? { text: "（没词了）" };
    if (s.text) yield { type: "delta", text: s.text };
    if (s.calls?.length) {
      yield { type: "tool_calls", calls: s.calls.map((c, k) => ({ id: `c${i}-${k}`, name: c.name, args: c.args })) };
    }
    yield { type: "done", finish: "stop" } as ChatEvent;
  };
}

function fakeTools(results: Record<string, { ok: boolean; output: string }>): ToolRegistry & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: () => [],
  refresh: () => {},
    schema: () => [{ type: "function", function: { name: "fs_write", description: "", parameters: {} } }] as never,
    async run(name, args) {
      calls.push(name + " " + JSON.stringify(args).slice(0, 30));
      const r = results[name] ?? { ok: true, output: "ok" };
      return { ...r, tier: "T1" };
    },
  };
}

const drain = async (gen: AsyncGenerator<unknown, void, void>) => {
  const out: Array<Record<string, unknown>> = [];
  for await (const e of gen) out.push(e as Record<string, unknown>);
  return out;
};

test("C-1 分类：写/跑 算改动，读/搜 算验证", () => {
  assert.equal(isMutating("fs.write"), true);
  assert.equal(isMutating("shell.run"), true);
  assert.equal(isMutating("memory.search"), false);
  assert.equal(isVerifying("shell.run"), true);
  assert.equal(isVerifying("project.read"), true);
  assert.equal(isError("E_CORE_PROTECTED: x"), true);
  assert.equal(isError("写入 tmp/a.txt（6 字节）"), false);
});

test("C-1 状态机：改过 → 需要验；验过 → 不需要；再改 → 又要验", () => {
  const g = newGuard();
  assert.equal(needVerify(g), false);
  noteToolResult(g, "fs.write", true, "写入 a.txt");
  assert.equal(needVerify(g), true, "改完必须验");
  noteToolResult(g, "project.read", true, "[a.txt] 内容");
  assert.equal(needVerify(g), false, "验过就不用再催");
  noteToolResult(g, "fs.write", true, "写入 b.txt");
  assert.equal(needVerify(g), true, "改完再改，前面的验证不算数");
});

test("C-1 真跑：改完不验会补一次，补过还不验就明说没验", async () => {
  const tools = fakeTools({ "fs.write": { ok: true, output: "写入 tmp/a.txt" } });
  // 剧本：① 写文件 ② 想收尾（会被拦） ③ 还是收尾（这次放行 + 提醒没验）
  const chat = scripted([
    { calls: [{ name: "fs.write", args: '{"path":"tmp/a.txt","content":"x"}' }] },
    { text: "改好了。" },
    { text: "改好了。" },
  ]);
  const evs = await drain(runAgent({ chat: chat as never, tools, maxSteps: 5 }, "sys", "帮我改个文件"));
  const notices = evs.filter((e) => e.type === "notice").map((e) => String(e.text));
  assert.ok(notices.some((n) => n.includes("没验证") || n.includes("验一次")), "要留可见痕迹：" + notices.join(" | "));
});

test("C-3 真跑：工具报错会补一次，第二次不再补", async () => {
  // 用**可恢复**的错误（E_NOT_FOUND）：路径找错了，补一次有意义
  const tools = fakeTools({ "fs.write": { ok: false, output: "E_NOT_FOUND: tmp/ 不存在" } });
  const chat = scripted([
    { calls: [{ name: "fs.write", args: '{"path":"memory.db","content":"x"}' }] },
    { calls: [{ name: "fs.write", args: '{"path":"memory.db","content":"x"}' }] },
    { text: "好吧，改不了。" },
  ]);
  const evs = await drain(runAgent({ chat: chat as never, tools, maxSteps: 6 }, "sys", "写个文件"));
  const notices = evs.filter((e) => e.type === "notice").map((e) => String(e.text));
  assert.ok(notices.some((n) => n.includes("补一次")), "第一次要补：" + notices.join(" | "));
  assert.ok(notices.some((n) => n.includes("不再补")), "第二次不再补：" + notices.join(" | "));
  assert.ok(retryNudge("fs.write", "E_X", false).includes("再试一次"));
});

test("C-3 收紧：不可恢复的错误（记忆核心/被拒）不浪费一轮去补", async () => {
  const tools = fakeTools({ "fs.write": { ok: false, output: "E_CORE_PROTECTED: 记忆库本体 不能直接改" } });
  const chat = scripted([
    { calls: [{ name: "fs.write", args: '{"path":"memory.db","content":"x"}' }] },
    { text: "改不了，因为那是记忆核心。" },
  ]);
  const evs = await drain(runAgent({ chat: chat as never, tools, maxSteps: 3 }, "sys", "写数据库"));
  const notices = evs.filter((e) => e.type === "notice").map((e) => String(e.text));
  assert.ok(!notices.some((n) => n.includes("补一次")), "不该补：" + notices.join(" | "));
});

test("C-2 判定：任务才讨计划，闲聊/提问不讨", () => {
  assert.equal(looksLikeTask("帮我把面板的权限开关挪到输入框旁边"), true);
  assert.equal(looksLikeTask("跑一下测试"), true);
  assert.equal(looksLikeTask("在吗"), false);
  assert.equal(looksLikeTask("你是什么"), false);
  assert.equal(looksLikeTask("为什么你记不住"), false);
  assert.equal(looksLikeTask("今天天气如何？"), false);

  const g = newGuard();
  assert.equal(needPlan(g, "帮我改一下配置"), true);
  assert.equal(needPlan(g, "帮我改一下配置"), false, "只讨一次");
});

test("C-2 真跑：任务开头会先收到列步骤的提示", async () => {
  const tools = fakeTools({});
  const chat = scripted([{ text: "1. 改配置 2. 跑测试验证" }, { text: "开始。" }]);
  const seen: string[] = [];
  // 把 chat 包一层，记录它收到的 messages
  const wrapped = async function* (messages: unknown[]) {
    seen.push(JSON.stringify(messages).slice(0, 400));
    yield* chat();
  };
  await drain(runAgent({ chat: wrapped as never, tools, maxSteps: 2 }, "sys", "帮我把默认模型改成 flash"));
  assert.ok(seen[0]!.includes("列出步骤"), "第一轮就该带计划提示：" + seen[0]);
});

test("verifyNudge 说人话：给两条验证路径 + 允许说没验", () => {
  const t = verifyNudge(["fs.write"]);
  assert.match(t, /必须先验证/);
  assert.match(t, /project\.read|node\.run_script/);
  assert.match(t, /不许说「已完成」/);
});


test("C-3 判定：只有可恢复的错误才补，且总提醒次数有上限", () => {
  assert.equal(isRecoverable("E_NOT_FOUND: tmp"), true);
  assert.equal(isRecoverable("E_PATH_DENIED: ."), true);
  assert.equal(isRecoverable("E_CORE_PROTECTED: 记忆库本体"), false, "记忆核心被拒是硬边界，补也没用");
  assert.equal(isRecoverable("E_DENIED(E_NO_RULE)"), false);
  const g = newGuard();
  assert.equal(canRetry(g, "fs.write", "E_NOT_FOUND: x"), true);
  assert.equal(canRetry(g, "fs.write", "E_NOT_FOUND: x"), false, "同名只补一次");
  assert.equal(canRetry(g, "fs.read", "E_NOT_FOUND: y"), true);
  assert.equal(canRetry(g, "project.read", "E_NOT_FOUND: z"), true);
  assert.equal(canRetry(g, "memory.search", "E_NOT_FOUND: w"), false, "第 4 次超出预算");
});


test("C-2 回归：不该讨计划时**不许标记** planned（否则收尾时会误发「开始执行」）", () => {
  const g = newGuard();
  assert.equal(needPlan(g, "在吗"), false);
  assert.equal(g.planned, false, "没讨过计划就不能标记，否则后面会误推它去执行");
  assert.equal(needPlan(g, "帮我改一下配置"), true);
  assert.equal(g.planned, true);
});
