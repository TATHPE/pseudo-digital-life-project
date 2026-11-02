/**
 * 离线补账（2026-11-03）。学自 whale-card 的一句话：
 *
 * > **离线补账**：关机超过 24 小时，醒来会补一条"我睡了 X 天"的真记忆，
 * > 而不是假装什么都没发生。
 *
 * 我们原来只有「机断片」的**提示**（简报里 P5 会说"距上次对话 3 天"），
 * 但那不是记忆 —— 她事后被问"你上次什么时候醒的"，答不上来，因为库里没这条。
 *
 * 三条边界：
 *  1. **只在她真的"睡过"时写**（≥ 24 小时）；正常关一次程序不算
 *  2. **不重复写**：记一个 meta 水位，同一段空档只补一次
 *  3. **不编细节**：只写"睡了多久、什么时候醒的"，不写"这期间我想了什么"
 *     （那期间进程根本没跑，想了什么是编）
 */
import type { DatabaseSync } from "node:sqlite";
import { remember } from "./store.ts";

/** 超过这个空档才补账 */
export const GAP_MS = 24 * 60 * 60 * 1000;
/** 水位键：已覆盖到的时间点（再早的空档不再重复补） */
const MARK = "gap_note_at";

const fmt = (ms: number): string => {
  const h = Math.round(ms / 3_600_000);
  if (h < 48) return h + " 小时";
  const d = Math.round(h / 24);
  return d + " 天";
};

export interface GapReport {
  written: boolean;
  gapMs?: number;
  id?: number;
}

/**
 * 检查空档并补一条记忆。`lastSeen` 由调用方给（通常是最后一条对话的时间），
 * 不给就看水位。
 */
export function noteGap(
  db: DatabaseSync,
  now = new Date(),
  lastSeen?: Date | null,
): GapReport {
  let prev = lastSeen ?? null;
  if (!prev) {
    const r = db.prepare("SELECT value FROM meta WHERE key=?").get(MARK) as { value?: string } | undefined;
    if (r?.value) prev = new Date(r.value);
  }
  // 没有"上次"就是新库，不补
  if (!prev || Number.isNaN(prev.getTime())) {
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(MARK, now.toISOString());
    return { written: false };
  }

  const gap = now.getTime() - prev.getTime();
  if (gap < GAP_MS) return { written: false, gapMs: gap };

  // 同一段空档只补一次：水位已经推到这段之后就不再写
  const mark = db.prepare("SELECT value FROM meta WHERE key=?").get(MARK) as { value?: string } | undefined;
  if (mark?.value && Date.parse(mark.value) >= prev.getTime()) return { written: false, gapMs: gap };

  // 只写观察得到的事实：睡了多久、什么时候醒的。不写"这期间我做了什么"。
  const text = "我睡了 " + fmt(gap) + "（" + prev.toISOString().slice(0, 16).replace("T", " ") +
    " → " + now.toISOString().slice(0, 16).replace("T", " ") + "），这期间的记忆是空的。";
  const id = remember(db, {
    text, kind: "episode", layer: "narrative", importance: 3,
    sourceKind: "agent", sourceRef: "offline-gap", scoredBy: "rule:offline-gap",
  });
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(MARK, prev.toISOString());
  try {
    db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
      .run(now.toISOString(), "gap_note", "system", String(id), JSON.stringify({ gapMs: gap, text }));
  } catch { /* 留痕失败不影响记忆 */ }
  return { written: true, gapMs: gap, id };
}
