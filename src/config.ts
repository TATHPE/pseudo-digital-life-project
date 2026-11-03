/**
 * 角色配置（13 §2）
 * 环境变量覆盖：JJ_OLLAMA、JJ_MODEL_DEFAULT、JJ_MODEL_EXPRESS、JJ_PROVIDER_EXPRESS
 */
import type { RoleConfig } from "./provider.ts";

export interface AppConfig {
  roles: Record<string, RoleConfig>;
  ollama: string;
  /** chat = 靠记忆召回（默认）；work = 带最近几轮历史 + 更宽的预算 */
  mode?: "chat" | "work";
}

/** 纯默认（不读任何环境变量）：本地模型名一律为空，缺就是缺（C-5） */
export function baseConfig(env: Record<string, string | undefined> = {}): AppConfig {
  void env;
  const ollama = "http://127.0.0.1:11434";
  const local = (model: string): RoleConfig => ({ kind: "local", provider: "ollama", model, baseUrl: ollama });
  return {
    ollama,
    roles: {
      embed:    local("bge-m3"),
      route:    local(""),
      extract:  local(""),
      salience: local(""),
      conflict: local(""),
      night:    local(""),
      // 官方 /models 现在只列 deepseek-flash（V4.1-Flash）与 deepseek-v4-pro；
      // deepseek-chat / deepseek-reasoner 仍作为**别名**可用，但新装默认走 flash。
      express: {
        kind: "cloud",
        provider: "deepseek",
        model: "deepseek-flash",
        maxTokens: 1024,
      },
      plan: {
        kind: "cloud",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        maxTokens: 2048,
      },
    },
  };
}

/**
 * 环境变量叠加（**永远最后一个应用**：env > config.json > 默认值）。
 *
 * 以前 defaultConfig 把 env 和默认值混在一起，而 resolveConfig 又把文件叠在它**后面**，
 * 于是 config.json 反而盖过了 env —— 和注释里写的优先级相反。
 */
export function applyEnv(base: AppConfig, env: Record<string, string | undefined> = process.env): AppConfig {
  const roles: Record<string, RoleConfig> = { ...base.roles };
  const ollama = env.JJ_OLLAMA ?? base.ollama;

  const setLocal = (role: string, model: string | undefined) => {
    if (!model) return;
    roles[role] = { ...roles[role]!, kind: "local", provider: "ollama", model, baseUrl: ollama };
  };
  // 共用变量：JJ_MODEL_DEFAULT 管 4 个记忆角色
  const small = env.JJ_MODEL_DEFAULT;
  for (const r of ["route", "extract", "salience", "conflict"]) setLocal(r, small);
  // night 不单独设时跟随 default
  setLocal("night", env.JJ_MODEL_NIGHT ?? small);
  setLocal("embed", env.JJ_MODEL_EMBED);

  // ollama 地址变了，所有本地角色的 baseUrl 要跟着走
  for (const [r, c] of Object.entries(roles)) {
    if (c.kind === "local" && c.provider === "ollama") roles[r] = { ...c, baseUrl: ollama };
  }
  if (env.JJ_PROVIDER_EXPRESS || env.JJ_MODEL_EXPRESS || env.JJ_BASE_EXPRESS) {
    const ex = roles["express"]!;
    roles["express"] = {
      ...ex,
      ...(env.JJ_PROVIDER_EXPRESS ? { provider: env.JJ_PROVIDER_EXPRESS as RoleConfig["provider"] } : {}),
      ...(env.JJ_MODEL_EXPRESS ? { model: env.JJ_MODEL_EXPRESS } : {}),
      ...(env.JJ_BASE_EXPRESS ? { baseUrl: env.JJ_BASE_EXPRESS } : {}),
    };
  }
  if (env.JJ_MODEL_PLAN) {
    roles["plan"] = { ...roles["plan"]!, model: env.JJ_MODEL_PLAN };
  }
  return { ...base, ollama, roles };
}

/**
 * `provider:model` 这个键散落在 6 处手拼（embed 指纹、索引身份、预算表…）。
 * 手拼的地方越多，改一处忘一处就越容易（"哪个 fingerprint 到底指哪个模型"）。
 */
export function modelKeyOf(c: { provider?: string; model?: string } | undefined | null): string | null {
  if (!c || !c.model) return null;
  return `${c.provider ?? "ollama"}:${c.model}`;
}

/** 兼容入口：默认值 + 环境变量 */
export function defaultConfig(env = process.env): AppConfig {
  return applyEnv(baseConfig(), env);
}
