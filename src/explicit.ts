/**
 * 当场记住（2026-11-04）：用户**明说**要记的事，不经过模型，直接落库。
 *
 * 为什么需要这一层：
 *   · 库里 `memory.search` 被调了 25 次，`memory.remember` 只有 2 次 ——
 *     她读记忆很勤，写记忆几乎只靠夜里那一次批处理。
 *   · 而夜间抽取一次最多收 5 条（刚改成按内容量放），还要先过 20 条一段的窗口。
 *     一句话说完要等几小时才可能被记住，而且可能被切掉。
 *
 * 所以：**明确的记性请求当场办**，其余交给夜间整理。
 * 这一层是纯规则（闸门先于模型）：宁可漏，不要误记 —— 误记一条比漏一条贵得多。
 *
 * 三条边界：
 *   ① 只认**明确的说法**（「记住 X」「以后别 X」「我对 X 过敏」），不猜语气
 *   ② 原文照抄（quote = 用户那句话，text = 去掉"记住："前缀的内容），不加工
 *   ③ 完全相同的正文不重复写（同一句话说两遍只留一条，count 由 reinforce 管）
 */
import type { DatabaseSync } from "node:sqlite";
import { remember } from "./store.ts";

export type ExplicitKind = "boundary" | "fact_hard" | "preference_hard" | "episode";

export interface Explicit {
  /** 落库正文（尽量贴近原话） */
  text: string;
  kind: ExplicitKind;
  layer: "narrative" | "contract";
  /** 命中了哪条规则（审计与测试用） */
  rule: string;
}

const MAX = 120;

/** 「记住 X」这种直接请求：把前缀剥掉，剩下的就是要记的内容 */
const ASK = /^(?:请|麻烦)?(?:你)?(?:记住|记一下|记下|记着|别忘了|帮我记住)[：:，,、\s]*(.+)$/;
/** 「以后别 / 今后不要」：边界。**必须指向人**（我/给我/找我/叫我），否则是在说代码 */
const NEVER = /((?:以后|今后|下次|往后)(?:别|不要|不用|别再)[^。！？!?]{1,40})/;
const ABOUT_ME = /(我|给我|找我|叫我|让我)/;
/** 过敏 / 忌口：硬事实 */
const ALLERGY = /(我(?:对|吃|喝)[^。！？!?]{1,12}(?:过敏|忌口))/;
/** 明确偏好 */
const LIKES = /(我(?:很|特别|比较)?(?:喜欢|爱吃|偏爱|不喜欢|讨厌|受不了|受不了)[^。！？!?]{1,40})/;
/** 生日 / 纪念日 */
const DATE = /((?:我的)?(?:生日|纪念日|结婚纪念日)(?:是|在)[^。！？!?]{1,20})/;

const clean = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, MAX);

/** 从一句话里判断"这是不是一次明确的记忆请求"；返回 0..N 条（通常 0 或 1） */
export function captureExplicit(utterance: string): Explicit[] {
  const raw = String(utterance ?? "").trim();
  if (!raw || raw.length < 3) return [];
  const out: Explicit[] = [];
  const push = (text: string, kind: ExplicitKind, rule: string) => {
    const t = clean(text);
    if (t.length < 3) return;
    if (out.some((x) => x.text === t)) return;
    out.push({ text: t, kind, layer: kind === "episode" ? "narrative" : kind === "preference_hard" ? "narrative" : "contract", rule });
  };

  // ① 「记住：X」——内容决定它是边界、硬事实还是经历
  const ask = ASK.exec(raw);
  if (ask) {
    const body = ask[1]!.trim();
    if (NEVER.test(body)) push(body, "boundary", "ask+never");
    else if (ALLERGY.test(body)) push(body, "fact_hard", "ask+allergy");
    else if (LIKES.test(body)) push(body, "preference_hard", "ask+like");
    else push(body, "episode", "ask");
    return out;   // 说了「记住」就按它说的记，不再叠规则
  }

  // ② 没有「记住」两个字，但这些说法本身就是请求
  const never = NEVER.exec(raw);
  if (never && ABOUT_ME.test(never[1]!)) push(never[1]!, "boundary", "never");
  const allergy = ALLERGY.exec(raw);
  if (allergy) push(allergy[1]!, "fact_hard", "allergy");
  const likes = LIKES.exec(raw);
  if (likes) push(likes[1]!, "preference_hard", "like");
  const date = DATE.exec(raw);
  if (date && !out.some((x) => x.kind === "fact_hard")) push(date[1]!, "fact_hard", "date");

  return out.slice(0, 2);
}

/**
 * 落库。已经完全相同的正文不再写（返回 null）——
 * 「记住我对花生过敏」说三遍，不该变成三条硬事实。
 */
export function writeExplicit(
  db: DatabaseSync,
  e: Explicit,
  utterance: string,
  now = new Date(),
): number | null {
  const dup = db.prepare(
    "SELECT id FROM memories WHERE status='active' AND layer=? AND text=? LIMIT 1",
  ).get(e.layer, e.text) as { id: number } | undefined;
  if (dup) return null;

  return remember(db, {
    layer: e.layer,
    kind: e.kind,
    text: e.text,
    // 聊天里说的：本来就已经作为用户消息出过网（19 §0.1）
    sensitivity: "shareable",
    sourceKind: "user",
    sourceRef: "explicit",
    // 原话照抄：将来"她当时到底怎么说的"要能查（J-2）
    quote: utterance.slice(0, 200),
    importance: e.layer === "contract" ? 4 : 3,
    scoredBy: "rule:explicit",
    now,
  });
}
