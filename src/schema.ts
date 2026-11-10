/** M0 schema（02 §4 + 18 §1 的 outage/审计） */
export const SCHEMA_VERSION = 12;

export const MIGRATION_001 = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, uri TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE,
  title TEXT, md_path TEXT, created_at TEXT NOT NULL, deleted_at TEXT,
  -- v7：摄入管道（02 §4/§5）
  rel_path TEXT, mime TEXT, bytes INTEGER, converter TEXT, meta_json TEXT,
  n_chunks INTEGER NOT NULL DEFAULT 0,
  -- v8：文档也分敏感度，默认 local_only（02 §10.1：磁盘/文档摄入不出网）
  sensitivity TEXT NOT NULL DEFAULT 'local_only'
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, heading_path TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL, text_bigram TEXT NOT NULL DEFAULT '',
  n_tokens INTEGER NOT NULL DEFAULT 0, sha256 TEXT,
  -- v7：两阶段检索用 BLOB 向量（vec0 是暴力扫描，只留给量小的记忆）
  embedding BLOB,
  -- v7：重摄入不原地改，旧块只标时间（02 §5.3 可回滚）
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chunks ON chunks(doc_id, ord);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text_bigram, heading_path, content='chunks', content_rowid='id'
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  layer TEXT NOT NULL CHECK (layer IN ('narrative','contract')),
  kind TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  subject TEXT,
  text TEXT NOT NULL,
  text_bigram TEXT NOT NULL DEFAULT '',
  normalized_key TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  importance INTEGER NOT NULL DEFAULT 3,
  salience REAL NOT NULL DEFAULT 0.3,
  sensitivity TEXT NOT NULL DEFAULT 'local_only'
    CHECK (sensitivity IN ('local_only','shareable')),
  taint TEXT NOT NULL DEFAULT 'trusted'
    CHECK (taint IN ('trusted','external')),
  valid_from TEXT, valid_to TEXT,
  superseded_by INTEGER REFERENCES memories(id),
  source_kind TEXT NOT NULL DEFAULT 'user'
    CHECK (source_kind IN ('user','agent','extract','doc')),
  source_ref TEXT,
  /** 原话（J-2）：写入时从 journal 取的原句，**不是模型转述**；没有就是 null */
  quote TEXT,
  /** 这个 importance/w0 是谁定的（E-3）：human:panel / extract:qwen2.5:7b / rule:outage / tool:memory.remember */
  scored_by TEXT,
  -- H-5 分代：这条记忆出生时是哪一代人格（0 = 未封存/迁移前的老数据）
  created_under_gen INTEGER NOT NULL DEFAULT 0,
  w0 REAL NOT NULL DEFAULT 0.55,
  beta REAL NOT NULL DEFAULT 0.85,
  floorw REAL NOT NULL DEFAULT 0.05,
  weight REAL NOT NULL DEFAULT 0.55,
  stage TEXT NOT NULL DEFAULT 'active' CHECK (stage IN ('active','fading','dormant')),
  recall_count INTEGER NOT NULL DEFAULT 0,
  -- 三段侵蚀阶段（0 完整 / 1 丢细节 / 2 只剩影子）；详见 erosion.ts
  erase_stage INTEGER NOT NULL DEFAULT 0,
  last_decay_at TEXT NOT NULL,
  embedding BLOB,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted'))
);
CREATE INDEX IF NOT EXISTS ix_mem_stage ON memories(status, stage);
CREATE INDEX IF NOT EXISTS ix_mem_layer ON memories(layer, kind);

-- FTS：contentless + 显式插入（不需要触发器，代价是删除时要手动 'delete'）
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, bigram);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL,
  actor TEXT NOT NULL, target TEXT, payload TEXT, ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS exec_audit (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, verb TEXT NOT NULL, tier TEXT NOT NULL,
  argv_json TEXT, cwd TEXT, exit_code INTEGER, duration_ms INTEGER,
  decision TEXT NOT NULL, deny_reason TEXT,
  -- v6：T3 的令牌 id（04 §7）与宿主画像（04 §5.3；我们不走 PowerShell，记 direct/node…）
  capability TEXT, host_profile TEXT
);

-- 记账（13 §6）：cached_tokens 单独一列
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  role TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  in_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_usage_ts ON usage(ts);

-- 记忆之间的关系（02 §4：supersedes / derived_from / related / contradicts）
CREATE TABLE IF NOT EXISTS memory_links (
  src_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  dst_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  rel TEXT NOT NULL CHECK (rel IN ('supersedes','derived_from','related','contradicts')),
  weight REAL NOT NULL DEFAULT 1.0,
  /** 为什么连（J-3）：≤60 字（J-3b 放宽，要放得下 cos/字面 双判据），说不出来的边不该建 */
  why TEXT,
  /** 止期（J-3）：作废写止期而不删边，历史仍查得到 */
  valid_to TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (src_id, dst_id, rel)
);
CREATE INDEX IF NOT EXISTS ix_links_dst ON memory_links(dst_id, rel);

-- 主动意图（01 §10.2）：发出去的、以及**没发出去的**都要记，否则无法回答"你为什么不说话"
CREATE TABLE IF NOT EXISTS intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('send','drop')),
  reason_kind TEXT NOT NULL,        -- promise_due | anniversary | silence | explicit | none
  reason_text TEXT NOT NULL,        -- 人话：因为哪条记忆、为什么是现在
  memory_ref INTEGER,               -- 触发的记忆 id（可空）
  message TEXT,                     -- 发出去的正文（drop 时为空）
  gate TEXT,                        -- 被哪道门拦下：quiet | cap | gap | no_reason
  FOREIGN KEY (memory_ref) REFERENCES memories(id)
);
CREATE INDEX IF NOT EXISTS ix_intents_ts ON intents(ts);

-- 自我状态快照（01 §8）：慢变量，每天至少一条，可回放
CREATE TABLE IF NOT EXISTS self_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  energy REAL NOT NULL DEFAULT 0.7, closeness REAL NOT NULL DEFAULT 0.3,
  mood TEXT, attention TEXT, note TEXT,
  source TEXT NOT NULL DEFAULT 'step'
);
CREATE INDEX IF NOT EXISTS ix_state_ts ON self_state(ts);

-- 断电感知（18 §2）
CREATE TABLE IF NOT EXISTS outages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_ts TEXT NOT NULL, to_ts TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('power','crash','restart')),
  est_error_s INTEGER NOT NULL DEFAULT 60,
  last_event_id TEXT, created_at TEXT NOT NULL
);
`;
