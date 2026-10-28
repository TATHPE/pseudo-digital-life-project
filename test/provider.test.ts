import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouter, validateRouter, PrivacyError, MEMORY_ROLES, type RoleConfig } from "../src/provider.ts";

const cfg: Partial<Record<any, RoleConfig>> = {
  embed:    { kind: "local", provider: "ollama", model: "bge-m3" },
  route:    { kind: "local", provider: "ollama", model: "qwen2.5:1.5b" },
  extract:  { kind: "local", provider: "ollama", model: "qwen2.5:1.5b" },
  salience: { kind: "local", provider: "ollama", model: "qwen2.5:1.5b" },
  conflict: { kind: "local", provider: "ollama", model: "qwen2.5:1.5b" },
  night:    { kind: "local", provider: "ollama", model: "qwen2.5:1.5b" },
  express:  { kind: "cloud", provider: "anthropic", model: "claude-sonnet-4-6" },
};

test("validateRouter：记忆类全 local 时无问题", () => {
  assert.deepEqual(validateRouter(cfg), []);
});

test("validateRouter：记忆类被配成 cloud → 拒绝启动", () => {
  const bad = { ...cfg, extract: { kind: "cloud", provider: "openai", model: "gpt" } } as any;
  const p = validateRouter(bad);
  assert.ok(p.some((x) => x.includes("extract")), p.join("; "));
});

test("assertLocalOnly：cloud 角色收到记忆原文 → E_PRIVACY", () => {
  const r = createRouter(cfg);
  assert.throws(() => r.assertLocalOnly("express", true), (e: any) =>
    e instanceof PrivacyError && /E_PRIVACY/.test(e.message));
  r.assertLocalOnly("express", false);           // 没有记忆原文就放行
  r.assertLocalOnly("extract", true);            // 本地角色 + 记忆原文 → 放行
});

test("override 不许把记忆类改成 cloud（唯一的例外也不给）", () => {
  const r = createRouter(cfg);
  assert.throws(() => r.override("conflict", { kind: "cloud" }), PrivacyError);
  r.override("express", { model: "claude-opus-4-6" });
  assert.equal(r.role("express").model, "claude-opus-4-6");
});

test("缺角色 → 报错（不能默默少一个）", () => {
  const r = createRouter({ express: cfg.express! });
  assert.throws(() => r.role("extract"), /E_ROLE_MISSING/);
});

test("MEMORY_ROLES 必须含 conflict（02 §8.2）与 embed（它拿到的就是记忆原文）", () => {
  assert.ok(MEMORY_ROLES.has("conflict"));
  assert.ok(MEMORY_ROLES.has("embed"), "embed 也算读记忆原文");
  assert.ok(!MEMORY_ROLES.has("express"));
});
