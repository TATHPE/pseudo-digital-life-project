/**
 * 召回装配（17 §2 的 P10 槽位该放什么）
 *
 * 这一层单独拎出来，是因为它是**隐私闸门的第二道**（第一道在 transport.ts）：
 * 进 P10 的东西会跟着简报一起发给 express 角色，而 express 常常是云端的。
 * 所以在装配的时候就按敏感度过滤，而不是等 transport 抛错——
 * 等它抛错意味着已经晚了：要么整轮失败，要么有人把闸门参数改成 false。
 *
 * 规则（02 §10.1 / 13 §10）：
 *   · 记忆：只放 `shareable`（聊天里说过的）；`local_only`（磁盘/文档摄入）只报个数
 *   · 文档块：同样只放 `shareable`；默认 `local_only`，要显式标注才会出网
 *
 * "只报个数"这件事本身是设计的一部分：它知道"我还记得别的，但这里不能说"，
 * 而不是假装那些东西不存在（07 §3 的诚实条款）。
 */
import { rerank as rerankHits, rerankModeFromConfig, type RerankHit, type RerankResult, type RerankMode } from "./rerank.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "./embed.ts";
import type { MemoryLine } from "./types.ts";
import { search, searchDocs, expandByLinks } from "./retrieve.ts";
import { dedupeTitle } from "./chunk.ts";

export interface RecallOpts {
  /** 记忆召回条数 */
  memK?: number;
  /** 文档块召回条数 */
  docK?: number;
  /** 文档块是否参与（有些调用场合不需要） */
  includeDocs?: boolean;
  /** 数据目录（重排要读 config 里的 ollama 端点） */
  home?: string;
  /** 重排模式：默认按配置（ui.rerank，auto） */
  rerankMode?: RerankMode;
  /** 测试可注入：替换重排器（生产不传，走 rerank.ts 的本地 7B） */
  rerankFn?: (
    home: string, query: string, hits: RerankHit[],
    o: { mode?: RerankMode; timeoutMs?: number; model?: string },
  ) => Promise<RerankResult>;
}

export interface RecallResult {
  recalled: MemoryLine[];
  /** 有内容但没发送的条数——简报里要如实说 */
  omittedMem: number;
  omittedDocs: number;
  /** 重排器说「都没有」但按保守回退保留了候选：简报据此把 confidence 降到 need_evidence */
  rerankNone: boolean;
  meta: { memCandidates: number; docCandidates: number; ms: number; memPool?: number };
}

/**
 * 层配额：契约层权重恒为 1、永不衰减（store.ts:60），夜间抽取会大量产出它们，
 * 固定 k 窗口会被契约独占，叙事证据被系统性挤出。
 * P1 实测（24 题分层抽样）：pool 15/24 → quota 17/24，净 +2 且零退化，证据命中 51%→55%。
 *
 * 做法照 P1：按原排名遍历，contract 最多 cap 条，其余名额留给 narrative；
 * 叙事不足时用被跳过的契约补位，最后仍按原排名排序（不改相关度顺序）。
 * cap < 0 = 关闭配额（退回「直接取前 k 条」）。
 */
export function applyLayerQuota<T extends { id: number }>(
  ordered: T[], layerOf: (id: number) => "narrative" | "contract", k: number, cap: number,
): { chosen: T[]; skipped: T[] } {
  if (cap < 0 || k <= 0) return { chosen: ordered.slice(0, k), skipped: [] };
  const chosen: T[] = [], skipped: T[] = [];
  let nContract = 0;
  for (const h of ordered) {
    if (chosen.length >= k) break;
    if (layerOf(h.id) === "contract") {
      if (nContract < cap) { chosen.push(h); nContract++; }
      else skipped.push(h);
    } else chosen.push(h);
  }
  while (chosen.length < k && skipped.length) chosen.push(skipped.shift()!);
  const rank = new Map(ordered.map((h, i) => [h.id, i]));
  chosen.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  return { chosen, skipped };
}

export async function recallForBrief(
  db: DatabaseSync, embedder: Embedder | null, query: string, o: RecallOpts = {},
): Promise<RecallResult> {
  const t0 = performance.now();
  const memK = o.memK ?? 6;
  const docK = o.docK ?? 4;
  const recalled: MemoryLine[] = [];

  // ── 层配额开关（P1 实测 +2、零退化）────────────────────
  // JJ_CONTRACT_CAP < 0 = 关闭（回到原来的 search(k=memK)）；默认 2。
  // 只在配额开启时放大候选池：否则「限额」只是把契约丢掉，叙事证据根本没机会补进来。
  const cap = Number(process.env.JJ_CONTRACT_CAP ?? 2);
  const quotaOn = Number.isFinite(cap) && cap >= 0;
  // 池大小与配额是**两个独立开关**：关掉配额默认回到旧的 search(k=memK)；
  // 但做 A/B 时要能保持同一个大池、只切配额，故 JJ_RECALL_POOL_K 可单独覆盖。
  const poolK = Math.max(memK, Number(process.env.JJ_RECALL_POOL_K ?? (quotaOn ? Math.max(memK * 4, 24) : memK)));
  // JJ_RERANK_NONE_FALLBACK=0 = 回到旧行为（NONE 时清空候选），供 A/B 与回滚。
  const noneFallback = process.env.JJ_RERANK_NONE_FALLBACK !== "0";
  const home = o.home ?? process.cwd();

  // ── 记忆 ────────────────────────────────────────────
  // 先拿候选池，再决定要不要让本地模型重排（只在模糊/全空时跑，见 src/rerank.ts）
  const poolHits = embedder ? (await search(db, embedder, query, { k: poolK })).hits : [];

  // 敏感度、层、种类都从库里现取——别猜（契约层在 P10 里也不能被显示成叙事）
  const metaById = new Map<number, { layer: "narrative" | "contract"; kind: string; sensitivity?: string; taint?: string; quote?: string | null; createdAt?: string }>();
  if (poolHits.length) {
    const got = db.prepare(
      `SELECT id, layer, kind, sensitivity, taint, quote, created_at FROM memories WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(poolHits.map((h) => h.id))) as Array<{ id: number; layer: string; kind: string; sensitivity?: string; taint?: string; quote?: string | null; created_at?: string }>;
    for (const g of got) {
      metaById.set(Number(g.id), {
        layer: g.layer === "contract" ? "contract" : "narrative", kind: g.kind,
        ...(g.sensitivity ? { sensitivity: g.sensitivity } : {}),
        ...(g.taint ? { taint: g.taint } : {}),
        ...(g.quote ? { quote: g.quote } : {}),
        ...(g.created_at ? { createdAt: g.created_at } : {}),
      });
    }
  }
  // D-1 的注入侧：不可信来源（taint=external）不进简报。
  // 它可以存在、可以被显式搜到，但不能自己跑到模型眼前 —— “quarantine by tier”。
  // 这就是 taint 那个列之前**零处参与逻辑**的那个缺口（docs/ops/22 D-1）。
  const shareablePool = poolHits.filter((h) => {
    const m = metaById.get(h.id);
    return m?.sensitivity === "shareable" && (m.taint ?? "trusted") === "trusted";
  });
  const { chosen } = applyLayerQuota(
    shareablePool, (id) => metaById.get(id)?.layer ?? "narrative", memK, quotaOn ? cap : -1,
  );
  let hits = chosen;

  // 重排：本地 7B 在候选里挑一条（或说 NONE）。失败/超时一律退回基线，绝不让回答卡住。
  let rerankedNone = false;
  if (hits.length >= 1) {
    const cand = hits.map((h) => ({ id: h.id, text: h.text, score: h.score }));
    const mode = o.rerankMode ?? rerankModeFromConfig(home);
    const rr = o.rerankFn
      ? await o.rerankFn(home, query, cand, { mode })
      : await rerankHits(home, query, cand, { mode });
    if (rr.none) {
      rerankedNone = true;
      // 保守回退（P1）：模型说「都没有」时**不清空**候选。
      // 实测 nightly 有 3 题整轮召回被 NONE 清空，答案变成「我没有相关记录」的错误否认。
      // 保留基线顺序，只是把 confidence 降到 need_evidence，不假装证据充足。
      if (!noneFallback) hits = [];
    } else if (rr.ran) {
      const byId = new Map(hits.map((h) => [h.id, h]));
      hits = rr.order.map((x) => byId.get(x.id)!).filter(Boolean);
    }
  }
  for (const h of hits) {
    const m = metaById.get(h.id)!;
    recalled.push({
      id: `mem:${h.id}`, layer: m.layer, kind: m.kind, stage: h.stage, weight: h.weight, text: h.text,
      sensitivity: "shareable", source: "memory",
      ...(m.quote ? { quote: m.quote } : {}),
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    });
  }

  // ── 沿关系一跳（J-1）────────────────────────────────
  // 之前 memory_links 零处读取，关系层等于不存在。这里只在"已经命中东西"时才扩，
  // 且邻居同样要过 taint/sensitivity 闸门 —— 不能因为它是"朋友的邻居"就绕过隐私。
  let omittedLink = 0;
  if (hits.length) {
    // 邻居的 sensitivity/taint/layer 由 expandByLinks 一起带回来（不再逐条查 = 不再 N+1）
    for (const h of expandByLinks(db, hits, { k: 2 })) {
      if (h.sensitivity !== "shareable" || (h.taint ?? "trusted") !== "trusted") { omittedLink++; continue; }
      if (recalled.some((r) => r.id === `mem:${h.id}`)) continue;
      recalled.push({
        id: `mem:${h.id}`, layer: h.layer ?? "narrative", kind: h.kind ?? "episode",
        stage: h.stage, weight: h.weight, text: h.text,
        sensitivity: "shareable", source: "memory",
        ...(h.quote ? { quote: h.quote } : {}),
        ...(h.createdAt ? { createdAt: h.createdAt } : {}),
        ...(h.viaLink ? { viaLink: h.viaLink } : {}),
      });
    }
  }

  // ── 文档块 ──────────────────────────────────────────
  let docCandidates = 0;
  let omittedDocs = 0;
  if (o.includeDocs !== false && embedder) {
    const docs = await searchDocs(db, embedder, query, { k: docK * 2 });
    docCandidates = docs.hits.length;
    const sendable = docs.hits.filter((h) => h.sensitivity === "shareable").slice(0, docK);
    omittedDocs = docCandidates - sendable.length;
    for (const h of sendable) {
      recalled.push({
        id: h.cite, layer: "narrative", kind: "doc", stage: "active", weight: 1,
        text: h.text, sensitivity: "shareable", source: "doc",
        headingPath: dedupeTitle(h.headingPath, h.title),
      });
    }
  }

  return {
    recalled,
    // 只报「被隐私闸门挡下的」+ 关系邻居挡下的。被层配额跳过的契约不是隐私遗漏
    // （P6 每轮另有契约层），不计入这句提示，免得把 shareable 的内容说成「本地记忆」。
    omittedMem: (poolHits.length - shareablePool.length) + omittedLink,
    omittedDocs,
    rerankNone: rerankedNone,
    meta: {
      memCandidates: hits.length, docCandidates, memPool: poolHits.length,
      ms: +(performance.now() - t0).toFixed(1),
    },
  };
}

/** 简报里那句"有些东西我没法在这里说"——措辞要能对上 P10 的实际内容（17 §2） */
export function omissionNote(omittedMem: number, omittedDocs: number): string {
  const parts: string[] = [];
  if (omittedMem > 0) parts.push(`${omittedMem} 条本地记忆`);
  if (omittedDocs > 0) parts.push(`${omittedDocs} 段本地文档`);
  if (!parts.length) return "";
  return `（另有 ${parts.join("、")}未发送，如需可说明"这部分我只能在本地记得"）`;
}
