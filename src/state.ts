/**
 * 自我状态（01 §8）：慢变量，不是每次对话随机生成的情绪标签。
 * 规则很笨，但可解释、可回放、可测——这是它存在的意义。
 */
import type { DatabaseSync } from "node:sqlite";

export interface SelfState {
  energy: number;     // 0..1
  closeness: number;  // 0..1
  mood?: string | null;
  attention?: string | null;
}

export const DEFAULTS: SelfState = { energy: 0.7, closeness: 0.3, mood: null, attention: null };

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const RULES = {
  closenessPerTurn: 0.005,
  closenessSilencePerDay: 0.01,
  energyPerTurn: 0.02,
  energyPerNight: 0.25,
  maxTurnDelta: 0.02,   // 单次交互内 closeness 变化上限（防跳变）
} as const;

export interface StepInput {
  turns?: number;      // 本次交互轮数
  silenceDays?: number;// 距上次对话多少天
  night?: boolean;     // 夜间整备
  mood?: string | null;
  attention?: string | null;
}

/** 纯函数：给前一状态与事件，算新状态（不含 IO，便于单测） */
export function step(prev: SelfState, input: StepInput): SelfState {
  let closeness = prev.closeness;
  let energy = prev.energy;

  if (input.night) {
    energy = clamp01(energy + RULES.energyPerNight);
    closeness = clamp01(closeness - RULES.closenessSilencePerDay * Math.max(0, input.silenceDays ?? 1));
  } else {
    const turns = Math.max(0, input.turns ?? 1);
    const dClose = Math.min(RULES.maxTurnDelta, RULES.closenessPerTurn * turns);
    closeness = clamp01(closeness + dClose - RULES.closenessSilencePerDay * Math.max(0, input.silenceDays ?? 0));
    energy = clamp01(energy - RULES.energyPerTurn * turns);
  }
  return {
    energy: r3(energy), closeness: r3(closeness),
    mood: input.mood !== undefined ? input.mood : (prev.mood ?? null),
    attention: input.attention !== undefined ? input.attention : (prev.attention ?? null),
  };
}

export function loadState(db: DatabaseSync): SelfState {
  const row = db.prepare("SELECT energy,closeness,mood,attention FROM self_state ORDER BY id DESC LIMIT 1")
    .get() as { energy: number; closeness: number; mood: string | null; attention: string | null } | undefined;
  return row ? { energy: row.energy, closeness: row.closeness, mood: row.mood, attention: row.attention } : { ...DEFAULTS };
}

export function saveState(db: DatabaseSync, s: SelfState, ts = new Date().toISOString(), source = "step"): void {
  db.prepare("INSERT INTO self_state(ts,energy,closeness,mood,attention,note,source) VALUES(?,?,?,?,?,?,?)")
    .run(ts, r3(s.energy), r3(s.closeness), s.mood ?? null, s.attention ?? null, null, source);
}

/**
 * 追加式状态快照（2026-11-14，学自 dsh-world 的 mood 快照）。
 *
 * `self_state` 表本来就是 append-only，但 `advance()` 以前**每轮都写一行**，状态没变也写，
 * 历史里全是重复的当前值；简报也只给「现在是多少」，没有「以最新一条为准」这句话。
 * 这里补两条，都不碰 P1–P4 稳定前缀：
 *   ① 只有状态真的变了才落库 —— 历史里每一行都是一次变化，而不是一次轮询
 *   ② 变化时产出一条可追加进 P7 的文本，明确上一条不再算数（只追加、不替换）
 */
export interface StateSnapshot {
  /** 追加到 P7 第二行的文本；null 时 P7 保持原样 */
  text: string;
  /** 逐字段的变化描述，顺序固定，便于测试与排障 */
  changes: string[];
}

const normalized = (s: SelfState) => ({
  energy: r3(s.energy), closeness: r3(s.closeness),
  mood: s.mood ?? null, attention: s.attention ?? null,
});

/** 纯函数：没变化返回 null（调用方据此跳过写库与追加行）。 */
export function stateSnapshot(prev: SelfState, next: SelfState): StateSnapshot | null {
  const a = normalized(prev), b = normalized(next);
  const changes: string[] = [];
  if (a.closeness !== b.closeness) changes.push(`closeness ${a.closeness.toFixed(3)} → ${b.closeness.toFixed(3)}`);
  if (a.energy !== b.energy) changes.push(`energy ${a.energy.toFixed(3)} → ${b.energy.toFixed(3)}`);
  if (a.mood !== b.mood) changes.push(`心情 ${a.mood ?? "（空）"} → ${b.mood ?? "（空）"}`);
  if (a.attention !== b.attention) changes.push(`在意 ${a.attention ?? "（空）"} → ${b.attention ?? "（空）"}`);
  if (!changes.length) return null;
  return { text: `【状态变化】${changes.join("；")}（以最新一条为准，之前那条不再算数）`, changes };
}

/** 更新一步并落库（服务端每轮调用）；状态没变就不写新行 */
export function advance(db: DatabaseSync, input: StepInput, now = new Date()): SelfState {
  return advanceWithSnapshot(db, input, now).state;
}

/** 同上，但把「这一轮状态真的变了吗」一起交回，供简报追加快照行。 */
export function advanceWithSnapshot(db: DatabaseSync, input: StepInput, now = new Date()): { state: SelfState; snapshot: StateSnapshot | null } {
  const prev = loadState(db);
  const next = step(prev, input);
  const snapshot = stateSnapshot(prev, next);
  if (snapshot) saveState(db, next, now.toISOString(), input.night ? "night" : "turn");
  return { state: next, snapshot };
}

/** 给界面的一句话（不显示数字，显示语气） */
export function describe(s: SelfState): string {
  const e = s.energy < 0.3 ? "有点累" : s.energy > 0.75 ? "精神还行" : "一般";
  const c = s.closeness < 0.2 ? "还不太熟" : s.closeness < 0.5 ? "在熟悉" : s.closeness < 0.8 ? "挺熟" : "很熟";
  const mood = s.mood ? "，" + s.mood : "";
  return `今天${e}，${c}${mood}`;
}
