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
import type { DatabaseSync } from "node:sqlite";
import type { Embedder } from "./embed.ts";
import type { MemoryLine } from "./types.ts";
import { search, searchDocs } from "./retrieve.ts";
import { dedupeTitle } from "./chunk.ts";

export interface RecallOpts {
  /** 记忆召回条数 */
  memK?: number;
  /** 文档块召回条数 */
  docK?: number;
  /** 文档块是否参与（有些调用场合不需要） */
  includeDocs?: boolean;
}

export interface RecallResult {
  recalled: MemoryLine[];
  /** 有内容但没发送的条数——简报里要如实说 */
  omittedMem: number;
  omittedDocs: number;
  meta: { memCandidates: number; docCandidates: number; ms: number };
}

export async function recallForBrief(
  db: DatabaseSync, embedder: Embedder | null, query: string, o: RecallOpts = {},
): Promise<RecallResult> {
  const t0 = performance.now();
  const memK = o.memK ?? 6;
  const docK = o.docK ?? 4;
  const recalled: MemoryLine[] = [];

  // ── 记忆 ────────────────────────────────────────────
  const hits = embedder ? (await search(db, embedder, query, { k: memK })).hits : [];
  // 敏感度、层、种类都从库里现取——别猜（契约层在 P10 里也不能被显示成叙事）
  const metaById = new Map<number, { layer: "narrative" | "contract"; kind: string; sensitivity?: string; taint?: string }>();
  if (hits.length) {
    const got = db.prepare(
      `SELECT id, layer, kind, sensitivity, taint FROM memories WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(hits.map((h) => h.id))) as Array<{ id: number; layer: string; kind: string; sensitivity?: string; taint?: string }>;
    for (const g of got) {
      metaById.set(Number(g.id), {
        layer: g.layer === "contract" ? "contract" : "narrative", kind: g.kind,
        ...(g.sensitivity ? { sensitivity: g.sensitivity } : {}),
        ...(g.taint ? { taint: g.taint } : {}),
      });
    }
  }
  // D-1 的注入侧：不可信来源（taint=external）不进简报。
  // 它可以存在、可以被显式搜到，但不能自己跑到模型眼前 —— “quarantine by tier”。
  // 这就是 taint 那个列之前**零处参与逻辑**的那个缺口（docs/22 D-1）。
  const shareable = hits.filter((h) => {
    const m = metaById.get(h.id);
    return m?.sensitivity === "shareable" && (m.taint ?? "trusted") === "trusted";
  });
  for (const h of shareable) {
    const m = metaById.get(h.id)!;
    recalled.push({
      id: `mem:${h.id}`, layer: m.layer, kind: m.kind, stage: h.stage, weight: h.weight, text: h.text,
      sensitivity: "shareable", source: "memory",
    });
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
    omittedMem: hits.length - shareable.length,
    omittedDocs,
    meta: {
      memCandidates: hits.length, docCandidates,
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
