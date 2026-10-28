/**
 * 角色配置（13 §2）
 * 环境变量覆盖：JJ_OLLAMA、JJ_MODEL_DEFAULT、JJ_MODEL_EXPRESS、JJ_PROVIDER_EXPRESS
 */
import type { RoleConfig } from "./provider.ts";

export interface AppConfig {
  roles: Record<string, RoleConfig>;
  ollama: string;
}

export function defaultConfig(env = process.env): AppConfig {
  const ollama = env.JJ_OLLAMA ?? "http://127.0.0.1:11434";
  const small = env.JJ_MODEL_DEFAULT ?? "qwen2.5:1.5b-instruct";
  const night = env.JJ_MODEL_NIGHT ?? small;   // 自传/反思用；1.5B 会编，建议 ≥3B
  const embed = env.JJ_MODEL_EMBED ?? "bge-m3";
  const local = (model: string): RoleConfig => ({ kind: "local", provider: "ollama", model, baseUrl: ollama });
  return {
    ollama,
    roles: {
      embed:    local(embed),
      route:    local(small),
      extract:  local(small),
      salience: local(small),
      conflict: local(small),
      night:    local(night),
      express:  {
        kind: "cloud",
        provider: (env.JJ_PROVIDER_EXPRESS as "anthropic" | "openai" | "deepseek") ?? "deepseek",
        model: env.JJ_MODEL_EXPRESS ?? "deepseek-chat",
        ...(env.JJ_BASE_EXPRESS ? { baseUrl: env.JJ_BASE_EXPRESS } : {}),
        maxTokens: 1024,
      },
      plan: {
        kind: "cloud",
        provider: (env.JJ_PROVIDER_EXPRESS as "anthropic" | "openai" | "deepseek") ?? "deepseek",
        model: env.JJ_MODEL_PLAN ?? "deepseek-reasoner",
        maxTokens: 2048,
      },
    },
  };
}
