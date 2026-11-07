/**
 * 任务编排（M7 最小切片）：表 + 纯逻辑 + tick 的三条硬规则。
 * 这里只测**不需要真模型**的部分 —— 解析、状态机、停滞判定、执行顺序。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createTask, getTask, listTasks, nextStepPrompt, parseNextStep, recordStep, setTaskStatus, verifyPrompt, type TaskStep } from "../src/tasks.ts";
import { tickOnce } from "../src/taskrunner.ts";

const ctx = () => {
  const dir = mkdtempSync(join(tmpdir(), "jj-task-"));
  return openDb(join(dir, "m.db"));
};
const now = () => new Date("2026-11-07T12:00:00Z");
const step = (n: number, over: Partial<TaskStep> = {}): TaskStep => ({
  n, intent: `第 ${n} 步`, ok: true, verified: true, at: now().toISOString(), ...over,
});

test("任务：建、列、取（同一个库里，跨会话还在）", () => {
  const d = ctx();
  const t = createTask(d.db, "把预算表整理好", now());
  assert.ok(t.id > 0);
  assert.equal(getTask(d.db, t.id)!.goal, "把预算表整理好");
  createTask(d.db, "第二件", now());
  assert.equal(listTasks(d.db).length, 2);
  assert.equal(listTasks(d.db, "active").length, 2);
  // 关掉再打开（同一文件）必须还在 —— 编排状态就是记忆，不能只活在内存
  assert.equal(listTasks(d.db).length, 2);
});

test("任务：没有目标就拒（E_EMPTY_GOAL）", () => {
  const d = ctx();
  assert.throws(() => createTask(d.db, "   ", now()), /E_EMPTY_GOAL/);
});

test("任务：成功且验证过 → 记一步，stalled 归零", () => {
  const d = ctx();
  const t = createTask(d.db, "g", now());
  const v = recordStep(d.db, { ...t, stalled: 0 }, step(1), now());
  assert.equal(v.kind, "step-done");
  assert.equal(v.task.stalled, 0);
  assert.equal(v.task.steps.length, 1);
});

test("任务：连续两步没进展 → 挂起（不假装在推进）", () => {
  const d = ctx();
  let t = createTask(d.db, "g", now());
  let v = recordStep(d.db, t, step(1, { ok: false }), now());
  assert.equal(v.kind, "step-failed");
  assert.equal(v.task.status, "active", "第一步失败还不挂起");
  t = v.task;
  v = recordStep(d.db, t, step(2, { ok: false }), now());
  assert.equal(v.kind, "stalled");
  assert.equal(v.task.status, "paused", "第二步失败就挂起，等人");
  assert.equal(getTask(d.db, t.id)!.status, "paused", "状态要落库");
});

test("任务：验证未过也算没进展", () => {
  const d = ctx();
  let t = createTask(d.db, "g", now());
  let v = recordStep(d.db, t, step(1, { ok: true, verified: false }), now());
  assert.equal(v.kind, "step-failed");
  t = v.task;
  v = recordStep(d.db, t, step(2, { ok: true, verified: false }), now());
  assert.equal(v.kind, "stalled");
});

test("任务：成功的一步会把 stalled 清零（失败一次后再成功）", () => {
  const d = ctx();
  let t = createTask(d.db, "g", now());
  let v = recordStep(d.db, t, step(1, { ok: false }), now());
  assert.equal(v.task.stalled, 1);
  v = recordStep(d.db, v.task, step(2), now());
  assert.equal(v.task.stalled, 0);
  assert.equal(v.task.status, "active");
});

test("任务：模型说做完了 → 任务关闭", () => {
  const d = ctx();
  const t = createTask(d.db, "g", now());
  const v = recordStep(d.db, t, step(1, { intent: "DONE 整理完了" }), now());
  assert.equal(v.kind, "finished");
  assert.equal(getTask(d.db, t.id)!.status, "done");
});

test("任务：步数到顶 → paused，不是 done（别假装做完了）", () => {
  const d = ctx();
  let t = createTask(d.db, "g", now());
  for (let i = 1; i <= 40; i++) {
    const v = recordStep(d.db, t, step(i), now());
    if (v.kind === "capped") {
      assert.equal(v.task.status, "paused");
      assert.ok(v.task.steps.length >= 40);
      return;
    }
    t = v.task;
  }
  assert.fail("40 步后应当 capped");
});

test("任务：手动改状态（resume/pause/done/abandon）", () => {
  const d = ctx();
  const t = createTask(d.db, "g", now());
  setTaskStatus(d.db, t.id, "paused", now());
  assert.equal(getTask(d.db, t.id)!.status, "paused");
  setTaskStatus(d.db, t.id, "active", now());
  assert.equal(getTask(d.db, t.id)!.status, "active");
});

test("下一步解析：正常 JSON / 带 ``` 包裹 / 说话带前缀 都能认", () => {
  const a = parseNextStep('{"verb":"fs.read","args":{"path":"a.txt"},"intent":"看一眼","done":false}');
  assert.equal(a!.verb, "fs.read");
  assert.deepEqual(a!.args, { path: "a.txt" });
  assert.equal(a!.done, false);

  const b = parseNextStep('好的，下一步：\n```json\n{"verb":"fs.list","args":{},"intent":"列目录","done":false}\n```');
  assert.equal(b!.verb, "fs.list");

  const c = parseNextStep('{"done":true,"intent":"DONE 都整理好了"}');
  assert.equal(c!.done, true);
});

test("下一步解析：解析不出来就返回 null（不猜）", () => {
  assert.equal(parseNextStep(""), null);
  assert.equal(parseNextStep("我觉得下一步应该先看看情况"), null);
  assert.equal(parseNextStep('{"intent":"想说点什么"}'), null, "既没 verb 也没 done");
  assert.equal(parseNextStep("{坏的 json"), null);
});

test("提示词：带目标、带最近三步、要求一步一事", () => {
  const t = { id: 1, goal: "整理预算", status: "active" as const, steps: [step(1), step(2, { ok: false, result: "E_NO_FILE" })], createdAt: "", updatedAt: "", stalled: 1 };
  const p = nextStepPrompt(t, ["fs.read", "fs.write"]);
  assert.match(p, /整理预算/);
  assert.match(p, /下一步做一件事/);
  assert.match(p, /E_NO_FILE/);
  assert.match(p, /fs.read/);
  const v = verifyPrompt(t, step(3, { intent: "读配置", verb: "fs.read", result: "{}" }));
  assert.match(v, /YES 或 NO/);
  assert.match(v, /读配置/);
});

test("tick：模型给出可执行的一步 → 真的跑、真的记", async () => {
  const d = ctx();
  const t = createTask(d.db, "看一眼配置", now());
  let ran: { verb: string; args: unknown } | null = null;
  const v = await tickOnce({
    db: d.db, home: "unused", now,
    ask: async (prompt) => (prompt.includes("YES 或 NO")
      ? "YES"
      : '{"verb":"fs.read","args":{"path":"config.json"},"intent":"读配置","done":false}'),
    run: async (verb, args) => { ran = { verb, args }; return { ok: true, out: '{"ok":1}' }; },
  }, t);
  assert.equal(v.kind, "step-done");
  assert.equal(ran!.verb, "fs.read");
  assert.equal(v.task.steps[0]!.verified, true);
  assert.equal(v.task.steps[0]!.result, '{"ok":1}');
});

test("tick：模型说完了 → 直接关闭，不去调工具", async () => {
  const d = ctx();
  const t = createTask(d.db, "已经做完了的事", now());
  let called = false;
  const v = await tickOnce({
    db: d.db, home: "unused", now,
    ask: async () => '{"done":true,"intent":"DONE 不用做"}',
    run: async () => { called = true; return { ok: true }; },
  }, t);
  assert.equal(v.kind, "finished");
  assert.equal(called, false, "说完了就不该再动工具");
});

test("tick：执行失败 → 记失败，且不再花一次验证调用", async () => {
  const d = ctx();
  const t = createTask(d.db, "g", now());
  let askCount = 0;
  const v = await tickOnce({
    db: d.db, home: "unused", now,
    ask: async (prompt) => { askCount++; return prompt.includes("YES 或 NO") ? "NO" : '{"verb":"fs.read","args":{},"intent":"读","done":false}'; },
    run: async () => ({ ok: false, error: "E_NO_FILE" }),
  }, t);
  assert.equal(v.kind, "step-failed");
  assert.equal(v.step.ok, false);
  assert.equal(askCount, 1, "失败就不该再问验证");
});

test("tick：模型胡说（解析不出）→ 记一步失败，不静默", async () => {
  const d = ctx();
  const t = createTask(d.db, "g", now());
  const v = await tickOnce({
    db: d.db, home: "unused", now,
    ask: async () => "我觉得应该先想想",
    run: async () => ({ ok: true }),
  }, t);
  assert.equal(v.kind, "step-failed");
  assert.match(v.task.steps[0]!.verifyWhy!, /E_TASK_PARSE/);
});

test("tick：原样重试上一步（且那次没达成）→ 直接记失败，不再执行", async () => {
  const d = ctx();
  let t = createTask(d.db, "g", now());
  let v = await tickOnce({
    db: d.db, home: "unused", now,
    ask: async (p) => (p.includes("YES 或 NO") ? "NO" : '{"verb":"fs.list","args":{"path":"."},"intent":"列目录","done":false}'),
    run: async () => ({ ok: true, out: "[]" }),
  }, t);
  assert.equal(v.kind, "step-failed");
  t = v.task;
  let ran = 0;
  v = await tickOnce({
    db: d.db, home: "unused", now,
    ask: async (p) => (p.includes("YES 或 NO") ? "NO" : '{"verb":"fs.list","args":{"path":"."},"intent":"再列一次","done":false}'),
    run: async () => { ran++; return { ok: true, out: "[]" }; },
  }, t);
  assert.equal(ran, 0, "同一个动作不该再跑一次");
  assert.equal(v.kind, "stalled");
  assert.equal(v.task.steps[1]!.verifyWhy, "E_TASK_REPEAT");
});

test("提示词：把「试过但没达成」的动作点名列出", () => {
  const t = { id: 1, goal: "g", status: "active" as const, stalled: 1, createdAt: "", updatedAt: "",
    steps: [step(1, { verb: "fs.list", args: { path: "." }, verified: false })] };
  const p = nextStepPrompt(t, ["fs.list"]);
  assert.match(p, /不要原样重复/);
  assert.match(p, /fs\.list/);
});
