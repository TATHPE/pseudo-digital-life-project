import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { loadPolicy } from "../src/policy.ts";
import { createToolRegistry } from "../src/tools.ts";
import { createEmbedder } from "../src/embed.ts";
import { verbs } from "../src/verbs.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-reg-"));
async function rig() {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  const db = openDb(join(home, "m.db")).db;
  const policy = await loadPolicy(home);
  const ctx = { home, now: () => new Date("2026-10-28T12:00:00Z"), db, embedder: createEmbedder("fake") };
  const reg = createToolRegistry({ db, policy, ctx });
  return { home, db, reg };
}

test("工具面只来自 verb 目录（不再有 fs_list / fs_read 两套命名）", async () => {
  const { reg } = await rig();
  const names = reg.list().map((t) => t.name);
  assert.ok(names.includes("fs.read") && names.includes("fs.write") && names.includes("memory.search"));
  assert.ok(!names.includes("fs_list"), "旧实现已删除");
  assert.equal(names.length, verbs.length);
});

test("schema 可直接给模型用（含参数）", async () => {
  const { reg } = await rig();
  const s = reg.schema();
  const fsRead = s.find((x) => x.function.name === "fs_read")!;
  assert.deepEqual(Object.keys((fsRead.function.parameters as any).properties), ["path"]);
});

test("工具调用走策略：记忆核心写被拒（给模型可读错误），其余目录可写", async () => {
  const { reg, db } = await rig();
  const bad = await reg.run("fs.write", { path: "memory.db", content: "x" });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /E_CORE_PROTECTED|E_DENIED/);
  assert.match(bad.output, /记忆库本体/);
  const good = await reg.run("fs.write", { path: "workspace/a.md", content: "hi" });
  assert.equal(good.ok, true, good.output);
  // 审计里两条都在（被拒的也要留痕）
  const rows = db.prepare("SELECT decision FROM exec_audit ORDER BY id").all() as any[];
  assert.equal(rows.length, 2);
});

test("工具调用走策略：T2 未确认 → needsConfirm 透传给 agent", async () => {
  const { reg } = await rig();
  const r = await reg.run("msg.notify", { text: "你好" });
  assert.equal(r.needsConfirm, true);
});

test("记忆类 verb 真的能写能查", async () => {
  const { reg } = await rig();
  const w = await reg.run("memory.remember", { text: "重要性影响衰减速率" });
  assert.equal(w.ok, true, w.output);
  const s = await reg.run("memory.search", { q: "衰减速率", k: 3 });
  assert.equal(s.ok, true, s.output);
  assert.match(s.output, /mem:/);
});

test("外部工具（MCP）也走策略与审计：tier 来自注册方，deny 时不留副作用", async () => {
  const home = H();
  const db = openDb(join(home, "m.db")).db;
  const policy = await loadPolicy(home);
  let called = 0;
  const reg = createToolRegistry({
    db, policy, ctx: { home, now: () => new Date() },
    external: [{ name: "mcp__x__danger", description: "d", parameters: {}, tier: "T4", call: async () => { called++; return "x"; } }],
  });
  const r = await reg.run("mcp__x__danger", {});
  assert.equal(r.ok, false);
  assert.equal(called, 0, "被策略拒绝时绝不能真的调用");
  assert.match(r.output, /E_DENIED/);
  const rows = db.prepare("SELECT count(*) c FROM exec_audit WHERE decision='denied'").get() as any;
  assert.equal(rows.c, 1);
});

test("模型侧函数名必须 API-safe（点号会被 DeepSeek 400 拒绝）", async () => {
  const { reg } = await rig();
  for (const t of reg.schema()) {
    assert.match(t.function.name, /^[a-zA-Z0-9_-]+$/, `不合法：${t.function.name}`);
  }
  // 内部仍保留点号（策略与审计用可读名字）
  assert.ok(reg.list().some((t) => t.name === "fs.read"));
  // 两种写法都能调用
  const a = await reg.run("fs_list", { path: "workspace" });
  const b = await reg.run("fs.list", { path: "workspace" });
  assert.equal(a.ok, b.ok);
  assert.equal(a.ok, true, a.output);
});
