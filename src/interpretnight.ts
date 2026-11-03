/**
 * 「她对你的理解」的提炼（2026-11-03）。
 *
 * 为什么补这个：`interpret.ts` 那套写得很完整（必须带 basis 指向具体记忆、
 * 改看法要 supersede 旧条、不许复述原文冒充解释），但 `writeInterpretation`
 * **全仓只有定义、没有调用方** —— 简报里 P13「我怎么理解你」永远是空的。
 * 又一个「写了没接上」。
 *
 * 它跟「人格」是两回事：
 *   人格（persona 6 块）只有人能改；这里是**画像**，会随相处慢慢变，而且每一句都要有据可查。
 *
 * 三条约束（都在 writeInterpretation 里强制，这里负责给对输入）：
 *  1. 必须挂到真实存在、且还活着的记忆上（basis）
 *  2. 不许复述原文（那是抄，不是理解）
 *  3. 改看法 → 旧条 superseded，老的留着可追溯
 */
import type { DatabaseSync } from "node:sqlite";
import { writeInterpretation, listInterpretations } from "./interpret.ts";

/** 今晚最多补几条：多了会把 P13 撑爆，而且"理解"不该像刷屏 */
export const MAX_PER_NIGHT = 2;

/**
 * 可解释性检查（2026-11-03 实测教训）：
 *
 * 小模型很爱「完成任务」：给它两条技术记忆（posture.ts 的功能 / 探针记忆），
 * 它照样能推出一句「她对加班既需要又抗拒」。basis 只验证 id 存在，管不了这个。
 *
 * 判据：理解里至少要有**一个实词**出现在依据里 —— 推断可以不共享整个句子，
 * 但话题得落在证据上。连一个词都对不上，那就是凭空造话题（编），直接丢。
 */
export function plausible(text: string, basisTexts: string[]): boolean {
  const STOP = new Set(["她对", "对加", "她其", "其实", "似乎", "可能", "总是", "经常", "觉得", "认为", "需要", "抗拒"]);
  const bi = (x: string): string[] => {
    const out: string[] = [];
    const han: string[] = [];
    for (const ch of x) {
      if (/[一-鿿]/.test(ch)) { han.push(ch); continue; }
      for (let i = 0; i + 1 < han.length; i++) out.push(han[i]! + han[i + 1]!);
      han.length = 0;
    }
    for (let i = 0; i + 1 < han.length; i++) out.push(han[i]! + han[i + 1]!);
    return out;
  };
  const want = bi(text).filter((b) => !STOP.has(b));
  if (!want.length) return false;
  const have = new Set(basisTexts.flatMap(bi));
  return want.some((b) => have.has(b));
}

/** 从模型输出里抠出「一句话 | 依据 id」的行 */
export function parseInterpretations(raw: string, cap = MAX_PER_NIGHT): Array<{ text: string; basis: number[] }> {
  const out: Array<{ text: string; basis: number[] }> = [];
  for (const line of String(raw ?? "").split(String.fromCharCode(10))) {
    const s = line.trim().replace(/^[-*•\d.、\s]+/, "");
    if (!s) continue;
    // 形状：理解一句话 || 12,34
    const m = /^(.{6,300}?)\s*(\|\||｜｜|\|)\s*([\d,\s]+)$/.exec(s);
    if (!m) continue;
    const basis = (m[3] ?? "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
    if (!basis.length) continue;
    const text = (m[1] ?? "").trim();
    if (text.length < 6) continue;
    if (out.some((o) => o.text === text)) continue;
    out.push({ text, basis });
    if (out.length >= cap) break;
  }
  return out;
}

/** 拼提示：给它**具体的记忆 id**，让它只能指着真东西说话 */
export function interpretationPrompt(
  memories: Array<{ id: number; text: string }>,
  existing: string[],
): string {
  const NL = String.fromCharCode(10);
  return [
    "下面是这一段时间里她（用户）说过/发生过的事，每条前面是编号：",
    ...memories.map((m) => "[" + m.id + "] " + String(m.text).replace(/\s+/g, " ").slice(0, 120)),
    "",
    existing.length ? "你已经有的理解（不要重复，要改就说得更准）：" + NL + existing.map((e) => "- " + e).join(NL) : "",
    "",
    "任务：从这些事里读出 1-" + MAX_PER_NIGHT + " 条「她是怎样的人」。",
    "要求：",
    "  · 必须是**推断**，不是复述（说\"她对加班既依赖又怕\"，不要抄\"她今天加班到十一点\"）",
    "  · 每条后面写清依据的记忆编号，用 || 分隔。例如：",
    "    她对加班既需要又抗拒 || " + (memories[0]?.id ?? 1) + (memories[1] ? "," + memories[1].id : ""),
    "  · 读不出来就**一条也别写**（宁缺勿滥，空着比瞎猜好）",
    "  · 如果这些只是系统日志（比如「进程被杀 X 分钟」这种），或者彼此毫不相干，一条也别写 —— ",
    "    在系统日志上推断「她是怎样的人」只会得到一个假的结论",
    "  · 只输出这种行，不要别的解释",
  ].filter(Boolean).join(NL);
}

export interface InterpretationReport {
  tried: number;
  written: number;
  replaced: number;
  skipped: string[];
}

/**
 * 跑一轮：用最近写入的一批记忆喂模型，解析出「理解」并落库。
 *
 * 只有在**有新记忆**时才跑（没有新东西就没有新理解）—— 省一次模型调用。
 */
export async function refineInterpretations(
  db: DatabaseSync,
  deps: {
    /**
     * **纯文本**补全（不是带工具的抽取器）。
     * 踩过：一开始复用了夜间抽取的那个 extract，它带着记忆类工具 schema ——
     * 小模型会去调工具而不是回一句话，于是解析结果永远是空的。
     */
    complete: (prompt: string) => Promise<string>;
    limit?: number;
    now?: Date;
  },
): Promise<InterpretationReport> {
  const now = deps.now ?? new Date();
  const limit = Math.max(1, deps.limit ?? 8);
  const report: InterpretationReport = { tried: 0, written: 0, replaced: 0, skipped: [] };

  // 取最近写下的、值得拿来推断的记忆（排除契约层：那是约定，不是性格；
  // 被侵蚀过的不参与 —— 自己都记不清的事，不该拿来判断别人是什么人）
  // 喂养质量（2026-11-03 实测教训）：一开始直接取最近 8 条，结果喂进去的是
  // 8 条「进程被杀 15 小时…」（离线补账写的系统日志），模型硬编出
  // 「她对加班既需要又抗拒」——依据完全不相干。
  //
  // 两条筛选：
  //   · 排除 source_ref='offline-gap'（那是系统日志，不是她的生活）
  //   · 同类只留一条（8 条几乎一样的日志会把模型带偏）
  const rows = db.prepare(
    `SELECT id, text FROM memories
      WHERE status='active' AND layer='narrative' AND erase_stage = 0
        AND (source_ref IS NULL OR source_ref NOT IN ('startup','offline-gap','system','nightly'))
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(limit * 3) as Array<{ id: number; text: string }>;
  const seen = new Set<string>();
  const mem: Array<{ id: number; text: string }> = [];
  for (const m of rows) {
    const key = String(m.text).replace(/[0-9]+/g, '#').slice(0, 24);
    if (seen.has(key)) continue;      // 同类只留一条
    seen.add(key);
    mem.push(m);
    if (mem.length >= limit) break;
  }
  // 少于 2 条就别推断了：一条孤立的事推不出「她是怎样的人」，硬推出来的一定是编
  // （实测：8 条「进程被杀 X 分钟」的系统日志，被推成「她对加班既需要又抗拒」）
  if (mem.length < 2) { report.skipped.push("可用的记忆太少（可能都是系统日志），不硬推"); return report; }

  const existing = listInterpretations(db, 5).map((x) => x.text);
  const raw = await deps.complete(interpretationPrompt(mem, existing));
  const parsed = parseInterpretations(raw);
  report.tried = parsed.length;
  if (!parsed.length) { report.skipped.push("模型这次没读出什么（或格式不对）"); return report; }

  const byId = new Map(mem.map((m) => [m.id, m.text]));
  for (const p of parsed) {
    // 依据里必须有一个实词出现在这句话里（否则就是凭空造话题）
    const texts = p.basis.map((id) => byId.get(id) ?? "").filter(Boolean);
    if (!plausible(p.text, texts)) {
      report.skipped.push("E_INTERP_UNGROUNDED: " + p.text.slice(0, 24) + " —— 依据里找不到对应的话题");
      continue;
    }
    const r = writeInterpretation(db, { ...p, scoredBy: "night:interpret" }, now);
    if (r.ok) {
      report.written++;
      if (r.replaced) report.replaced++;
    } else {
      report.skipped.push(r.code + ": " + r.why.slice(0, 60));
    }
  }
  return report;
}
