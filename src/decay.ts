/**
 * 记忆动力学（01 §4/§5）——全项目唯一"写完之后不用改"的模块。
 *
 * 公式（拉伸指数 / Weibull）：
 *   w(t) = clamp(floor, 1, (floor + (1-floor)·w0·exp(-λeff·d^β)) · accessBoost)
 *   λ    = ln2 / t½^β          （由半衰期与 β 反算，人只调半衰期）
 *   λeff = λ / (1 + 0.2·n)     （常想起的忘得更慢；01 §4.1）
 *   accessBoost = min(1.6, 1 + 0.15·ln(1+n))
 *
 * 注意：01 §4.2 里另写了「λ ×0.97/次」，与 λeff 是同一效应的两种写法，**不叠加**。
 */

export type Stage = "active" | "fading" | "dormant";
export type Layer = "narrative" | "contract";

export interface DecayParams {
  halfLifeDays: number;  // Infinity = 不衰减（契约层）
  beta: number;          // <1 前陡后长尾
  floor: number;         // 地板
}

/** 01 §12 参数表的代码版；改这里 = 改行为，必须同步 decay_params_version */
export const KIND_PARAMS: Record<string, DecayParams> = {
  episode:         { halfLifeDays: 30,   beta: 0.85, floor: 0.05 },
  emotion:         { halfLifeDays: 20,   beta: 0.85, floor: 0.05 },
  thought:         { halfLifeDays: 50,   beta: 0.85, floor: 0.05 },
  preference_soft: { halfLifeDays: 70,   beta: 0.90, floor: 0.15 },
  preference_hard: { halfLifeDays: 120,  beta: 0.95, floor: 0.25 },
  fact:            { halfLifeDays: 180,  beta: 0.95, floor: 0.30 },
  fact_hard:       { halfLifeDays: 180,  beta: 0.95, floor: 0.30 },
  gist:            { halfLifeDays: 90,   beta: 0.90, floor: 0.10 },
  anchor:          { halfLifeDays: 300,  beta: 1.00, floor: 0.35 },
  promise:         { halfLifeDays: 365,  beta: 1.00, floor: 0.40 },
  boundary:        { halfLifeDays: 365,  beta: 1.00, floor: 0.40 },
  contract:        { halfLifeDays: Infinity, beta: 1, floor: 1 },
};

/**
 * nightly 抽取**能产出**的 kind（E-1）。
 *
 * 为什么单列一份：之前 prompt 里写的是 episode|preference_hard|fact_hard|promise|boundary|thought，
 * 而参数表里只有 episode / thought 命中 —— 另外 4 种全静默回落到 episode（30 天），
 * 而 preference_soft / gist / anchor 三档（70/90/300 天）没有任何写入方会产生。
 * 现在两边共用这一份，并有测试盯着 NIGHTLY_KINDS ⊆ KIND_PARAMS。
 */
export const NIGHTLY_KINDS = ["episode", "preference_hard", "fact_hard", "promise", "boundary", "thought"] as const;

/** 未知 kind 会不会被回落（可观测：store 写入时会记一条事件） */
export function isKnownKind(kind: string): boolean {
  return Object.hasOwn(KIND_PARAMS, kind);
}

export const DECAY_PARAMS_VERSION = 1;

/** 唯一入口：未知 kind 回落到 episode，不用 `!` 也不用 ?? 撒满地 */
export function paramsFor(kind: string): DecayParams {
  return KIND_PARAMS[kind] ?? KIND_PARAMS["episode"]!;
}

/** 双阈值滞后带（01 §5）：进出用不同的门，中间带不转移 */
export const T = {
  activeIn: 0.55, activeOut: 0.35,
  fadingIn: 0.25, fadingOut: 0.15,
} as const;

export const RECONSOLIDATION = { gamma: 0.08 } as const;
export const ACCESS = { alpha: 0.15, cap: 1.6 } as const;

export interface MemoryDynamics {
  id: string;
  layer: Layer;
  kind: string;
  w0: number;
  recallCount: number;
  lastDecayAt: Date;
  stage: Stage;
  /** 来源可信度（D-1）：external 不因“被召回”而变重 */
  taint?: "trusted" | "external";
}

const DAY = 86_400_000;
export const days = (ms: number) => ms / DAY;

export function lambdaFrom(params: DecayParams): number {
  if (!Number.isFinite(params.halfLifeDays)) return 0;
  return Math.LN2 / Math.pow(params.halfLifeDays, params.beta);
}

export function accessBoost(n: number): number {
  return Math.min(ACCESS.cap, 1 + ACCESS.alpha * Math.log1p(n));
}

/** 核心：给定一条记忆与"现在"，算权重 */
export function weight(m: Pick<MemoryDynamics, "layer" | "kind" | "w0" | "recallCount" | "lastDecayAt">, now: Date, kindOverride?: string): number {
  const params = paramsFor(kindOverride ?? m.kind);
  // 契约层：短路，绝不进公式（避免浮点误差让它慢慢掉到 0.9999）
  if (m.layer === "contract" || !Number.isFinite(params.halfLifeDays)) return 1;
  const lambda = lambdaFrom(params);
  const lambdaEff = lambda / (1 + 0.2 * m.recallCount);
  const d = Math.max(0, days(now.getTime() - m.lastDecayAt.getTime()));
  const base = params.floor + (1 - params.floor) * m.w0 * Math.exp(-lambdaEff * Math.pow(d, params.beta));
  return clamp(params.floor, 1, base * accessBoost(m.recallCount));
}

export function clamp(lo: number, hi: number, x: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** 带滞后的阶段判定：0.35–0.55 与 0.15–0.25 之间保持原阶段，防夜间震荡 */
export function classify(w: number, prev: Stage, layer: Layer = "narrative"): Stage {
  if (layer === "contract") return "active";
  switch (prev) {
    case "active":
      if (w >= T.activeOut) return "active";
      return w < T.fadingOut ? "dormant" : "fading";
    case "fading":
      if (w >= T.activeIn) return "active";
      return w < T.fadingOut ? "dormant" : "fading";
    case "dormant":
      if (w >= T.activeIn) return "active";
      if (w >= T.fadingIn) return "fading";
      return "dormant";
  }
}

/** 再巩固（01 §4.2）：只有“真的被注入上下文”才调用它 */
export function reconsolidate(m: MemoryDynamics, now: Date): MemoryDynamics {
  // D-1 晋升侧：不可信来源不因“被召回”而变重。
  // 这两行就是 OpenClaw 那句 “no amount of recall frequency promotes untrusted content” 的落地：
  // 不动 w0、不动 recall_count、**也不动锚点**（动锚点会因 d 归零而变相提高权重）。
  if ((m.taint ?? "trusted") !== "trusted") {
    return { ...m, stage: classify(weight(m, now), m.stage, m.layer) };
  }
  const w0 = Math.min(1, m.w0 + RECONSOLIDATION.gamma * (1 - m.w0));
  return { ...m, w0, recallCount: m.recallCount + 1, lastDecayAt: now, stage: classify(weight({ ...m, w0, recallCount: m.recallCount + 1, lastDecayAt: now }, now), m.stage, m.layer) };
}

/**
 * ⚠️ 关键语义：`lastDecayAt` 是**锚点**，不是"上次 tick 的时间"。
 *
 * w = f(w0, now − 锚点, n)。所以：
 *   · 普通 tick **绝不能** 更新锚点——否则下次会用"小 d"重算出高权重（记忆复活）
 *   · 只有"再巩固"（召回）与"参数变更 rebase"才可以移动锚点，且必须同时改 w0
 *   · 断电补算因此不需要循环：锚点没动，公式一跳就到位（β≠1 也一样）
 */

/** 把当前权重压回 w0 并移动锚点——只在参数变更/手动重建时用 */
export function rebase(m: MemoryDynamics, now: Date): { w0: number; weight: number; stage: Stage } {
  if (m.layer === "contract") return { w0: 1, weight: 1, stage: "active" };
  const p = paramsFor(m.kind);
  const w = weight(m, now);
  const b = accessBoost(m.recallCount);
  // 注意公式形状：w = (floor + (1-floor)·w0·g) · b —— boost 乘的是**整个括号**（01 §4.1）
  const w0 = clamp(0, 1, (w / b - p.floor) / (1 - p.floor));
  return { w0: Math.round(w0 * 1e6) / 1e6, weight: round3(w), stage: classify(w, m.stage, m.layer) };
}

/** 记账用：一次 tick 里批量重算（夜间 + 断电补算走同一条路径；**不动锚点**） */
export function recompute(m: MemoryDynamics, now: Date): { weight: number; stage: Stage } {
  if (m.layer === "contract") return { weight: 1, stage: "active" };
  const w = weight(m, now);
  return { weight: round3(w), stage: classify(w, m.stage, m.layer) };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

// ── flashback（01 §6.1）：强线索唤醒，仅本轮有效，每轮 ≤2 条 ────────
export interface FlashCue {
  entities?: string[];     // 查询里出现的专名
  anniversary?: boolean;   // 今天/附近是记忆里提到的日期
  emotionMatch?: number;   // 0..1
  date?: Date;             // 今天
}

export function isFlashback(
  m: { stage: Stage; text: string },
  cue: FlashCue,
): boolean {
  if (m.stage !== "dormant") return false;
  const hitEntity = (cue.entities ?? []).some((e) => e.length >= 2 && m.text.includes(e));
  const hitEmotion = (cue.emotionMatch ?? 0) >= 0.75;
  return hitEntity || Boolean(cue.anniversary) || hitEmotion;
}

export const FLASHBACK = { cap: 2, reviveTo: 0.5 } as const;
