/**
 * 三段侵蚀（2026-11-03）。学自 whale-card 的 `render_predicate()`：
 *
 *   stage=0 完整      → 「吃过烧烤」
 *   stage=1 擦了动词   → 「烧烤（做什么记不清了）」
 *   stage=2 擦了宾语   → 「（做过点什么记不清了）」
 *   stage=3 全没       → 整条消失（先登记台账，删了就算不出哈希了）
 *
 * 为什么值得学：我们现在的记忆只有「在」和「不在」两种状态 —— 权重掉到底就归档，
 * 干净利落，**但不像人**。人忘事是渐进的：先忘细节，再忘发生了什么，最后只留个影子。
 * 这个中间态还有个实打实的好处：她可以诚实地说「我记不清了」，而不是假装没这回事。
 *
 * 我们没法做「动词/宾语」拆分（中文要分词，而且我们的记忆是自由文本），
 * 所以按**信息量**分三段，精神一致：
 *   stage 1：抹掉可验证的细节（时间、数字、路径、引号里的原话）—— 骨架还在
 *   stage 2：只剩开头一小段 + 明说记不清了 —— 影子
 *   stage 3：归档（不是硬删，还能从归档里翻出来）
 *
 * 铁律：**被侵蚀过的记忆永远知道自己被侵蚀过**（erase_stage > 0 会带标签），
 * 不会假装自己是完整的原话。
 */
import type { DatabaseSync } from "node:sqlite";

/** 权重低到这个值以下，才开始侵蚀（比归档门槛更低：先模糊，再消失） */
export const ERODE_W = 0.03;
/** 一次 tick 里被侵蚀的概率（不是全都同时掉档，像人一样有先后） */
export const ERODE_P = 0.5;
/** 已经被想起过很多次的记忆不侵蚀（"想一次就更牢"） */
export const ERODE_KEEP_RECALL = 3;

const CONTROL = /[\u0000-\u001f]/g;

/** 细节类片段：日期、时间、数字+单位、长路径、括号里的补充说明 */
const DETAIL = [
  /\d{1,4}[-/]\d{1,2}(?:[-/]\d{1,2})?/g,                  // 2026-10-30 / 10-30
  /\d{1,2}:\d{2}(?::\d{2})?/g,                              // 18:43
  /\d+(?:\.\d+)?\s*(?:分钟|小时|秒|天|周|个月|年|ms|s|min|h)/g,
  /[A-Za-z]:[^\s，。；、）)]+/g,                             // D:\LLM\...（盘符后整段）
  /（[^）]{2,20}）/g,                                        // （补充说明）
];

/** 第一段侵蚀：抹掉细节，保留主干 */
export function erodeStage1(text: string): string {
  let s = String(text ?? "").replace(CONTROL, " ").trim();
  for (const re of DETAIL) s = s.replace(re, " ");
  s = s.replace(/\s{2,}/g, " ").replace(/[，、；]\s*(?=[，、；。])/g, "").trim();
  if (!s) return "（做过点什么，但细节全忘了）";
  const cut = [...s];
  if (cut.length > 24) s = cut.slice(0, 24).join("") + "…";
  return s + "（细节记不清了）";
}

/** 第二段侵蚀：只剩开头，明说记不清 */
export function erodeStage2(text: string): string {
  const s = String(text ?? "").replace(CONTROL, " ").replace(/（[^）]*）/g, "").trim();
  const head = [...s].slice(0, 6).join("");
  return head ? head + "…（记不清了）" : "（做过什么，记不清了）";
}

/** 按 stage 推进一格后的正文（stage 已经是 2 就返回 null：该归档了） */
export function nextErosion(text: string, stage: number): { text: string; stage: number } | null {
  if (stage <= 0) return { text: erodeStage1(text), stage: 1 };
  if (stage === 1) return { text: erodeStage2(text), stage: 2 };
  return null;
}

/**
 * 按侵蚀阶段渲染正文（**只用于展示**，库里存的仍是原文）。
 * stage 0 原样；1 抹细节；2 只剩影子。
 */
export function renderEroded(text: string, stage: number | null | undefined): string {
  const st = Number(stage ?? 0);
  if (st <= 0) return String(text ?? "");
  if (st === 1) return erodeStage1(text);
  return erodeStage2(text);
}

export interface ErosionReport {
  /** 这一轮被侵蚀的条数 */
  eroded: number;
  /** 被归档的条数（侵蚀到头） */
  archived: number;
}

/**
 * 跑一轮侵蚀：挑「权重已经很低 + 没被反复想起」的叙事记忆，推进一格。
 *
 * 只动 narrative：契约层是硬事实，不参与侵蚀（它有自己的"了结"机制）。
 */
export function tickErosion(
  db: DatabaseSync,
  now = new Date(),
  opts: { random?: () => number; limit?: number } = {},
): ErosionReport {
  const rnd = opts.random ?? Math.random;
  const limit = Math.max(1, opts.limit ?? 50);
  const rows = db.prepare(
    `SELECT id,text,weight,erase_stage FROM memories
      WHERE status='active' AND layer='narrative' AND weight < ?
        AND recall_count < ?
      ORDER BY weight ASC LIMIT ?`,
  ).all(ERODE_W, ERODE_KEEP_RECALL, limit) as Array<{ id: number; text: string; weight: number; erase_stage: number }>;

  const ts = now.toISOString();
  let eroded = 0, archived = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      if (rnd() >= ERODE_P) continue;
      const next = nextErosion(r.text, Number(r.erase_stage ?? 0));
      if (next) {
        // **不改正文**：正文只有人能改（store.updateMemoryText 的硬门槛，map:check 也盯着）。
        // 这也正是 whale-card 的做法 —— 原文留在库里，按 stage 渲染出模糊版，
        // 于是「她还记得有这么件事，但细节想不起来了」，而原始记录随时可以查。
        db.prepare("UPDATE memories SET erase_stage=?, updated_at=? WHERE id=?")
          .run(next.stage, ts, r.id);
        db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
          .run(ts, "memory_eroded", "system", String(r.id),
            JSON.stringify({ stage: next.stage, before: String(r.text).slice(0, 60), after: next.text.slice(0, 60) }));
        eroded++;
      } else {
        // 侵蚀到头：归档（不是硬删 —— 还能从归档里翻出来，也留了台账）
        db.prepare("UPDATE memories SET status='archived', updated_at=? WHERE id=?").run(ts, r.id);
        db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
          .run(ts, "memory_erased", "system", String(r.id), JSON.stringify({ text: String(r.text).slice(0, 60) }));
        archived++;
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { eroded, archived };
}
