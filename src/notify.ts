/**
 * 回执通道（D-3 的前置，`docs/ops/25 §4`）。
 *
 * 为什么先做它：常驻指令 = 没人看着的时候它自己做事。
 * 那唯一的保险就是「做完必须留一条，并且能判定人看到了」。
 * 没有这条通道，调度器写得多漂亮都是黑箱 —— 所以先做通道，再做调度。
 *
 * 三条语义（都刻意做得简单）：
 *  ① **送达 ≠ 已读**：写进队列算送达，人点了「知道了」才算已读
 *  ② **读不到就停**：一条回执超过 `ESCALATE_MS` 没被读，调用方必须停用它的来源（见 standing.ts）
 *  ③ **不重试、不刷屏**：一条动作一条回执；同一件事不会因为"没读到"再发一遍
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";

export type ReceiptKind = "standing" | "action" | "uncertain";

export interface Receipt {
  id: string;
  at: string;
  kind: ReceiptKind;
  /** 一句话：做了什么 */
  title: string;
  /** 展开：输出摘要 / 为什么 / 需要人怎么处理 */
  body: string;
  /** 哪个来源产的（standing:<id> / 空） */
  source: string;
  seen: boolean;
  seenAt?: string;
  ok: boolean;
}

export const receiptDir = (home: string): string => join(home, "notify");
const ID_RE = /^rcp_[0-9a-z]{6,40}$/;
/** 超过这个时间还没被读 → 上层应当停用它（默认 3 天） */
export const ESCALATE_MS = 3 * 86400_000;

export const newReceiptId = (now = new Date()): string =>
  `rcp_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const pathOf = (home: string, id: string): string => {
  if (!ID_RE.test(id)) throw new Error(`E_RECEIPT_ID: ${id}`);
  return join(receiptDir(home), id + ".json");
};

export function pushReceipt(
  home: string,
  input: { kind: ReceiptKind; title: string; body?: string; source?: string; ok?: boolean },
  now = new Date(),
): Receipt {
  const r: Receipt = {
    id: newReceiptId(now),
    at: now.toISOString(),
    kind: input.kind,
    title: String(input.title ?? "").replace(/[\r\n\t]+/g, " ").slice(0, 120),
    body: String(input.body ?? "").slice(0, 2000),
    source: String(input.source ?? "").slice(0, 80),
    seen: false,
    ok: input.ok !== false,
  };
  const dir = receiptDir(home);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFile(pathOf(home, r.id), JSON.stringify(r, null, 2));
  return r;
}

export function listReceipts(home: string, opts: { unseenOnly?: boolean; limit?: number } = {}): Receipt[] {
  const dir = receiptDir(home);
  if (!existsSync(dir)) return [];
  const out: Receipt[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("rcp_") || !f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Receipt;
      if (opts.unseenOnly && r.seen) continue;
      out.push(r);
    } catch { /* 坏文件跳过，不炸列表 */ }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, opts.limit ?? 20);
}

/** 人点了「知道了」。这是"被看见"的唯一凭据，没有别的路 */
export function markSeen(home: string, id: string, now = new Date()): Receipt | null {
  let r: Receipt;
  try {
    r = JSON.parse(readFileSync(pathOf(home, id), "utf8")) as Receipt;
  } catch { return null; }
  const next: Receipt = { ...r, seen: true, seenAt: now.toISOString() };
  atomicWriteFile(pathOf(home, id), JSON.stringify(next, null, 2));
  return next;
}

export const unseenCount = (home: string): number => listReceipts(home, { unseenOnly: true, limit: 1000 }).length;

/** 有没有「太久没人看」的回执（上层据此停用来源） */
export function staleUnseen(home: string, now = new Date(), ms = ESCALATE_MS): Receipt[] {
  return listReceipts(home, { unseenOnly: true, limit: 1000 })
    .filter((r) => now.getTime() - Date.parse(r.at) > ms);
}
