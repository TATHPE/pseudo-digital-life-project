/**
 * 用户自定义配置（2026-11-15）：把「声音 / 视觉」从我预设的几档里放开。
 *
 * 参考口径：
 *  - OpenAI 兼容 /v1/audio/speech：model / voice / speed(0.25–4) / response_format / instructions
 *  - 本地推理服务（Ollama 11434/v1、LM Studio 1234/v1、llama.cpp 8080/v1、vLLM 8000/v1）：
 *    baseUrl + model + 一个常被忽略的占位 apiKey
 *  - VS Code settings.json：GUI 之外给一份可直接编辑的 JSON，未设置的键不写回默认值
 *
 * 三条硬规矩：
 *  1. 字符串值**自由填**，不枚举、不回落；空字符串 = 清空（不替用户补默认）。
 *  2. 数值只校验范围，不静默替换成默认值。
 *  3. apiKey 永远不进 config.json（走 SecretStore），这里只认有没有。
 */
import { UI_THEMES, type CfgGroup, type FileConfig } from "./configfile.ts";

export type PatchResult<T> = { ok: true; patch: T } | { ok: false; error: string; why: string };

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" ? v.trim().slice(0, max) : undefined;

/** 空串要真的落盘（清掉旧值），所以不能用 `||` 过滤 */
function strings(body: Record<string, unknown>, keys: readonly string[], max: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (!(k in body)) continue;
    const v = str(body[k], max);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function numIn(body: Record<string, unknown>, key: string, lo: number, hi: number, code: string): PatchResult<Record<string, number>> {
  if (!(key in body) || body[key] === "" || body[key] === null) return { ok: true, patch: {} };
  const v = typeof body[key] === "string" ? Number(body[key]) : body[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) {
    return { ok: false, error: code, why: `${key} 要在 ${lo}–${hi} 之间，且得是数字` };
  }
  return { ok: true, patch: { [key]: v } };
}

export const TTS_TEXT_FIELDS = [
  "backend", "baseUrl", "model", "voice", "format", "instructions", "modelPath",
] as const;
export const VISION_TEXT_FIELDS = ["provider", "model", "baseUrl"] as const;
/** raw JSON 里 ui 允许的键：能力枚举 + 用户自定义项。不收任意键，避免 __proto__ 之类混进配置 */
export const UI_KEYS = ["theme", "splash", "shell", "beat", "sound", "volume", "cfgGroups", "avatar"] as const;

export function ttsPatch(body: Record<string, unknown>): PatchResult<Partial<NonNullable<FileConfig["tts"]>>> {
  const patch: Record<string, unknown> = strings(body, TTS_TEXT_FIELDS, 300);
  for (const [k, code, lo, hi] of [["speed", "E_BAD_SPEED", 0.25, 4], ["volume", "E_BAD_VOLUME", 0, 1]] as const) {
    const r = numIn(body, k, lo, hi, code);
    if (!r.ok) return r;
    Object.assign(patch, r.patch);
  }
  return { ok: true, patch: patch as Partial<NonNullable<FileConfig["tts"]>> };
}

export function visionPatch(body: Record<string, unknown>): PatchResult<Partial<NonNullable<FileConfig["vision"]>>> {
  const patch: Record<string, unknown> = strings(body, VISION_TEXT_FIELDS, 300);
  if (typeof body.cloudEnabled === "boolean") patch.cloudEnabled = body.cloudEnabled;
  return { ok: true, patch: patch as Partial<NonNullable<FileConfig["vision"]>> };
}

/** 设置页布局：用户自己决定分组、每组的节与顺序。不合法的整份拒掉，不悄悄修。 */
export function cfgGroupsPatch(v: unknown): PatchResult<CfgGroup[] | undefined> {
  if (v === null) return { ok: true, patch: undefined }; // 恢复内置默认
  if (!Array.isArray(v)) return { ok: false, error: "E_BAD_GROUPS", why: "要一个数组（或 null 恢复默认）" };
  if (v.length > 20) return { ok: false, error: "E_BAD_GROUPS", why: "最多 20 组" };
  let total = 0;
  const out: CfgGroup[] = [];
  for (const g of v) {
    if (!g || typeof g !== "object" || Array.isArray(g)) return { ok: false, error: "E_BAD_GROUPS", why: "每组要是对象" };
    const o = g as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name.trim() || o.name.length > 24) return { ok: false, error: "E_BAD_GROUPS", why: "组名 1–24 字" };
    if (o.hint !== undefined && (typeof o.hint !== "string" || o.hint.length > 60)) return { ok: false, error: "E_BAD_GROUPS", why: "hint 要短文字" };
    if (!Array.isArray(o.secs) || o.secs.length > 40) return { ok: false, error: "E_BAD_GROUPS", why: "secs 要是数组（最多 40 节）" };
    const secs: string[] = [];
    for (const s of o.secs) {
      if (typeof s !== "string" || !s.trim() || s.length > 40) return { ok: false, error: "E_BAD_GROUPS", why: "节名 1–40 字" };
      secs.push(s.trim());
    }
    total += secs.length;
    if (total > 120) return { ok: false, error: "E_BAD_GROUPS", why: "总节数最多 120" };
    out.push({ name: o.name.trim(), ...(typeof o.hint === "string" ? { hint: o.hint } : {}), secs });
  }
  return { ok: true, patch: out };
}

/** raw JSON 编辑：只认 ui / tts / vision 三个命名空间，其余原样保留不动。 */
export function rawPatch(body: Record<string, unknown>): PatchResult<Partial<FileConfig>> {
  const patch: Record<string, unknown> = {};
  if ("tts" in body) {
    if (!body.tts || typeof body.tts !== "object" || Array.isArray(body.tts)) return { ok: false, error: "E_BAD_RAW", why: "tts 要是对象" };
    const r = ttsPatch(body.tts as Record<string, unknown>);
    if (!r.ok) return r;
    patch.tts = r.patch;
  }
  if ("vision" in body) {
    if (!body.vision || typeof body.vision !== "object" || Array.isArray(body.vision)) return { ok: false, error: "E_BAD_RAW", why: "vision 要是对象" };
    const r = visionPatch(body.vision as Record<string, unknown>);
    if (!r.ok) return r;
    patch.vision = r.patch;
  }
  if ("ui" in body) {
    if (!body.ui || typeof body.ui !== "object" || Array.isArray(body.ui)) return { ok: false, error: "E_BAD_RAW", why: "ui 要是对象" };
    const u = body.ui as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    for (const k of UI_KEYS) {
      if (!(k in u)) continue;
      if (k === "cfgGroups") {
        const r = cfgGroupsPatch(u.cfgGroups);
        if (!r.ok) return r;
        clean.cfgGroups = r.patch;
      } else if (k === "beat" || k === "sound") {
        if (typeof u[k] !== "boolean") return { ok: false, error: "E_BAD_RAW", why: `${k} 要 true/false` };
        clean[k] = u[k];
      } else if (k === "volume") {
        const r = numIn(u, "volume", 0, 1, "E_BAD_VOLUME");
        if (!r.ok) return r;
        Object.assign(clean, r.patch);
      } else if (k === "theme" || k === "splash" || k === "shell") {
        // 这三项是**内置能力**的档位，不是自由值：写个不存在的值会被运行时默默回落，
        // 那又是「替你预设」。不如当场拒掉，说清有哪几档（与 /api/ui 的校验一致）。
        const v = String(u[k] ?? "").slice(0, 60);
        const allowed = k === "theme" ? UI_THEMES
          : k === "shell" ? ["classic", "notebook"]
            : ["off", "simple", "full"];
        if (!allowed.includes(v)) return { ok: false, error: "E_BAD_RAW", why: `${k} 只能是 ${allowed.join(" / ")}` };
        clean[k] = v;
      } else if (k === "avatar") {
        clean[k] = String(u[k] ?? "").slice(0, 60);
      }
    }
    patch.ui = clean;
  }
  if (!Object.keys(patch).length) return { ok: false, error: "E_EMPTY_PATCH", why: "没有 ui / tts / vision 里的任何东西" };
  return { ok: true, patch: patch as Partial<FileConfig> };
}

/** GET /api/config/raw：脱敏后的三个命名空间。密钥另有 SecretStore，绝不出现在这里。 */
export function rawView(cfg: FileConfig): { ui: unknown; tts: unknown; vision: unknown } {
  return {
    ui: cfg.ui ?? {},
    tts: cfg.tts ?? {},
    vision: cfg.vision ?? {},
  };
}
