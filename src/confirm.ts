/**
 * 待确认清单（04 §4.1 的"人那一侧"）
 *
 * 为什么需要它：T3 的令牌必须由**人**签发，而人不在终端的时候（在看面板），
 * 模型提的案就只会得到一个 E_NEEDS_CONFIRM 然后消失——"这次想跑什么"就丢了。
 * 所以 execute 每次拒绝了 T3，就在这里留一张待确认卡：确切 argv + 指纹 + 为什么不行。
 *
 * 三条设计：
 *  ① **按指纹去重**：模型重试十次也只有一张卡（同一 argv 只留最新的）
 *  ② **同 argv 短时效**：卡本身会过期（默认 15 min），过期就不能点确认（否则等于长期授权）
 *  ③ **确认的动作在服务端**：面板只发 `{action:"confirm"}`，令牌由服务端现场签发、绑这条 argv、立即用掉。
 *     —— 页面拿不到令牌，也就无法"确认一次、以后一直用"。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";

export type PendingStatus = "pending" | "done" | "failed" | "rejected";

export interface Pending {
  id: string;
  verb: string;
  /** shell.run 的模板 id */
  template: string;
  /** 给 shell.run 重放用的原始参数（确认时按原样渲染，不通再拼） */
  args: Record<string, unknown>;
  argv: string[];
  cwd: string;
  digest: string;
  created_at: string;
  expires_at: string;
  status: PendingStatus;
  /** 被拒/执行后的原因或输出（截断后） */
  result?: string;
  source: string;
}

export const pendingDir = (home: string) => join(home, "pending");
const ID_RE = /^pnd_[0-9a-z]{6,40}$/;
const TTL_MS = 15 * 60_000;

const pathOf = (home: string, id: string) => {
  if (!ID_RE.test(id)) throw new Error(`E_PENDING_ID: ${id}`);
  return join(pendingDir(home), id + ".json");
};

export function newPendingId(now = new Date()): string {
  return `pnd_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function listPending(home: string, now = new Date(), all = false): Pending[] {
  const dir = pendingDir(home);
  if (!existsSync(dir)) return [];
  const out: Pending[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = JSON.parse(readFileSync(join(dir, f), "utf8")) as Pending;
      if (!all && Date.parse(p.expires_at) <= now.getTime() && p.status === "pending") continue;
      out.push(p);
    } catch { /* 坏文件跳过（verify 会报） */ }
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export function getPending(home: string, id: string): Pending | undefined {
  try {
    const p = pathOf(home, id);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as Pending;
  } catch { return undefined; }
}

/**
 * 记一张待确认卡。同一 argv（digest 相同）只留一张：刷新时间、替换参数。
 */
export function recordPending(
  home: string,
  o: Omit<Pending, "id" | "created_at" | "expires_at" | "status"> & { now?: Date },
): Pending {
  const now = o.now ?? new Date();
  const dir = pendingDir(home);
  mkdirSync(dir, { recursive: true });

  const same = listPending(home, now, true).find((p) => p.digest === o.digest && p.status === "pending");
  const rec: Pending = {
    id: same?.id ?? newPendingId(now),
    verb: o.verb,
    template: o.template,
    args: o.args,
    argv: o.argv,
    cwd: o.cwd,
    digest: o.digest,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + TTL_MS).toISOString(),
    status: "pending",
    source: o.source,
  };
  atomicWriteFile(pathOf(home, rec.id), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

export function updatePending(home: string, id: string, patch: Partial<Pending>): Pending {
  const cur = getPending(home, id);
  if (!cur) throw new Error(`E_PENDING_NOT_FOUND: ${id}`);
  const next: Pending = { ...cur, ...patch };
  atomicWriteFile(pathOf(home, id), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** 过期 / 已结案的卡留 1 天后清掉（面板默认只看 24h 内的） */
export function sweepPending(home: string, now = new Date()): number {
  const dir = pendingDir(home);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = JSON.parse(readFileSync(join(dir, f), "utf8")) as Pending;
      const age = now.getTime() - Date.parse(p.created_at);
      if (age > 86_400_000) { unlinkSync(join(dir, f)); n++; }
    } catch { /* 坏文件留着 */ }
  }
  return n;
}
