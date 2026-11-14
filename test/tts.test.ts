/**
 * TTS（2026-11-12，陪伴视图 P2）：WAV 封装 / 配置 / 音色 / 诚实报错。
 * 不真发声、不下载模型：本地缺模型/空文本/超长都在调原生模块之前就拒。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wavFromSamples, ttsConfig, listVoices, ttsStatus, synthesize, EDGE_VOICES, localModelReady } from "../src/tts.ts";
import { writeFileConfig } from "../src/configfile.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-tts-"));

test("wavFromSamples：16-bit PCM 单声道 WAV 头与样值", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const buf = wavFromSamples(samples, 22050);
  assert.equal(buf.length, 44 + samples.length * 2);
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  assert.equal(buf.readUInt32LE(24), 22050);      // sampleRate
  assert.equal(buf.readUInt16LE(22), 1);          // mono
  assert.equal(buf.readUInt16LE(34), 16);         // bits
  assert.equal(buf.readInt16LE(44), 0);           // 0
  assert.equal(buf.readInt16LE(44 + 2), 16384);   // 0.5 * 32767 ≈ 16384
  assert.equal(buf.readInt16LE(44 + 4), -16383);  // -0.5（Math.round 向 +∞ 舍入：-16383.5 → -16383）
});

test("ttsConfig：默认 local / 语速 1 / 模型目录；语速越界夹到 0.5–2", () => {
  const home = H();
  const d = ttsConfig(home);
  assert.equal(d.backend, "local");
  assert.equal(d.speed, 1);
  assert.equal(d.modelPath, join(home, "tts", "model"));
  writeFileConfig(home, { tts: { backend: "cloud", voice: "zh-CN-XiaoxiaoNeural", speed: 9 } });
  const c = ttsConfig(home);
  assert.equal(c.backend, "cloud");
  assert.equal(c.voice, "zh-CN-XiaoxiaoNeural");
  assert.equal(c.speed, 2);
});

test("云音色列表免模型；本地缺模型时状态诚实报未就绪", async () => {
  const home = H();
  writeFileConfig(home, { tts: { backend: "cloud" } });
  const v = await listVoices(home);
  assert.equal(v.backend, "cloud");
  assert.equal(v.voices.length, EDGE_VOICES.length);
  assert.ok(v.voices.some((x) => x.id === "zh-CN-XiaoxiaoNeural"));

  const home2 = H();
  const st = await ttsStatus(home2);
  assert.equal(st.backend, "local");
  assert.equal(st.ready, false);
  assert.ok(st.why && st.why.length > 0);
  assert.equal(localModelReady(ttsConfig(home2)), false);
});

test("synthesize：空文本 / 超长 / 本地缺模型 —— 都在发声前拒", async () => {
  const home = H();
  await assert.rejects(() => synthesize(home, "   "), /E_TTS_EMPTY/);
  await assert.rejects(() => synthesize(home, "字".repeat(2001)), /E_TTS_TOO_LONG/);
  await assert.rejects(() => synthesize(home, "你好"), /E_TTS_NO_MODEL/);
});