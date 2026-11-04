/**
 * 启动自检（18 §1.3 / §2.2）：断电检测 → 记 outage → 写一条记忆 → 补算衰减。
 * 幂等：**一段空档只记一条**（按 from_ts 去重）。
 *
 * 为什么不是 (from_ts, to_ts)：to_ts 是"这次启动的时间"，所以每重启一次就变一次。
 * 于是一次真正的断片会被反复记成新事件 —— 实测（2026-11-04）同一段 21:23 开始、
 * 每次都还没等到新对话就又被杀，最后留下 52/48/46/42 分钟四条记忆，
 * 连同更早的重复一共 193 条"进程被杀"占满整个库。from_ts 才是这段空档的身份。
 */
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readEvents, lastEvent } from "./journal.ts";
import { detectOutage } from "./boot.ts";
import { remember, tickDecay } from "./store.ts";
import type { Outage } from "./types.ts";

export interface StartupResult {
  outage: Outage | null;
  recorded: boolean;
  decayed: number;
  inbox: { events: number; quarantined: number; corrupted: number };
}

export function startup(deps: {
  db: DatabaseSync; inboxDir: string; home: string;
  cleanLastShutdown: boolean; now?: Date; embedder?: { embed(t: string[]): Promise<Float32Array[]> } | null;
}): StartupResult {
  const now = deps.now ?? new Date();
  const { events, quarantined, corrupted } = readEvents(deps.inboxDir, { quarantine: true });
  const last = lastEvent(events);
  const outage = detectOutage(deps.home, last ? new Date(last.ts) : null, now, deps.cleanLastShutdown);

  let recorded = false;
  if (outage) {
    const dup = deps.db.prepare(
      "SELECT id, to_ts FROM outages WHERE from_ts=? ORDER BY to_ts DESC LIMIT 1",
    ).get(outage.from.toISOString()) as { id: number; to_ts: string } | undefined;
    if (dup) {
      // 同一段断片又醒了一次：只把结束时间往后推，**绝不写第二条记忆**。
      // 记忆里那条保留"第一次醒来的时长" —— 它是当时真正知道的事；
      // 更长的真实空档在 outages 表里，视图要用就读那边。
      const next = outage.to.toISOString();
      if (next > dup.to_ts) {
        deps.db.prepare("UPDATE outages SET to_ts=? WHERE id=?").run(next, dup.id);
      }
    } else {
      deps.db.prepare(
        "INSERT INTO outages(from_ts,to_ts,kind,est_error_s,last_event_id,created_at) VALUES(?,?,?,?,?,?)",
      ).run(outage.from.toISOString(), outage.to.toISOString(), outage.kind, 60, last?.id ?? null, now.toISOString());

      // 写一条叙事记忆：它自己也会记得那次断片（salience 0.6，18 §2.2）
      const mins = Math.round((outage.to.getTime() - outage.from.getTime()) / 60000);
      const dur = mins >= 1440 ? `${Math.floor(mins / 1440)} 天 ${Math.floor((mins % 1440) / 60)} 小时`
                : mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${mins} 分钟`;
      const what = outage.kind === "power" ? "断电" : outage.kind === "crash" ? "进程被杀" : "关机";
      remember(deps.db, {
        layer: "narrative", kind: "episode", sensitivity: "local_only",
        text: `${what} ${dur}（${fmt(outage.from)}–${fmt(outage.to)}），其间无经历`,
        importance: 4, salience: 0.6, sourceKind: "agent", sourceRef: "startup", scoredBy: "rule:outage", now,
      });
      recorded = true;
    }
  }

  // 补算衰减：锚点没动，一次跳步即可（01 §4.1 的连续公式天然支持）
  const decayed = tickDecay(deps.db, now);
  return { outage, recorded, decayed, inbox: { events: events.length, quarantined, corrupted } };
}

const fmt = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const outagePath = (home: string) => join(home, "outages.jsonl");
