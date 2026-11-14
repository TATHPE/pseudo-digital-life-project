/**
 * 常驻指令（D-3）：有范围的预授权 + 调度。
 *
 * `docs/ops/25` 定下的四条硬约束，这里是它们的实现：
 *  ① **只收模板，不收任意 argv** —— 定时任务没人看着，参数写错了没人拦
 *  ② **必须指定通知通道**，且**回执没人读就自动停用**（`staleUnseen`）
 *  ③ **每次触发自己开一个 60 秒的窗口**，跑完立刻收回 ——
 *     常驻指令不是"永久授权"，是"每次触发时自己重新申请一次"
 *  ④ 每天最多 N 次（默认 1）；ttl 到点自动作废，不自动续
 *
 * 另外：`taint=external` 不参与（外部内容不能成为定时任务的触发源）；这条在 judge 里做。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import { templateById, TEMPLATES } from "./shell.ts";
import { listReceipts, pushReceipt, staleUnseen } from "./notify.ts";
import { localDay } from "./localday.ts";

export interface StandingOrder {
  id: string;
  /** `HH:MM` + 可选星期：`daily 09:00` / `workdays 09:00` / `mon,thu 20:00` */
  when: string;
  template: string;
  slots: Record<string, string>;
  because: string;
  /** 必须指定；目前只支持 "panel"（面板回执） */
  notify: string;
  maxPerDay: number;
  createdAt: string;
  expiresAt: string;
  enabled: boolean;
  /** 最近一次触发日期（本地日）与当天次数 */
  lastDay?: string;
  countToday?: number;
  disabledReason?: string;
}

export const standingDir = (home: string): string => join(home, "standing");
const ID_RE = /^[a-z][a-z0-9-]{2,30}$/;
const MAX_TTL_DAYS = 30;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const pathOf = (home: string, id: string): string => {
  if (!ID_RE.test(id)) throw new Error(`E_STANDING_ID: ${id}`);
  return join(standingDir(home), id + ".json");
};

/** `daily 09:00` / `workdays 09:00` / `mon,thu 20:00` */
export function parseWhen(when: string): { days: number[] | "all"; hh: number; mm: number } | null {
  const m = String(when ?? "").trim().match(/^(daily|workdays|([a-z]{3}(,[a-z]{3})*))\s+(\d{1,2}):(\d{2})$/i);
  if (!m) return null;
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  if (hh > 23 || mm > 59) return null;
  const head = String(m[1]).toLowerCase();
  if (head === "daily") return { days: "all", hh, mm };
  if (head === "workdays") return { days: [1, 2, 3, 4, 5], hh, mm };
  const days: number[] = [];
  for (const d of head.split(",")) {
    const i = (DAY_KEYS as readonly string[]).indexOf(d);
    if (i < 0) return null;
    days.push(i);
  }
  return { days, hh, mm };
}

export function addStanding(
  home: string,
  input: {
    id: unknown; when: unknown; template: unknown; slots?: unknown;
    because: unknown; notify?: unknown; ttlDays?: unknown; maxPerDay?: unknown;
  },
  now = new Date(),
): { ok: true; order: StandingOrder } | { ok: false; code: string; why: string } {
  const id = String(input.id ?? "").trim().toLowerCase();
  if (!ID_RE.test(id)) return { ok: false, code: "E_STANDING_ID", why: "id 只收小写字母/数字/短横（3–31 字）" };

  const when = String(input.when ?? "").trim();
  if (!parseWhen(when)) return { ok: false, code: "E_STANDING_WHEN", why: "when 只收 `daily 09:00` / `workdays 09:00` / `mon,thu 20:00`" };

  const template = String(input.template ?? "").trim();
  const t = templateById(template);
  if (!t) {
    return { ok: false, code: "E_STANDING_TEMPLATE", why: `没有这个模板：${template}（可选 ${TEMPLATES.map((x) => x.id).join(" / ")}）` };
  }

  const because = String(input.because ?? "").trim();
  if (because.length < 10) return { ok: false, code: "E_STANDING_BECAUSE", why: "常驻指令的理由至少 10 个字：它会在你不在的时候自己跑" };

  const notify = String(input.notify ?? "").trim();
  // ② 没有通知通道就不许建 —— 这条是 D-3 的核心，不是可选项
  if (notify !== "panel") return { ok: false, code: "E_STANDING_NOTIFY", why: "必须指定通知通道（目前支持 notify=panel），否则跑完了没人知道" };

  const slots: Record<string, string> = {};
  if (input.slots && typeof input.slots === "object") {
    for (const [k, v] of Object.entries(input.slots as Record<string, unknown>)) slots[k] = String(v);
  }

  const ttlDays = Math.min(MAX_TTL_DAYS, Math.max(1, Number(input.ttlDays ?? 7)));
  const maxPerDay = Math.min(6, Math.max(1, Number(input.maxPerDay ?? 1)));

  const order: StandingOrder = {
    id, when, template, slots, because,
    notify, maxPerDay,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlDays * 86400_000).toISOString(),
    enabled: true,
  };
  const dir = standingDir(home);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFile(pathOf(home, id), JSON.stringify(order, null, 2));
  return { ok: true, order };
}

export function listStanding(home: string): StandingOrder[] {
  const dir = standingDir(home);
  if (!existsSync(dir)) return [];
  const out: StandingOrder[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as StandingOrder); } catch { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getStanding(home: string, id: string): StandingOrder | null {
  try { return JSON.parse(readFileSync(pathOf(home, id), "utf8")) as StandingOrder; } catch { return null; }
}

export function disableStanding(home: string, id: string, reason: string, now = new Date()): StandingOrder | null {
  const o = getStanding(home, id);
  if (!o) return null;
  const next: StandingOrder = { ...o, enabled: false, disabledReason: `${now.toISOString()} ${reason}`.slice(0, 200) };
  atomicWriteFile(pathOf(home, id), JSON.stringify(next, null, 2));
  return next;
}

/** 现在该不该跑？只看时间与配额，不看授权（授权在 runStanding 里现开现收） */
export function isDue(o: StandingOrder, now = new Date()): boolean {
  if (!o.enabled) return false;
  if (Date.parse(o.expiresAt) <= now.getTime()) return false;
  const w = parseWhen(o.when);
  if (!w) return false;
  if (w.days !== "all" && !w.days.includes(now.getDay())) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < w.hh * 60 + w.mm) return false;              // 还没到点
  const day = localDay(now);
  const used = o.lastDay === day ? (o.countToday ?? 0) : 0;
  return used < o.maxPerDay;
}

export interface RunDeps {
  home: string;
  /** 真正把模板跑起来的函数（CLI 传 execute 的包装，测试可注入） */
  run: (o: StandingOrder) => Promise<{ ok: boolean; output: string }>;
  now?: Date;
}

export interface RunReport {
  ran: Array<{ id: string; ok: boolean; receipt: string }>;
  skipped: Array<{ id: string; why: string }>;
  disabled: Array<{ id: string; why: string }>;
}

/**
 * 跑一次「到点的那些」。
 *
 * 顺序刻意是：**先检查回执** → 再跑 → 写回执。
 * 因为如果上一轮的回执一直没人读，这一轮就不该再产出新的（越堆越没人看）。
 */
export async function runDue(deps: RunDeps, now = deps.now ?? new Date()): Promise<RunReport> {
  const report: RunReport = { ran: [], skipped: [], disabled: [] };

  // ③ 回执没人读 → 停用来源（3 天）
  const stale = staleUnseen(deps.home, now);
  const blocked = new Set<string>();
  for (const s of stale) {
    if (!s.source.startsWith("standing:")) continue;
    const id = s.source.slice("standing:".length);
    if (blocked.has(id)) continue;
    blocked.add(id);
    const o = disableStanding(deps.home, id, `回执超过 3 天没人读（${s.id}），自动停用`, now);
    if (o) report.disabled.push({ id, why: "回执没人读 → 已停用" });
  }

  for (const o of listStanding(deps.home)) {
    if (blocked.has(o.id)) continue;
    if (!isDue(o, now)) { report.skipped.push({ id: o.id, why: "没到点 / 配额用完 / 已停用 / 已过期" }); continue; }

    const r = await deps.run(o);
    const receipt = pushReceipt(deps.home, {
      kind: "standing",
      ok: r.ok,
      title: `${o.id} ${r.ok ? "跑完了" : "失败了"}：${o.template}`,
      body: r.output.slice(0, 1500),
      source: `standing:${o.id}`,
    }, now);

    const day = localDay(now);
    const next: StandingOrder = {
      ...o,
      lastDay: day,
      countToday: (o.lastDay === day ? (o.countToday ?? 0) : 0) + 1,
    };
    atomicWriteFile(pathOf(deps.home, o.id), JSON.stringify(next, null, 2));
    report.ran.push({ id: o.id, ok: r.ok, receipt: receipt.id });
  }
  return report;
}

/** 面板/CLI 用：还有几条回执没人看（一眼就知道"它在后台做过事"） */
export function unseenStandingReceipts(home: string): number {
  return listReceipts(home, { unseenOnly: true, limit: 1000 }).filter((r) => r.source.startsWith("standing:")).length;
}
