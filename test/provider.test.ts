import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouter, validateRouter, PrivacyError, MEMORY_ROLES, type RoleConfig } from "../src/provider.ts";
import { defaultConfig } from "../src/config.ts";

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

// ── C-5：默认值不许指向一个已经不存在的模型 ──────────────────
test("C-5 本地角色默认不写死模型名：缺就是缺，由 validateRouter 报出来", () => {
  const cfg = defaultConfig({});
  for (const r of ["route", "extract", "salience", "conflict", "night"] as const) {
    assert.equal(cfg.roles[r]!.model, "", `${r} 不该有默认模型名`);
  }
  const problems = validateRouter(cfg.roles);
  assert.ok(problems.some((p) => p.includes("缺 provider/model")), "必须有人替它说人话");
  // 用 JJ_MODEL_DEFAULT 显式给了就不该报
  const ok = defaultConfig({ JJ_MODEL_DEFAULT: "qwen2.5:7b-instruct" });
  assert.equal(ok.roles["extract"]!.model, "qwen2.5:7b-instruct");
});

// ── C-4：优先级 env > config.json > 默认值，且本地模型可持久化 ─────────────
test("C-4 优先级：config.json 写进去的模型会被 env 盖掉（env 永远赢）", async () => {
  const { resolveConfig, writeFileConfig } = await import("../src/configfile.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "jj-cfg-"));

  writeFileConfig(home, { local: { default: "qwen2.5:3b", night: "qwen2.5:7b", embed: "bge-m3" } });
  const fromFile = resolveConfig(home, {});
  assert.equal(fromFile.roles["extract"]!.model, "qwen2.5:3b", "default 管 4 个记忆角色");
  assert.equal(fromFile.roles["conflict"]!.model, "qwen2.5:3b");
  assert.equal(fromFile.roles["night"]!.model, "qwen2.5:7b", "night 可以单设一档");
  assert.equal(fromFile.roles["embed"]!.model, "bge-m3");

  const withEnv = resolveConfig(home, { JJ_MODEL_DEFAULT: "qwen2.5:14b" });
  assert.equal(withEnv.roles["extract"]!.model, "qwen2.5:14b", "env 必须盖过文件");
  assert.equal(withEnv.roles["night"]!.model, "qwen2.5:14b", "没单设 JJ_MODEL_NIGHT 时跟随 DEFAULT");
});

test("C-4 night 不单设时跟随 default（文件与 env 同一套语义）", async () => {
  const { resolveConfig, writeFileConfig } = await import("../src/configfile.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "jj-cfg2-"));
  writeFileConfig(home, { local: { default: "qwen2.5:7b" } });
  assert.equal(resolveConfig(home, {}).roles["night"]!.model, "qwen2.5:7b");
});
