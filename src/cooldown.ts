/**
 * 云端失败冷却（D-2）
 *
 * 现在的行为：一个坏 key / 一次 429，每条消息都去打一次网络，每次都失败。
 * 用户看到的是「一直在转圈然后出错」，而账单和延迟都在烧。
 *
 * 三条判断（借 OpenClaw 的一半，不借它整套 profile/order 状态机）：
 *  1. **只冷却"确定是它坏了"的错**：401/403（凭据无效）/429（限流）/5xx。
 *     网络超时、DNS 失败这类"可能是本机网络"的，不冷却（否则断网一次要等 5 分钟）。
 *  2. **连续 3 次才冷却 5 分钟**：单次抖动不该停服务。
 *  3. **冷却期间明确说"在冷却"**，不是静默失败，也不是假装在重试。
 *
 * 状态在内存里（进程内），重启即清 —— 它对"这一轮会话"有效，不跨进程持久化：
 * 把冷却写进库会让"换了个好 key 却还要等 5 分钟"变得更难解释。
 */
export type FailureKind = "auth" | "rate" | "server" | "network" | "other";

export interface CooldownState {
  kind: FailureKind;
  fails: number;
  until: number | null;
  lastAt: number;
  lastDetail: string;
}

export const COOLDOWN = { threshold: 3, ms: 5 * 60 * 1000 } as const;

const table = new Map<string, CooldownState>();

/** 从错误信息里判"这是哪一类失败" */
export function classifyFailure(message: string): FailureKind {
  const m = String(message ?? "");
  const code = Number((m.match(/E_PROVIDER:\s*(\d{3})/) ?? [])[1] ?? 0);
  if (code === 401 || code === 403) return "auth";
  if (code === 429) return "rate";
  if (code >= 500 && code < 600) return "server";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|aborted/i.test(m)) return "network";
  return "other";
}

/** 这些类的失败才累计到冷却里 */
export function isCooldownWorthy(kind: FailureKind): boolean {
  return kind === "auth" || kind === "rate" || kind === "server";
}

export interface GateResult {
  blocked: boolean;
  /** 冷却中时给用户看的一句话 */
  reason?: string;
  remainingMs?: number;
}

/** 调用前查一次：这个 provider 正在冷却吗 */
export function gate(provider: string, now = Date.now()): GateResult {
  const st = table.get(provider);
  if (!st?.until || st.until <= now) return { blocked: false };
  return {
    blocked: true,
    remainingMs: st.until - now,
    reason: `${provider} 已暂停 ${Math.ceil((st.until - now) / 60000)} 分钟（连续 ${st.fails} 次 ${
      st.kind === "auth" ? "凭据无效" : st.kind === "rate" ? "限流" : "服务端错误"
    }）`,
  };
}

export interface RecordResult extends GateResult {
  fails: number;
  kind: FailureKind;
  /** 这一次是否刚刚进入冷却 */
  justCooled?: boolean;
}

/** 记录一次失败；达到阈值就进入冷却 */
export function recordFailure(provider: string, message: string, now = Date.now()): RecordResult {
  const kind = classifyFailure(message);
  if (!isCooldownWorthy(kind)) {
    // 网络类不累计：它多半是本机的问题，冷却反而把"网络回来了"也一起拖住
    return { blocked: false, fails: table.get(provider)?.fails ?? 0, kind };
  }
  const prev = table.get(provider);
  const fails = (prev?.fails ?? 0) + 1;
  const until = fails >= COOLDOWN.threshold ? now + COOLDOWN.ms : null;
  const st: CooldownState = { kind, fails, until, lastAt: now, lastDetail: String(message).slice(0, 160) };
  table.set(provider, st);
  return {
    blocked: Boolean(until),
    fails, kind,
    ...(until ? { justCooled: true, remainingMs: until - now, reason: gate(provider, now).reason } : {}),
  };
}

/** 成功一次：清空计数（成功的定义是"拿到完整响应"，不是"连上了"） */
export function recordSuccess(provider: string): void {
  table.delete(provider);
}

export function stateOf(provider: string): CooldownState | undefined {
  return table.get(provider);
}

/** 测试/换 key 后手动解除 */
export function reset(provider?: string): void {
  if (provider) table.delete(provider); else table.clear();
}
