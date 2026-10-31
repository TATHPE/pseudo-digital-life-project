import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startSetup, readSession, notePulledModel, noteFileWillChange, completeStep,
  pauseSetup, resumeSetup, undoSetup, SETUP_STEPS, recommendFor, detect,
} from "../src/setup.ts";
import { ensureEmbedding, ensureChatModel, ensureOllama, writeLocalConfig, runStep, type Runner } from "../src/setupsteps.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-setup-"));

/** 假 runner：记录所有调用，可指定哪些失败 */
function fakeRunner(opts: { installed?: boolean; listHas?: string[]; pullFails?: boolean; serveFails?: boolean } = {}) {
  const calls: string[] = [];
  const runner: Runner & { calls: string[] } = {
    calls,
    run(cmd, args) {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "ollama" && args[0] === "--version") return { ok: opts.installed !== false, out: "ollama version 0.5.0" };
      if (cmd === "ollama" && args[0] === "list") return { ok: true, out: (opts.listHas ?? []).join("\n") };
      if (cmd === "ollama" && args[0] === "serve") return { ok: opts.serveFails !== true, out: "" };
      if (cmd === "ollama" && args[0] === "pull") return { ok: opts.pullFails !== true, out: "pulling…" };
      if (cmd === "ollama" && args[0] === "rm") return { ok: true, out: "deleted" };
      if (cmd === "winget") return { ok: true, out: "installed" };
      return { ok: true, out: "" };
    },
  };
  return runner;
}

test("H-4 步骤顺序写死，且能暂停/恢复", () => {
  const home = H();
  const s = startSetup(home);
  assert.equal(s.status, "running");
  assert.equal(s.step, "detect");
  assert.deepEqual(SETUP_STEPS.slice(0, 3), ["detect", "ollama", "embed"], "先探硬件 → 装 ollama → 装 embedding");

  completeStep(home, "detect", true, "8 GB / 无 ollama");
  assert.equal(readSession(home)!.step, "ollama", "完成后指针前移");

  pauseSetup(home);
  assert.equal(readSession(home)!.status, "paused");
  assert.equal(readSession(home)!.artifacts.pulledModels.length, 0, "暂停不清账（还没终止）");
  resumeSetup(home);
  assert.equal(readSession(home)!.status, "running");
});

test("H-4 embedding 是必装档：装过就不重复拉，且记账只在**我们拉的**时候", () => {
  const home = H();
  startSetup(home);

  // 已经装过（不是我们装的）→ 不记账
  const r1 = fakeRunner({ listHas: ["bge-m3:latest"] });
  const a = ensureEmbedding(home, r1, "bge-m3");
  assert.equal(a.ok, true);
  assert.match(a.note, /不是我们装的/);
  assert.equal(readSession(home)!.artifacts.pulledModels.length, 0, "本来就有的不能算我们的，否则终止会误删");

  // 没装 → 拉之前先记账
  const r2 = fakeRunner({ listHas: [] });
  const b = ensureEmbedding(home, r2, "bge-m3");
  assert.equal(b.ok, true);
  assert.deepEqual(readSession(home)!.artifacts.pulledModels, ["bge-m3"]);
  assert.ok(r2.calls.some((c) => c.includes("pull bge-m3")));
});

test("H-4 终止 = 按账回滚：删我们拉的模型、恢复写过的 config、停我们起的进程", () => {
  const home = H();
  startSetup(home);
  // 写一份"原来就有"的 config
  const cfgPath = join(home, "config.json");
  const original = JSON.stringify({ local: { embed: "old-model" } }, null, 2);
  writeFileSync(cfgPath, original, "utf8");

  notePulledModel(home, "bge-m3");
  notePulledModel(home, "qwen2.5:7b-instruct");
  writeLocalConfig(home, { embed: "bge-m3", chat: "qwen2.5:7b-instruct" });
  assert.match(readFileSync(cfgPath, "utf8"), /qwen2\.5/, "配置确实被改了");

  const calls: string[] = [];
  const report = undoSetup(home, {
    run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { ok: true, out: "" }; },
    killPid: () => { /* ok */ },
    removeDir: () => { /* ok */ },
  });

  assert.deepEqual(report.removedModels.sort(), ["bge-m3", "qwen2.5:7b-instruct"], "只删我们拉的");
  assert.ok(report.restoredFiles.includes(cfgPath));
  assert.equal(readFileSync(cfgPath, "utf8"), original, "config 必须原样恢复（不是删掉）");
  assert.equal(readSession(home)!.status, "aborted");
  assert.equal(readSession(home)!.artifacts.pulledModels.length, 0, "回滚后账本清空");
  assert.ok(calls.some((c) => c.startsWith("ollama rm")), "真的去删了模型");
});

test("H-4 终止后清干净才能再开始（账本不残留）", () => {
  const home = H();
  startSetup(home);
  notePulledModel(home, "bge-m3");
  undoSetup(home, { run: () => ({ ok: true, out: "" }), removeDir: () => { /* ok */ } });
  const again = startSetup(home);
  assert.equal(again.status, "running");
  assert.equal(again.artifacts.pulledModels.length, 0);
});

test("H-4 装 Ollama 失败要给可照做的退路，不是死路", () => {
  const home = H();
  startSetup(home);
  const r = fakeRunner({ installed: false, serveFails: true });
  // winget 也失败
  const runner: Runner = { run: (cmd, args) => (cmd === "winget" ? { ok: false, out: "no network" } : r.run(cmd, args)) };
  const out = ensureOllama(home, runner);
  assert.equal(out.ok, false);
  assert.match(out.note, /ollama\.com\/download|云端模型/, "要给两个出口：手动装 或 跳过本地只配云端");
});

test("H-4 推荐档按内存分，且说清代价", () => {
  assert.match(recommendFor(6).model, /3b/);
  assert.match(recommendFor(12).model, /7b/);
  assert.match(recommendFor(24).model, /14b/);
  assert.match(recommendFor(64).model, /32b/);
  assert.match(recommendFor(12).note, /拐点|性价比/);
});

test("H-4 探测是只读的：不动配置、不拉模型、不记账", async () => {
  const home = H();
  writeFileSync(join(home, "config.json"), JSON.stringify({ local: { embed: "bge-m3" } }), "utf8");
  const before = readFileSync(join(home, "config.json"), "utf8");
  const d = await detect(home, {
    totalMemGB: 12,
    run: (cmd) => (cmd === "ollama" ? { ok: true, out: "ollama version 0.5.0" } : { ok: false, out: "" }),
  });
  assert.equal(d.ramGB, 12);
  assert.equal(d.ollama.installed, true);
  assert.match(d.recommend.model, /7b/);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), before, "探测不该改配置");
  assert.equal(readSession(home), null, "探测不该建事务账本");
  void existsSync;
});

test("H-4 runStep 记账：成功推指针，失败留原因且不前进", () => {
  const home = H();
  startSetup(home);
  completeStep(home, "detect", true, "ok");
  const bad = runStep(home, "embed", fakeRunner({ pullFails: true }), { model: "bge-m3" });
  assert.equal(bad.ok, false);
  assert.match(bad.note, /ollama pull bge-m3/, "失败提示要能照做");
  assert.equal(readSession(home)!.step, "embed", "失败不前进");

  const good = runStep(home, "embed", fakeRunner({ listHas: [] }), { model: "bge-m3" });
  assert.equal(good.ok, true);
  assert.equal(readSession(home)!.step, "chat");
  assert.ok(ensureChatModel(home, fakeRunner({ listHas: ["qwen2.5:7b-instruct"] }), "qwen2.5:7b-instruct").ok);
});
