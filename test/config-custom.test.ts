/**
 * 声音 / 视觉配置「自己决定」的回归（2026-11-15）。
 * 以前的真 bug：backend 只认 local|cloud、provider 只认 ollama|cloud，写别的值被静默丢掉
 * 却仍然返回 ok；配置读取又强推回默认值，界面还拿归一化值冒充用户写过的配置。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileConfig, writeFileConfig } from "../src/configfile.ts";
import { ttsPatch, visionPatch, cfgGroupsPatch, rawPatch, rawView } from "../src/config-custom.ts";
import { ttsConfig, buildSpeechRequest, openaiSynthesize, ttsStatus } from "../src/tts.ts";
import { visionConfig, buildRequest } from "../src/vision.ts";
import { openDb } from "../src/db.ts";
import { createWebServer } from "../src/web/server.ts";
import type { AddressInfo } from "node:net";

const H = () => mkdtempSync(join(tmpdir(), "jj-custom-"));
const BLOCKED = new Set([0, 6665, 6666, 6667, 6668, 6669, 10080]);
async function listenSafe(srv: any): Promise<number> {
  for (let i = 0; ; i++) {
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    if (!BLOCKED.has(port)) return port;
    await new Promise<void>((r) => srv.close(() => r()));
    if (i > 8) throw new Error("E_BAD_PORT");
  }
}
async function start() {
  const dir = H();
  const d = openDb(join(dir, "m.db"));
  const srv = createWebServer({
    db: d.db, inboxDir: join(dir, "inbox"), home: dir,
    getTransport: () => { throw new Error("测试不该真调模型"); },
    getEmbedder: () => null,
    getConfig: () => ({ ollama: "http://127.0.0.1:11434", roles: { express: { provider: "deepseek", model: "deepseek-chat", embed: { provider: "ollama", model: "bge-m3" } } } }),
    now: () => new Date("2026-11-15T12:00:00Z"),
    reply: async function* () { yield "在。"; },
  });
  const port = await listenSafe(srv);
  return { srv, dir, base: `http://127.0.0.1:${port}` };
}
const hdr = { "content-type": "application/json", "x-jj": "1" };
const put = async (base: string, path: string, body: unknown) => {
  const r = await fetch(base + path, { method: "PUT", headers: hdr, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};

test("ttsPatch / visionPatch：任意值都存，空串清空，数值越界明拒", () => {
  const a = ttsPatch({ backend: "my-kokoro", baseUrl: "http://localhost:8880/v1", model: "kokoro",
    voice: "af_bella", speed: 1.3, volume: 0.4, format: "wav", instructions: "温柔一点" });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(a.patch.backend, "my-kokoro");
  assert.equal(a.patch.baseUrl, "http://localhost:8880/v1");
  assert.equal(a.patch.speed, 1.3);
  assert.equal(a.patch.volume, 0.4);
  const empty = ttsPatch({ backend: "" });
  assert.equal(empty.ok && empty.patch.backend, "", "空串要真的落盘清掉旧值");
  assert.equal(ttsPatch({ speed: 9 }).ok, false, "不许静默改成默认值");
  assert.equal(ttsPatch({ volume: 2 }).ok, false);
  const v = visionPatch({ provider: "my-vendor", model: "", baseUrl: "http://x/v1" });
  assert.equal(v.ok, true);
  if (v.ok) { assert.equal(v.patch.provider, "my-vendor"); assert.equal(v.patch.model, ""); }
});

test("cfgGroupsPatch：分组与顺序由用户写，null 恢复默认，畸形整份拒掉", () => {
  const g = [{ name: "我的", hint: "随便", secs: ["声音", "外观"] }, { name: "另一组", secs: ["主动开口"] }];
  const r = cfgGroupsPatch(g);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.patch, g.map((x) => ({ ...x })));
  assert.equal((cfgGroupsPatch(null) as any).patch, undefined);
  assert.equal(cfgGroupsPatch({}).ok, false);
  assert.equal(cfgGroupsPatch([{ name: "", secs: [] }]).ok, false);
  assert.equal(cfgGroupsPatch([{ name: "X", secs: [1] }]).ok, false);
  assert.equal(cfgGroupsPatch(Array.from({ length: 21 }, () => ({ name: "X", secs: [] }))).ok, false);
});

test("rawPatch / rawView：只认三个命名空间，密钥不出现，内置档位不许乱写", () => {
  const r = rawPatch({ tts: { backend: "mine" }, ui: { volume: 0.5, sound: false },
    vision: { provider: "vendor" }, secrets: { leaked: 1 }, agent: { name: "改名字" } });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(Object.keys(r.patch).sort(), ["tts", "ui", "vision"]);
    assert.ok(!("secrets" in r.patch) && !("agent" in r.patch));
  }
  assert.equal(rawPatch({ ui: { theme: "solar" } }).ok, false, "不存在的档位当场拒，别运行时默默回落");
  assert.equal(rawPatch({}).ok, false);
  assert.deepEqual(Object.keys(rawView({ tts: { backend: "x" } })).sort(), ["tts", "ui", "vision"]);
});

test("ttsConfig：自定义后端不被强推回 local，OpenAI 兼容请求形状正确", async () => {
  const home = H();
  writeFileConfig(home, { tts: { backend: "my-kokoro", baseUrl: "http://localhost:8880/v1", model: "kokoro",
    voice: "af_bella", speed: 1.3, format: "wav", instructions: "轻一点" } });
  const cfg = ttsConfig(home);
  assert.equal(cfg.backend, "my-kokoro");
  assert.equal(cfg.configured, true);
  const req = buildSpeechRequest(cfg, "你好", "sk-test-key");
  assert.equal(req.url, "http://localhost:8880/v1/audio/speech");
  assert.equal(req.headers.authorization, "Bearer sk-test-key");
  assert.deepEqual(req.body, { model: "kokoro", input: "你好", voice: "af_bella",
    response_format: "wav", instructions: "轻一点", speed: 1.3 });
  // 只给主机名时自动补 /v1；已经写全路径时不再补
  assert.equal(buildSpeechRequest({ ...cfg, baseUrl: "http://127.0.0.1:8000" }, "x").url, "http://127.0.0.1:8000/v1/audio/speech");
  assert.equal(buildSpeechRequest({ ...cfg, baseUrl: "http://x/v1/audio/speech" }, "x").url, "http://x/v1/audio/speech");
  assert.throws(() => buildSpeechRequest({ ...cfg, baseUrl: "" }, "x"), /E_TTS_NO_BASEURL/);

  let seenUrl = "";
  const mock = (async (url: string) => {
    seenUrl = url;
    return { ok: true, status: 200, headers: new Headers({ "content-type": "audio/wav" }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as any;
  }) as unknown as typeof fetch;
  const got = await openaiSynthesize(cfg, "你好", { key: "sk-test-key", fetch: mock });
  assert.equal(seenUrl, "http://localhost:8880/v1/audio/speech");
  assert.equal(got.mime, "audio/wav");
  assert.equal(got.data.length, 3);
  const st = await ttsStatus(home);
  assert.equal(st.backend, "my-kokoro");
  assert.equal(st.ready, true);
});

test("visionConfig：自定义 provider 与 baseUrl 不被改回内置值", () => {
  const home = H();
  writeFileConfig(home, { vision: { provider: "my-vendor", model: "glm-4v-flash", baseUrl: "http://localhost:1234/v1", cloudEnabled: true } });
  const cfg = visionConfig(home);
  assert.equal(cfg.provider, "my-vendor");
  assert.equal(cfg.model, "glm-4v-flash");
  assert.equal(cfg.baseUrl, "http://localhost:1234/v1");
  assert.equal(cfg.configured, true);
  assert.equal(cfg.modelSet, true);
  // baseUrl 已经带 /v1 时不许再拼一层
  assert.equal(buildRequest(cfg, "QUJD", "有什么").url, "http://localhost:1234/v1/chat/completions");
  // 本地没写模型时运行时才用内置默认，且如实标出 modelSet=false
  const home2 = H();
  const d = visionConfig(home2);
  assert.equal(d.configured, false);
  assert.equal(d.modelSet, false);
  assert.equal(readFileConfig(home2).vision, undefined, "运行时默认绝不写回配置文件");
});

test("集成：PUT /api/tts 自定义值真的落盘；空串清空；不写默认值", async () => {
  const { srv, dir, base } = await start();
  try {
    const body = { backend: "my-kokoro", baseUrl: "http://localhost:8880/v1", model: "kokoro",
      voice: "af_bella", speed: 1.3, volume: 0.4, format: "wav" };
    const r = await put(base, "/api/tts", body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.backend, "my-kokoro");
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).tts;
    for (const [k, v] of Object.entries(body)) assert.deepEqual(onDisk[k], v, `${k} 要原样落盘`);
    assert.ok(!("apiKey" in onDisk), "密钥不许进 config.json");
    const cleared = await put(base, "/api/tts", { backend: "", model: "" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.raw.backend, "");
    assert.equal((await put(base, "/api/tts", { speed: 99 })).status, 400, "越界要明拒，不许静默替换");
  } finally { srv.close(); }
});

test("集成：/api/ui 存用户布局与声音开关；/api/config/raw 脱敏且按命名空间合并", async () => {
  const { srv, dir, base } = await start();
  try {
    const groups = [{ name: "我的", hint: "自定", secs: ["声音", "外观"] }];
    const a = await put(base, "/api/ui", { cfgGroups: groups, sound: false, volume: 0.3 });
    assert.equal(a.status, 200, JSON.stringify(a.json));
    const ui0 = await (await fetch(base + "/api/ui")).json() as any;
    assert.deepEqual(ui0.raw.cfgGroups, groups);
    assert.equal(ui0.raw.sound, false);
    assert.equal(ui0.raw.volume, 0.3);
    assert.equal((await put(base, "/api/ui", { cfgGroups: "nope" })).status, 400);
    const back = await put(base, "/api/ui", { cfgGroups: null });
    assert.equal(back.status, 200);
    const ui1 = await (await fetch(base + "/api/ui")).json() as any;
    assert.equal(ui1.raw.cfgGroups, null, "恢复默认 = 把键删掉，不写一份默认布局进去");
    assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).ui.cfgGroups, undefined);

    const raw = await (await fetch(base + "/api/config/raw")).json() as any;
    assert.deepEqual(Object.keys(raw).sort().filter((k) => ["ui", "tts", "vision", "namespaces"].includes(k)).sort(),
      ["namespaces", "tts", "ui", "vision"]);
    const saved = await put(base, "/api/config/raw", { tts: { backend: "raw-vendor" }, vision: { provider: "raw-eye" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(cfg.tts.backend, "raw-vendor");
    assert.equal(cfg.vision.provider, "raw-eye");
    assert.equal(cfg.ui.sound, false, "没提到的 ui 键保持不变");
    assert.equal((await put(base, "/api/config/raw", { ui: { theme: "solar" } })).status, 400);
  } finally { srv.close(); }
});

test("集成：/api/vision 自定义 provider 原样保存并返回 raw", async () => {
  const { srv, base } = await start();
  try {
    const r = await put(base, "/api/vision", { provider: "my-eye", model: "qwen-vl", baseUrl: "http://localhost:1234/v1" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.provider, "my-eye");
    assert.equal(r.json.raw.provider, "my-eye");
    assert.equal(r.json.raw.model, "qwen-vl");
    const g = await (await fetch(base + "/api/vision")).json() as any;
    assert.equal(g.provider, "my-eye");
    assert.equal(g.configured, true);
  } finally { srv.close(); }
});
