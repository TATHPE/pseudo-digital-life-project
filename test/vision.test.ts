/**
 * 眼（2026-11-12）：本地/云双路请求形状 + 隐私闸 + 缺模型/缺 key 的诚实报错。
 * 用 mock fetch，不真调模型、不真截屏（截屏真机验收另跑）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRequest, visionConfig, see, VISION_LOCAL_MODEL } from "../src/vision.ts";
import { writeFileConfig } from "../src/configfile.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-vis-"));
function img(home: string): string {
  const p = join(home, "shot.png");
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  return p;
}
const mockFetch = (routes: Record<string, unknown>) => (async (url: string) => {
  for (const k of Object.keys(routes)) {
    if (String(url).includes(k)) return { ok: true, status: 200, json: async () => routes[k], text: async () => JSON.stringify(routes[k]) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => "no route" };
}) as unknown as typeof fetch;

test("buildRequest：本地走 /api/chat 带 images；云走 /v1/chat/completions 带 image_url", () => {
  const local = buildRequest({ provider: "ollama", model: "qwen2.5vl:3b", baseUrl: "http://127.0.0.1:11434", cloudEnabled: false }, "QUJD", "屏幕上有什么");
  assert.equal(local.url, "http://127.0.0.1:11434/api/chat");
  const lm = (local.body as { messages: Array<{ content: string; images: string[] }> }).messages[0]!;
  assert.deepEqual(lm.images, ["QUJD"]);
  assert.equal(lm.content, "屏幕上有什么");

  const cloud = buildRequest({ provider: "cloud", model: "glm-4v", baseUrl: "https://open.bigmodel.cn/api/paas/v4", cloudEnabled: true }, "QUJD", "");
  assert.equal(cloud.url, "https://open.bigmodel.cn/api/paas/v4/v1/chat/completions");
  const cm = (cloud.body as { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> }).messages[0]!;
  const part = cm.content.find((x) => x.type === "image_url")!;
  assert.equal(part.image_url!.url, "data:image/png;base64,QUJD");
});

test("visionConfig：默认本地 qwen2.5vl:3b、云闸关；配 cloud 后切云", () => {
  const home = H();
  const d = visionConfig(home);
  assert.equal(d.provider, "ollama");
  assert.equal(d.model, VISION_LOCAL_MODEL);
  assert.equal(d.cloudEnabled, false);
  writeFileConfig(home, { vision: { provider: "cloud", model: "glm-4v", baseUrl: "https://x/v4", cloudEnabled: true } });
  const c = visionConfig(home);
  assert.equal(c.provider, "cloud");
  assert.equal(c.model, "glm-4v");
  assert.equal(c.cloudEnabled, true);
});

test("隐私闸：云闸没开 → E_VISION_CLOUD_OFF（一个请求都不发）", async () => {
  const home = H();
  writeFileConfig(home, { vision: { provider: "cloud", model: "m", baseUrl: "https://x", cloudEnabled: false } });
  let called = 0;
  const f = (async () => { called++; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
  await assert.rejects(() => see(home, img(home), "", { fetch: f }), /E_VISION_CLOUD_OFF/);
  assert.equal(called, 0);
});

test("云端缺 key → E_VISION_NO_KEY；本地缺模型 → E_VISION_NO_MODEL（带 pull 提示）", async () => {
  const home = H();
  writeFileConfig(home, { vision: { provider: "cloud", model: "m", baseUrl: "https://x", cloudEnabled: true } });
  await assert.rejects(() => see(home, img(home), "", { fetch: mockFetch({}) }), /E_VISION_NO_KEY/);

  const home2 = H();
  await assert.rejects(() => see(home2, img(home2), "", { fetch: mockFetch({ "/api/tags": { models: [] } }) }), /E_VISION_NO_MODEL/);
});

test("本地看图成功：先查 tags 再 /api/chat，返回模型的话", async () => {
  const home = H();
  const f = mockFetch({ "/api/tags": { models: [{ name: VISION_LOCAL_MODEL }] }, "/api/chat": { message: { content: "屏幕上有个终端" } } });
  const r = await see(home, img(home), "有什么", { fetch: f });
  assert.equal(r.provider, "ollama");
  assert.equal(r.text, "屏幕上有个终端");
});

test("云端看图成功：带 Bearer key，返回 choices 里的话", async () => {
  const home = H();
  writeFileConfig(home, { vision: { provider: "cloud", model: "glm-4v", baseUrl: "https://x/v4", cloudEnabled: true } });
  const f = mockFetch({ "/v1/chat/completions": { choices: [{ message: { content: "云端看到的" } }] } });
  const r = await see(home, img(home), "", { fetch: f, key: "secretkey123" });
  assert.equal(r.provider, "cloud");
  assert.equal(r.text, "云端看到的");
});