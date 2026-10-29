/**
 * 工具调用冒烟（P0-1）
 *
 * 为什么要有它：这个项目里"本地模型"的用途不是聊天，是**自己调工具整理记忆**
 * （`doc.search` 捞原文、`memory.remember` 落条目、冲突时回查）。1.5B 栽在这里，
 * 而且是**上线之后才发现**——所以要有一样东西，能在换模型之前先问一句"你到底会不会调工具"。
 *
 * 判据不是"能不能吐 tool_calls"，而是三件事同时成立：
 *   ① 挑对了工具（问时间不该去读文件）
 *   ② 参数是合法 JSON 对象
 *   ③ 必需的参数在位且内容对（路径真的指向那个文件、查询词真的包含关键词）
 *
 * 通过线默认 70%（3 个用例 × n 次，每次最多算 1 次尝试）。低于它就是"不可用"——
 * 不是"还差一点"，因为记忆整理是**批量**任务，30% 的失败率会把脏数据写进长期记忆。
 */
import type { ChatEvent } from "./transport.ts";

export interface SmokeCase {
  id: string;
  /** 给模型的提示（不含任何记忆原文，云端模型也能跑） */
  prompt: string;
  /** 期望调用的工具（OpenAI 风格的名字，即下划线别名） */
  want: string;
  /** 必需参数：键 → 必须满足的条件 */
  need: Record<string, string | RegExp>;
}

export const SMOKE_CASES: SmokeCase[] = [
  {
    id: "time",
    prompt: "现在几点了？用工具查，不要猜。",
    want: "time_now",
    need: {},
  },
  {
    id: "read",
    prompt: "用工具读一下 workspace/smoke-probe.txt 的内容，然后把第一行告诉我。",
    want: "fs_read",
    need: { path: /smoke-probe/ },
  },
  {
    id: "search",
    prompt: "用工具在我记住的事情里搜一下「衰减」，告诉我最相关的一条。",
    want: "memory_search",
    need: { q: /衰减/ },
  },
];

export interface CallCheck {
  ok: boolean;
  /** 失败时的原因码，便于统计（不是给人看的散文） */
  code?: "E_NO_CALL" | "E_UNKNOWN_TOOL" | "E_BAD_ARGS" | "E_WRONG_TOOL" | "E_MISSING_ARG" | "E_BAD_ARG_VALUE";
  detail?: string;
}

interface RawCall { name: string; args: string }

/** 校验一次尝试的工具调用：挑对工具 + 合法 JSON + 必需参数在位 */
export function checkCalls(
  calls: RawCall[], allowed: ReadonlySet<string>, c: SmokeCase,
): CallCheck {
  if (!calls.length) return { ok: false, code: "E_NO_CALL" };
  const first = calls[0]!;
  if (!allowed.has(first.name)) return { ok: false, code: "E_UNKNOWN_TOOL", detail: first.name };
  let args: unknown;
  try { args = JSON.parse(first.args || "{}"); } catch { return { ok: false, code: "E_BAD_ARGS", detail: first.args.slice(0, 40) }; }
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, code: "E_BAD_ARGS", detail: "not an object" };
  if (first.name !== c.want) return { ok: false, code: "E_WRONG_TOOL", detail: `${first.name} ≠ ${c.want}` };
  const obj = args as Record<string, unknown>;
  for (const [k, want] of Object.entries(c.need)) {
    const got = obj[k];
    if (got === undefined || got === null || got === "") return { ok: false, code: "E_MISSING_ARG", detail: k };
    const s = String(got);
    const ok = typeof want === "string" ? s === want : want.test(s);
    if (!ok) return { ok: false, code: "E_BAD_ARG_VALUE", detail: `${k}=${s.slice(0, 30)}` };
  }
  return { ok: true };
}

export type ChatLike = (messages: unknown[], tools: unknown) => AsyncGenerator<ChatEvent, void, void>;

export interface Attempt {
  caseId: string;
  ok: boolean;
  code?: string;
  detail?: string;
  ms: number;
  toolName?: string;
}

export interface SmokeReport {
  model: string;
  attempts: Attempt[];
  total: number;
  passed: number;
  rate: number;
  /** 每类失败出现了几次（E_NO_CALL 最常见于"根本不会调工具"） */
  byCode: Record<string, number>;
  perCase: Record<string, { total: number; passed: number }>;
  latencyMs: { p50: number; max: number };
  /** 判定：rate ≥ threshold */
  pass: boolean;
  threshold: number;
}

const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

/**
 * 跑 N 轮 × 每个用例一次。`chat` 注入（测试里可以给假模型），CLI 里给真 transport。
 */
export async function runToolSmoke(o: {
  chat: ChatLike;
  /** OpenAI 风格的 tool schema（name 必须与用例里的 want 对得上） */
  schema: Array<{ type: "function"; function: { name: string } }>;
  model?: string;
  n?: number;
  cases?: SmokeCase[];
  threshold?: number;
  onAttempt?: (a: Attempt) => void;
}): Promise<SmokeReport> {
  const cases = o.cases ?? SMOKE_CASES;
  const n = Math.max(1, o.n ?? 10);
  const threshold = o.threshold ?? 0.7;
  const allowed = new Set(o.schema.map((s) => s.function.name));
  const attempts: Attempt[] = [];

  for (let i = 0; i < n; i++) {
    for (const c of cases) {
      const t0 = Date.now();
      let calls: RawCall[] = [];
      try {
        for await (const ev of o.chat([{ role: "user", content: c.prompt }], o.schema)) {
          if (ev.type === "tool_calls") calls = ev.calls.map((x) => ({ name: x.name, args: x.args }));
        }
      } catch (e) {
        calls = [];
        attempts.push({ caseId: c.id, ok: false, code: "E_CALL", detail: String(e).slice(0, 60), ms: Date.now() - t0 });
        o.onAttempt?.(attempts[attempts.length - 1]!);
        continue;
      }
      const ms = Date.now() - t0;
      const v = checkCalls(calls, allowed, c);
      const a: Attempt = { caseId: c.id, ok: v.ok, ms, ...(v.code ? { code: v.code } : {}), ...(v.detail ? { detail: v.detail } : {}), ...(calls[0] ? { toolName: calls[0].name } : {}) };
      attempts.push(a);
      o.onAttempt?.(a);
    }
  }

  const total = attempts.length;
  const passed = attempts.filter((a) => a.ok).length;
  const byCode: Record<string, number> = {};
  for (const a of attempts) if (!a.ok) byCode[a.code ?? "E_?"] = (byCode[a.code ?? "E_?"] ?? 0) + 1;
  const perCase: SmokeReport["perCase"] = {};
  for (const c of cases) {
    const xs = attempts.filter((a) => a.caseId === c.id);
    perCase[c.id] = { total: xs.length, passed: xs.filter((a) => a.ok).length };
  }
  return {
    model: o.model ?? "(unknown)",
    attempts, total, passed,
    rate: total ? passed / total : 0,
    byCode, perCase,
    latencyMs: { p50: pct(attempts.map((a) => a.ms), 50), max: Math.max(...attempts.map((a) => a.ms), 0) },
    pass: total > 0 && passed / total >= threshold,
    threshold,
  };
}

/** 人看的报告（CLI 用） */
export function describeSmoke(r: SmokeReport): string {
  const lines: string[] = [];
  lines.push(`模型 ${r.model} ｜ ${r.passed}/${r.total} 次合法工具调用（${(r.rate * 100).toFixed(0)}%，线 ${(r.threshold * 100).toFixed(0)}%）`);
  for (const [id, v] of Object.entries(r.perCase)) {
    lines.push(`  ${id.padEnd(8)} ${v.passed}/${v.total}`);
  }
  if (Object.keys(r.byCode).length) {
    lines.push("  失败分布：" + Object.entries(r.byCode).map(([k, v]) => `${k}×${v}`).join(" · "));
  }
  lines.push(`  延迟 p50 ${r.latencyMs.p50}ms / max ${r.latencyMs.max}ms`);
  lines.push(r.pass ? "✅ 通过：这个模型可以拿去做记忆整理" : "❌ 不通过：别用它做批量整理（会把脏数据写进长期记忆）");
  return lines.join("\n");
}

/**
 * 问一次 Ollama：本机装了哪些模型。
 * 返回 null 表示 Ollama 连不上（这与"列表为空"是两件事，不能混）。
 */
export async function ollamaModels(baseUrl = "http://127.0.0.1:11434"): Promise<string[] | null> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json() as { models?: Array<{ name: string }> };
    return (j.models ?? []).map((m) => m.name);
  } catch { return null; }
}
