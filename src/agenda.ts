/**
 * 她自己的惦记（H-a）—— 人性缺的第一块。
 *
 * 之前她只有**状态**（energy/closeness/mood）和**线头**（别人提过的事），
 * 但没有"**她自己在想的**"。主动开口就只能是保温，不是动机。
 *
 * 三条设计约束：
 *  ① **每条都必须有出处**（`from`：记忆 id / 线索 id / 链接）。没有出处的"惦记"就是编。
 *  ② **不许无限长**：最多 5 条待办式惦记，超了就别加（否则她整天惦记十件事，比不惦记更烦人）。
 *  ③ **可以被了结**：人一句话、或她自己判断兑现了，就移出（写 `closedAt`，不删 —— 历史要留）。
 *
 * 来源是**确定性的**（不看模型）：未闭合的承诺、拖太久的线索、待人判的矛盾。
 * 模型只能在夜里最多加 2 条「想知道的事」，而且必须挂到既有记忆上。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import type { DatabaseSync } from "node:sqlite";

export interface AgendaItem {
  id: string;
  /** 一句话：她惦记的是什么 */
  text: string;
  /** 为什么惦记（人话） */
  why: string;
  /** 出处：`mem:12` / `link:3:5:contradicts` / `thread:12` —— 不许为空 */
  from: string;
  at: string;
  /** 来源类型：确定性的 / 模型提的 */
  via: "rule" | "model" | "human";
  closedAt?: string;
}

export const AGENDA_CAP = 5;
export const agendaPath = (home: string): string => join(home, "agenda.json");

export function readAgenda(home: string): AgendaItem[] {
  try {
    if (!existsSync(agendaPath(home))) return [];
    const j = JSON.parse(readFileSync(agendaPath(home), "utf8")) as AgendaItem[];
    return Array.isArray(j) ? j.filter((x) => x && typeof x.text === "string") : [];
  } catch { return []; }
}

const write = (home: string, items: AgendaItem[]): void =>
  atomicWriteFile(agendaPath(home), JSON.stringify(items, null, 2));

export const openItems = (home: string): AgendaItem[] => readAgenda(home).filter((x) => !x.closedAt);

/** 加一条：必须带出处；同一出处不重复；超过上限就不加（并如实返回原因） */
export function addItem(
  home: string,
  input: { text: string; why: string; from: string; via?: AgendaItem["via"] },
  now = new Date(),
): { ok: true; item: AgendaItem } | { ok: false; code: string; why: string } {
  const text = String(input.text ?? "").trim().slice(0, 80);
  const from = String(input.from ?? "").trim();
  if (!text) return { ok: false, code: "E_AGENDA_EMPTY", why: "惦记的内容是空的" };
  // ① 出处是硬要求
  if (!from) return { ok: false, code: "E_AGENDA_NO_SOURCE", why: "没有出处的惦记就是编的（必须写 from: mem:12 之类）" };

  const items = readAgenda(home);
  if (items.some((x) => !x.closedAt && x.from === from)) {
    return { ok: false, code: "E_AGENDA_DUP", why: "这件事已经在惦记里了（同一出处）" };
  }
  const open = items.filter((x) => !x.closedAt);
  // ② 上限
  if (open.length >= AGENDA_CAP) {
    return { ok: false, code: "E_AGENDA_FULL", why: `已经惦记着 ${open.length} 件事了，先了结一件` };
  }
  const item: AgendaItem = {
    id: `agn_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    text, why: String(input.why ?? "").trim().slice(0, 160), from,
    at: now.toISOString(), via: input.via ?? "rule",
  };
  write(home, [...items, item]);
  return { ok: true, item };
}

export function closeItem(home: string, id: string, note: string, now = new Date()): AgendaItem | null {
  const items = readAgenda(home);
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return null;
  if (items[i]!.closedAt) return items[i]!;      // 已经了结过
  const next: AgendaItem = { ...items[i]!, closedAt: now.toISOString(), why: (items[i]!.why || "") + (note ? `（了结：${note.slice(0, 60)}）` : "") };
  items[i] = next;
  write(home, items);
  return next;
}

/**
 * 从**确定性来源**刷新惦记（不看模型）：
 *  · 未闭合的承诺（contract/promise，active，没止期）
 *  · 拖了 ≥7 天还没了结的线索
 *  · 待人判的矛盾（contradicts 边还没被抽检判过）
 * 只增不减；了结由人或 `closeItem` 做。
 */
export function refreshFromFacts(db: DatabaseSync, home: string, now = new Date()): { added: number; skipped: string[] } {
  const skipped: string[] = [];
  let added = 0;
  const tryAdd = (input: { text: string; why: string; from: string }) => {
    const r = addItem(home, { ...input, via: "rule" }, now);
    if (r.ok) added++;
    else skipped.push(r.code);
  };

  // ① 未闭合的承诺
  const promises = db.prepare(
    `SELECT id, text, created_at FROM memories
     WHERE status='active' AND layer='contract' AND kind='promise'
       AND valid_to IS NULL AND superseded_by IS NULL
     ORDER BY created_at ASC LIMIT 3`,
  ).all() as Array<{ id: number; text: string; created_at: string }>;
  for (const p of promises) {
    tryAdd({ text: p.text.slice(0, 60), why: "答应过的事还没了结", from: `mem:${p.id}` });
  }

  // ② 拖太久的线索（≥7 天）
  const old = db.prepare(
    `SELECT id, text, created_at FROM memories
     WHERE status='active' AND kind='promise' AND valid_to IS NULL
       AND julianday(?) - julianday(created_at) >= 7
     ORDER BY created_at ASC LIMIT 2`,
  ).all(now.toISOString()) as Array<{ id: number; text: string; created_at: string }>;
  for (const o of old) {
    tryAdd({ text: o.text.slice(0, 60), why: "立了七天了，还没动静", from: `mem:${o.id}` });
  }

  // ③ 待人判的矛盾
  try {
    const conflicts = db.prepare(
      `SELECT src_id, dst_id FROM memory_links WHERE rel='contradicts' AND valid_to IS NULL LIMIT 2`,
    ).all() as Array<{ src_id: number; dst_id: number }>;
    for (const c of conflicts) {
      tryAdd({ text: `有两句话对不上（#${c.src_id} 与 #${c.dst_id}）`, why: "该由人来判，我判不了", from: `link:${c.src_id}:${c.dst_id}:contradicts` });
    }
  } catch { /* 老库没有这张表也正常 */ }

  return { added, skipped };
}

/** 给简报用：最多 2 条，且每条带出处（她可以主动提，也可以等被问） */
export function agendaForBrief(home: string, limit = 2): string[] {
  return openItems(home)
    .sort((a, b) => a.at.localeCompare(b.at))      // 越早惦记的越靠前
    .slice(0, limit)
    .map((x) => `${x.text}（我惦记着，因为${x.why || "还没了结"}）`);
}
