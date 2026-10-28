export type Tier = "T0" | "T1" | "T2" | "T3" | "T4";
export type Stage = "active" | "fading" | "dormant";
export type Layer = "narrative" | "contract";

export interface MemoryLine {
  id: string;
  layer: Layer;
  kind: string;
  stage: Stage;
  weight: number;      // 0..1，由 decay.ts 算出（01 §4）
  text: string;
  sensitivity?: "local_only" | "shareable";
}

/** 断电/停机类型（18 §2.1） */
export type OutageKind = "power" | "crash" | "restart";

export interface Outage {
  from: Date;
  to: Date;
  kind: OutageKind;
}

export interface SelfState {
  energy: number;       // 0..1
  closeness: number;    // 0..1
  mood?: string;        // 一句话，不显示数字
}

export interface PersonaFiles {
  core: string;         // P1
  boundaries: string;   // P2
  evidenceOrder: string;// P3
  toolSchemas: string;  // P4a 常驻 4 个的紧凑 schema
  toolDirectory: string;// P4b 目录（只有名字+一行）
}

export interface BriefInput {
  now: Date;
  lastSeenAt?: Date | null;
  outage?: Outage | null;
  persona: PersonaFiles;
  contracts: string[];       // P6 契约层，≤15 条
  state?: SelfState | null;  // P7
  threads?: string[];        // P8 线头，≤3 条
  lastName?: string | null;  // P8 上次到哪了
  delta?: string | null;     // P9 这次变了什么
  recalled: MemoryLine[];    // P10 ≤8 条
  user: string;              // P11
  budget?: Partial<BriefBudget>;
}

export interface BriefBudget {
  total: number;      // 默认 2000（17 §2）
  contracts: number;  // 默认 400
  recalled: number;   // 默认 600
  prefix: number;     // 默认 1400（稳定区上限）
}

export interface BriefSlot {
  id: string;
  label: string;
  tokens: number;
  stable: boolean;   // true = 属于稳定前缀（逐字不变、可缓存）
}

export interface BriefOutput {
  text: string;
  tokens: number;
  prefixHash: string;
  slots: BriefSlot[];
  dropped: { recalled: number; contracts: number; threads: number };
  confidence: "answer" | "clarify" | "abstain" | "need_evidence";
}
