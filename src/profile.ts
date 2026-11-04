/**
 * 「关于你」的缺口（2026-11-04）
 *
 * 现状：库里 204 条 active，关于人的只有 11 条，其中还有 3 条是系统动作。
 * 而语料九成是「跑一下测试」「把这个 bug 修了」—— 指望夜间抽取从工作日志里
 * 长出「她几点睡、忌不忌口」是不现实的（实测 129 句 → 4 条）。
 *
 * 所以换个方向：**记忆的缺口由人补**。面板上放一张小卡，问 3 件她不知道的事，
 * 答一句就落一条 contract。不弹窗、不打断、不猜 —— 只在人自己走到记忆屏时出现。
 *
 * 三条边界：
 *  ① 只问**长期有效**的事（称呼/作息/忌口/生日/所在地/工作），不问一时一刻
 *  ② 答什么记什么（原文照抄），不加工、不推断
 *  ③ 答过就不再问（source_ref = profile:<key> 是"这题已经答过"的凭据）
 */
import type { DatabaseSync } from "node:sqlite";
import { remember } from "./store.ts";

export interface Gap {
  /** 同时用作 subject 与 source_ref 的后半段 */
  key: string;
  /** 面板上的一句话问法 */
  question: string;
  kind: string;
  layer: "narrative" | "contract";
  /** 为什么值得占一条契约（写给人看的） */
  why: string;
}

export const GAPS: readonly Gap[] = [
  { key: "称呼", question: "你希望我怎么称呼你？", kind: "boundary", layer: "contract", why: "叫错了每次都在错" },
  { key: "作息", question: "你一般几点之后不想被打扰？", kind: "boundary", layer: "contract", why: "决定她什么时候能主动开口" },
  { key: "忌口", question: "有什么不吃的、或者过敏的？", kind: "fact_hard", layer: "contract", why: "说错了是害人" },
  { key: "生日", question: "你的生日是哪天？（年份可以不说）", kind: "fact_hard", layer: "contract", why: "一年一次，忘了就没有第二次" },
  { key: "所在地", question: "你现在住在哪个城市？", kind: "fact_hard", layer: "contract", why: "天气、时间、寄送都靠它" },
  { key: "工作", question: "你平时做什么工作？", kind: "fact_hard", layer: "contract", why: "决定她怎么理解你的忙与累" },
];

export const gapSourceRef = (key: string): string => "profile:" + key;

/** 这题答过了没有：看 source_ref，也看 subject（夜里抽出来的也算答过） */
export function answered(db: DatabaseSync, key: string): boolean {
  const byRef = db.prepare(
    "SELECT id FROM memories WHERE status='active' AND source_ref=? LIMIT 1",
  ).get(gapSourceRef(key)) as { id: number } | undefined;
  if (byRef) return true;
  const bySubject = db.prepare(
    "SELECT id FROM memories WHERE status='active' AND subject=? LIMIT 1",
  ).get(key) as { id: number } | undefined;
  return Boolean(bySubject);
}

/**
 * 六道题各自的答案（没答过的 key 不出现）。
 * 给 `jingjing profile` 用：让人一眼看见"她到底知道你什么"。
 */
export function answers(db: DatabaseSync): Map<string, { text: string; from: string }> {
  const out = new Map<string, { text: string; from: string }>();
  for (const g of GAPS) {
    const r = db.prepare(
      `SELECT text, source_ref, scored_by FROM memories
        WHERE status='active' AND (source_ref=? OR subject=?)
        ORDER BY CASE WHEN source_ref=? THEN 0 ELSE 1 END, id DESC LIMIT 1`,
    ).get(gapSourceRef(g.key), g.key, gapSourceRef(g.key)) as
      { text: string; source_ref: string | null; scored_by: string } | undefined;
    if (r) out.set(g.key, { text: r.text, from: r.source_ref === gapSourceRef(g.key) ? "你答的" : "她抽出来的" });
  }
  return out;
}

/** 还没答的题（面板只展示前 3 条，问多了像表单） */
export function openGaps(db: DatabaseSync, limit = 3): Gap[] {
  try {
    return GAPS.filter((g) => !answered(db, g.key)).slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

// ── 什么时候**问**（下面那一节是"答了怎么落库"）──────────────

/** 上次问是什么时候（meta 里；进程重启也不会忘） */
const ASK_MARK = "profile_asked_at";

/**
 * 这一轮该不该顺口问一句。
 *
 * 只有两个条件：还有没答的题、距上次问超过 cooldown（默认 24h）。
 * 不做"话题相关才问"的判断 —— 那要模型参与，而她现在连自己在问什么都记不住。
 */
export function nextAsk(db: DatabaseSync, now = new Date(), cooldownMs = 24 * 60 * 60 * 1000): Gap | null {
  const gaps = openGaps(db, 1);
  if (!gaps.length) return null;
  try {
    const r = db.prepare("SELECT value FROM meta WHERE key=?").get(ASK_MARK) as { value?: string } | undefined;
    if (r?.value) {
      const t = Date.parse(r.value);
      if (Number.isFinite(t) && now.getTime() - t < cooldownMs) return null;
    }
  } catch { /* 没有 meta 表 = 从没问过 */ }
  return gaps[0]!;
}

/** 记下"问过了"（在拼简报时调，不管她最后有没有真问 —— 否则一天能问十次） */
export function markAsked(db: DatabaseSync, now = new Date()): void {
  try {
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(ASK_MARK, now.toISOString());
  } catch { /* 记不下就退化成每轮都问 —— 但不该阻断对话 */ }
}

/**
 * 落一条答案。空文本拒绝；已经有答案的题返回 null（不覆盖 —— 改主意要走记忆编辑）。
 */
export function answerGap(
  db: DatabaseSync,
  key: string,
  text: string,
  now = new Date(),
): { ok: true; id: number } | { ok: false; code: string; why: string } {
  const g = GAPS.find((x) => x.key === key);
  if (!g) return { ok: false, code: "E_UNKNOWN_GAP", why: "没有这道题" };
  const body = String(text ?? "").trim().slice(0, 120);
  if (body.length < 2) return { ok: false, code: "E_EMPTY", why: "还没写呢" };
  if (answered(db, key)) return { ok: false, code: "E_ALREADY", why: "这题已经有答案了" };

  const id = remember(db, {
    layer: g.layer,
    kind: g.kind,
    subject: g.key,
    text: body,
    // 用户亲口说的：作为用户消息本来就出过网（19 §0.1）
    sensitivity: "shareable",
    sourceKind: "user",
    sourceRef: gapSourceRef(key),
    quote: body,
    importance: 5,
    scoredBy: "human:profile",
    now,
  });
  return { ok: true, id };
}
