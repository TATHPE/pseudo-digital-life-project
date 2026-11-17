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

test("H-4 embedding 是必装档：装过就不重复拉，且记账只在**我们拉的**时候", async () => {
  const home = H();
  startSetup(home);

  // 已经装过（不是我们装的）→ 不记账
  const r1 = fakeRunner({ listHas: ["bge-m3:latest"] });
  const a = await ensureEmbedding(home, r1, "bge-m3");
  assert.equal(a.ok, true);
  assert.match(a.note, /不是我们装的/);
  assert.equal(readSession(home)!.artifacts.pulledModels.length, 0, "本来就有的不能算我们的，否则终止会误删");

  // 没装 → 拉之前先记账
  const r2 = fakeRunner({ listHas: [] });
  const b = await ensureEmbedding(home, r2, "bge-m3");
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

test("H-4 装 Ollama 失败要给可照做的退路，不是死路", async () => {
  const home = H();
  startSetup(home);
  const r = fakeRunner({ installed: false, serveFails: true });
  // winget 也失败
  const runner: Runner = { run: (cmd, args) => (cmd === "winget" ? { ok: false, out: "no network" } : r.run(cmd, args)) };
  const out = await ensureOllama(home, runner);
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

test("H-4 探测：端点读配置、HTTP 在线就算装了（CLI 不在 PATH 也不误报）、只读", async () => {
  const home = H();
  writeFileSync(join(home, "config.json"), JSON.stringify({ local: { embed: "bge-m3" }, ollama: "http://127.0.0.1:11435" }), "utf8");
  const before = readFileSync(join(home, "config.json"), "utf8");
  let probed = "";
  const d = await detect(home, {
    totalMemGB: 12,
    run: () => ({ ok: false, out: "" }),  // CLI 不在 PATH（桌面版常见）
    probe: async (base) => { probed = base; return { online: true, names: ["bge-m3:latest"] }; },
  });
  assert.equal(probed, "http://127.0.0.1:11435", "探测必须用配置里的端点，不能写死 11434");
  assert.equal(d.endpoint, "http://127.0.0.1:11435");
  assert.equal(d.ollama.installed, true, "HTTP 在线就是装了 —— 旧判断只看 CLI，会误报『识别不到』");
  assert.equal(d.ollama.running, true);
  assert.deepEqual(d.ollama.models, ["bge-m3:latest"]);
  assert.equal(d.ramGB, 12);
  assert.match(d.recommend.model, /7b/);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), before, "探测不该改配置");
  assert.equal(readSession(home), null, "探测不该建事务账本");
  void existsSync;
});

test("H-4 runStep 记账：成功推指针，失败留原因且不前进", async () => {
  const home = H();
  startSetup(home);
  completeStep(home, "detect", true, "ok");
  const bad = await runStep(home, "embed", fakeRunner({ pullFails: true }), { model: "bge-m3" });
  assert.equal(bad.ok, false);
  assert.match(bad.note, /ollama pull bge-m3/, "失败提示要能照做");
  assert.equal(readSession(home)!.step, "embed", "失败不前进");

  const good = await runStep(home, "embed", fakeRunner({ listHas: [] }), { model: "bge-m3" });
  assert.equal(good.ok, true);
  assert.equal(readSession(home)!.step, "chat");
  assert.ok((await ensureChatModel(home, fakeRunner({ listHas: ["qwen2.5:7b-instruct"] }), "qwen2.5:7b-instruct")).ok);
});

test("H-4 2026-11-17：Runner 返回 Promise 必须等结果，不能把 Promise 当成功", async () => {
  const home = H();
  startSetup(home);
  completeStep(home, "detect", true, "ok");
  let resolved = false;
  const slow: Runner = {
    run: async () => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
      return { ok: false, out: "network down" };
    },
  };
  const out = await runStep(home, "embed", slow, { model: "bge-m3" });
  assert.equal(resolved, true, "异步 runner 的结果必须被 await");
  assert.equal(out.ok, false, "旧实现把 Promise 对象当结果，会误判成成功");
  assert.match(out.note, /拉 bge-m3 失败/);
});

test("H-4 2026-11-17：常驻 serve 走 start 后台启动并记 PID，不再用 run 等它退出", async () => {
  const home = H();
  startSetup(home);
  const calls: string[] = [];
  const runner: Runner = {
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "ollama" && args[0] === "--version") return { ok: true, out: "0.5" };
      return { ok: false, out: "not running" };
    },
    start: async (cmd, args) => { calls.push("START " + [cmd, ...args].join(" ")); return { ok: true, pid: 4242 }; },
  };
  const out = await ensureOllama(home, runner);
  assert.equal(out.ok, true);
  assert.match(out.note, /PID 4242/);
  assert.ok(calls.includes("START ollama serve"));
  assert.ok(!calls.includes("ollama serve"), "常驻进程不能交给 run 等退出（那只会超时并杀掉它）");
  assert.equal(readSession(home)!.artifacts.startedProcesses[0]!.pid, 4242, "记账带 pid，终止时才停得掉");
});

test("2026-11-17 createAsyncRunner：长命令期间事件循环照常转，进度按行回传", async () => {
  const { createAsyncRunner } = await import("../src/setupsteps.ts");
  const r = createAsyncRunner();
  let ticked = false;
  setTimeout(() => { ticked = true; }, 20);
  const lines: string[] = [];
  const res = await r.stream!(process.execPath, ["-e", "console.log('one'); setTimeout(()=>console.log('two'), 120)"], (s) => lines.push(s));
  assert.equal(res.ok, true);
  assert.equal(ticked, true, "命令还没结束时定时器就该触发 —— 事件循环不能被同步按住（这就是引导卡死的根因）");
  assert.deepEqual(lines, ["one", "two"]);
});
