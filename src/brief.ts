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
const MAX_AGENDA = 2;
const MAX_INTERP = 2;
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
  // 读来的单独标一档：她对书里的句子和对自己的经历，语气不该一样
  const tag = m.layer === "contract" ? "契约" : m.kind === "reading" ? "读来" : "叙事";
  // 原话优先（J-2）：想起"奶奶生日"时，先浮出来的应该是那句原话，
  // 而不是一条抽象的"待办：提醒生日"。
  const q = m.quote ? String.fromCharCode(12300) + m.quote + String.fromCharCode(12301) + " " : "";
  const via = m.viaLink ? `（接着 #${m.viaLink.from}：${m.viaLink.why}）` : "";
  return `- [${tag} · ${m.kind} · ${m.stage} ${m.weight.toFixed(2)}] ${q}${m.text}（cite: ${m.id}）${via}`;
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
  // ── 没有真召回时，把话说死（2026-11-02，来自她自己的第 3 条自检）──
  //
  // 她的原话：「我分不清『我记着』和『我觉得应该记得』……契约第一条写在最前面，
  // 但它是这七条里我最容易踩的，因为它不像越权那样会立刻报错，错了也没人当场抓住。」
  //
  // 靠自律没用（她自己也这么说）。这里改的是**上下文结构**：没召回 / 只召回到契约条目时，
  // 就在 P10 里紧跟一段硬提示，并把契约第一条**再念一遍** —— 放在她犯错的位置，
  // 而不是指望她记得最前面那一条。放易变区，稳定前缀的 prefixHash 不受影响。
  const narrativeHits = (input.recalled ?? []).filter((m) => (m.layer ?? "narrative") !== "contract").length;
  const noNarrative = narrativeHits === 0;
  const ABSTAIN_NOTE = [
    "（这一轮没有与你问的这件事相关的记忆。",
    "不要说「上次你说过」「我们之前提过」这类话 —— 那是编。不知道就说不知道，问她。）",
    "（契约第一条：不确定是不是真的记得，就说不记得。别把「我觉得应该记得」说成「我记得」。）",
  ].join("\n");
  const p10body = r.lines.length ? `【召回】\n${r.lines.join("\n")}` : "【召回】无";
  const p10 = noNarrative ? `${p10body}\n${ABSTAIN_NOTE}` : p10body;
  slots.push({ id: "P10", label: "召回", tokens: estimateTokens(p10), stable: false });

  // ── 她自己那一层（H-a / H-b）────────────────────────
  // 她有「自己在惦记的事」和「对人的理解」，不是每轮都靠人提。
  const ag = (input.agenda ?? []).slice(0, MAX_AGENDA);
  const p12 = ag.length ? `【我惦记的】${ag.join(" ／ ")}` : "";
  slots.push({ id: "P12", label: "我惦记的", tokens: estimateTokens(p12), stable: false });

  const it = (input.interpretations ?? []).slice(0, MAX_INTERP);
  const p13 = it.length ? `【我怎么理解你】${it.join(" ／ ")}` : "";
  slots.push({ id: "P13", label: "我的理解", tokens: estimateTokens(p13), stable: false });

  // P14 技能索引（docs/11 第二优先）：只报"有这么一份说明书"，正文按需取。
  // 放在易变区：装了/删了技能不该让稳定前缀（prefixHash）变。
  const p14 = input.skills ? input.skills : "";
  slots.push({ id: "P14", label: "可用技能", tokens: estimateTokens(p14), stable: false });

  // P15 我现在的权限：让她知道自己此刻能做什么。
  // 没有这一槽的时候，她明明能跑命令也会说"我不能直接操作你的电脑"（实测）。
  const p15 = input.powers ? input.powers : "";
  slots.push({ id: "P15", label: "我现在的权限", tokens: estimateTokens(p15), stable: false });
  // ── 本轮输入 ────────────────────────────────────────
  const p11 = input.user;
  slots.push({ id: "P11", label: "用户输入", tokens: estimateTokens(p11), stable: false });

  // confidence 四态（01 §6.2）：召回为空时必须能说"不知道"
  const confidence: BriefOutput["confidence"] =
    narrativeHits === 0 ? "abstain" : narrativeHits < 2 ? "need_evidence" : "answer";

  const body = [p5, p6, p7, p8, p9, p10, p12, p13, p14, p15].filter(Boolean).join("\n\n");
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
