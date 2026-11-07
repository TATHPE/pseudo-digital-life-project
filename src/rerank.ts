/**
 * 选择性重排（2026-11-05，docs/ops/24 的标准：R@1 和 abstain **同时**变好才落地）。
 *
 * 为什么不是 cross-encoder：Ollama 没有 rerank 接口；引 Python/ONNX 会打破「零构建、两个依赖」。
 * 用本地 7B 当列表重排器，代价是 1–2 秒 —— 所以**只在不确定的时候跑**：
 *   · 命中 ≥2 条，且第一、第二名的分数贴得很近（模糊）
 *   · 或者一条都没命中（这一轮干脆问它"有没有"）
 *
 * 实测（tools/eval-rerank.ts，hard 夹具 12 条）：
 *   基线 R@1 9/10 · abstain 0/2  →  重排 R@1 10/10 · abstain 2/2
 *
 * 任何一步失败（超时、模型不在、输出看不懂）都**退回基线顺序**，绝不让回答卡住。
 */
import type { DatabaseSync } from "node:sqlite";
import { readFileConfig } from "./configfile.ts";

export type RerankMode = "off" | "auto" | "always";

export interface RerankHit { id: number; text: string; score: number }

/** 从模型的回答里抠出编号：只认第一个 1-9，或者 NONE。公开成纯函数是为了能单测。 */
export function parsePick(raw: string, n: number): number | "NONE" | null {
  const t = String(raw ?? "").toUpperCase();
  if (t.includes("NONE")) return "NONE";
  const m = t.match(/[1-9]/);
  if (!m) return null;
  const i = Number(m[0]);
  return i >= 1 && i <= n ? i - 1 : null;
}

/** 值得跑一次重排吗？（默认 auto：只在模糊或全空时跑） */
export function shouldRerank(mode: RerankMode, hits: RerankHit[]): boolean {
  if (mode === "off") return false;
  if (mode === "always") return hits.length >= 2;
  if (hits.length === 0) return true;          // 全空：问一句"真的没有吗"
  if (hits.length === 1) return false;         // 只有一条，没什么可排的
  const gap = hits[0]!.score - hits[1]!.score;
  return gap < 0.04;                            // 贴得很近才算模糊
}

export interface RerankResult {
  /** 重排后的顺序（可能就是原顺序） */
  order: RerankHit[];
  /** 模型说"都没有" */
  none: boolean;
  /** 真跑了没有 */
  ran: boolean;
  ms: number;
  /** 跑失败的原因（退回基线时有用） */
  error?: string;
}

export function rerankModel(home: string): string {
  const cfg = readFileConfig(home) as { local?: { default?: string; night?: string } };
  return String(cfg.local?.default ?? cfg.local?.night ?? "qwen2.5:7b-instruct");
}

/**
 * 让本地模型在候选里挑一条；挑不出来就说 NONE。
 * timeoutMs 一到就放弃（返回基线），因为回答不能等它。
 */
export async function rerank(
  home: string, query: string, hits: RerankHit[],
  o: { mode?: RerankMode; timeoutMs?: number; model?: string } = {},
): Promise<RerankResult> {
  const t0 = Date.now();
  const mode = o.mode ?? "auto";
  if (!shouldRerank(mode, hits)) return { order: hits, none: false, ran: false, ms: 0 };
  if (!hits.length) return { order: hits, none: false, ran: false, ms: 0 };

  const cfg = readFileConfig(home) as { ollama?: string };
  const base = String(cfg.ollama ?? "http://127.0.0.1:11434");
  const model = o.model ?? rerankModel(home);
  const timeoutMs = o.timeoutMs ?? 4500;

  const list = hits.map((h, i) => i + 1 + ". " + String(h.text).slice(0, 160)).join(String.fromCharCode(10));
  const prompt = [
    "你是检索重排器。下面是问题与候选记忆。",
    "只输出一个编号（1 到 " + hits.length + "）；真的没有相关的，才输出 NONE。",
    "注意：问题可能说得很含糊（「上周说的那个」「我妈生日那事」「之前定的规范」）——",
    "只要候选里有一条在讲同一件事，就选它，不要因为问法含糊而说 NONE。",
    "不要解释，不要标点，不要别的话。",
    "",
    "问题：" + query,
    "候选：",
    list,
  ].join(String.fromCharCode(10));

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(base + "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, num_predict: 8 } }),
      signal: ctl.signal,
    });
    if (!r.ok) return { order: hits, none: false, ran: false, ms: Date.now() - t0, error: "E_RERANK_HTTP_" + r.status };
    const j = (await r.json()) as { response?: string };
    const pick = parsePick(String(j.response ?? ""), hits.length);
    if (pick === "NONE") return { order: [], none: true, ran: true, ms: Date.now() - t0 };
    if (pick === null) return { order: hits, none: false, ran: false, ms: Date.now() - t0, error: "E_RERANK_PARSE" };
    const order = [hits[pick]!, ...hits.filter((_, i) => i !== pick)];
    return { order, none: false, ran: true, ms: Date.now() - t0 };
  } catch (e) {
    return { order: hits, none: false, ran: false, ms: Date.now() - t0, error: String((e as Error)?.name ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

export function rerankModeFromConfig(home: string): RerankMode {
  const cfg = readFileConfig(home) as { ui?: { rerank?: string } };
  const v = String(cfg.ui?.rerank ?? "auto");
  return v === "off" || v === "always" ? v : "auto";
}

void (0 as unknown as DatabaseSync);
