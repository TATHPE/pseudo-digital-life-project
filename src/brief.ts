/**
 * 情境简报（06 §3 / 17 §2）
 *
 * 三条不变量（test/brief.test.ts 守着）：
 *  1) P1–P4 逐字不变 → 前缀 hash 稳定 → 可命中缓存（0.1x）
 *  2) 总预算 ≤ budget.total（默认 2000），且**不随轮数增长**
 *  3) 槽位集合与顺序固定，缺内容时留空标记而不是消失
 */
import { createHash } from "node:crypto";
import { estimateTokens } from "./tokens.ts";
import type {
  BriefBudget, BriefInput, BriefOutput, BriefSlot, MemoryLine,
} from "./types.ts";

const DEFAULT_BUDGET: BriefBudget = {
  total: 2000,
  contracts: 400,
  recalled: 600,
  prefix: 1400,
};

const MAX_CONTRACTS = 15;
const MAX_THREADS = 3;
const MAX_RECALLED = 8;

function fmtGap(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "刚刚";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${mm} 分`;
  return `${mm} 分钟`;
}

function fmtTime(d: Date): string {
  const w = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${w} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** P5：三种时间措辞（18 §2.3）——正常 / 休息 / 断片，绝不混用 */
export function timeLine(input: BriefInput): string {
  const { now, lastSeenAt, outage } = input;
  if (outage) {
    const dur = fmtGap(outage.to.getTime() - outage.from.getTime());
    const head = outage.kind === "power" ? "我断电了" : "我刚断了一下";
    return `【现在】${fmtTime(now)}。${head} ${dur}（${fmtTime(outage.from).slice(11)}–${fmtTime(outage.to).slice(11)}），那段我什么都没经历。`;
  }
  if (!outage && lastSeenAt) {
    return `【现在】${fmtTime(now)}。距上次对话 ${fmtGap(now.getTime() - lastSeenAt.getTime())}（${fmtTime(lastSeenAt)}）。`;
  }
  return `【现在】${fmtTime(now)}。`;
}

function recallLine(m: MemoryLine): string {
  // 文档块：不是“我记得”，是“书里写着”——两种来源在提示里必须一眼能分
  if (m.source === "doc") {
    const where = m.headingPath ? " · " + m.headingPath : "";
    return `- [文档${where}] ${m.text}（cite: ${m.id}）`;
  }
  const tag = m.layer === "contract" ? "契约" : "叙事";
  return `- [${tag} · ${m.kind} · ${m.stage} ${m.weight.toFixed(2)}] ${m.text}（cite: ${m.id}）`;
}

function fit<T>(items: T[], max: number, budget: number, render: (x: T) => string) {
  const kept: T[] = [];
  const lines: string[] = [];
  let used = 0;
  for (const it of items) {
    const line = render(it);
    const t = estimateTokens(line) + 1;
    if (kept.length >= max || used + t > budget) break;
    kept.push(it);
    lines.push(line);
    used += t;
  }
  return { kept, lines, used };
}

export function buildBrief(input: BriefInput): BriefOutput {
  const b: BriefBudget = { ...DEFAULT_BUDGET, ...(input.budget ?? {}) };
  const p = input.persona;

  // ── 稳定前缀（P1–P4）：逐字不变 ───────────────────────
  const stable = [
    ["P1", "我是谁", p.core],
    ["P2", "禁区", p.boundaries],
    ["P3", "证据优先级", p.evidenceOrder],
    ["P4", "工具与目录", `${p.toolSchemas}\n${p.toolDirectory}`],
  ] as const;

  const slots: BriefSlot[] = stable.map(([id, label, text]) => ({
    id, label, tokens: estimateTokens(text), stable: true,
  }));

  const prefixText = stable.map(([, , t]) => t).join("\n\n");
  const prefixHash = createHash("sha256").update(prefixText).digest("hex").slice(0, 16);

  // ── 半稳定（P5–P7）───────────────────────────────────
  const p5 = timeLine(input);
  slots.push({ id: "P5", label: "此刻", tokens: estimateTokens(p5), stable: false });

  const c = fit(input.contracts, MAX_CONTRACTS, b.contracts, (s) => `- ${s}`);
  const p6 = c.lines.length ? `【关于你 · 契约层】\n${c.lines.join("\n")}` : "【关于你】暂无。";
  slots.push({ id: "P6", label: "契约记忆", tokens: estimateTokens(p6), stable: false });

  const st = input.state;
  const p7 = st
    ? `【状态】energy ${st.energy.toFixed(2)}｜closeness ${st.closeness.toFixed(2)}${st.mood ? `｜${st.mood}` : ""}`
    : "";
  slots.push({ id: "P7", label: "我的状态", tokens: estimateTokens(p7), stable: false });

  // ── 易变（P8–P10）────────────────────────────────────
  const th = (input.threads ?? []).slice(0, MAX_THREADS);
  const p8parts: string[] = [];
  if (input.lastName) p8parts.push(`【我们上次】${input.lastName}`);
  if (th.length) p8parts.push(`【线头】${th.map((x, i) => `${i + 1}. ${x}`).join(" ")}`);
  const p8 = p8parts.join("\n");
  slots.push({ id: "P8", label: "上次/线头", tokens: estimateTokens(p8), stable: false });

  const p9 = input.delta ? `【这次变了】${input.delta}` : "";
  slots.push({ id: "P9", label: "增量", tokens: estimateTokens(p9), stable: false });

  const r = fit(input.recalled, MAX_RECALLED, b.recalled, recallLine);
  const p10 = r.lines.length ? `【召回】\n${r.lines.join("\n")}` : "【召回】无";
  slots.push({ id: "P10", label: "召回", tokens: estimateTokens(p10), stable: false });

  // ── 本轮输入 ────────────────────────────────────────
  const p11 = input.user;
  slots.push({ id: "P11", label: "用户输入", tokens: estimateTokens(p11), stable: false });

  // confidence 四态（01 §6.2）：召回为空时必须能说"不知道"
  const confidence: BriefOutput["confidence"] =
    input.recalled.length === 0 ? "abstain" : input.recalled.length < 2 ? "need_evidence" : "answer";

  const body = [p5, p6, p7, p8, p9, p10].filter(Boolean).join("\n\n");
  const text = [prefixText, body, p11].filter(Boolean).join("\n\n");
  const tokens = estimateTokens(text);

  return {
    text, tokens, prefixHash, slots, confidence,
    dropped: {
      recalled: input.recalled.length - r.kept.length,
      contracts: input.contracts.length - c.kept.length,
      threads: (input.threads ?? []).length - th.length,
    },
  };
}
