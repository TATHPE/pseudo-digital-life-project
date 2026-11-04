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
  /** 来自记忆还是文档块（P10 里两种来源要能区分：一个是我认定的，一个是书上写的） */
  source?: "memory" | "doc";
  /** 文档块专用：章节路径（已去掉与标题重复的首段） */
  headingPath?: string;
  /** 原话（J-2）：写入时从 journal 取的原句 */
  quote?: string | null;
  /**
   * 侵蚀阶段（0 完整 / 1 丢细节 / 2 只剩影子）。
   * **展示时**按它渲染模糊版；库里存的仍是原文（正文只有人能改）。
   */
  eraseStage?: number;
  /** 沿一根线过来的（J-1）：来自哪条、为什么连 */
  viaLink?: { from: number; why: string };
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
  /** H-a：她自己惦记的事（每句带出处，≤2 条） */
  agenda?: string[];
  /** H-b：她对人的理解（每句带依据 id，≤2 条） */
  interpretations?: string[];
  /**
   * 我现在的权限（P15）：preset + super + 一句话"能做什么"。
   * 不加这个，她不知道自己能不能跑命令 —— 于是遇到能做的事也会说"我不能"。
   */
  powers?: string | null;
  /**
   * 我这一轮能看到多少（P16，2026-11-03）。
   *
   * 起因：用户连问两次「你能读多少记忆」，她两次都没直接答，而是去 fs_list 查磁盘、
   * node -e 查库 —— 因为**她的简报里从来没写过自己的容量**。第二次还编出「已按你的确认执行」。
   * 这是「答不出自己的事，只能去查」，不是态度问题：数字就在配置里，就该让她看见。
   */
  /**
   * 插件现状（2026-11-03）。
   *
   * 学自 Coopanion 的 onWorldLifecycle：它把「某个 World 起不来 / 挂了 / 被藏起来」
   * 直接注入给模型（"failed to start and is not running this time"）。
   * 我们之前：MCP 连不上 → 面板标红 → **她完全不知道**，照样以为自己有那个工具。
   */
  plugins?: {
    /** 在跑的 server 名 */
    running: string[];
    /** 连不上的（带原因） */
    errors: string[];
    /** 磁盘上的 mcp.json 改了但还没重启 */
    pending: boolean;
  };

  /**
   * 工作模式还是聊天模式（2026-11-03）。
   *  work 会把最近几轮真实对话装进 P18，并把预算放宽；chat 靠记忆召回，不带历史。
   */
  mode?: "chat" | "work";
  /** 最近几轮对话（work 模式才有）：按时间正序，最后一条是最近的一轮 */
  history?: Array<{ role: "user" | "agent"; text: string }>;

  /**
   * 我还不知道的一件事（P19，2026-11-04）。
   *
   * 记忆缺口卡只在人逛到记忆屏时才有用。这条让缺口在她**自己开口**时出现：
   * 有未答的题 + 距上次问超过 24 小时，才塞一句问法进来。
   * 措辞里写死「没聊到别硬问」—— 否则她会每轮都查户口。
   */
  gapAsk?: string | null;

  capacity?: {
    memories: number;
    docs?: number;
    chunks?: number;
    recallMax?: number;
    recallBudget?: number;
    searchMax?: number;
  };
  /** 技能索引（P14）：只有名字 + 一句描述，正文要模型自己 skill.read 取 */
  skills?: string | null;
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
