/**
 * TTS（2026-11-12 建，2026-11-15 放开）：她开口说话。
 *
 *   local  = sherpa-onnx（npm，ONNX 无 Python；中文多音色 VITS，音色 = speaker id）
 *   cloud  = msedge-tts（npm，免 key，微软 Edge 神经音色；需网络）
 *   其它值 = OpenAI 兼容 /v1/audio/speech（自己填 baseUrl / model / voice / format / apiKey）
 *
 * 2026-11-15 之前 backend 只有 local|cloud 两个字面量，写别的值会被路由**静默丢掉**，
 * ttsConfig 又强推回 local —— 用户填了等于没填（「值写死、改了不生效」）。
 * 现在 backend 是任意字符串；运行时只是按上面三条路分派，不再改写用户的选择。
 * **没配后端就是没配**：陪伴视图安静跳过发声，主动合成/试听报 E_TTS_NO_BACKEND，
 * 不再偷偷拿 local 兜底（用户 2026-11-15 定：「没配就干脆不发声 / 明确报错」）。
 * 内置两个后端仍懒加载；模型由人下载：`jingjing tts setup`。
 *
 * 字段口径对齐 OpenAI /audio/speech 与本地推理服务（Ollama 11434/v1、LM Studio 1234/v1、
 * llama.cpp 8080/v1、vLLM 8000/v1）：baseUrl + apiKey + model + voice + speed + format。
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFileConfig } from "./configfile.ts";

export interface TtsConfig {
  /** 任意字符串；**空 = 没配，不兜底、不发声、主动合成报错** */
  backend: string;
  baseUrl: string;
  model: string;
  voice: string;
  speed: number;
  volume: number;
  format: string;
  instructions: string;
  modelPath: string;
  /** 用户有没有真的设过 backend（界面要如实显示「未设置」） */
  configured: boolean;
}

export function ttsConfig(home: string): TtsConfig {
  const t = readFileConfig(home).tts ?? {};
  const backend = String(t.backend ?? "").trim();
  // 内置两个后端语速范围窄；自定义 OpenAI 兼容后端按 OpenAI 的 0.25–4.0
  const custom = backend !== "" && backend !== "local" && backend !== "cloud";
  const speed = typeof t.speed === "number" && Number.isFinite(t.speed)
    ? Math.max(custom ? 0.25 : 0.5, Math.min(custom ? 4 : 2, t.speed))
    : 1.0;
  const volume = typeof t.volume === "number" && Number.isFinite(t.volume)
    ? Math.max(0, Math.min(1, t.volume)) : 1;
  return {
    backend,   // 空就是空，绝不补 "local"
    baseUrl: String(t.baseUrl ?? "").trim(),
    model: String(t.model ?? "").trim(),
    voice: String(t.voice ?? "").trim(),
    format: String(t.format ?? "").trim(),
    instructions: String(t.instructions ?? "").trim(),
    speed, volume,
    modelPath: t.modelPath?.trim() || join(home, "tts", "model"),
    configured: backend !== "",
  };
}

/** 自定义后端走 OpenAI 兼容 /audio/speech。纯函数，便于测，不碰网络。 */
export function buildSpeechRequest(
  cfg: TtsConfig, text: string, apiKey?: string,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  let base = cfg.baseUrl.replace(/\/+$/, "");
  if (!base) throw new Error("E_TTS_NO_BASEURL: 自定义声音后端要先填 baseUrl");
  if (!/\/audio\/speech$/i.test(base)) {
    // 只有 base 已经以 /v1 结尾才不补；厂商自己的 /v4 之类路径仍按 OpenAI 兼容拼 /v1
    if (!/\/v1$/i.test(base)) base += "/v1";
    base += "/audio/speech";
  }
  const body: Record<string, unknown> = {
    model: cfg.model || "tts-1",
    input: text,
    voice: cfg.voice || "alloy",
    ...(cfg.format ? { response_format: cfg.format } : {}),
    ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
    speed: cfg.speed,
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = "Bearer " + apiKey;
  return { url: base, headers, body };
}

export function mimeForFormat(format: string): string {
  const f = format.toLowerCase();
  if (f === "wav" || f === "pcm") return "audio/wav";
  if (f === "opus") return "audio/ogg";
  if (f === "aac") return "audio/aac";
  if (f === "flac") return "audio/flac";
  return "audio/mpeg";
}

export interface Voice { id: string; name: string; lang?: string }

/** 云 edge-tts 常用中文音色（完整列表可扩；免 key） */
export const EDGE_VOICES: Voice[] = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓（女·温柔）", lang: "zh-CN" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊（女·活泼）", lang: "zh-CN" },
  { id: "zh-CN-YunxiNeural", name: "云希（男·阳光）", lang: "zh-CN" },
  { id: "zh-CN-YunyangNeural", name: "云扬（男·新闻）", lang: "zh-CN" },
  { id: "zh-CN-liaoning-XiaobeiNeural", name: "小北（女·东北）", lang: "zh-CN" },
  { id: "zh-CN-shaanxi-XiaoniNeural", name: "小妮（女·陕西）", lang: "zh-CN" },
];

/** 16-bit PCM 单声道 WAV（纯函数，测试不依赖原生模块） */
export function wavFromSamples(samples: Float32Array, sampleRate: number): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

// ── 本地 sherpa-onnx ──────────────────────────────────────────
let sherpaMod: any = null;
async function loadSherpa(): Promise<any> {
  if (sherpaMod) return sherpaMod;
  const name = "sherpa-onnx"; // 变量名 → TS 不解析模块，缺依赖时运行期才报
  sherpaMod = await import(name);
  return sherpaMod;
}

/** 本地模型在不在（model.onnx + tokens.txt 若是 vits 还需 lexicon） */
export function localModelReady(cfg: TtsConfig): boolean {
  return existsSync(join(cfg.modelPath, "model.onnx")) && existsSync(join(cfg.modelPath, "tokens.txt"));
}

async function localVoices(cfg: TtsConfig): Promise<Voice[]> {
  // 优先读 setup 写的 voices.json；否则尝试 sherpa 的 numSpeakers；再否则给 sid 0
  try {
    const { readFileSync } = await import("node:fs");
    const f = join(cfg.modelPath, "voices.json");
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as Voice[];
  } catch { /* 落到下面 */ }
  try {
    const sherpa = await loadSherpa();
    const tts = localTtsInstance(sherpa, cfg);
    const n = Number(tts.numSpeakers ?? 1);
    return Array.from({ length: Math.max(1, n) }, (_, i) => ({ id: String(i), name: "音色 " + i, lang: "zh" }));
  } catch {
    return [{ id: "0", name: "默认音色（sid 0）", lang: "zh" }];
  }
}

// 模型只加载一次（2026-11-13）：npm 版 sherpa-onnx 是 WASM，每次 createOfflineTts
// 都要把 50–160 MB 的 model.onnx 重新读进内存 —— 每句都重建的话，一句要多等 1–3 秒。
// 按「模型目录 + model.onnx 的 mtime」缓存实例：换模型 / 换目录 / 重新下载都会自动失效。
let localTts: { key: string; tts: any } | null = null;
function localTtsKey(cfg: TtsConfig): string {
  try { return cfg.modelPath + "|" + statSync(join(cfg.modelPath, "model.onnx")).mtimeMs; }
  catch { return cfg.modelPath; }
}
function localTtsInstance(sherpa: any, cfg: TtsConfig): any {
  const key = localTtsKey(cfg);
  if (localTts && localTts.key === key) return localTts.tts;
  const tts = createSherpaTts(sherpa, cfg);
  localTts = { key, tts };
  return tts;
}

function createSherpaTts(sherpa: any, cfg: TtsConfig): any {
  const vits: Record<string, string> = {
    model: join(cfg.modelPath, "model.onnx"),
    tokens: join(cfg.modelPath, "tokens.txt"),
  };
  const lex = join(cfg.modelPath, "lexicon.txt");
  if (existsSync(lex)) vits.lexicon = lex;
  const dataDir = join(cfg.modelPath, "espeak-ng-data");
  if (existsSync(dataDir)) vits.dataDir = dataDir;
  return sherpa.createOfflineTts({ model: { vits }, maxNumSentences: 1 });
}

async function localSynthesize(cfg: TtsConfig, text: string, voice: string): Promise<{ mime: string; data: Buffer }> {
  if (!localModelReady(cfg)) throw new Error("E_TTS_NO_MODEL: 本地模型缺（跑 jingjing tts setup 下载，或切云后端）");
  const sherpa = await loadSherpa();
  const tts = localTtsInstance(sherpa, cfg);
  const sid = Number(voice || cfg.voice || "0") || 0;
  const r = tts.generate({ text, sid, speed: cfg.speed });
  const samples = r.samples as Float32Array;
  return { mime: "audio/wav", data: wavFromSamples(samples, Number(r.sampleRate) || 22050) };
}

// ── 云 msedge-tts ─────────────────────────────────────────────
let edgeMod: any = null;
async function loadEdge(): Promise<any> {
  if (edgeMod) return edgeMod;
  const name = "msedge-tts";
  edgeMod = await import(name);
  return edgeMod;
}

async function edgeSynthesize(text: string, voice: string, speed = 1): Promise<{ mime: string; data: Buffer }> {
  const mod = await loadEdge();
  const { MsEdgeTTS, OUTPUT_FORMAT } = mod;
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  // 语速以前只对本地声音生效，云端这条路把参数丢了（2026-11-14）。
  // msedge-tts 的 toStream 第二个参数就是 ProsodyOptions，rate 用相对百分比。
  const pct = Math.round((Math.max(0.5, Math.min(2, speed)) - 1) * 100);
  const { audioStream } = tts.toStream(text, pct === 0 ? undefined : { rate: (pct > 0 ? "+" : "") + pct + "%" });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    audioStream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    audioStream.on("end", () => resolve());
    audioStream.on("error", (e: Error) => reject(e));
  });
  return { mime: "audio/mpeg", data: Buffer.concat(chunks) };
}

// ── OpenAI 兼容 HTTP 后端 ─────────────────────────────────────
/** opts.fetch / opts.key 供测试与路由注入；key 不落盘、不进日志。 */
export async function openaiSynthesize(
  cfg: TtsConfig, text: string,
  opts: { key?: string; fetch?: typeof fetch } = {},
): Promise<{ mime: string; data: Buffer }> {
  const req = buildSpeechRequest(cfg, text, opts.key);
  const doFetch = opts.fetch ?? fetch;
  const r = await doFetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`E_TTS_HTTP_${r.status}: ${detail || "合成失败"}`);
  }
  const data = Buffer.from(await r.arrayBuffer());
  return { mime: mimeForFormat(cfg.format || String(r.headers.get("content-type") || "")), data };
}

// ── 对外 ──────────────────────────────────────────────────────
/** 没配后端时统一的一句话：状态栏、音色列表、合成错误都用同一个口径，别各说各的。 */
export const NO_BACKEND_HINT = "没配声音后端：设置 → 声音，填 local / cloud / 或自定义端点名；留空就是没配，不会发声";

export async function listVoices(home: string): Promise<{ backend: string; voices: Voice[]; note?: string }> {
  const cfg = ttsConfig(home);
  if (!cfg.backend) return { backend: "", voices: [], note: NO_BACKEND_HINT };
  if (cfg.backend === "cloud") return { backend: "cloud", voices: EDGE_VOICES };
  if (cfg.backend !== "local") {
    return { backend: cfg.backend, voices: [], note: "自定义后端没有预置音色表，音色名自己填" };
  }
  return { backend: "local", voices: await localVoices(cfg) };
}

export async function ttsStatus(home: string): Promise<{
  backend: string; configured: boolean; ready: boolean; voice: string; why?: string;
}> {
  const cfg = ttsConfig(home);
  if (!cfg.backend) {
    return { backend: "", configured: false, ready: false, voice: cfg.voice, why: NO_BACKEND_HINT };
  }
  if (cfg.backend === "cloud") {
    let ready = true; let why: string | undefined;
    try { await loadEdge(); } catch { ready = false; why = "msedge-tts 没装（npm i msedge-tts）"; }
    return { backend: "cloud", configured: cfg.configured, ready,
      voice: cfg.voice || EDGE_VOICES[0]!.id, ...(why ? { why } : {}) };
  }
  if (cfg.backend !== "local") {
    const missing = !cfg.baseUrl ? "baseUrl 没填" : !cfg.model ? "model 没填" : "";
    return { backend: cfg.backend, configured: true, ready: !missing, voice: cfg.voice,
      ...(missing ? { why: missing + "（自定义后端按 OpenAI 兼容 /audio/speech 走）" } : {}) };
  }
  let ready = localModelReady(cfg); let why: string | undefined;
  if (!ready) why = "本地模型缺（跑 jingjing tts setup，或自己填一个声音后端）";
  else { try { await loadSherpa(); } catch { ready = false; why = "sherpa-onnx 没装或 Node 24 二进制不可用"; } }
  return { backend: "local", configured: cfg.configured, ready, voice: cfg.voice || "0", ...(why ? { why } : {}) };
}

/** 合成一段语音。返回 mime + 音频字节。后端不可用/缺模型时抛带码的错误。 */
export async function synthesize(
  home: string, text: string, voice?: string,
  opts: { key?: string; fetch?: typeof fetch } = {},
): Promise<{ mime: string; data: Buffer }> {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("E_TTS_EMPTY: 没有要说的文本");
  if (t.length > 2000) throw new Error("E_TTS_TOO_LONG: 一次最多 2000 字");
  const cfg = ttsConfig(home);
  // 没配就是没配：主动合成（试听 / CLI tts say）明确报错，不静默拿 local 兜底
  if (!cfg.backend) throw new Error("E_TTS_NO_BACKEND: " + NO_BACKEND_HINT);
  const v = voice || cfg.voice;
  if (cfg.backend === "cloud") return edgeSynthesize(t, v || EDGE_VOICES[0]!.id, cfg.speed);
  if (cfg.backend !== "local") return openaiSynthesize(cfg, t, opts);
  return localSynthesize(cfg, t, v);
}