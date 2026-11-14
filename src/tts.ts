/**
 * TTS（2026-11-12，陪伴视图 P2）：她开口说话。可插拔后端，本地为主、云备选、音色可选。
 *
 *   local = sherpa-onnx（npm，ONNX 无 Python；中文多音色 VITS，音色 = speaker id）
 *   cloud = msedge-tts（npm，免 key，微软 Edge 神经音色；需网络）
 *
 * 两个后端都**懒加载**（动态 import 用变量名，TS 不解析模块）：没装/没模型时诚实报不可用，
 * 绝不拖垮面板。声音克隆（GPT-SoVITS/CosyVoice，Python）留作后续可插拔后端，不在本期。
 * 模型由人下载（照 WSL 先例）：`jingjing tts setup`。
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFileConfig } from "./configfile.ts";

export interface TtsConfig { backend: "local" | "cloud"; voice: string; speed: number; modelPath: string }

export function ttsConfig(home: string): TtsConfig {
  const t = readFileConfig(home).tts ?? {};
  const speed = typeof t.speed === "number" ? Math.max(0.5, Math.min(2, t.speed)) : 1.0;
  return {
    backend: t.backend === "cloud" ? "cloud" : "local",
    voice: String(t.voice ?? ""),
    speed,
    modelPath: t.modelPath ?? join(home, "tts", "model"),
  };
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

// ── 对外 ──────────────────────────────────────────────────────
export async function listVoices(home: string): Promise<{ backend: string; voices: Voice[] }> {
  const cfg = ttsConfig(home);
  if (cfg.backend === "cloud") return { backend: "cloud", voices: EDGE_VOICES };
  return { backend: "local", voices: await localVoices(cfg) };
}

export async function ttsStatus(home: string): Promise<{ backend: string; ready: boolean; voice: string; why?: string }> {
  const cfg = ttsConfig(home);
  if (cfg.backend === "cloud") {
    let ready = true; let why: string | undefined;
    try { await loadEdge(); } catch { ready = false; why = "msedge-tts 没装（npm i msedge-tts）"; }
    return { backend: "cloud", ready, voice: cfg.voice || EDGE_VOICES[0]!.id, ...(why ? { why } : {}) };
  }
  let ready = localModelReady(cfg); let why: string | undefined;
  if (!ready) why = "本地模型缺（跑 jingjing tts setup，或切云后端）";
  else { try { await loadSherpa(); } catch { ready = false; why = "sherpa-onnx 没装或 Node 24 二进制不可用（可先切云后端）"; } }
  return { backend: "local", ready, voice: cfg.voice || "0", ...(why ? { why } : {}) };
}

/** 合成一段语音。返回 mime + 音频字节。后端不可用/缺模型时抛带码的错误。 */
export async function synthesize(home: string, text: string, voice?: string): Promise<{ mime: string; data: Buffer }> {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("E_TTS_EMPTY: 没有要说的文本");
  if (t.length > 2000) throw new Error("E_TTS_TOO_LONG: 一次最多 2000 字");
  const cfg = ttsConfig(home);
  const v = voice || cfg.voice;
  if (cfg.backend === "cloud") return edgeSynthesize(t, v || EDGE_VOICES[0]!.id, cfg.speed);
  return localSynthesize(cfg, t, v);
}