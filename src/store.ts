/** 记忆读写（M0 最小面）：remember / 载入候选 / 批量衰减 */
import type { DatabaseSync } from "node:sqlite";
import { bigramText } from "./text.ts";
import { paramsFor, recompute, isKnownKind, type Layer, type Stage } from "./decay.ts";

export interface NewMemory {
  layer: Layer; kind: string; text: string;
  subject?: string | null; scope?: string;
  importance?: number; salience?: number;
  sensitivity?: "local_only" | "shareable";
  taint?: "trusted" | "external";
  sourceKind?: "user" | "agent" | "extract" | "doc";
  sourceRef?: string | null;
  w0?: number;
  embedding?: Float32Array | null;
  now?: Date;
}

export interface MemoryRow {
  id: number; layer: Layer; kind: string; text: string;
  weight: number; stage: Stage; recall_count: number;
  last_decay_at: string; w0: number; importance: number;
  sensitivity: string; taint: string; created_at: string;
  embedding: Uint8Array | null;
}

export function remember(db: DatabaseSync, m: NewMemory): number {
  const now = (m.now ?? new Date()).toISOString();
  const p = paramsFor(m.kind);
  // D-1：契约层不允许存不可信来源。
  // 一旦写进去就是“永不衰减的硬事实”，而它可能是某份文档/某个工具结果里的一句话。
  // 静默降级更糟：直接拒写，让人或整理器显式改成 narrative。
  if (m.layer === "contract" && (m.taint ?? "trusted") !== "trusted") {
    throw new Error("E_TAINT_CONTRACT: 不可信来源（taint=external）不能直接进契约层（永不衰减）；先写叙事层，等人确认");
  }
  const w0 = m.w0 ?? (m.layer === "contract" ? 1 : 0.55);
  const emb = m.embedding ? new Uint8Array(m.embedding.buffer.slice(0)) : null;
  const r = db.prepare(`
    INSERT INTO memories(layer,kind,scope,subject,text,text_bigram,importance,salience,
      sensitivity,taint,source_kind,source_ref,w0,beta,floorw,weight,stage,last_decay_at,
      embedding,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      m.layer, m.kind, m.scope ?? "global", m.subject ?? null, m.text, bigramText(m.text),
      m.importance ?? 3, m.salience ?? 0.3, m.sensitivity ?? "local_only", m.taint ?? "trusted",
      m.sourceKind ?? "user", m.sourceRef ?? null,
      w0, p.beta, p.floor, m.layer === "contract" ? 1 : w0,
      m.layer === "contract" ? "active" : "active", now, emb, now, now,
    );
  const id = Number(r.lastInsertRowid);
  db.prepare("INSERT INTO memories_fts(memory_id,bigram) VALUES(?,?)").run(id, bigramText(m.text));
  // E-1：未知 kind 以前是**静默**回落到 episode（30 天）。回落仍然发生（老数据里有 kind='fact' 这类），
  // 但必须可观测：记一条事件，否则“模型填了个我们不认识的 kind”永远不会有人发现。
  if (!isKnownKind(m.kind)) {
    db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
      .run(now, "unknown_kind", "system", String(id), `kind=${String(m.kind).slice(0, 40)} → 回落 episode`);
  }
  if (emb) {
    // vec0 的主键只接受整数：node:sqlite 会把 JS number 绑成 REAL，必须 BigInt。
    // 失败时**不静默**：写 meta + 记事件（02 §4.3 的教训）。
    try {
      db.prepare("INSERT INTO vec_memories(memory_id,embedding) VALUES(?,?)").run(BigInt(id), emb);
    } catch (e) {
      db.prepare("INSERT INTO meta(key,value) VALUES('vec_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(e).slice(0, 200));
      db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,0)")
        .run(now, "vec_insert_failed", "system", String(id), String(e).slice(0, 200));
    }
  }
  return id;
}

export function getRow(db: DatabaseSync, id: number): MemoryRow | undefined {
  return db.prepare(`SELECT id,layer,kind,text,weight,stage,recall_count,last_decay_at,w0,
    importance,sensitivity,taint,created_at,embedding FROM memories WHERE id=?`).get(id) as MemoryRow | undefined;
}

/** 夜间 / 断电补算统一走这里（01 §11.1）：只重算"可能变了"的行 */
/**
 * 还没过期的契约层记忆（P6 用）。
 *
 * 为什么必须有这个函数：库里有 `valid_to` 这一列（承诺的约定时间 / 事实的有效期），
 * 但之前简报的 P6 只按 `status='active'` 取 —— 于是**已经了结的承诺每轮还在喂给模型**，
 * 它就一直提。用户说"我吃了"之后，那句「提醒他今晚 8 点吃药」被 nightly 关了（valid_to 落上），
 * 但 P6 照样带着它，模型当然反复提。
 *
 * 时间比较一律走 julianday（18 §5.2）：库里 `...Z` 与 `...+08:00` 混存，字符串比较会判错。
 */
export function openContracts(db: DatabaseSync, now: Date, limit = 15): Array<{ id: number; text: string }> {
  return db.prepare(
    `SELECT id,text FROM memories
      WHERE layer='contract' AND status='active'
        AND (valid_to IS NULL OR julianday(valid_to) > julianday(?))
      ORDER BY importance DESC, id ASC LIMIT ?`,
  ).all(now.toISOString(), limit) as Array<{ id: number; text: string }>;
}

export function tickDecay(db: DatabaseSync, now = new Date(), minGapDays = 0.5): number {
  const rows = db.prepare(`SELECT id,layer,kind,weight,stage,recall_count,last_decay_at,w0
    FROM memories WHERE status='active' AND layer='narrative'
      AND julianday(?) - julianday(last_decay_at) > ?`).all(now.toISOString(), minGapDays) as Array<{
      id: number; layer: Layer; kind: string; weight: number; stage: Stage;
      recall_count: number; last_decay_at: string; w0: number;
    }>;
  // 注意：**不更新 last_decay_at**（锚点语义，见 decay.ts 注释）。
  const upd = db.prepare("UPDATE memories SET weight=?,stage=?,updated_at=? WHERE id=?");
  const ts = now.toISOString();
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const { weight, stage } = recompute({
        id: String(r.id), layer: r.layer, kind: r.kind, w0: r.w0,
        recallCount: r.recall_count, lastDecayAt: new Date(r.last_decay_at), stage: r.stage,
      }, now);
      upd.run(weight, stage, ts, r.id);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return n;
}
