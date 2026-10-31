/** 记忆读写（M0 最小面）：remember / 载入候选 / 批量衰减 */
import type { DatabaseSync } from "node:sqlite";
import { bigramText } from "./text.ts";
import { paramsFor, recompute, reconsolidate, weight, w0FromImportance, isKnownKind, type Layer, type Stage } from "./decay.ts";

export interface NewMemory {
  layer: Layer; kind: string; text: string;
  subject?: string | null; scope?: string;
  importance?: number; salience?: number;
  sensitivity?: "local_only" | "shareable";
  taint?: "trusted" | "external";
  sourceKind?: "user" | "agent" | "extract" | "doc";
  sourceRef?: string | null;
  /** 原话（J-2）：必须是 journal 里的原句，不是模型转述 */
  quote?: string | null;
  /** 这个 importance 是谁定的（E-3）：human:panel / extract:<model> / rule:outage / tool:memory.remember */
  scoredBy?: string | null;
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
  // E-2：w0 由 importance 推导（之前恒 0.55，权重从来没有方差）
  const importance = Math.max(1, Math.min(5, Math.round(Number(m.importance ?? 3))));
  const w0 = m.w0 ?? w0FromImportance(importance, m.layer);
  const emb = m.embedding ? new Uint8Array(m.embedding.buffer.slice(0)) : null;
  const r = db.prepare(`
    INSERT INTO memories(layer,kind,scope,subject,text,text_bigram,importance,salience,
      sensitivity,taint,source_kind,source_ref,quote,scored_by,w0,beta,floorw,weight,stage,last_decay_at,
      embedding,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      m.layer, m.kind, m.scope ?? "global", m.subject ?? null, m.text, bigramText(m.text),
      importance, m.salience ?? 0.3, m.sensitivity ?? "local_only", m.taint ?? "trusted",
      m.sourceKind ?? "user", m.sourceRef ?? null, m.quote ?? null, m.scoredBy ?? "system",
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
      // 成功就要把旧报错清掉：否则一次历史失败会让 `/health` 永远说 `vec-index-broken`
      // （状态标记只在“现在真的坏”时才该存在）
      db.prepare("DELETE FROM meta WHERE key='vec_error'").run();
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

/**
 * 再巩固（J-1）：**只有真的进了装配块**才调用，不是“被检索到”。
 *
 * 之前 `decay.ts:reconsolidate()` 写好了却**全库零调用** —— 于是 recall_count 永远是 0，
 * accessBoost 恒为 1，“想一次就更牢”从没发生过。
 *
 * 同一事务批写；external 来源由 reconsolidate 自己拒绝加权（不动 w0/计数/锚点）。
 */
export function reinforce(db: DatabaseSync, ids: readonly number[], now = new Date()): number {
  if (!ids.length) return 0;
  const sel = db.prepare("SELECT id,layer,kind,w0,recall_count,last_decay_at,stage,taint FROM memories WHERE id=? AND status='active'");
  const upd = db.prepare("UPDATE memories SET w0=?,recall_count=?,last_decay_at=?,stage=?,weight=?,updated_at=? WHERE id=?");
  const ts = now.toISOString();
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const id of ids) {
      const r = sel.get(id) as
        | { id: number; layer: Layer; kind: string; w0: number; recall_count: number; last_decay_at: string; stage: Stage; taint: string }
        | undefined;
      if (!r) continue;
      const before = {
        id: String(r.id), layer: r.layer, kind: r.kind, w0: r.w0,
        recallCount: r.recall_count, lastDecayAt: new Date(r.last_decay_at), stage: r.stage,
        taint: (r.taint === "external" ? "external" : "trusted") as "trusted" | "external",
      };
      const after = reconsolidate(before, now);
      if (after.w0 === before.w0 && after.recallCount === before.recallCount && after.lastDecayAt.getTime() === before.lastDecayAt.getTime()) continue;
      upd.run(after.w0, after.recallCount, after.lastDecayAt.toISOString(), after.stage, r3(weight(after, now)), ts, id);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return n;
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

/** 三位小数（只在写库时用） */
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * 改正文（E-5）：**只有人**能改。
 *
 * 为什么要在 store 层拦而不是只靠约定：模型现在能通过工具写库（`memory.remember`），
 * 将来 P1-2 冲突消解还会让它"改写旧条目"。一旦模型能改正文，
 * 它就会用自己的话改历史（`01 §9` 明确要防的），而审计里看不出区别。
 *
 * 人类改正文也必须留 **pre-image**（改前/改后的哈希 + 谁改的），
 * 这样"这句话什么时候变的"永远查得到。
 */
export function updateMemoryText(
  db: DatabaseSync, id: number, text: string, by: string, now = new Date(),
  /**
   * 改完正文要一起重算向量（可选）：**正文与向量必须同一次写**。
   * 以前面板改完正文自己在 server.ts 里补 embedding + vec 行，于是出现了第二个写入口 ——
   * map:check 的「写入单入口」第四条当场把它抓了出来。
   */
  embedding?: Float32Array | null,
): { ok: true; changed: boolean } {
  if (!by.startsWith("human:")) {
    throw new Error(`E_METADATA_ONLY: ${by} 只能改元数据（stage/weight/link），不能改正文`);
  }
  const next = String(text).trim();
  if (!next) throw new Error("E_EMPTY");
  const cur = db.prepare("SELECT text FROM memories WHERE id=?").get(id) as { text: string } | undefined;
  if (!cur) throw new Error("E_NO_MEMORY");
  if (cur.text === next) return { ok: true, changed: false };

  const ts = now.toISOString();
  db.prepare("UPDATE memories SET text=?, text_bigram=?, updated_at=? WHERE id=?")
    .run(next, bigramText(next), ts, id);
  db.prepare("DELETE FROM memories_fts WHERE memory_id=?").run(id);
  db.prepare("INSERT INTO memories_fts(memory_id,bigram) VALUES(?,?)").run(id, bigramText(next));
  db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
    .run(ts, "memory_text_changed", by, String(id),
      // pre-image 必须含**旧正文**（截断 300 字）：只有哈希的话"变过"能查到、却恢复不了
      JSON.stringify({ before: hash8(cur.text), after: hash8(next), by, before_text: cur.text.slice(0, 300) }));

  // 正文变了，向量也跟着变（同一次写，不留给调用方补）
  if (embedding) {
    db.prepare("UPDATE memories SET embedding=? WHERE id=?")
      .run(new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength), id);
    try {
      db.prepare("DELETE FROM vec_memories WHERE memory_id=?").run(BigInt(id));
      db.prepare("INSERT INTO vec_memories(memory_id,embedding) VALUES(?,?)").run(BigInt(id), embedding);
      db.prepare("DELETE FROM meta WHERE key='vec_error'").run();
    } catch (e) {
      db.prepare("INSERT INTO meta(key,value) VALUES('vec_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(String(e).slice(0, 200));
    }
  }
  return { ok: true, changed: true };
}

/**
 * 改元数据（E-5 的另一半）：模型/规则可以改这些，但**改不了正文**。
 * 白名单是硬的：传 text/bigram 进来直接拒。
 */
const META_FIELDS = new Set(["stage", "weight", "w0", "importance", "valid_to", "superseded_by", "status", "sensitivity", "taint", "scored_by"]);

export function patchMemoryMeta(
  db: DatabaseSync, id: number, patch: Record<string, unknown>, by: string, now = new Date(),
): { ok: true; applied: string[] } {
  const keys = Object.keys(patch);
  const bad = keys.filter((k) => !META_FIELDS.has(k));
  if (bad.length) throw new Error(`E_METADATA_ONLY: ${by} 不许改 ${bad.join(",")}（正文/文本索引只能人改）`);
  if (!keys.length) return { ok: true, applied: [] };
  const ts = now.toISOString();
  db.prepare(`UPDATE memories SET ${keys.map((k) => `${k}=?`).join(",")}, updated_at=? WHERE id=?`)
    .run(...(keys.map((k) => patch[k] as never) as never[]), ts as never, id as never);
  db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
    .run(ts, "memory_meta_changed", by, String(id), JSON.stringify({ keys }));
  return { ok: true, applied: keys };
}

function hash8(s: string): string {
  // 只为"查得到变过"服务，不做安全用途；用简单 FNV-1a 免得引依赖
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
