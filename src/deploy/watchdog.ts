/**
 * 看门狗 + 自动回滚（18 §4.3 / §4.5，99 §5.1）
 *
 * 判定只用三样东西：`lastAttempt`（开始启动）、`lastHealthy`（启动成功过）、
 * `deadlineMs`（观察窗口，默认 10 分钟）。
 *
 *   没有进行中的启动            → idle
 *   这次启动的版本已经上报健康   → ok
 *   还没到窗口结束              → wait
 *   窗口结束还不见健康           → 记一次失败 → 回滚到 lastHealthy
 *   连续失败 ≥ maxStreak        → 冻结自我更新 freezeMs（默认 24h），防"来回抖"
 *
 * 关键的一个细节：**同一个版本的重复启动不重置时钟**。
 * 否则"启动即崩 → 立刻重启 → 时钟归零"会无限循环，永远等不到 deadline。
 */
import { bootId as hostBootId } from "../boot.ts";
import {
  assertReleaseId, hasRelease, readStateSafe, rollbackTarget, writeState,
  type DeployState, type Attempt,
} from "./slot.ts";

export interface DeployPolicy {
  deadlineMs: number;
  freezeMs: number;
  maxStreak: number;
}

export const DEFAULT_DEPLOY_POLICY: DeployPolicy = {
  deadlineMs: 10 * 60_000,
  freezeMs: 24 * 3_600_000,
  maxStreak: 2,
};

/** 环境变量覆盖（测试与手工演练用；生产默认值就是文档里的 10 min / 24 h / 2 次） */
export function policyFromEnv(env: Record<string, string | undefined> = process.env): DeployPolicy {
  const num = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    deadlineMs: num("JJ_DEPLOY_DEADLINE_MS", DEFAULT_DEPLOY_POLICY.deadlineMs),
    freezeMs: num("JJ_DEPLOY_FREEZE_MS", DEFAULT_DEPLOY_POLICY.freezeMs),
    maxStreak: num("JJ_DEPLOY_MAX_STREAK", DEFAULT_DEPLOY_POLICY.maxStreak),
  };
}

export type Decision =
  | { action: "idle"; reason: string }
  | { action: "ok"; id: string }
  | { action: "wait"; id: string; msLeft: number }
  | { action: "frozen"; until: string }
  | { action: "rollback"; failed: string; to: string; failures: number; streak: number; frozen: boolean }
  | { action: "halt"; failed: string; failures: number; streak: number; frozen: boolean; reason: string };

/** 记录"我要用这一版启动了"。同版本重复调用保留原有时钟。 */
export function bootAttempt(
  home: string, id: string, opts: { now?: Date; pid?: number; boot?: string } = {},
): DeployState {
  assertReleaseId(id);
  if (!hasRelease(home, id)) throw new Error(`E_NO_RELEASE: ${id}`);
  const { state: st } = readStateSafe(home);
  if (st.lastAttempt?.id === id) return st;
  const at = (opts.now ?? new Date()).toISOString();
  const attempt: Attempt = { id, at, pid: opts.pid ?? process.pid, boot: opts.boot ?? hostBootId() };
  st.lastAttempt = attempt;
  writeState(home, st);
  return st;
}

/** 启动成功（HTTP 已在听 / 自检通过）→ 观察窗口结束得早，也不必等满 10 分钟 */
export function markHealthy(home: string, id: string, now = new Date()): DeployState {
  const { state: st } = readStateSafe(home);
  st.lastHealthy = { id, at: now.toISOString() };
  st.failStreak = 0;
  writeState(home, st);
  return st;
}

export function isFrozen(state: DeployState, now = new Date()): boolean {
  return Boolean(state.freezeUntil) && Date.parse(String(state.freezeUntil)) > now.getTime();
}

/** 发布闸：冻结期内不许装/切（18 §4.5 "连续两次失败 → 24h 内拒绝任何自我更新"） */
export function assertNotFrozen(home: string, now = new Date()): void {
  const { state: st } = readStateSafe(home);
  if (isFrozen(st, now)) throw new Error(`E_DEPLOY_FROZEN: 自我更新冻结至 ${st.freezeUntil}`);
}

/**
 * 纯判定（不写盘）。`force` 表示"不用等窗口了"——子进程已经退出时用它。
 */
export function evaluate(
  home: string, now = new Date(), policy = DEFAULT_DEPLOY_POLICY, opts: { force?: boolean } = {},
): Decision {
  const { state: st } = readStateSafe(home);
  if (isFrozen(st, now)) return { action: "frozen", until: String(st.freezeUntil) };
  const att = st.lastAttempt;
  if (!att) return { action: "idle", reason: "没有进行中的启动" };
  if (st.lastHealthy?.id === att.id) return { action: "ok", id: att.id };

  const age = now.getTime() - Date.parse(att.at);
  if (!opts.force && age < policy.deadlineMs) {
    return { action: "wait", id: att.id, msLeft: policy.deadlineMs - age };
  }

  const failures = (st.failures[att.id] ?? 0) + 1;
  const streak = st.failStreak + 1;
  const frozen = streak >= policy.maxStreak;
  const to = rollbackTarget(home, att.id);
  if (!to) {
    return { action: "halt", failed: att.id, failures, streak, frozen, reason: "没有可回滚的上一版" };
  }
  return { action: "rollback", failed: att.id, to, failures, streak, frozen };
}

/** 把判定落到 state.json（回滚 = 切槽 + 清 applied，真正的文件复制在下次启动） */
export function apply(
  home: string, d: Decision, now = new Date(), policy = DEFAULT_DEPLOY_POLICY,
): DeployState {
  const { state: st } = readStateSafe(home);
  if (d.action !== "rollback" && d.action !== "halt") return st;

  st.failures[d.failed] = d.failures;
  st.failStreak = d.streak;
  if (d.frozen) st.freezeUntil = new Date(now.getTime() + policy.freezeMs).toISOString();
  st.lastAttempt = null; // 消费掉这次尝试，否则每个 tick 都重复计数

  if (d.action === "rollback") {
    st.prev = d.failed;
    st.active = d.to;
    st.applied = null;
    st.history.push({ at: now.toISOString(), from: d.failed, to: d.to, why: "auto-rollback" });
  }
  writeState(home, st);
  return st;
}

/** 单次巡检 = 判定 + 落盘 */
export function tick(
  home: string, now = new Date(), policy = DEFAULT_DEPLOY_POLICY, opts: { force?: boolean } = {},
): Decision {
  const d = evaluate(home, now, policy, opts);
  if (d.action === "rollback" || d.action === "halt") apply(home, d, now, policy);
  return d;
}

export function describe(d: Decision): string {
  switch (d.action) {
    case "idle": return `空闲（${d.reason}）`;
    case "ok": return `${d.id} 已上报健康`;
    case "wait": return `${d.id} 观察中，还剩 ${Math.ceil(d.msLeft / 1000)}s`;
    case "frozen": return `自我更新冻结至 ${d.until}`;
    case "rollback":
      return `回滚 ${d.failed} → ${d.to}（第 ${d.failures} 次失败，连续 ${d.streak} 次${d.frozen ? "，已冻结" : ""}）`;
    case "halt":
      return `停在 ${d.failed}（${d.reason}，连续 ${d.streak} 次${d.frozen ? "，已冻结" : ""}）`;
  }
}
