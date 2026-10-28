/**
 * 可持久化的配置（13 §2）：env > data/config.json > 默认值
 * 面板里改 API 走这里；key 不进这个文件（走 auth.ts 的 DPAPI）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import { defaultConfig, type AppConfig } from "./config.ts";

export interface FileConfig {
  ollama?: string;
  express?: { provider?: string; model?: string; baseUrl?: string };
  plan?: { provider?: string; model?: string };
  budget?: { dailyUsd?: number };
  persona?: { name?: string };
  /** 外观偏好（头像框）——与模型配置分开放，清理接口配置时不会被意外抹掉 */
  ui?: { avatar?: string };
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
    budget: { ...(cur.budget ?? {}), ...(patch.budget ?? {}) },
    persona: { ...(cur.persona ?? {}), ...(patch.persona ?? {}) },
    ui: { ...(cur.ui ?? {}), ...(patch.ui ?? {}) },
  };
  atomicWriteFile(join(home, "config.json"), JSON.stringify(next, null, 2) + "\n");
  cache = null;
  return next;
}

/** 合并：env 覆盖文件（环境变量永远赢，方便临时试验） */
export function resolveConfig(home: string, env = process.env): AppConfig {
  const base = defaultConfig(env);
  const f = readFileConfig(home);
  const ex = f.express ?? {};
  const pl = f.plan ?? {};
  const roles = { ...base.roles };
  if (ex.provider || ex.model || ex.baseUrl) {
    roles["express"] = {
      ...roles["express"]!,
      ...(ex.provider ? { provider: ex.provider } : {}),
      ...(ex.model ? { model: ex.model } : {}),
      ...(ex.baseUrl ? { baseUrl: ex.baseUrl } : {}),
    };
  }
  if (pl.provider || pl.model) {
    roles["plan"] = {
      ...roles["plan"]!,
      ...(pl.provider ? { provider: pl.provider } : {}),
      ...(pl.model ? { model: pl.model } : {}),
    };
  }
  return { ...base, ollama: f.ollama ?? base.ollama, roles };
}
