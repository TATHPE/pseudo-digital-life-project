/**
 * 设定封存的**分代**（H-5）。
 *
 * 原则（用户原话）：「设定永不可改，它就不是生命，是一个配置文件。设定界面封存，
 * 不能在给它添加新设定，因为记忆已经跑起来了，再添加和修改设定会把记忆打乱。」
 *
 * 但人总要能改。所以真正要守的不是"永不修改"，而是**修改不追溯**：
 *
 *   · 每一代 = 一份人格指纹（六块文件的 sha256）+ 开启时间 + 为什么开
 *   · 每条记忆记下它**出生时是哪一代**（`memories.created_under_gen`）
 *   · 之后的解释变化只对**新记忆**生效；旧记忆仍然属于旧代 ——
 *     "她当时为什么那样想"这个问题，答案必须还是当时那一代
 *   · 要真的把旧记忆拉进新代，必须走 `migrate({reason})`：**显式、带理由、重算权重**
 *
 * 一句话：**默认向前生效；追溯是例外，且必须署名。**
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { PERSONA_FILES, loadPersonaText } from "./persona.ts";

export interface Generation {
  /** 递增整数；0 = 还没有人格（空库/首次） */
  gen: number;
  /** 六块文件的联合指纹（sha256 前 16 位） */
  fingerprint: string;
  /** 什么时候开的这一代 */
  createdAt: string;
  /** 为什么开（第一次是"初始人格"，之后是人写的理由） */
  because: string;
}

const META_KEY = "persona_gen";
const GEN_LOG = "persona_gen_log";

/** 当前人格指纹：六块按固定顺序拼接后 sha256 */
export function personaFingerprint(home: string): string {
  const files = loadPersonaText(home);
  const joined = PERSONA_FILES.map((f) => `--- ${f} ---` + String.fromCharCode(10) + (files[f] ?? "")).join(String.fromCharCode(10));
  return createHash("sha256").update(joined).digest("hex").slice(0, 16);
}

function readGen(db: DatabaseSync): Generation | null {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(META_KEY) as { value?: string } | undefined;
  if (!row?.value) return null;
  try { return JSON.parse(row.value) as Generation; } catch { return null; }
}

/** 当前代（没有就返回第 0 代，fingerprint 用当前人格现算） */
export function currentGeneration(db: DatabaseSync, home: string): Generation {
  return readGen(db) ?? { gen: 0, fingerprint: personaFingerprint(home), createdAt: new Date().toISOString(), because: "初始人格（未封存）" };
}

function logGen(db: DatabaseSync, g: Generation): void {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(GEN_LOG) as { value?: string } | undefined;
  const list = row?.value ? (JSON.parse(row.value) as Generation[]) : [];
  list.push(g);
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(GEN_LOG, JSON.stringify(list.slice(-50)));
}

export function generationLog(db: DatabaseSync): Generation[] {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(GEN_LOG) as { value?: string } | undefined;
  return row?.value ? (JSON.parse(row.value) as Generation[]) : [];
}

/**
 * 人格变了 → 开新一代（**只影响之后的记忆**）。
 * 内容没变、指纹相同 → 不换代（重复保存不该产生新代）。
 */
export function bumpGenerationIfChanged(
  db: DatabaseSync, home: string, because: string, now = new Date(),
): { bumped: boolean; generation: Generation } {
  const cur = readGen(db);
  const fp = personaFingerprint(home);
  if (cur && cur.fingerprint === fp) return { bumped: false, generation: cur };
  const next: Generation = {
    gen: (cur?.gen ?? 0) + 1,
    fingerprint: fp,
    createdAt: now.toISOString(),
    because: String(because ?? "").trim().slice(0, 200) || (cur ? "人格有改动（未写理由）" : "初始人格"),
  };
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(META_KEY, JSON.stringify(next));
  logGen(db, next);
  return { bumped: true, generation: next };
}

/**
 * 追溯迁移：把指定范围（默认"全部 active"）的记忆拉进当前代。
 * **必须给理由**，并且在事件里留痕 —— 这是"修改不追溯"的唯一例外通道。
 */
export function migrateToCurrentGen(
  db: DatabaseSync, home: string, opts: { reason?: string; fromGen?: number; now?: Date } = {},
): { moved: number; gen: number } {
  const reason = String(opts.reason ?? "").trim();
  if (reason.length < 10) {
    throw new Error("E_GEN_REASON: 追溯迁移必须写清为什么（至少 10 个字）—— 它会把旧记忆的解释换成新人格");
  }
  const now = opts.now ?? new Date();
  const g = currentGeneration(db, home);
  if (g.gen === 0) throw new Error("E_GEN_NONE: 还没有封存过任何一代（先在面板上保存一次人格）");
  const from = opts.fromGen;
  const res = from === undefined
    ? db.prepare("UPDATE memories SET created_under_gen=? WHERE created_under_gen<>?").run(g.gen, g.gen)
    : db.prepare("UPDATE memories SET created_under_gen=? WHERE created_under_gen=?").run(g.gen, from);
  const moved = Number(res.changes ?? 0);
  db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
    .run(now.toISOString(), "persona_gen_migrate", "human", String(g.gen),
      JSON.stringify({ from: from ?? "all", to: g.gen, moved, reason }));
  return { moved, gen: g.gen };
}

/** 一条记忆出生时的那一代（越界/未记录返回 null） */
export function generationOf(db: DatabaseSync, gen: number | null | undefined): Generation | null {
  if (gen === null || gen === undefined) return null;
  return generationLog(db).find((g) => g.gen === gen) ?? null;
}
