/**
 * 两阶段检索（02 §7.1 实测修订 / 12 §9.1）
 *
 * ① BM25/FTS5(bigram) 出候选（不碰向量）
 * ② 只对候选算 cosine + MMR
 *
 * 为什么：vec0 是暴力扫描，40k×1024 维实测 155–195 ms（超预算），
 * 两阶段把"读 164 MB"降到"读 2000×2 KB ≈ 4 MB"。
 */
import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "./embed.ts";
import { ftsQuery } from "./text.ts";
import { queryVariants, onlyStopwordHits } from "./queryrewrite.ts";
import { at } from "./assert.ts";
import { bigrams } from "./text.ts";
import type { Stage } from "./decay.ts";
import { WHY_BRIEF } from "./links.ts";

export interface Hit {
  id: number; text: string; score: number;
  stage: Stage; weight: number; cite: string;
  relevance: number;          // 0..1，用于 fading 的"话题直接命中"判断
  via: "active" | "fading" | "flashback";
  /** 敏感度：local_only 的原文不许跟着工具结果出网（13 §10） */
  sensitivity?: "local_only" | "shareable";
  /** 原话（J-2）：先给原话，再给内容 */
  quote?: string | null;
  /** 怎么进来的：命中 / 强线索 / **沿一根线过来**（J-1 一跳） */
  viaLink?: { from: number; why: string };
  /** 隐私闸门要用的字段（随行一起取回，避免调用方再查一次 = N+1） */
  layer?: "narrative" | "contract";
  taint?: "trusted" | "external";
  /** 记忆种类（沿边过来时也要带上，否则简报里会全显示成 episode） */
  kind?: string;
  /** 写下时间（P10 要显示「多久以前」，权重不能代替它） */
  createdAt?: string;
  bm25Rank?: number; cosRank?: number; cosine?: number;
}

export interface SearchOpts {
  k?: number;               // 返回条数，默认 8
  candidates?: number;
  /** E-8：有几个候选是从向量召回进来的（FTS 一个都没命中时就是它们的全部） */
  vecHits?: number;      // 第一段候选数，默认 1000
  fadingMin?: number;       // fading 最低权重，默认 0.15
  fadingRelevance?: number; // fading 需"话题直接命中"，默认 0.45
  flashbackCap?: number;    // dormant 强线索唤醒上限，默认 2
  mmrLambda?: number;       // 默认 0.7
  /** RRF 的 K（默认 60）。越小越偏向名次靠前的那一路 */
  rrfK?: number;
  /** 权重在融合里占多少（默认 0.4；其余给名次） */
  weightMix?: number;
}

export interface SearchMeta {
  stage1Ms: number; stage2Ms: number; totalMs: number;
  candidates: number; degraded: string[];
  /** E-8：有几个候选是从向量召回进来的（FTS 一个都没命中时就是它们的全部） */
  vecHits?: number;
}

/** 已过 valid_to 的记忆还在，但不该和现行的事抢位置（0.75 是保守值，先不调） */
const EXPIRED_DAMP = 0.75;

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
};
const toF32 = (blob: Uint8Array) => new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);


/**
 * E-8：**向量召回**。
 *
 * 之前 search() 的候选入口只有 memories_fts MATCH，向量只给已召回的候选重排 ——
 * 词面不重合时（「她不喜欢我怎么称呼」 vs 「不要叫我助手」）向量永远没机会出场。
 * vec_memories 表建了很久、reembed 也一直在写，**却没有任何读路径**。
 *
 * 两条路：
 *  ① vec_memories 可用（sqlite-vec 已加载）→ k-NN。vec0 默认 L2，
 *     单位向量下 cos = 1 - d²/2，这里换算回余弦，和别处口径一致。
 *  ② 不可用 → 有界扫描（默认 2000 行）。慢一点，但不会假装自己没有向量。
 */
function vecRecall(
  db: DatabaseSync, qv: Float32Array, k: number, nowIso: string, scanCap = 2000,
): Array<{ id: number; cos: number }> {
  const out: Array<{ id: number; cos: number }> = [];
  const seen = new Set<number>();
  const bytes = new Uint8Array(qv.buffer, qv.byteOffset, qv.byteLength);

  // ① k-NN
  try {
    const rows = db.prepare(
      "SELECT memory_id AS id, distance FROM vec_memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?",
    ).all(bytes, k) as Array<{ id: number | bigint; distance: number }>;
    for (const r of rows) {
      const id = Number(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, cos: 1 - (Number(r.distance) ** 2) / 2 });
    }
  } catch { /* 扩展没加载 / 表不存在 → 走 ② */ }

  // ② 有界扫描（也补上 vec 表可能漏掉的 id）
  if (out.length < k) {
    try {
      const rows = db.prepare(
        "SELECT id, embedding FROM memories WHERE status='active' AND embedding IS NOT NULL" +
        " ORDER BY id DESC LIMIT ?",
      ).all(scanCap) as Array<{ id: number; embedding: Uint8Array }>;
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({ id: r.id, cos: dot(qv, toF32(r.embedding)) });
      }
    } catch { /* 没有 embedding 列/表 → 算了 */ }
  }
  return out.sort((a, b) => b.cos - a.cos).slice(0, Math.max(k, 8));
}
export async function search(
  db: DatabaseSync, embedder: Embedder | null, query: string, opts: SearchOpts = {},
): Promise<{ hits: Hit[]; meta: SearchMeta }> {
  const k = opts.k ?? 8;
  const lim = opts.candidates ?? 1000;
  const fadingMin = opts.fadingMin ?? 0.15;
  const fadingRel = opts.fadingRelevance ?? 0.45;
  const flashCap = opts.flashbackCap ?? 2;
  const lam = opts.mmrLambda ?? 0.7;
  const degraded: string[] = [];
  const t0 = performance.now();

  // ── ① 关键词候选 + 向量候选（E-8：两路都要）────────────
  // 实测：JOIN memories 会把 text+embedding(2KB/行) 一起拉出来，
  // 4000 候选 = 8MB 读，单这一步就 57 ms。所以拆成「先取 id，再取需要的列」。
  const q = ftsQuery(query);
  let ranked: Array<{ id: number; score: number }> = [];
  const ftsRun = (query2: string): Array<{ id: number; score: number }> => {
    if (!query2) return [];
    return db.prepare(
      "SELECT memory_id AS id, bm25(memories_fts) AS score FROM memories_fts" +
      " WHERE memories_fts MATCH ? ORDER BY score LIMIT ?",
    ).all(query2, lim) as Array<{ id: number; score: number }>;
  };
  ranked = ftsRun(q);

  // 向量召回：词面不重合时的唯一活路。查询向量在这里就要算出来。
  let qv: Float32Array | null = null;
  if (embedder) {
    try { qv = (await embedder.embed([query]))[0] ?? null; } catch { degraded.push("E_EMBED_DOWN"); }
    if (!qv) degraded.push("E_EMBED_EMPTY");
  } else degraded.push("no_embedder");

  const vecIds = new Map<number, number>();
  if (qv) {
    for (const v of vecRecall(db, qv, Math.max(24, k * 4), new Date().toISOString())) {
      // 只收够像的：0.55 以下进了候选也只会在闸门那里被丢掉，白算
      if (v.cos >= 0.55) vecIds.set(v.id, v.cos);
    }
  }
  // 元数据按 id 批量取（不含 embedding）。
  // 用 json_each(?) 而不是 IN (?,?,…)——后者要为每个 chunk 重新 prepare 一个
  // 500 参数的语句，实测占掉 20 ms；json_each 只要一个参数、一条语句。
  // 只留**还活着**的记忆：status=active、且没被 valid_to 截断。
  const metaById = new Map<number, { text: string; stage: Stage; weight: number; sensitivity?: string; textBigram?: string; eraseStage?: number }>();
  const fetchMeta = () => {
    const ids = [...new Set([...ranked.map((r) => r.id), ...vecIds.keys()])];
    metaById.clear();
    if (!ids.length) return;
    // ── valid_to 的语义修正（2026-11-03）──
    //
    // valid_to 的本意是「这条**承诺**什么时候该停止提醒」（openContracts 用它排除已了结的承诺）。
    // 但检索层拿它把**整条记忆**抹掉了 —— 于是「记住下周三为你妈妈买蛋糕」在生日一过，
    // 她就再也想不起这件事（eval 的 h-recall-1 反复红，根因在这里，不是用例腐化）。
    //
    // 现在：到期只是**降权**（0.75），不是消失。她可以记得"我给你妈买过蛋糕，那是 10 月的事"，
    // 只是不再把它当待办反复提（那是 P6/openContracts 的活，那边仍然严格按时间排除）。
    const got = db.prepare(
      `SELECT id,text,stage,weight,sensitivity,text_bigram,
         (valid_to IS NOT NULL AND julianday(valid_to) <= julianday(?)) AS expired
       FROM memories WHERE status='active' AND id IN (SELECT value FROM json_each(?))`,
    ).all(new Date().toISOString(), JSON.stringify(ids)) as Array<{ id: number; text: string; stage: Stage; weight: number; sensitivity?: string; text_bigram?: string; erase_stage?: number; expired: number }>;
    for (const g of got) {
      const w = g.expired ? Number(g.weight) * EXPIRED_DAMP : Number(g.weight);
      metaById.set(g.id, { text: g.text, stage: g.stage, weight: w, ...(g.sensitivity ? { sensitivity: g.sensitivity } : {}), ...(g.text_bigram ? { textBigram: g.text_bigram } : {}), ...(g.erase_stage ? { eraseStage: Number(g.erase_stage) } : {}) });
    }
  };
  fetchMeta();

  // ── E-10 查询改写：**有效**候选不足时，用别名归一后的变体再补一路 ──
  // 触发条件看的是过滤之后还剩几条（教训：一开始看的是过滤前，命中的全是
  // valid_to 已过 / archived 的记录，于是"有候选"→ 不触发 → 用户还是搜不到）。
  // 只在几乎没东西时才做：正常查询不多花时间，生造词（abstain 用例）也碰不到。
  // 合并时取各路最小的 bm25（bm25 是负数，越小越相关），再整体重排一次名次。
  // JJ_QUERY_REWRITE=0 可关掉（只为做 A/B 对照：同一份代码、同一份数据跑两次）。
  const rewriteOn = process.env.JJ_QUERY_REWRITE !== "0";
  // 默认**总是**跑改写（2026-11-03 用难用例量出来的）：
  //   只在「候选 < 2」时触发 → R@1 7/10；总是触发 → 8/10，且三个夹具都没回归。
  //   代价是每个查询多跑 1-2 次 FTS（每次 < 5ms）。JJ_REWRITE_MIN_CANDS 可回调。
  // 注意：默认值 999 是**刻意让条件恒真**（=永远改写），不是忘了启用；
  // A/B 对照时设 JJ_REWRITE_MIN_CANDS=2 就能退回旧的「候选不足才改写」。
  const rewriteMin = Number(process.env.JJ_REWRITE_MIN_CANDS ?? 999);
  if (rewriteOn && metaById.size < rewriteMin) {
    let added = 0;
    const variants = queryVariants(query).slice(1);
    for (const v of variants) {
      const more = ftsRun(ftsQuery(v));
      if (!more.length) continue;
      for (const m of more) {
        const prev = ranked.find((r) => r.id === m.id);
        if (!prev) { ranked.push(m); added++; }
        else if (m.score < prev.score) prev.score = m.score;
      }
    }
    if (added) {
      degraded.push("query_rewritten");
      ranked.sort((a, b) => a.score - b.score);
      fetchMeta();
    }
  }
  // ── E-11：只被虚词命中的候选不算证据（2026-11-02）──
  // FTS 是 OR：任一 bigram 命中就算候选，于是「我**上次**说的那个股票代码」会召回
  // 「**上次**程序挂掉…」。她拿到这条就往「上次你说过」上靠 —— 她自己复盘的第 3 条。
  // 只处理**仅靠 FTS 进来**的行：向量召回的归向量管，别在这里误伤。
  if (ranked.length) {
    const kept: Array<{ id: number; score: number }> = [];
    let dropped = 0;
    // 判定要看**所有变体**：候选可能是「妈妈生日」这条改写变体带进来的，
    // 而原句里只有「我妈」—— 用原句判会把它误杀（测试抓到过）。
    const judge = rewriteOn ? queryVariants(query) : [query];
    for (const r of ranked) {
      if (vecIds.has(r.id)) { kept.push(r); continue; }
      const m = metaById.get(r.id);
      if (!m) { kept.push(r); continue; }
      const docBi = new Set(String(m.textBigram ?? "").split(" ").filter(Boolean));
      if (judge.every((v) => onlyStopwordHits(v, docBi))) { dropped++; metaById.delete(r.id); continue; }
      kept.push(r);
    }
    if (dropped) {
      ranked = kept;
      degraded.push("stopword_filtered");
    }
  }

  // 顺序：先向量分数（越高越前），同分再按 bm25 名次
  const bmScoreById = new Map(ranked.map((r) => [r.id, r.score]));
  const rows = [...metaById.entries()]
    .map(([id, m]) => ({ id, score: bmScoreById.get(id) ?? 0, ...m }))
    .sort((a, b) => (vecIds.get(b.id) ?? -1) - (vecIds.get(a.id) ?? -1) || a.score - b.score);

  const t1 = performance.now();

  // ── ② 候选重排：cosine（向量召回那批已经有分数，不用重算）──
  const cos = new Map<number, number>(vecIds);
  if (qv && rows.length) {
    const got = db.prepare(
      `SELECT id, embedding FROM memories
       WHERE embedding IS NOT NULL AND id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(rows.map((r) => r.id))) as Array<{ id: number; embedding: Uint8Array }>;
    for (const g of got) cos.set(g.id, dot(qv, toF32(g.embedding)));
    // 索引坏了要显式降级，不能假装有向量
    const vecErr = db.prepare("SELECT value FROM meta WHERE key='vec_error'").get() as { value?: string } | undefined;
    if (vecErr?.value) degraded.push("vec_index_broken");
  }
  const t2 = performance.now();

  // ── 融合：RRF(k=60) + 权重 ───────────────────
  // bmRank 只对 FTS 命中有效：向量召回进来的行没有 bm25 名次（融合时按 lim 计）
  const bmRank = new Map(ranked.map((r, i) => [r.id, i + 1]));
  const cosSorted = [...cos.entries()].sort((a, b) => b[1] - a[1]);
  const cosRank = new Map(cosSorted.map(([id], i) => [id, i + 1]));
  // 覆盖率特征（实验开关 JJ_COVER_MIX，默认 0 = 关）：
  // 与查询共享的 bigram 越多，越可能是真在说这件事 —— 对「虚词/偶然重合」有抑制作用。
  // 默认 0.5（2026-11-03 用难用例量出来的）：R@1 8/10 → 9/10，三个旧夹具无回归。
  // 0.3 / 0.5 / 0.8 结果相同 —— 说明 0.3 就够，取 0.5 留余量。
  const COVER = Number(process.env.JJ_COVER_MIX ?? 0.5);
  const qBi = [...new Set(bigrams(query))];
  const coverOf = (text2: string): number => {
    if (!COVER || !qBi.length) return 1;
    const set = new Set(bigrams(text2));
    let hit = 0;
    for (const b2 of qBi) if (set.has(b2)) hit++;
    return hit / qBi.length;
  };
  const K = opts.rrfK ?? 60;
  const MIX = opts.weightMix ?? 0.4;
  const fused: Hit[] = rows.map((r, i) => {
    const rrf = 1 / (K + (bmRank.get(r.id) ?? lim)) + (cosRank.has(r.id) ? 1 / (K + cosRank.get(r.id)!) : 0);
    const c = cos.get(r.id);
    // relevance：有向量就用 cosine 映射到 0..1；降级时用名次近似
    const relevance = c !== undefined ? clamp01((c + 1) / 2) : clamp01(1 - i / Math.max(1, rows.length));
    return {
      id: r.id, text: r.text, stage: r.stage, weight: r.weight, relevance,
      via: "active" as const,
      score: rrf * ((1 - MIX) + MIX * r.weight) * (COVER ? (1 - COVER) + COVER * coverOf(r.text) : 1),
      cite: `mem:${r.id}`, bm25Rank: bmRank.get(r.id), cosRank: cosRank.get(r.id), cosine: c,
      ...((r as { eraseStage?: number }).eraseStage ? { eraseStage: (r as { eraseStage?: number }).eraseStage } : {}),
      ...(r.sensitivity ? { sensitivity: r.sensitivity as "local_only" | "shareable" } : {}),
    };
  });

  // ── 三道闸（01 §6）：不是"一刀切阈值"，而是按 stage 走不同门 ──
  // 硬门槛（实验开关 JJ_COVER_MIN，默认 0 = 关）：
  // 只靠向量进来、且**与查询一个 bigram 都不共享**的候选，不可信 —— 那是看起来像。
  // **默认关**：它能挡住 abstain 的误召回（2/2），但会误杀「纯语义」的真命中
  // （实测：把「我对花生过敏」从命中 2 条杀成 0 条）。这个矛盾留给 reranker。
  // 注意：默认 0（关）是量出来的结论、是有意的实验开关，不是没接线的死参数。
  const COVER_MIN = Number(process.env.JJ_COVER_MIN ?? 0);
  let fused2 = fused;
  if (COVER_MIN > 0) {
    fused2 = fused.filter((h) => {
      if (h.bm25Rank) return true;                 // 词面命中过：不算只靠向量
      return coverOf(h.text) >= COVER_MIN;
    });
    if (fused2.length !== fused.length) degraded.push("cover_gate:" + (fused.length - fused2.length));
  }

  const injectable: Hit[] = [];
  let flashUsed = 0;
  for (const h of fused2) {
    if (h.stage === "active") { injectable.push({ ...h, via: "active" }); continue; }
    if (h.stage === "fading" && h.weight >= fadingMin && h.relevance >= fadingRel) {
      injectable.push({ ...h, via: "fading" }); continue;
    }
    if (h.stage === "dormant" && flashUsed < flashCap && flashbackHit(query, h.text)) {
      flashUsed++;
      // 强线索唤醒：仅本轮有效，权重临时抬到 0.5（01 §6.1），不写库
      injectable.push({ ...h, via: "flashback", weight: Math.max(h.weight, 0.5), score: h.score * 1.2 });
    }
  }
  if (!injectable.length) degraded.push(fused2.length ? "all_below_threshold" : "no_candidates");

  // ── MMR 去冗余 ──────────────────────────────
  const pool = injectable.slice(0, Math.max(k * 3, 30));
  const picked: Hit[] = [];
  while (pool.length && picked.length < k) {
    let best = -Infinity, bi = 0;
    for (let i = 0; i < pool.length; i++) {
      const cand = at(pool, i);
      let maxSim = 0;
      for (const p of picked) maxSim = Math.max(maxSim, jaccard(cand.text, p.text));
      const mmr = lam * cand.score - (1 - lam) * maxSim;
      if (mmr > best) { best = mmr; bi = i; }
    }
    picked.push(at(pool.splice(bi, 1), 0));
  }
  const t3 = performance.now();

  return {
    hits: picked,
    meta: {
      stage1Ms: +(t1 - t0).toFixed(1), stage2Ms: +(t2 - t1).toFixed(1),
      totalMs: +(t3 - t0).toFixed(1), candidates: rows.length, vecHits: vecIds.size, degraded,
    },
  };
}

/** 强线索：查询里的 bigram 出现在记忆原文里（专名/地点/作品名都可命中） */
export function flashbackHit(query: string, text: string): boolean {
  const q = new Set(bigrams(query).filter((t) => t.length >= 2));
  if (!q.size) return false;
  for (const t of bigrams(text)) if (t.length >= 2 && q.has(t)) return true;
  return false;
}

/**
 * 沿一根线取邻居（J-1，对应那篇样本的“一跳”）。
 *
 * 为什么要它：想起来常常是因为“刚才那句说到了别的，顺着一根线走过去”。
 * 之前 `memory_links` 只在夜间写得进，**零处读取** —— 关系层等于不存在。
 *
 * 三条约束：
 *   · 只走**有效边**（`valid_to` 为空或未过期），作废的边不能把人带偏；
 *   · 只扩 active/fading 的邻居（dormant 不靠线强拉，走 flashback 那条路）；
 *   · 每一步都要能说出“为什么连”（`why`），没有 why 的边不扩。
 */
export function expandByLinks(
  db: DatabaseSync, hits: readonly Hit[], opts: { k?: number; now?: Date } = {},
): Hit[] {
  if (!hits.length) return [];
  const now = opts.now ?? new Date();
  const cap = opts.k ?? 2;
  const ids = hits.map((h) => h.id);
  const rows = db.prepare(`
    SELECT l.src_id, l.dst_id, l.why, m.id, m.text, m.kind, m.stage, m.weight, m.sensitivity, m.quote, m.layer, m.taint, m.created_at
    FROM memory_links l
    JOIN memories m ON m.id = CASE WHEN l.src_id IN (SELECT value FROM json_each(?)) THEN l.dst_id ELSE l.src_id END
    WHERE (l.src_id IN (SELECT value FROM json_each(?)) OR l.dst_id IN (SELECT value FROM json_each(?)))
      AND (l.valid_to IS NULL OR julianday(l.valid_to) > julianday(?))
      AND l.why IS NOT NULL AND l.why <> ''
      AND m.status = 'active' AND m.stage IN ('active','fading')
    ORDER BY l.weight DESC, l.created_at DESC
    LIMIT ?`).all(
    JSON.stringify(ids), JSON.stringify(ids), JSON.stringify(ids), now.toISOString(), cap * 4,
  ) as Array<{
    src_id: number; dst_id: number; why: string; id: number;
    text: string; kind: string; stage: Stage; weight: number; sensitivity?: string; quote?: string | null;
    layer: string; taint: string; created_at?: string;
  }>;

  const seen = new Set(ids);
  const out: Hit[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const from = ids.includes(r.src_id) ? r.src_id : r.dst_id;
    out.push({
      id: r.id, text: r.text, score: 0, stage: r.stage, weight: r.weight,
      cite: `mem:${r.id}`, relevance: 0, via: r.stage === "fading" ? "fading" : "active",
      ...(r.sensitivity ? { sensitivity: r.sensitivity as "local_only" | "shareable" } : {}),
      ...(r.quote ? { quote: r.quote } : {}),
      ...(r.created_at ? { createdAt: r.created_at } : {}),
      kind: r.kind,
      layer: r.layer === "contract" ? "contract" : "narrative",
      taint: (r.taint === "external" ? "external" : "trusted") as "trusted" | "external",
      // P10 有 token 预算，只留开头；关系判据（J-3b）刻意以 cos/字面 数字起头，截完仍成立
      viaLink: { from, why: String(r.why).slice(0, WHY_BRIEF) },
    });
    if (out.length >= cap) break;
  }
  return out;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** MMR 用的便宜相似度：字面 bigram 重叠（不额外算 embedding） */
export function jaccard(a: string, b: string): number {
  const A = new Set(a.match(/[\u4e00-\u9fff]{2}|[a-z]{2,}/gi) ?? []);
  const B = new Set(b.match(/[\u4e00-\u9fff]{2}|[a-z]{2,}/gi) ?? []);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// ── 文档块检索（02 §7.1 的同一套两阶段，作用在 chunks 上）────────────

export interface DocHit {
  chunkId: number;
  docId: string;
  ord: number;
  title: string;
  headingPath: string;
  text: string;
  /** 文档敏感度：local_only 的块绝不进云端简报（02 §10.1） */
  sensitivity: "local_only" | "shareable";
  score: number;
  cosine?: number;
  /** 引用格式：doc:<doc_id>#<ord>（与 mem:<id> 对称） */
  cite: string;
}

/**
 * 先 FTS(bigram) 出候选，再只对候选算 cosine。
 * 不用 vec0：40k 块时暴力扫描要 150 ms+（README 实测），两阶段把读放大降下来。
 */
export async function searchDocs(
  db: DatabaseSync, embedder: Embedder | null, query: string, opts: { k?: number; candidates?: number } = {},
): Promise<{ hits: DocHit[]; meta: SearchMeta }> {
  const k = opts.k ?? 6;
  const lim = opts.candidates ?? 800;
  const degraded: string[] = [];
  const t0 = performance.now();
  const q = ftsQuery(query);

  let ranked: Array<{ id: number; score: number }> = [];
  if (q) {
    ranked = db.prepare(
      `SELECT rowid AS id, bm25(chunks_fts) AS score FROM chunks_fts
        WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`,
    ).all(q, lim) as typeof ranked;
  }

  const meta = new Map<number, { docId: string; ord: number; title: string; headingPath: string; text: string; sensitivity: "local_only" | "shareable" }>();
  if (ranked.length) {
    const got = db.prepare(
      `SELECT c.id, c.doc_id, c.ord, c.heading_path, c.text, d.title,
              COALESCE(d.sensitivity, 'local_only') AS sensitivity
         FROM chunks c JOIN documents d ON d.id = c.doc_id
        WHERE c.deleted_at IS NULL AND d.deleted_at IS NULL
          AND c.id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(ranked.map((r) => r.id))) as Array<{
      id: number; doc_id: string; ord: number; heading_path: string; text: string;
      title: string | null; sensitivity: string;
    }>;
    for (const g of got) {
      meta.set(g.id, {
        docId: g.doc_id, ord: g.ord, title: g.title ?? "", headingPath: g.heading_path, text: g.text,
        sensitivity: g.sensitivity === "shareable" ? "shareable" : "local_only",
      });
    }
  }
  const rows = ranked.filter((r) => meta.has(r.id));
  const t1 = performance.now();

  // 候选重排（只读候选行的 embedding）
  const cos = new Map<number, number>();
  if (embedder && rows.length) {
    let qv: Float32Array | null = null;
    try { qv = (await embedder.embed([query]))[0] ?? null; } catch { degraded.push("E_EMBED_DOWN"); }
    if (qv) {
      const got = db.prepare(
        `SELECT id, embedding FROM chunks
          WHERE embedding IS NOT NULL AND id IN (SELECT value FROM json_each(?))`,
      ).all(JSON.stringify(rows.map((r) => r.id))) as Array<{ id: number; embedding: Uint8Array }>;
      for (const g of got) cos.set(g.id, dot(qv, toF32(g.embedding)));
    } else degraded.push("E_EMBED_EMPTY");
  } else if (!embedder) degraded.push("no_embedder");
  const t2 = performance.now();

  const bmRank = new Map(rows.map((r, i) => [r.id, i + 1]));
  const cosRank = new Map([...cos.entries()].sort((a, b) => b[1] - a[1]).map(([id], i) => [id, i + 1]));
  const K = 60;
  const fused: DocHit[] = rows.map((r) => {
    const m = meta.get(r.id)!;
    const rrf = 1 / (K + (bmRank.get(r.id) ?? lim)) + (cosRank.has(r.id) ? 1 / (K + cosRank.get(r.id)!) : 0);
    return {
      chunkId: r.id, docId: m.docId, ord: m.ord, title: m.title, headingPath: m.headingPath,
      text: m.text, sensitivity: m.sensitivity, score: rrf, ...(cos.has(r.id) ? { cosine: cos.get(r.id) } : {}),
      cite: `doc:${m.docId}#${m.ord}`,
    };
  });

  // MMR：同一篇文档里相邻两块内容高度重叠，不去冗余就会"返回三条其实是一条"
  const pool = fused.slice();
  const picked: DocHit[] = [];
  while (pool.length && picked.length < k) {
    let best = -Infinity, bi = 0;
    for (let i = 0; i < pool.length; i++) {
      const cand = at(pool, i);
      let maxSim = 0;
      for (const p of picked) maxSim = Math.max(maxSim, jaccard(cand.text, p.text));
      const mmr = 0.7 * cand.score - 0.3 * maxSim;
      if (mmr > best) { best = mmr; bi = i; }
    }
    picked.push(at(pool.splice(bi, 1), 0));
  }
  const t3 = performance.now();

  return {
    hits: picked,
    meta: {
      stage1Ms: +(t1 - t0).toFixed(1), stage2Ms: +(t2 - t1).toFixed(1),
      totalMs: +(t3 - t0).toFixed(1), candidates: rows.length, degraded,
    },
  };
}
