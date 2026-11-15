/**
 * 眼（2026-11-12）：截图 + 视觉理解，本地 / 云双路。
 *
 * 用户定：A+B 都做。本地拉 qwen2.5vl:3b（Ollama），云端走 OpenAI 兼容视觉 API（厂商不预设）。
 * **屏幕内容默认只走本地**；`vision.cloudEnabled` 是人开的隐私闸，开了才允许发云端。
 *
 * 独立模块，不动 transport/router（surgical）：视觉是一次性的「看图答一句」，
 * 不需要进对话主链路那套角色路由/守卫/记账。审计由 verb 层（execute）统一记。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileConfig } from "./configfile.ts";
import { createStore } from "./auth.ts";
import { isInstalled } from "./ollama.ts";

export const VISION_LOCAL_MODEL = "qwen2.5vl:3b";

export interface VisionConfig {
  /** 任意字符串；ollama 走本地 /api/chat，其余走 OpenAI 兼容 /v1/chat/completions */
  provider: string;
  model: string;
  baseUrl: string;
  cloudEnabled: boolean;
  /** 用户有没有真的设过 provider / model（界面要如实显示「未设置」，不拿运行时默认冒充） */
  configured?: boolean;
  modelSet?: boolean;
}

export function visionConfig(home: string): VisionConfig {
  const f = readFileConfig(home);
  const v = f.vision ?? {};
  const rawProvider = String(v.provider ?? "").trim();
  const provider = rawProvider || "ollama";
  const isLocal = provider === "ollama";
  const rawModel = String(v.model ?? "").trim();
  // 本地没设模型时运行时用内置 qwen2.5vl:3b，但**不写回配置**，并通过 modelSet=false 如实标出来
  const model = rawModel || (isLocal ? VISION_LOCAL_MODEL : "");
  const base = String(v.baseUrl ?? "").trim() || (isLocal ? (f.ollama ?? "http://127.0.0.1:11434") : "");
  return {
    provider, model, baseUrl: base.replace(/\/+$/, ""),
    cloudEnabled: v.cloudEnabled === true,
    configured: rawProvider !== "", modelSet: rawModel !== "",
  };
}

/** 纯函数：把一张图 + 一个问题渲染成请求（测试不依赖网络）。 */
export function buildRequest(cfg: VisionConfig, b64: string, question: string, mime = "image/png"): { url: string; body: unknown } {
  const q = question.trim() || "用一两句中文描述这张屏幕截图里有什么。";
  if (cfg.provider === "ollama") {
    return {
      url: cfg.baseUrl + "/api/chat",
      body: { model: cfg.model, stream: false, messages: [{ role: "user", content: q, images: [b64] }] },
    };
  }
  // 常见本地推理服务给的 baseUrl 已经带 /v1（Ollama 11434/v1、LM Studio 1234/v1…），
  // 再拼一层 /v1 会变成 /v1/v1/... —— 那是把「照别的软件填的地址」判成了错地址。
  const base = cfg.baseUrl.replace(/\/+$/, "");
  return {
    url: base + (/\/v1$/i.test(base) ? "/chat/completions" : "/v1/chat/completions"),
    body: {
      model: cfg.model, max_tokens: 600,
      messages: [{ role: "user", content: [
        { type: "text", text: q },
        { type: "image_url", image_url: { url: "data:" + mime + ";base64," + b64 } },
      ] }],
    },
  };
}

function mimeOf(p: string): string {
  const l = p.toLowerCase();
  return l.endsWith(".jpg") || l.endsWith(".jpeg") ? "image/jpeg" : l.endsWith(".webp") ? "image/webp" : "image/png";
}

/** 看图答一句。opts.fetch / opts.key 供测试注入。 */
export async function see(
  home: string, imageAbs: string, question: string,
  opts: { fetch?: typeof fetch; key?: string } = {},
): Promise<{ text: string; provider: string; model: string }> {
  const cfg = visionConfig(home);
  const b64 = readFileSync(imageAbs).toString("base64");
  const mime = mimeOf(imageAbs);
  const doFetch = opts.fetch ?? fetch;

  // 任何非 ollama 的 provider（含用户自己起的厂牌名）都算「把屏幕内容送出去」，
  // 一律过隐私闸 + key，不因为换了名字就绕开。
  if (cfg.provider !== "ollama") {
    if (!cfg.cloudEnabled) throw new Error("E_VISION_CLOUD_OFF: 屏幕内容默认只走本地；要发到自定义端点，先在设置里开「屏幕可发云端」并填 key");
    const key = opts.key ?? createStore(join(home, "secrets")).get("vision");
    if (!key) throw new Error("E_VISION_NO_KEY: 自定义视觉端点没填 key（设置 → 大脑 → 眼 · 视觉）");
    if (!cfg.baseUrl || !cfg.model) throw new Error("E_VISION_NO_CONFIG: 自定义视觉要填 baseUrl 与 model");
    const { url, body } = buildRequest(cfg, b64, question, mime);
    const r = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("E_VISION_HTTP: " + r.status + " " + (await r.text()).slice(0, 200));
    const j = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    return { text: String(j.choices?.[0]?.message?.content ?? "").trim(), provider: cfg.provider, model: cfg.model };
  }

  if (!cfg.model) throw new Error("E_VISION_NO_MODEL: 没配视觉模型");
  const tags = await doFetch(cfg.baseUrl + "/api/tags").then((r) => r.json()).catch(() => null) as { models?: Array<{ name?: string; model?: string }> } | null;
  const names = (tags?.models ?? []).map((m) => String(m.name ?? m.model ?? ""));
  if (!isInstalled(names, cfg.model)) throw new Error("E_VISION_NO_MODEL: 本地没装 " + cfg.model + "（ollama pull " + cfg.model + "）");
  const { url, body } = buildRequest(cfg, b64, question, mime);
  const r = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("E_VISION_HTTP: " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json() as { message?: { content?: string } };
  return { text: String(j.message?.content ?? "").trim(), provider: "ollama", model: cfg.model };
}

/**
 * 截屏（Windows）：调自家可信脚本 capture.ps1（照 auth.ts 调 PowerShell 的先例；
 * FULL_DENY 管的是模型 argv，不管自家 verb 实现）。多屏合并取 VirtualScreen。
 * 落 workspace/captures/<ts>.png，返回路径与尺寸。
 */
export function capture(home: string, now = new Date()): { path: string; bytes: number; width: number; height: number } {
  const dir = join(home, "workspace", "captures");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, now.toISOString().replace(/[:.]/g, "-") + ".png");
  const script = join(dirname(fileURLToPath(import.meta.url)), "scripts", "capture.ps1");
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-OutPath", out],
    { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (r.status !== 0 || !existsSync(out)) {
    throw new Error("E_SCREEN_CAPTURE: " + String(r.stderr || r.stdout || "截图失败（这台机器可能没有 PowerShell / 图形会话）").slice(0, 200));
  }
  const m = String(r.stdout ?? "").match(/(\d+)x(\d+)/);
  return { path: out, bytes: statSync(out).size, width: m ? Number(m[1]) : 0, height: m ? Number(m[2]) : 0 };
}