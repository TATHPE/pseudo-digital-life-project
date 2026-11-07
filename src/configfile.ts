/**
 * 可持久化的配置（13 §2）：env > data/config.json > 默认值
 * 面板里改 API 走这里；key 不进这个文件（走 auth.ts 的 DPAPI）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import { applyEnv, baseConfig, type AppConfig } from "./config.ts";

export interface FileConfig {
  ollama?: string;
  express?: { provider?: string; model?: string; baseUrl?: string };
  plan?: { provider?: string; model?: string };
  budget?: { dailyUsd?: number };
  /**
   * 本地模型（C-4）：沿用「共享默认 + 单个例外」这个已存在的语义，
   * 不摊成 5 个格子 —— 5 个角色 × N 个模型的下拉框没人会去调。
   *   default → route / extract / salience / conflict（night 也跟着它，除非单设）
   *   night   → 自传/反思（建议比 default 大一档）
   *   embed   → 向量模型（换它必须重建索引，见 docs/ops/22 C-2）
   */
  local?: { default?: string; night?: string; embed?: string };
  /**
   * 衰减参数覆盖（E-4）。**必须在这里声明并合并** —— 以前 writeFileConfig 只合并
   * express/plan/budget/persona/local/ui，别的字段靠 `...patch` 整体替换；
   * 于是"先写参数、再 bump 版本号"的第二步会把参数整块抹掉（实测踩到）。
   */
  decay?: {
    version?: number;
    kinds?: Record<string, Record<string, number>>;
    globals?: Record<string, number>;
  };
  persona?: { name?: string };
  /** 外观偏好（头像框）——与模型配置分开放，清理接口配置时不会被意外抹掉 */
  ui?: {
    /** 头像框（已删，保留字段兼容旧配置） */
    avatar?: string;
    /**
     * 开机片头档位（照 dsh-550c-boot 的 off / simple / full）：
     *   off    不播
     *   simple 约 3.4s：logo 描边 → 填充 → 呼吸 → 项目名
     *   full   约 9s：多一层网格擦出 + 逐条真实读数 + READY
     * 默认 full —— 用户 2026-11-02 明确要完整档。
     */
    splash?: string;
    /** 主题：ledger（记录本，默认）/ hermes（Hermes 版式） */
    theme?: string;
  };
  /**
   * 她叫什么（2026-11-01）：**"鲸鲸" 只是预置人格的名字，不是项目名**。
   * 用户第一次就该能自己取；这里存下来，面板/引导页/窗口标题都读它。
   */
  agent?: { name?: string };
  /**
   * 工作模式还是聊天模式（2026-11-03 用户要求）。
   *
   * chat（默认）：靠「记忆 + 召回」代替历史，简报固定 2000 token —— 日常闲聊、一百轮也不爆预算。
   * work：带最近 8 轮真实对话历史、预算放宽到 5000、工具步数 6→16、单轮输出 3000→6000。
   * 为什么必须分开：「不随轮数增长」在闲聊里成立，在连续干活时是错的 ——
   * 你连着问三件有依赖的事时，聊天模式会断片（实测她说「我看不到你的界面」）。
   */
  /** chat / work / auto（auto：按每句话自己判，2026-11-07） */
  mode?: "chat" | "work" | "auto";
  /**
   * 宿主层：跑脚本文件时用哪个解释器（2026-11-01 用户要求：PowerShell 默认，Git Bash 自配）。
   * 只影响「跑 home 里的脚本文件」，**不影响**任意命令的 argv 直传（见 src/host.ts 的头注释）。
   */
  host?: {
    /** auto | powershell | pwsh | gitbash | bash */
    shell?: string;
    /** Git Bash 的 bash.exe 绝对路径（安装位置五花八门，探测不到就让用户填） */
    gitbashPath?: string;
  };
}

/**
 * 预置人格的名字。**这不是项目名** —— 项目叫 Pseudo Digital Life Project（见 tauri.conf 的 productName）。
 * 用户第一次进来就该能改：这里只是"没人取名时"的默认值。
 */
export const PRESET_AGENT_NAME = "鲸鲸";
export const MAX_AGENT_NAME = 16;

/** 名字只能是可打印字符、≤16 字、不含控制字符；空 = 用预置名 */
export function normalizeAgentName(x: unknown): string {
  const s = String(x ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!s) return PRESET_AGENT_NAME;
  return s.slice(0, MAX_AGENT_NAME);
}

let cache: { at: number; cfg: FileConfig } | null = null;

export function readFileConfig(home: string): FileConfig {
  const f = join(home, "config.json");
  if (!existsSync(f)) return {};
  const at = statSync(f).mtimeMs;
  if (cache && cache.at === at) return cache.cfg;
  try {
    const cfg = JSON.parse(readFileSync(f, "utf8")) as FileConfig;
    cache = { at, cfg };
    return cfg;
  } catch { return {}; }
}

export function writeFileConfig(home: string, patch: FileConfig): FileConfig {
  const cur = readFileConfig(home);
  const next: FileConfig = {
    ...cur, ...patch,
    express: { ...(cur.express ?? {}), ...(patch.express ?? {}) },
    plan: { ...(cur.plan ?? {}), ...(patch.plan ?? {}) },
    local: { ...(cur.local ?? {}), ...(patch.local ?? {}) },
    decay: {
      ...(cur.decay ?? {}), ...(patch.decay ?? {}),
      kinds: { ...(cur.decay?.kinds ?? {}), ...(patch.decay?.kinds ?? {}) },
      globals: { ...(cur.decay?.globals ?? {}), ...(patch.decay?.globals ?? {}) },
    },
    budget: { ...(cur.budget ?? {}), ...(patch.budget ?? {}) },
    persona: { ...(cur.persona ?? {}), ...(patch.persona ?? {}) },
    ui: { ...(cur.ui ?? {}), ...(patch.ui ?? {}) },
    agent: { ...(cur.agent ?? {}), ...(patch.agent ?? {}) },
    host: { ...(cur.host ?? {}), ...(patch.host ?? {}) },
  };
  atomicWriteFile(join(home, "config.json"), JSON.stringify(next, null, 2) + "\n");
  cache = null;
  return next;
}

/**
 * 合并优先级（**这是硬规矩**）：env > data/config.json > 内置默认值。
 *
 * 以前是“defaultConfig(env) 之后再把文件叠上去”，结果文件盖过了 env，
 * 和注释写的优先级正好相反；而且本地角色根本不在文件里，所以既管不了也切不了。
 */
export function resolveConfig(home: string, env: Record<string, string | undefined> = process.env): AppConfig {
  const f = readFileConfig(home);
  const roles = { ...baseConfig().roles };

  const ex = f.express ?? {};
  if (ex.provider || ex.model || ex.baseUrl) {
    roles["express"] = {
      ...roles["express"]!,
      ...(ex.provider ? { provider: ex.provider } : {}),
      ...(ex.model ? { model: ex.model } : {}),
      ...(ex.baseUrl ? { baseUrl: ex.baseUrl } : {}),
    };
  }
  const pl = f.plan ?? {};
  if (pl.provider || pl.model) {
    roles["plan"] = {
      ...roles["plan"]!,
      ...(pl.provider ? { provider: pl.provider } : {}),
      ...(pl.model ? { model: pl.model } : {}),
    };
  }

  // 本地模型：default 覆盖 4 个记忆角色；night 缺省跟随 default（与 env 语义一致）
  const lo = f.local ?? {};
  const small = lo.default;
  for (const r of ["route", "extract", "salience", "conflict"]) {
    if (small) roles[r] = { ...roles[r]!, model: small };
  }
  const night = lo.night ?? small;
  if (night) roles["night"] = { ...roles["night"]!, model: night };
  if (lo.embed) roles["embed"] = { ...roles["embed"]!, model: lo.embed };

  const out: AppConfig = { ollama: f.ollama ?? "http://127.0.0.1:11434", roles, ...(f.mode === "work" ? { mode: "work" as const } : { mode: "chat" as const }) };
  // 最后并 env —— 它永远赢
  return applyEnv(out, env);
}

/** 每个本地/云端角色的“这个值从哪来”，给 `jingjing config` 和面板用 */
export type Source = "env" | "file" | "default";
export function configSources(home: string, env: Record<string, string | undefined> = process.env): Record<string, Source> {
  const f = readFileConfig(home);
  const lo = f.local ?? {};
  const out: Record<string, Source> = {};
  for (const r of ["route", "extract", "salience", "conflict"]) {
    out[r] = env.JJ_MODEL_DEFAULT ? "env" : lo.default ? "file" : "default";
  }
  out["night"] = env.JJ_MODEL_NIGHT || env.JJ_MODEL_DEFAULT ? "env" : lo.night || lo.default ? "file" : "default";
  out["embed"] = env.JJ_MODEL_EMBED ? "env" : lo.embed ? "file" : "default";
  out["express"] = env.JJ_MODEL_EXPRESS || env.JJ_PROVIDER_EXPRESS || env.JJ_BASE_EXPRESS ? "env" : f.express?.model ? "file" : "default";
  out["plan"] = env.JJ_MODEL_PLAN ? "env" : f.plan?.model ? "file" : "default";
  return out;
}
