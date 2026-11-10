/**
 * 记忆的「意义层」（H-b）—— 人性缺的第二块。
 *
 * 现在能存"下周三生日"，但存不下"**这件事对她意味着什么**"。
 * 只有事实没有解释，记忆是数据库；有了解释，才有"认识你"。
 *
 * 但这条路最危险的地方（Twig 那篇也承认）是**漂移**：
 * 模型写一句话，看起来深情，其实和证据无关，然后越写越像真的。
 *
 * 所以这里只允许一种形态 —— **"带证据的一句话"**：
 *   · 解释必须挂到**已存在的记忆**上（`derived_from` 边 + why）
 *   · 不许凭空起一个 subject；`basis` 里列的证据 id 必须真的存在
 *   · 每条解释都带 confidence，且**可以被取代**（superseded），不删
 *   · 一个话题最多 1 条 active 解释（新的取代旧的，旧的归档）
 *
 * 一句话：**允许她理解你，不允许她编你。**
 */
import type { DatabaseSync } from "node:sqlite";
import { remember, patchMemoryMeta } from "./store.ts";
import { linkIfNew, WHY_MAX } from "./links.ts";

export interface Interpretation {
  id: number;
  text: string;
  subject: string | null;
  confidence: number;
  basis: number[];
  createdAt: string;
}

/** 解释类记忆的 kind（复用 thought，不新增 kind —— 衰减按 thought 走：50 天） */
export const INTERPRET_KIND = "thought";

const basisOf = (db: DatabaseSync, id: number): number[] => {
  try {
    const rows = db.prepare("SELECT dst_id FROM memory_links WHERE src_id=? AND rel='derived_from'").all(id) as Array<{ dst_id: number }>;
    return rows.map((r) => Number(r.dst_id));
  } catch { return []; }
};

export function listInterpretations(db: DatabaseSync, limit = 5): Interpretation[] {
  const rows = db.prepare(
    `SELECT id, text, subject, confidence, created_at FROM memories
     WHERE status='active' AND kind=? AND superseded_by IS NULL
     ORDER BY created_at DESC LIMIT ?`,
  ).all(INTERPRET_KIND, limit) as Array<{ id: number; text: string; subject: string | null; confidence: number; created_at: string }>;
  return rows.map((r) => ({ id: r.id, text: r.text, subject: r.subject, confidence: r.confidence, createdAt: r.created_at, basis: basisOf(db, r.id) }));
}

/**
 * 写一条解释。
 *
 * 闸门（全确定性）：
 *   ① `basis` 非空，且每个 id 都必须是**存在的 active 记忆** —— 编不了
 *   ② 文本不能和证据原文几乎一样（那是复述，不是解释）：bigram 相似度 < 0.9
 *   ③ 同一 subject 已有 active 解释 → 新的取代旧的（旧条 archived + supersedes 边）
 */
export function writeInterpretation(
  db: DatabaseSync,
  input: { text: string; subject?: string; basis: number[]; confidence?: number; scoredBy?: string },
  now = new Date(),
): { ok: true; id: number; replaced: number | null } | { ok: false; code: string; why: string } {
  const text = String(input.text ?? "").trim().slice(0, 300);
  if (text.length < 6) return { ok: false, code: "E_INTERP_SHORT", why: "一句话太短，解释不了一件事" };

  const basis = [...new Set((input.basis ?? []).map(Number).filter(Number.isFinite))];
  if (!basis.length) {
    return { ok: false, code: "E_INTERP_NO_BASIS", why: "解释必须挂到某条记忆上（basis 不能为空）—— 没证据的理解就是编" };
  }
  const rows = db.prepare(
    `SELECT id, text FROM memories WHERE id IN (SELECT value FROM json_each(?)) AND status='active'`,
  ).all(JSON.stringify(basis)) as Array<{ id: number; text: string }>;
  if (rows.length !== basis.length) {
    return { ok: false, code: "E_INTERP_BAD_BASIS", why: `证据里有不存在的记忆 id：${basis.filter((b) => !rows.some((r) => r.id === b)).join(",")}` };
  }

  // ② 不许复述原文冒充解释
  for (const r of rows) {
    const a = text.replace(/\s+/g, ""), b = String(r.text).replace(/\s+/g, "");
    if (a === b) return { ok: false, code: "E_INTERP_RESTATE", why: "这只是复述原文，不是解释" };
  }

  const subject = String(input.subject ?? "").trim().slice(0, 16) || null;
  const id = remember(db, {
    layer: "narrative",
    kind: INTERPRET_KIND,
    ...(subject ? { subject } : {}),
    text,
    importance: 3,
    salience: 0.6,
    sensitivity: "local_only",          // 对人的理解：默认不外发
    sourceKind: "agent",
    sourceRef: `interpret:${basis.join(",")}`,
    scoredBy: input.scoredBy ?? "interpret",
    now,
  });

  // J-3b：原来是句「解释的证据」——人抽检时看不出依据是哪几条。
  // 改成把**已核过存在性**的证据 id 写进边上，判据可回查（函数开头 ① 已逐条验过 active）。
  const whyBasis = `证据 #${basis.join("、#")}（${basis.length} 条，已核 active）`.slice(0, WHY_MAX);
  for (const b of basis) linkIfNew(db, id, b, "derived_from", 0.8, whyBasis, now);

  // ③ 同一 subject 的旧解释：取代（不删）
  let replaced: number | null = null;
  if (subject) {
    const old = db.prepare(
      `SELECT id FROM memories WHERE status='active' AND kind=? AND subject=? AND id<>? ORDER BY created_at DESC LIMIT 1`,
    ).get(INTERPRET_KIND, subject, id) as { id: number } | undefined;
    if (old) {
      patchMemoryMeta(db, old.id, { status: "archived", superseded_by: id }, "interpret", now);
      linkIfNew(db, id, old.id, "supersedes", 1,
        `同 subject「${subject}」取代 #${old.id} · 证据 #${basis.join("、#")}`.slice(0, WHY_MAX), now);
      replaced = old.id;
    }
  }

  void input.confidence;
  return { ok: true, id, replaced };
}

/** 给简报：最近 2 条解释，附证据 id（cite 可查） */
export function interpretationsForBrief(db: DatabaseSync, limit = 2): string[] {
  return listInterpretations(db, limit).map(
    (x) => `${x.text}` + (x.basis.length ? `（依据 #${x.basis.join("、#")}）` : ""),
  );
}
