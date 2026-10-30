/**
 * 夜间整备（01 §9）：消化 inbox → 抽取 → 冲突消解 → 归并。
 *
 * 设计取舍：
 *  · 抽取用**本地模型**（role=extract，W-A：能看到记忆原文的角色必须 local）
 *  · 冲突判定优先用**确定性规则**（可测、可解释）；模型判定只用于可选分支
 *  · 游标存 meta.nightly_cursor_ts：断电/重跑都不会重复消化
 *  · 宁缺毋滥：模型给出 0 条是正常结果，不追问
 */
import type { DatabaseSync } from "node:sqlite";
import { readEvents, type Event } from "./journal.ts";
import { remember, tickDecay } from "./store.ts";
import type { Embedder } from "./embed.ts";
import { NIGHTLY_KINDS, type Layer } from "./decay.ts";

export interface Candidate {
  kind: string;
  layer: Layer;
  subject: string;
  text: string;
  salience: number;
  reason: string;
}

export type Verdict = "duplicate" | "supersede" | "refine";

export interface NightlyDeps {
  db: DatabaseSync;
  inboxDir: string;
  home: string;
  embedder: Embedder | null;
  /** 调本地模型做抽取（非流式）。返回模型原始文本 */
  extract: (prompt: string) => Promise<string>;
  /** 打分者的名字（E-3）：写进 scored_by，让“这条为什么重”能查 */
  scoredBy?: string;
  /**
   * 降级：有值就**不抽**，但仍算衰减（E-6）。
   * 为什么要这条：energy 的唯一恢复点在 `night` 末尾的 advance({night:true})，
   * 而以前缺模型在更早的地方就 return 2 了 —— 于是每聊 50 句 energy 掉一整格，永远回不来。
   * 不可达 ≠ 失败：能做的部分照做，不能做的部分说清楚。
   */
  skipExtract?: string;
  /** 冲突判定的可选模型分支（模糊带）。不给就纯规则 */
  verdict?: (a: { oldText: string; newText: string }) => Promise<Verdict>;
  now?: Date;
  maxItems?: number;
  fuzzyThreshold?: number;
}

export interface NightlyReport {
  scanned: number;
  candidates: number;
  added: number;
  noop: number;
  superseded: number;
  refined: number;
  decayed: number;
  cursorFrom: string | null;
  cursorTo: string | null;
  ms: number;
  notes: string[];
}

/** 记一笔“今晚没抽”（/health 的 degraded 读它）。成功跑完就清掉。 */export function noteNightlySkip(db: DatabaseSync, reason: string, now: Date): void {
  db.prepare("INSERT INTO meta(key,value) VALUES('nightly_skipped',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`${now.toISOString()} ${reason}`);
}

export function clearNightlySkip(db: DatabaseSync): void {
  db.prepare("DELETE FROM meta WHERE key='nightly_skipped'").run();
}

/**
 * 原话（J-2）：从当晚的真实对话里找最像这条记忆的那一句。
 *
 * 为什么不让模型自己交“原话”：那就不是原话了，是模型再写一遍。
 * 这里用字面重合挑，且只接受**逐字子串**（宁缺毋滥：挑不出就存 null）。
 */
export function pickQuote(events: readonly Event[], memoryText: string): string | null {
  const target = new Set(bigramsFor(memoryText));
  if (!target.size) return null;
  let best: { text: string; score: number } | null = null;
  for (const e of events) {
    const t = String((e.payload as { text?: string })?.text ?? "").trim();
    if (!t || t.length > 120) continue;          // 原话要短，长段落不算“那一句”
    const b = bigramsFor(t);
    let hit = 0;
    for (const x of b) if (target.has(x)) hit++;
    const score = hit / Math.max(1, Math.min(b.length, target.size));
    if (score >= 0.34 && (!best || score > best.score)) best = { text: t, score };   // 至少三成字面重合
  }
  return best ? best.text.slice(0, 120) : null;
}

function bigramsFor(s: string): string[] {
  const out: string[] = [];
  const t = s.replace(/[\s，。！？、；：""''（）()【】\[\]…—]/g, "");
  for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2));
  return out;
}

/**
 * 建边之前先过黑名单（J-5）：人拆过的线**永不自动接回**。
 * 黑名单存在 meta.links_blocked："src:dst:rel" 一行一个。
 */
export function linkIfNew(
  db: DatabaseSync, src: number, dst: number, rel: string, weight: number, why: string, now: Date,
): boolean {
  const key = `${src}:${dst}:${rel}`;
  const blocked = String(readMeta(db, "links_blocked") ?? "");
  if (blocked.split(String.fromCharCode(10)).includes(key)) return false;
  db.prepare(
    `INSERT INTO memory_links(src_id,dst_id,rel,weight,why,created_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(src_id,dst_id,rel) DO UPDATE SET weight=excluded.weight`,
  ).run(src, dst, rel, weight, String(why || "").slice(0, 20), now.toISOString());
  return true;
}

function readMeta(db: DatabaseSync, key: string): string | null {
  const r = db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value?: string } | undefined;
  return r?.value ?? null;
}

const EXTRACT_PROMPT = (transcript: string): string => [
  "你是记忆抽取器。从下面的对话里抽取「值得长期记住」的东西，只输出 JSON 数组，不要解释。",
  '每条格式：{"kind":"' + NIGHTLY_KINDS.join("|") + '","layer":"narrative|contract","subject":"不超过8字的主题","text":"一句话，不超过60字","salience":0到1,"reason":"为什么值得记"}',
  "规则：",
  "1) 承诺、边界、硬性事实 → layer=contract（永不衰减）；其余 → narrative",
  "2) 最多 5 条。宁缺毋滥：没有值得记的就输出 []",
  "3) 不要编造对话里没出现的内容；不要记录寒暄",
  "",
  "对话：",
  transcript,
].join(String.fromCharCode(10));

/** 宽松解析：容忍 ```json 围栏、前后废话、单条对象 */
export function parseCandidates(raw: string, cap = 5): Candidate[] {
  const t = raw.replace(/```[a-zA-Z]*/g, "").trim();
  const first = t.indexOf("[");
  const last = t.lastIndexOf("]");
  let arr: unknown = [];
  if (first >= 0 && last > first) {
    try { arr = JSON.parse(t.slice(first, last + 1)); } catch { arr = []; }
  } else {
    const o1 = t.indexOf("{");
    const o2 = t.lastIndexOf("}");
    if (o1 >= 0 && o2 > o1) {
      try { arr = [JSON.parse(t.slice(o1, o2 + 1))]; } catch { arr = []; }
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: Candidate[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = String(o.text ?? "").trim();
    if (!text || text.length > 200) continue;
    const layer: Layer = o.layer === "contract" ? "contract" : "narrative";
    out.push({
      kind: String(o.kind ?? (layer === "contract" ? "promise" : "episode")).slice(0, 24),
      layer,
      subject: String(o.subject ?? "").slice(0, 16),
      text,
      salience: Math.max(0, Math.min(1, Number(o.salience ?? 0.3) || 0.3)),
      reason: String(o.reason ?? "").slice(0, 120),
    });
    if (out.length >= cap) break;
  }
  return out;
}

const PUNCT = /[\s，。！？、；：""''（）()【】\[\]…—]/g;const normalize = (s: string): string => s.toLowerCase().replace(PUNCT, "");

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += (a[i] ?? 0) * (b[i] ?? 0);
  return d; // 两边都已 L2 归一化
}

export async function runNightly(deps: NightlyDeps): Promise<NightlyReport> {
  const t0 = Date.now();
  const now = deps.now ?? new Date();
  const notes: string[] = [];
  const cap = deps.maxItems ?? 5;
  const th = deps.fuzzyThreshold ?? 0.92;

  const cursorRow = deps.db.prepare("SELECT value FROM meta WHERE key='nightly_cursor_ts'").get() as { value?: string } | undefined;
  const cursorFrom = cursorRow?.value ?? null;

  const { events } = readEvents(deps.inboxDir);
  const fresh: Event[] = events.filter(
    (e) => (e.kind === "utterance" || e.kind === "agent_reply") && (!cursorFrom || e.ts > cursorFrom),
  );

  const report: NightlyReport = {
    scanned: fresh.length,
    candidates: 0,
    added: 0,
    noop: 0,
    superseded: 0,
    refined: 0,
    decayed: 0,
    cursorFrom,
    cursorTo: fresh.length ? fresh[fresh.length - 1]!.ts : cursorFrom,
    ms: 0,
    notes,
  };

  if (deps.skipExtract) {
    // 只算衰减 + 记一笔，游标**不动**（等模型到位再把这段 digest 掉，否则直接丢了）
    report.cursorTo = cursorFrom;
    report.decayed = tickDecay(deps.db, now);
    notes.push(`SKIPPED: ${deps.skipExtract}`);
    noteNightlySkip(deps.db, deps.skipExtract, now);
    report.ms = Date.now() - t0;
    return report;
  }

  if (!fresh.length) {
    report.decayed = tickDecay(deps.db, now);
    clearNightlySkip(deps.db);
    report.ms = Date.now() - t0;
    return report;
  }

  const transcript = fresh
    .map((e) => `${e.kind === "utterance" ? "用户" : "鲸鲸"}：${String((e.payload as { text?: string })?.text ?? "")}`)
    .join("\n")
    .slice(0, 6000);

  let raw = "";
  let extractFailed = false;
  try {
    raw = await deps.extract(EXTRACT_PROMPT(transcript));
  } catch (e) {
    // 抽取失败 ≠ 今天没什么可记的：**游标不能推进**，否则这批对话永久丢掉
    extractFailed = true;
    notes.push(`E_EXTRACT: ${String(e).slice(0, 120)}`);
  }

  const cands = parseCandidates(raw, cap);
  report.candidates = cands.length;

  for (const c of cands) {
    const vec = deps.embedder ? (await deps.embedder.embed([c.text]))[0] ?? null : null;

    // 同层同主题的既有记忆（subject 归一化后作为"槽位"）
    const key = `${c.layer}|${normalize(c.subject)}`;
    const same = deps.db
      .prepare(`SELECT id,text,embedding FROM memories
                WHERE status='active' AND layer=? AND normalized_key=? LIMIT 20`)
      .all(c.layer, key) as Array<{ id: number; text: string; embedding: Uint8Array | null }>;

    let verdict: Verdict | null = null;
    let target: number | null = null;

    for (const s of same) {
      if (normalize(s.text) === normalize(c.text)) { verdict = "duplicate"; target = s.id; break; }
      if (vec && s.embedding) {
        const old = new Float32Array(s.embedding.buffer, s.embedding.byteOffset, s.embedding.byteLength / 4);
        const cos = cosine(vec, old);
        if (cos >= th) {
          verdict = deps.verdict ? await deps.verdict({ oldText: s.text, newText: c.text }) : "supersede";
          target = s.id;
          break;
        }
        if (cos >= 0.75) { verdict = "refine"; target = s.id; }
      }
    }

    if (verdict === "duplicate" && target != null) {
      deps.db.prepare("UPDATE memories SET confidence=MIN(1,confidence+0.05), updated_at=? WHERE id=?")
        .run(now.toISOString(), target);
      report.noop++;
      notes.push(`NOOP ${c.text.slice(0, 20)}`);
      continue;
    }

    const id = remember(deps.db, {
      layer: c.layer,
      kind: c.kind,
      subject: c.subject || null,
      text: c.text,
      importance: c.layer === "contract" ? 5 : Math.round(2 + c.salience * 3),
      salience: c.salience,
      sensitivity: "shareable",           // 聊天来源 → 已出过网（19 §0.1）
      sourceKind: "extract",
      sourceRef: c.reason.slice(0, 80),
      // 原话（J-2）：**从 journal 里逐字取**，不采信模型转述 —— 否则“原话”又变成模型写的
      quote: pickQuote(fresh, c.text) ?? null,
      scoredBy: deps.scoredBy ?? "extract",
      embedding: vec,
      now,
    });
    // 归一化键（源里叫 normalized_key，store 负责写 text_bigram；这里补 key）
    deps.db.prepare("UPDATE memories SET normalized_key=? WHERE id=?").run(key, id);

    if (verdict === "supersede" && target != null) {
      deps.db.prepare("UPDATE memories SET superseded_by=?, status='archived', updated_at=? WHERE id=?")
        .run(id, now.toISOString(), target);
      linkIfNew(deps.db, id, target, "supersedes", 1, "同一件事的新说法", now);
      report.superseded++;
      notes.push(`SUPERSEDE ${c.text.slice(0, 20)}`);
    } else if (verdict === "refine" && target != null) {
      linkIfNew(deps.db, id, target, "derived_from", 0.8, (c.reason || c.subject || "同一段经历").slice(0, 20), now);
      report.refined++;
      report.added++;
    } else {
      report.added++;
    }
  }

  if (extractFailed) {
    report.cursorTo = cursorFrom;                       // 失败就留在原地，下轮重试
    noteNightlySkip(deps.db, "抽取失败（见 notes.E_EXTRACT）", now);
    report.decayed = tickDecay(deps.db, now);
    report.ms = Date.now() - t0;
    return report;
  }
  if (report.cursorTo) {
    deps.db.prepare("INSERT INTO meta(key,value) VALUES('nightly_cursor_ts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(report.cursorTo);
  }
  report.decayed = tickDecay(deps.db, now);
  clearNightlySkip(deps.db);
  report.ms = Date.now() - t0;
  return report;
}
