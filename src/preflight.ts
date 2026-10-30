/**
 * 本地端点前置检查（C-3）
 *
 * 为什么要统一：`/api/tags` 这件事之前被抄了三遍 —— `night` 的 `missingLocalModels()`、
 * `smoke-tools` 里的一段、`models` 命令的 `probeOllama()`。三份实现迟早会漂，
 * 而漂的方式很难发现（“某一处说没模型，另一处说没事”）。
 *
 * 三条纪律（借 OpenClaw 的 `skipped` 语义）：
 *  1. **不可达 ≠ 失败**。端点没起来是“这次跳过”，不是“模型不会干活”——
 *     所以调用方拿到的是 `{ online:false }`，不是异常。
 *  2. **按端点缓存 5 分钟**（不是按角色/模型）：一台机器只有一个 Ollama，
 *     一次探活就够；否则每个角色、每次对话都去敲一次端口。
 *  3. **并发去重**：同一时刻多个调用共享一个 promise，不打端口风暴。
 *
 * 注意：这里只探活 + 列模型，**不加载模型**（那是 `models doctor` 的事）。
 */
import { probeOllama } from "./ollama.ts";

export interface PreflightState {
  base: string;
  online: boolean;
  names: string[];
  error?: string;
  /** 这次结果的时间戳（ms） */
  at: number;
  /** 是不是命中缓存（测试/日志用） */
  cached: boolean;
}

export const PREFLIGHT_TTL_MS = 5 * 60 * 1000;

interface Entry { at: number; state: Omit<PreflightState, "cached"> }
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<PreflightState>>();

export interface PreflightOpts {
  /** 缓存有效期，默认 5 分钟 */
  ttlMs?: number;
  /** 忽略缓存强制重探 */
  force?: boolean;
  now?: () => number;
  /** 测试注入 */
  probe?: (base: string) => Promise<{ online: boolean; names: string[]; error?: string }>;
}

export async function preflight(base: string, o: PreflightOpts = {}): Promise<PreflightState> {
  const ttl = o.ttlMs ?? PREFLIGHT_TTL_MS;
  const now = o.now ?? Date.now;
  const key = base.replace(/\/+$/, "");

  if (!o.force) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return { ...hit.state, cached: true };
  }
  // 并发去重**与 force 无关**：force 只是“不信缓存”，不该变成“同时打两个请求”。
  const busy = inflight.get(key);
  if (busy) return busy;

  const probe = o.probe ?? ((b: string) => probeOllama(b));
  const p = (async (): Promise<PreflightState> => {
    const r = await probe(key);
    const state = { base: key, online: r.online, names: r.names, ...(r.error ? { error: r.error } : {}), at: now() };
    cache.set(key, { at: state.at, state });
    return { ...state, cached: false };
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

/** 只读缓存，不触发探测（`/health` 用：探针不该把探针拖慢） */
export function lastPreflight(base: string): PreflightState | null {
  const hit = cache.get(base.replace(/\/+$/, ""));
  return hit ? { ...hit.state, cached: true } : null;
}

/** 测试/搬家后清缓存 */
export function resetPreflight(base?: string): void {
  if (base) cache.delete(base.replace(/\/+$/, ""));
  else { cache.clear(); inflight.clear(); }
}

/** 端点在线时，这些模型名里谁没装（容忍 :latest 后缀） */
export function missingFrom(state: PreflightState, wanted: readonly string[]): string[] {
  if (!state.online) return [];
  const has = (m: string) => state.names.includes(m) || state.names.includes(m + ":latest");
  return [...new Set(wanted.filter(Boolean))].filter((m) => !has(m));
}

/** 给调用方一句人话：为什么这次要跳过 */
export function describeSkip(state: PreflightState, localRoles: Array<{ role: string; model: string }>): string | null {
  if (!state.online) return `本地端点不可达（${state.base}${state.error ? " · " + state.error : ""}）`;
  // 两件事要分开报：**没配**（该配没配）与**配了但没装**（要 pull）。
  // 以前只看 wanted.some(Boolean) —— 于是 embed 一配，聊天角色全空也会被判成“没事”。
  const unset = localRoles.filter((r) => !r.model).map((r) => r.role);
  const miss = missingFrom(state, localRoles.map((r) => r.model));
  const parts: string[] = [];
  if (unset.length) parts.push(`未配置本地模型（${unset.join("/")}）`);
  if (miss.length) parts.push(`本地模型未安装：${miss.join(", ")}`);
  return parts.length ? parts.join("；") : null;
}
