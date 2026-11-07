/**
 * 任务编排的最小切片（M7 起步，2026-11-07）。
 *
 * 为什么是这个形状（docs/history/20 §5.2）：
 *   · **只让模型出「下一步」**，不让它出整条计划 —— 整条计划是幻想，
 *     第 2 步偏了以后剩下 10 步全是编的。
 *   · 状态就放在**我们自己的库里**（tasks 表），不引外部编排框架：
 *     编排器的状态本质上就是记忆，搬出去必然打架。
 *   · 每步都要**验证**（另一次模型判断"这一步做到没有"），
 *     连续两步无进展就挂起，主动问人 —— 不许装作在推进。
 *
 * 这一版只做「任务 + 步骤 + 检查点 + 续跑」；不做 DAG、不做并行、不做子任务。
 */
import type { DatabaseSync } from "node:sqlite";

export type TaskStatus = "active" | "paused" | "done" | "abandoned";

export interface TaskStep {
  /** 第几步（从 1 开始） */
  n: number;
  /** 模型说它要做什么（人话，给用户看的） */
  intent: string;
  /** 实际执行的 verb 与参数 */
  verb?: string;
  args?: Record<string, unknown>;
  /** 执行结果摘要（成功/失败 + 一句话） */
  result?: string;
  ok?: boolean;
  /** 验证：这一步算不算达成了 intent */
  verified?: boolean;
  /** 验证时模型给的理由 */
  verifyWhy?: string;
  at: string;
}

export interface Task {
  id: number;
  goal: string;
  status: TaskStatus;
  steps: TaskStep[];
  createdAt: string;
  updatedAt: string;
  /** 连续无进展的步数：≥2 就挂起（不装忙） */
  stalled: number;
}

const MAX_STEPS = 40;

export function ensureTaskTable(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','abandoned')),
  steps_json TEXT NOT NULL DEFAULT '[]',
  stalled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tasks_status ON tasks(status, updated_at);
`);
}

function row2task(r: Record<string, unknown>): Task {
  let steps: TaskStep[] = [];
  try { steps = JSON.parse(String(r.steps_json ?? "[]")) as TaskStep[]; } catch { steps = []; }
  return {
    id: Number(r.id),
    goal: String(r.goal),
    status: String(r.status) as TaskStatus,
    steps,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    stalled: Number(r.stalled ?? 0),
  };
}

export function createTask(db: DatabaseSync, goal: string, now = new Date()): Task {
  const g = String(goal ?? "").trim();
  if (!g) throw new Error("E_EMPTY_GOAL: 任务得有个目标");
  ensureTaskTable(db);
  const ts = now.toISOString();
  db.prepare("INSERT INTO tasks(goal,status,steps_json,stalled,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run(g, "active", "[]", 0, ts, ts);
  const id = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  return { id, goal: g, status: "active", steps: [], createdAt: ts, updatedAt: ts, stalled: 0 };
}

export function listTasks(db: DatabaseSync, status?: TaskStatus): Task[] {
  ensureTaskTable(db);
  const rows = status
    ? db.prepare("SELECT * FROM tasks WHERE status=? ORDER BY updated_at DESC").all(status)
    : db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all();
  return (rows as Record<string, unknown>[]).map(row2task);
}

export function getTask(db: DatabaseSync, id: number): Task | null {
  ensureTaskTable(db);
  const r = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return r ? row2task(r) : null;
}

/** 一次 tick 的结局 */
export type TickVerdict =
  | { kind: "step-done"; task: Task; step: TaskStep }
  | { kind: "step-failed"; task: Task; step: TaskStep }
  | { kind: "stalled"; task: Task }
  | { kind: "finished"; task: Task }
  | { kind: "capped"; task: Task };

/**
 * 记一步、更新检查点。
 * 规则：
 *   · 达成 → done
 *   · 失败或验证未过 → stalled+1；连续 2 次 → paused（等人）
 *   · 步数到顶 → paused（不是 done，别假装做完了）
 */
export function recordStep(db: DatabaseSync, task: Task, step: TaskStep, now = new Date()): TickVerdict {
  const steps = [...task.steps, step];
  const ts = now.toISOString();
  const progress = step.ok === true && step.verified !== false;

  let status: TaskStatus = task.status;
  let stalled = progress ? 0 : task.stalled + 1;
  if (step.ok === true && step.verified !== false && step.intent.startsWith("DONE")) status = "done";
  if (stalled >= 2) { status = "paused"; }
  if (steps.length >= MAX_STEPS && status === "active") status = "paused";

  db.prepare("UPDATE tasks SET steps_json=?, stalled=?, status=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(steps), stalled, status, ts, task.id);

  const next: Task = { ...task, steps, stalled, status, updatedAt: ts };
  if (status === "done") return { kind: "finished", task: next };
  if (stalled >= 2) return { kind: "stalled", task: next };
  if (status === "paused" && steps.length >= MAX_STEPS) return { kind: "capped", task: next };
  return { kind: progress ? "step-done" : "step-failed", task: next, step };
}

export function setTaskStatus(db: DatabaseSync, id: number, status: TaskStatus, now = new Date()): void {
  ensureTaskTable(db);
  db.prepare("UPDATE tasks SET status=?, updated_at=? WHERE id=?").run(status, now.toISOString(), id);
}

/**
 * 让模型说"下一步做什么"。纯函数化的解析在这里，调用模型在外面 ——
 * 这样解析规则能被单测，不用连真模型。
 *
 * 期望的回答形状（宽松解析）：
 *   {"verb":"fs.read","args":{...},"intent":"看一眼配置","done":false}
 *   {"done":true,"intent":"DONE 已经整理好了"}
 */
export function parseNextStep(raw: string): { verb?: string; args?: Record<string, unknown>; intent: string; done: boolean } | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { verb?: unknown; args?: unknown; intent?: unknown; done?: unknown };
    const intent = String(j.intent ?? "").trim();
    const done = j.done === true;
    if (!intent && !done) return null;
    const verb = typeof j.verb === "string" && j.verb.trim() ? j.verb.trim() : undefined;
    const args = j.args && typeof j.args === "object" ? (j.args as Record<string, unknown>) : undefined;
    if (!done && !verb) return null;
    return { verb, args, intent: intent || "DONE", done };
  } catch {
    return null;
  }
}

/** 给模型的提示：只问下一步，并强调"上一步的结果" */
export function nextStepPrompt(task: Task, tools: string[]): string {
  // 试过但没达成的动作：模型在实测里会原样重试（2026-11-07 tick 实测），这里点名禁掉
  const tried = task.steps.filter((s) => s.verified === false).slice(-5)
    .map((s) => `${s.verb || "?"}${JSON.stringify(s.args ?? {})}`);
  const recent = task.steps.slice(-3).map((s) => {
    const r = s.result ? ` → ${s.result}` : "";
    const v = s.verified === undefined ? "" : s.verified ? "（已验证达成）" : "（验证未达成）";
    return `${s.n}. 想做：${s.intent}${r}${v}`;
  }).join(String.fromCharCode(10)) || "（还没有做过任何一步）";

  return [
    "你在替用户推进一个**跨会话**的任务。现在只决定**下一步做一件事**，不要给整条计划。",
    "只输出一行 JSON，不要解释：",
    '  {"verb":"<工具名>","args":{…},"intent":"这一步要达成什么","done":false}',
    '  或者：{"done":true,"intent":"DONE 一句话说清完成了什么"}',
    "",
    "可用工具：" + tools.join(" "),
    "",
    "任务目标：" + task.goal,
    "已经试过但没有达成的动作（不要原样重复，换更小的动作）：",
    tried.join(" ") || "（没有）",
    "",
    "已经做过的最近几步：",
    recent,
    "",
    "要求：",
    "1) 一步只做一件事，选一个工具；能读就先读，不要凭空写。",
    "2) 如果上一步失败了，换成更小的动作，不要重复同一个调用。",
    "3) 目标已经达成（或做不到了）就输出 done:true，并在 intent 里写清原因。",
    "4) 不确定就输出一个**只读**动作去确认，不要猜。",
  ].join(String.fromCharCode(10));
}

/** 验证提示：这一步算不算达成 */
export function verifyPrompt(task: Task, step: TaskStep): string {
  return [
    "判断这一步有没有达成它自己声明的意图。只回答 YES 或 NO，不要解释。",
    "标准：结果里必须有证据表明做到了；只是「调用了工具但没看到结果」算 NO。",
    "",
    "任务目标：" + task.goal,
    "这步的意图：" + step.intent,
    "用的工具：" + (step.verb || "—"),
    "参数：" + JSON.stringify(step.args ?? {}),
    "结果：" + (step.result || "（空）"),
  ].join(String.fromCharCode(10));
}
