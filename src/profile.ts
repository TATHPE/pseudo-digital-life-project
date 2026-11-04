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

/** 还没答的题（面板只展示前 3 条，问多了像表单） */
export function openGaps(db: DatabaseSync, limit = 3): Gap[] {
  try {
    return GAPS.filter((g) => !answered(db, g.key)).slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
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
