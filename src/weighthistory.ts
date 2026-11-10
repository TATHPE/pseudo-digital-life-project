/**
 * 权重变更历史（E-3b，2026-11-10）。
 *
 * 为什么单独一张审计：此前只有 `memory_text_changed`（改正文）和
 * `memory_meta_changed`（只记 `keys`，没有数值），于是「这条记忆的权重变过几次、
 * 每次是被谁抬上去的」答不出来。抽检时看到一条权重反常的契约，没法回溯。
 *
 * ⚠️ **记什么**：只记**离散变更**（锚点 / w0 被移动）：
 *   ① reconsolidate —— 真的进了装配块，w0↑、recall_count+1、锚点移到 now
 *   ② meta_patch    —— 人或模型显式改 weight / w0 / importance
 *   ③ reweight      —— CLI `decay --reweight --apply` 按 importance 重建 w0
 *
 * ⚠️ **不记什么**：`tickDecay()`（每 0.5 天重算所有 narrative 的 weight/stage）。
 *   `w = f(w0, now − 锚点, n)` 是时间的纯函数，普通 tick **不动锚点**；
 *   把它也记成事件，「变过几次」就退化成「过了几天」，还会把 events 表淹没。
 *   想看某时刻的权重，用 `decay.ts:recompute(m, at)` 直接算，不需要历史。
 *
 * 不升 schema：复用现有 `events` 表，kind=`memory_weight_changed`，
 * `target` 存记忆 id，payload 存改前/改后快照。老库里没有数值的
 * `memory_meta_changed` 单独报 `legacyCount`，**不混进 count**（口径不能含糊）。
 */
import type { DatabaseSync } from "node:sqlite";

export const WEIGHT_EVENT = "memory_weight_changed";

/** 触发原因：能看出"是自然想起、还是人手动改的" */
export type WeightCause = "reconsolidate" | "meta_patch" | "reweight" | "rebase";

/** 快照字段全部可选：调用方能读到多少就记多少，不许为了凑格式去猜 */
export interface WeightSnapshot {
  w0?: number;
  weight?: number;
  importance?: number;
  recallCount?: number;
  stage?: string;
}

export interface WeightChange {
  ts: string;
  cause: WeightCause;
  by: string;
  from: WeightSnapshot;
  to: WeightSnapshot;
}

export interface WeightHistory {
  id: number;
  /** 有数值的离散变更次数（不含 legacyCount） */
  count: number;
  lastAt: string | null;
  lastCause: WeightCause | null;
  /** 时间升序：老 → 新 */
  changes: WeightChange[];
  /** 老版本 `memory_meta_changed` 里涉及权重字段的条数：只有字段名、没有数值 */
  legacyCount: number;
}

export interface LogWeightInput {
  id: number;
  cause: WeightCause;
  from: WeightSnapshot;
  to: WeightSnapshot;
  by: string;
  now?: Date;
}

const WEIGHT_KEYS = new Set(["weight", "w0", "importance"]);

/**
 * 写一条权重变更。**必须在调用方的事务里调**：审计丢了而权重变了，
 * 比整批回滚更糟 —— 那就再也说不清这条是怎么变成现在这样的。
 */
export function logWeightChange(db: DatabaseSync, input: LogWeightInput): void {
  const ts = (input.now ?? new Date()).toISOString();
  db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
    .run(ts, WEIGHT_EVENT, input.by, String(input.id), JSON.stringify({
      cause: input.cause, by: input.by, from: input.from, to: input.to,
    }));
}

/** 「变过几次 / 最近一次是什么」：一眼能答，且能按次核对前后数值 */
export function weightHistory(db: DatabaseSync, id: number): WeightHistory {
  const rows = db.prepare(
    "SELECT ts,payload FROM events WHERE kind=? AND target=? ORDER BY ts ASC, id ASC",
  ).all(WEIGHT_EVENT, String(id)) as Array<{ ts: string; payload: string | null }>;

  const legacy = db.prepare(
    "SELECT payload FROM events WHERE kind='memory_meta_changed' AND target=?",
  ).all(String(id)) as Array<{ payload: string | null }>;

  const changes: WeightChange[] = [];
  for (const r of rows) {
    try {
      const p = JSON.parse(String(r.payload ?? "{}")) as Partial<WeightChange>;
      changes.push({
        ts: r.ts,
        cause: (p.cause ?? "meta_patch") as WeightCause,
        by: String(p.by ?? "unknown"),
        from: p.from ?? {},
        to: p.to ?? {},
      });
    } catch { /* 坏 payload 不毁掉整份历史：跳过这一条，其余照常 */ }
  }

  let legacyCount = 0;
  for (const r of legacy) {
    try {
      const keys = (JSON.parse(String(r.payload ?? "{}")) as { keys?: string[] }).keys ?? [];
      if (keys.some((k) => WEIGHT_KEYS.has(k))) legacyCount++;
    } catch { /* 同上 */ }
  }

  const last = changes.at(-1);
  return {
    id, count: changes.length,
    lastAt: last?.ts ?? null, lastCause: last?.cause ?? null,
    changes, legacyCount,
  };
}

/** CLI 用：把次数和每次的从→到写成能直接读的几行 */
export function formatWeightHistory(h: WeightHistory): string {
  const out: string[] = [];
  out.push(`记忆 #${h.id} 权重变更 ${h.count} 次` +
    (h.lastAt ? `（最近 ${h.lastAt.slice(0, 19).replace("T", " ")} · ${h.lastCause}）` : "（无记录）"));
  h.changes.forEach((c, i) => {
    const parts: string[] = [];
    for (const key of ["w0", "weight", "importance", "recallCount", "stage"] as const) {
      const a = c.from[key], b = c.to[key];
      if (a === undefined || b === undefined || a === b) continue;
      const fmt = (x: number | string) => typeof x === "number" ? (Number.isInteger(x) ? String(x) : x.toFixed(3)) : x;
      parts.push(`${key} ${fmt(a)}→${fmt(b)}`);
    }
    out.push(`  ${i + 1}. ${c.ts.slice(0, 19).replace("T", " ")}  ${c.cause} · ${c.by}  ${parts.join(" · ")}`);
  });
  if (h.legacyCount) out.push(`  （另有 ${h.legacyCount} 条旧版元数据事件只记了字段名、没有数值，未计入次数）`);
  if (!h.count) out.push("  提示：普通衰减 tick 不算离散变更 —— 权重是时间的纯函数，用 decay.ts:recompute(m, at) 回溯即可");
  return out.join(String.fromCharCode(10));
}
