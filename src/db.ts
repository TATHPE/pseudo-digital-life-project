import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { MIGRATION_001, SCHEMA_VERSION } from "./schema.ts";

const require = createRequire(import.meta.url);

export interface Db {
  db: DatabaseSync;
  vecLoaded: boolean;
  path: string;
}

export function openDb(path: string): Db {
  const db = new DatabaseSync(path, { allowExtension: true });
  let vecLoaded = false;
  try {
    const v = require("sqlite-vec") as { getLoadablePath(): string };
    db.loadExtension(v.getLoadablePath());
    vecLoaded = true;
  } catch {
    // 没有扩展也能跑：检索退化为两阶段的"纯 BM25 + 内存重排"
  }
  db.exec(MIGRATION_001);
  // 40k 行基准里，这两条把 FTS 排序从 12 ms 稳到 3–10 ms（i/o 抖动变小）
  try { db.exec("PRAGMA mmap_size=268435456; PRAGMA cache_size=-40000;"); } catch { /* 平台不支持则忽略 */ }
  if (vecLoaded) {
    try { db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(memory_id INTEGER PRIMARY KEY, embedding FLOAT[512])`); } catch { vecLoaded = false; }
  }
  // 启动时自检一次向量表（不是读旧标记，而是**现在试一下**）：
  // `meta.vec_error` 以前只写不删 —— 一次历史失败会让 `/health` 和 `capabilities`
  // 永远报 `vec-index-broken`。写入探针用负 id，插完立刻删。
  if (vecLoaded) {
    try {
      const probe = new Float32Array(512);
      db.prepare("INSERT OR REPLACE INTO vec_memories(memory_id,embedding) VALUES(?,?)").run(BigInt(-1), new Uint8Array(probe.buffer));
      db.prepare("DELETE FROM vec_memories WHERE memory_id=?").run(BigInt(-1));
      db.prepare("DELETE FROM meta WHERE key='vec_error'").run();
    } catch (e) {
      try {
        db.prepare("INSERT INTO meta(key,value) VALUES('vec_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(String(e).slice(0, 200));
      } catch { /* ignore */ }
    }
  }
  // 迁移：001 是幂等的 CREATE IF NOT EXISTS；后续版本在 SCHEMA_VERSION 推进时补
  const cur = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined;
  if (!cur) {
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run("schema_version", String(SCHEMA_VERSION));
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run("created_at", new Date().toISOString());
  } else if (Number(cur.value) < SCHEMA_VERSION) {
    // 新增表全部 IF NOT EXISTS，所以"重跑 001"等价于迁移；
    // 但**加列**不行（CREATE TABLE IF NOT EXISTS 对已存在的表是空操作）——要显式 ALTER。
    if (Number(cur.value) < 6) {
      ensureColumn(db, "exec_audit", "capability", "TEXT");
      ensureColumn(db, "exec_audit", "host_profile", "TEXT");
    }
    if (Number(cur.value) < 7) {
      // 摄入管道（02 §5）：文档多了元信息，块多了向量与删除标记
      ensureColumn(db, "documents", "rel_path", "TEXT");
      ensureColumn(db, "documents", "mime", "TEXT");
      ensureColumn(db, "documents", "bytes", "INTEGER");
      ensureColumn(db, "documents", "converter", "TEXT");
      ensureColumn(db, "documents", "meta_json", "TEXT");
      ensureColumn(db, "documents", "n_chunks", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "chunks", "embedding", "BLOB");
      ensureColumn(db, "chunks", "deleted_at", "TEXT");
    }
    if (Number(cur.value) < 8) {
      ensureColumn(db, "documents", "sensitivity", "TEXT NOT NULL DEFAULT 'local_only'");
    }
    if (Number(cur.value) < 10) {
      // E-3：权重/重要性是谁打的分，必须能查（否则"这条为什么比那条重"永远说不清）
      ensureColumn(db, "memories", "scored_by", "TEXT");
    }
    if (Number(cur.value) < 12) {
      // 三段侵蚀（学 whale-card）：0 完整 / 1 丢了细节 / 2 只剩影子（详见 erosion.ts）
      ensureColumn(db, "memories", "erase_stage", "INTEGER NOT NULL DEFAULT 0");
    }
    if (Number(cur.value) < 11) {
      // H-5 分代：旧数据一律记为第 0 代（未封存），迁移时才能显式区分"老记忆"
      ensureColumn(db, "memories", "created_under_gen", "INTEGER NOT NULL DEFAULT 0");
    }
    if (Number(cur.value) < 9) {
      // J 组：原话层（J-2）+ 关系带 why 与止期（J-3）
      ensureColumn(db, "memories", "quote", "TEXT");
      ensureColumn(db, "memory_links", "why", "TEXT");
      ensureColumn(db, "memory_links", "valid_to", "TEXT");
    }
    db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION));
  }
  return { db, vecLoaded, path };
}

export function meta(db: DatabaseSync, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value?: string } | undefined)?.value;
}

/** 幂等加列（SQLite 没有 ADD COLUMN IF NOT EXISTS） */
function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

/** 启动自检（18 §1.3）：quick_check + 指纹。integrity_check 太重，只在 unclean 时跑 */
export function selfCheck(d: Db): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  const qc = d.db.prepare("PRAGMA quick_check").get() as Record<string, string>;
  const okQuick = Object.values(qc)[0] === "ok";
  if (!okQuick) notes.push(`quick_check: ${Object.values(qc)[0]}`);
  const sv = meta(d.db, "schema_version");
  if (sv !== String(SCHEMA_VERSION)) notes.push(`schema_version ${sv} != ${SCHEMA_VERSION}（拒绝启动，02 §4.3）`);
  if (!d.vecLoaded) notes.push("sqlite-vec 未加载：向量检索降级");
  return { ok: okFull(notes), notes };
}

const okFull = (notes: string[]) => !notes.some((n) => n.includes("拒绝启动") || n.startsWith("quick_check"));
