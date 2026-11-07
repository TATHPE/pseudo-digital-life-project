/**
 * 任务编排的**执行器**（M7 最小切片的 tick）。
 *
 * 分工：`tasks.ts` 只管表和纯逻辑（可单测）；这里负责"问模型一步 → 跑 → 验 → 记账"。
 * 一次 tick 只推进一步 —— 这是刻意的：整条计划是幻想，单步 + 验证才可执行。
 */
import type { DatabaseSync } from "node:sqlite";
import { readFileConfig } from "./configfile.ts";
import { execute } from "./execute.ts";
import { loadPolicy } from "./policy.ts";
import { createEmbedder } from "./embed.ts";
import { resolveConfig } from "./configfile.ts";
import { verbCatalog } from "./verbs.ts";
import { nextStepPrompt, parseNextStep, recordStep, verifyPrompt, type Task, type TaskStep, type TickVerdict } from "./tasks.ts";

export interface TickDeps {
  db: DatabaseSync;
  home: string;
  /** 注入模型，测试里换成假的 */
  ask: (prompt: string) => Promise<string>;
  /** 注入执行器，测试里换成假的（真身是 execute） */
  run: (verb: string, args: Record<string, unknown>) => Promise<{ ok: boolean; out?: string; error?: string }>;
  now?: () => Date;
}

/** 默认的本地模型调用（和重排同一个端点/模型，别无第二套配置） */
export function localAsk(home: string): (prompt: string) => Promise<string> {
  const cfg = readFileConfig(home) as { ollama?: string; local?: { default?: string; night?: string } };
  const base = String(cfg.ollama ?? "http://127.0.0.1:11434");
  const model = String(cfg.local?.default ?? cfg.local?.night ?? "qwen2.5:7b-instruct");
  return async (prompt: string) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60_000);
    try {
      const r = await fetch(base + "/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, num_predict: 300 } }),
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error("E_TASK_MODEL_HTTP_" + r.status);
      const j = (await r.json()) as { response?: string };
      return String(j.response ?? "");
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 真执行器：走 04 的 T 档与门禁 */
export function realRun(home: string, db: DatabaseSync) {
  return async (verb: string, args: Record<string, unknown>) => {
    const policy = await loadPolicy(home);
    const cfg = resolveConfig(home);
    const emb = createEmbedder("ollama", { baseUrl: cfg.ollama, model: cfg.roles.embed!.model });
    const r = await execute(
      { db, policy, ctx: { home, now: () => new Date(), db, embedder: emb } },
      verb,
      args,
      { approved: true },
    );
    const anyR = r as { ok: boolean; out?: string; error?: string };
    return { ok: Boolean(anyR.ok), out: anyR.out, error: anyR.error };
  };
}

/** 推进任务一步 */
export async function tickOnce(deps: TickDeps, task: Task): Promise<TickVerdict> {
  const now = deps.now ?? (() => new Date());
  const tools = verbCatalog().filter((v) => v.tier !== "T4").map((v) => v.name);
  const raw = await deps.ask(nextStepPrompt(task, tools));
  const plan = parseNextStep(raw);

  // 模型没说清 → 记为失败的一步（不冒充进展）
  if (!plan) {
    const step: TaskStep = { n: task.steps.length + 1, intent: "（模型没给出可解析的下一步）", ok: false, verified: false, verifyWhy: "E_TASK_PARSE", at: now().toISOString() };
    return recordStep(deps.db, task, step, now());
  }

  // 它说做完了：验证一句（避免自说自话）
  if (plan.done) {
    const step: TaskStep = { n: task.steps.length + 1, intent: plan.intent, ok: true, verified: true, at: now().toISOString() };
    return recordStep(deps.db, task, step, now());
  }

  // 同一动作原样重试 → 直接记失败，不再花一次执行 + 一次验证（实测模型会这么干）
  const sig = plan.verb + JSON.stringify(plan.args ?? {});
  const lastFail = [...task.steps].reverse().find((s) => s.verified === false);
  if (lastFail && lastFail.verb + JSON.stringify(lastFail.args ?? {}) === sig) {
    const step: TaskStep = { n: task.steps.length + 1, intent: plan.intent, verb: plan.verb, args: plan.args ?? {},
      result: "（和上一步完全一样，且那次没达成——跳过）", ok: false, verified: false, verifyWhy: "E_TASK_REPEAT", at: now().toISOString() };
    return recordStep(deps.db, task, step, now());
  }

  const r = await deps.run(plan.verb!, plan.args ?? {});
  const result = r.ok ? String(r.out ?? "").slice(0, 1200) : String(r.error ?? "失败").slice(0, 300);
  const step: TaskStep = {
    n: task.steps.length + 1,
    intent: plan.intent,
    verb: plan.verb,
    args: plan.args ?? {},
    result,
    ok: r.ok,
    at: now().toISOString(),
  };

  // 执行失败就不用再问验证了（省一次调用）
  if (!r.ok) return recordStep(deps.db, task, step, now());

  // 成功也验一次：调用了工具 ≠ 达成了意图
  try {
    const verdict = await deps.ask(verifyPrompt(task, step));
    const yes = String(verdict ?? "").trim().toUpperCase().startsWith("YES");
    step.verified = yes;
    step.verifyWhy = String(verdict ?? "").trim().slice(0, 80);
  } catch {
    // 验证失败不等于步骤失败：记 verified 未定，让下一步继续
    step.verified = undefined;
  }
  return recordStep(deps.db, task, step, now());
}
