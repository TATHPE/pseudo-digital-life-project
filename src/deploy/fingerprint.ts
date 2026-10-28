/**
 * 三重指纹（02 §4.3 / §6，18 §1.3）：schema / tool / embed。
 *
 * 为什么要有它：换表结构、换工具集、换 embedding 模型，都会让召回**静默劣化**——
 * 不报错，只是越来越答不准。所以每一版发布都要把这三个值钉在 manifest 里，
 * 启动时比对，不一致就拒绝启动（而不是"先跑起来再说"）。
 *
 * 三个值都是**代码推导**出来的，不是人工维护的版本号：
 *   schema ← SCHEMA_VERSION + 建表 SQL 的哈希（改了 SQL 就变）
 *   tool   ← verb 目录（名字/档位/参数）的哈希（加一个 verb 就变）
 *   embed  ← meta.embed_model（换模型/换量化就变）
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATION_001, SCHEMA_VERSION } from "../schema.ts";
import { verbCatalog } from "../verbs.ts";
import { meta } from "../db.ts";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex").slice(0, 8);

export interface CoreFp {
  schema: string;
  tool: string;
  embed: string;
}

export function schemaFp(): string {
  return `v${SCHEMA_VERSION}-${sha(MIGRATION_001)}`;
}

export function toolFp(): string {
  const cat = verbCatalog();
  return `n${cat.length}-${sha(JSON.stringify(cat))}`;
}

export function embedFp(db: DatabaseSync): string {
  return meta(db, "embed_model") ?? "unset";
}

export function coreFpFromDb(db: DatabaseSync): CoreFp {
  return { schema: schemaFp(), tool: toolFp(), embed: embedFp(db) };
}

/**
 * 从 home 推导指纹（只读打开库，拿 embed）。
 * 库还没建 / 打不开时 embed 记 `unknown`——**不当作相等**，这样首次发布不会假装校验过。
 */
export function coreFpFromHome(home: string): CoreFp {
  const schema = schemaFp();
  const tool = toolFp();
  const file = join(home, "memory.db");
  if (!existsSync(file)) return { schema, tool, embed: "unknown" };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return { schema, tool, embed: embedFp(db) };
  } catch {
    return { schema, tool, embed: "unknown" };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 逐项比对，返回人话版的差异（空数组 = 一致） */
export function fpDiff(expected: CoreFp, actual: CoreFp): string[] {
  const out: string[] = [];
  if (expected.schema !== actual.schema) out.push(`schema ${expected.schema} → ${actual.schema}`);
  if (expected.tool !== actual.tool) out.push(`tool ${expected.tool} → ${actual.tool}`);
  if (expected.embed !== actual.embed) out.push(`embed ${expected.embed} → ${actual.embed}`);
  return out;
}
