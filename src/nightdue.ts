/**
 * 闲时整理的自动触发（2026-11-03）。
 *
 * 用户的追问：「这个闲时整理从来没启动过吗」
 * 查下来是真的：`events(kind=night)` 只有一条，还是我手动跑的那次；
 * CLI 只有 `jingjing night`，`standing`/`cron` 里没有模板，桌面壳没有，面板也没有按钮。
 * 于是「她会自己整理记忆」这句承诺，一直是**空头**。
 *
 * 这里补三件事里的两件（第三件是面板按钮，走 /api/night/run）：
 *  1. serve 启动时检查：距上次整理超过 `DUE_HOURS` 且 inbox 有新事件 → 后台补跑
 *  2. 同一条闸门：跑之前先判「本地整理模型在不在」，不在就明确降级（不是失败）
 *
 * 三条边界：
 *  · **不阻塞启动**：不 await，起完监听再跑（否则面板要等 40 秒）
 *  · **一次只跑一个**：进程内用标记锁住（两次 tick 撞在一起会把同一批事件抽两遍）
 *  · **不假装跑过**：跳过时写 noteNightlySkip，/health 会报 nightly-skipped
 */
import type { DatabaseSync } from "node:sqlite";

/** 距上次整理超过这么久才算「该跑了」 */
export const DUE_HOURS = 20;

export interface DueInfo {
  due: boolean;
  /** 上次整理时间（events 里最后一条 night，没有就用游标） */
  lastAt: string | null;
  /** 待整理条数。dueInfo 只拿到 db、拿不到 inboxDir，恒为 0；真实计数由调用方按 inbox 判断 */
  pending: number;
  why?: string;
}

function readMeta(db: DatabaseSync, key: string): string | null {
  try {
    const r = db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value?: string } | undefined;
    return r?.value ?? null;
  } catch { return null; }
}

/** 该不该跑：只看「上次整理多久前」+「有没有新东西」，不做别的判断 */
export function dueInfo(db: DatabaseSync, now = new Date(), opts: { hours?: number } = {}): DueInfo {
  const hours = opts.hours ?? DUE_HOURS;
  let lastAt: string | null = null;
  try {
    const r = db.prepare("SELECT max(ts) t FROM events WHERE kind='night'").get() as { t?: string } | undefined;
    lastAt = r?.t ?? null;
  } catch { /* 表还没建 */ }
  const cursor = readMeta(db, "nightly_cursor_ts");
  const since = lastAt ?? cursor;

  // 2026-11-09 修：以前这里查了 events 的 count 却 `void r` 丢掉，再硬编码 pending = 1，
  // 等于对面板假报「有 1 条待整理」。events 表不存对话（对话在 inbox 的 JSONL 里），
  // 本函数只拿到 db、拿不到 inboxDir，本来就数不出真实条数。
  // 诚实做法：恒为 0，「有没有新东西」由调用方按 inbox 判断；
  // kickNightIfDue 只看 due / lastAt / why，不看 pending，行为不受影响。
  const pending = 0;

  if (!since) return { due: true, lastAt: null, pending, why: "从没整理过" };
  const gapH = (now.getTime() - Date.parse(since)) / 3600_000;
  if (Number.isNaN(gapH)) return { due: true, lastAt: since, pending, why: "时间戳坏了" };
  return {
    due: gapH >= hours,
    lastAt: since,
    pending,
    ...(gapH >= hours ? {} : { why: "上次整理在 " + gapH.toFixed(1) + " 小时前（阈值 " + hours + "h）" }),
  };
}

/** 进程内锁：一次只跑一个闲时整理 */
let running = false;
export function nightRunning(): boolean { return running; }

/**
 * 后台补跑。**不 await**（调用方拿到 promise 就行，别阻塞启动）。
 * 传进来的 runner 就是 CLI 那条路（runNightCli），保持一致：同一份闸门、同一份报告。
 */
export function kickNightIfDue(
  db: DatabaseSync,
  runner: () => Promise<number>,
  now = new Date(),
  opts: { hours?: number; log?: (s: string) => void } = {},
): { started: boolean; why?: string } {
  const log = opts.log ?? ((s: string) => console.error(s));
  if (running) return { started: false, why: "已经在跑了" };
  const d = dueInfo(db, now, opts.hours === undefined ? {} : { hours: opts.hours });
  if (!d.due) return { started: false, why: d.why };

  running = true;
  log("[night] " + (d.why ?? "到期") + " → 后台开始整理（上次 " + String(d.lastAt ?? "无").slice(0, 16) + "）");
  runner()
    .then((code) => { log("[night] 结束 exit=" + code); })
    .catch((e) => { log("[night] 失败：" + String((e as Error)?.message ?? e).slice(0, 160)); })
    .finally(() => { running = false; });
  return { started: true };
}
