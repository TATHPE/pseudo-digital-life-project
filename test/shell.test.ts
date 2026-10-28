import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, meta } from "../src/db.ts";
import { loadPolicy } from "../src/policy.ts";
import { execute } from "../src/execute.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";
import {
  TEMPLATES, argvSha256, cleanEnv, consumeToken, issueToken, planRun, renderTemplate, runArgv, sweepTokens,
  templateById, tokensDir, dockerAvailable, _resetDockerProbe,
} from "../src/shell.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-shell-"));
const at = (ms: number) => new Date(Date.UTC(2026, 9, 28, 12, 0, 0) + ms);
const T0 = at(0);

function rig() {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  const db = openDb(join(home, "memory.db")).db;
  return { home, db };
}

async function rigEx() {
  const { home, db } = rig();
  const policy = await loadPolicy(home);
  const ctx = { home, now: () => new Date() };
  const ex = (verb: string, args: Record<string, unknown>, opts: { approved?: boolean; token?: string } = {}) =>
    execute({ db, policy, ctx }, verb, args, opts);
  return { home, db, ex };
}

// ── 模板表 ──────────────────────────────────────────────────

test("模板表：占位符都有槽定义，二进制不在危险名单里", () => {
  const danger = ["rm", "sudo", "del", "format", "mkfs", "shutdown", "reg", "schtasks",
    "curl", "wget", "powershell", "pwsh", "cmd", "bash", "sh"];
  for (const t of TEMPLATES) {
    for (const bin of [t.win[0], t.linux?.[0] ?? t.win[0]]) {
      assert.ok(!danger.includes(bin.toLowerCase()), `${t.id} 用了 ${bin}`);
    }
    for (const arg of [...t.win[1], ...(t.linux?.[1] ?? [])]) {
      const m = arg.match(/^\{([A-Za-z0-9_]+)\}$/);
      if (m) assert.ok(t.slots[m[1]!], `${t.id} 的 {${m[1]}} 没有槽定义`);
    }
  }
});

test("渲染：无槽模板得到确定的 argv", () => {
  const home = H();
  const r = renderTemplate(home, "node.version");
  assert.deepEqual(r.argv, ["node", "--version"]);
  assert.equal(r.tier, "T0");
  assert.ok(r.digest.length === 64);
});

test("渲染：未知模板 / 未知槽 / 缺槽", () => {
  const home = H();
  assert.throws(() => renderTemplate(home, "rm.rf"), /E_NO_TEMPLATE/);
  assert.throws(() => renderTemplate(home, "node.version", { extra: "1" }), /E_BAD_SLOT/);
  assert.throws(() => renderTemplate(home, "node.run_script", {}), /E_BAD_ARGV/);
});

test("渲染：注入串一个都过不去（分号/管道/命令替换/反引号/空格）", () => {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  const bad = [
    "a.mjs; rm -rf /", "a.mjs | sh", "a.mjs && curl x", "$(id).mjs", "`id`.mjs",
    "a mjs", "a.mjs\nrm -rf /", "../../x.mjs", "/etc/passwd", "a.exe", "-e.mjs",
  ];
  for (const b of bad) {
    assert.throws(() => renderTemplate(home, "node.run_script", { script: b }), /E_BAD_ARGV/, `应拒绝：${b}`);
  }
});

test("占位符必须独占一个 argv 元素（拼在别的元素里一律是模板错误）", () => {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  TEMPLATES.push({
    id: "zz.bad", tier: "T3", description: "测试用：坏模板",
    win: ["node", ["--eval=console.log({script})"]], slots: { script: { pattern: "^x$" } },
  });
  try {
    assert.throws(() => renderTemplate(home, "zz.bad", { script: "x" }), /E_BAD_TEMPLATE/);
  } finally { TEMPLATES.pop(); }
});

test("路径槽：必须在 workspace/ 下，且必须真的存在", () => {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  assert.throws(() => renderTemplate(home, "node.run_script", { script: "missing.mjs" }), /E_NOT_FOUND/);
  writeFileSync(join(home, "workspace", "ok.mjs"), "console.log(1)");
  assert.deepEqual(renderTemplate(home, "node.run_script", { script: "ok.mjs" }).argv, ["node", "ok.mjs"]);
  // 目录联接逃逸（红队 #4 同款）：workspace/up → home 上级
  writeFileSync(join(home, "..", `jj-out-${process.pid}.mjs`), "console.log('out')");
  try {
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    symlinkSync(join(home, ".."), join(home, "workspace", "up"), "junction");
    assert.throws(() => renderTemplate(home, "node.run_script", { script: "up/jj-out.mjs" }), /E_BAD_ARGV/);
  } catch (e) {
    if (!String(e).includes("E_BAD_ARGV")) return; // 平台不让建联接就跳过
  }
});

test("指纹：argv 改一个字节就变，cwd 变也变", () => {
  const a = ["node", "x.mjs"], b = ["node", "x.msj"];
  assert.notEqual(argvSha256(a, "D:/w"), argvSha256(b, "D:/w"));
  assert.notEqual(argvSha256(a, "D:/w"), argvSha256(a, "D:/w2"));
  assert.equal(argvSha256(a, "D:/w"), argvSha256(a, "D:/w"));
  // "a b" 与 "a","b" 不能撞
  assert.notEqual(argvSha256(["node", "a b"], "D:/w"), argvSha256(["node", "a", "b"], "D:/w"));
});

// ── 令牌 ────────────────────────────────────────────────────

test("令牌：单次、过期、指纹不匹配、形状不对", () => {
  const home = H();
  const digest = argvSha256(["node", "a.mjs"], join(home, "workspace"));

  const t = issueToken(home, { verb: "shell.run", template: "node.run_script", digest, cwd: join(home, "workspace"), now: T0 });
  assert.ok(existsSync(join(tokensDir(home), t.token + ".json")));

  // 指纹不匹配
  const wrong = consumeToken(home, t.token, { verb: "shell.run", digest: "deadbeef" }, at(1000));
  assert.equal(wrong.ok, false);
  assert.equal(!wrong.ok && wrong.code, "E_TOKEN_MISMATCH");

  // 正常用掉
  assert.equal(consumeToken(home, t.token, { verb: "shell.run", digest }, at(1000)).ok, true);
  // 再用一次
  const again = consumeToken(home, t.token, { verb: "shell.run", digest }, at(1500));
  assert.equal(!again.ok && again.code, "E_TOKEN_USED");

  // 过期（令牌 120s）
  const t2 = issueToken(home, { verb: "shell.run", template: "node.run_script", digest, cwd: home, now: T0 });
  const late = consumeToken(home, t2.token, { verb: "shell.run", digest }, at(121_000));
  assert.equal(!late.ok && late.code, "E_TOKEN_EXPIRED");

  // 形状不对（防路径穿越）
  const junk = consumeToken(home, "../../memory.db", { verb: "shell.run", digest }, at(1000));
  assert.equal(!junk.ok && junk.code, "E_TOKEN_UNKNOWN");
  assert.equal(consumeToken(home, "cap_nonexistent", { verb: "shell.run", digest }, at(1000)).ok, false);
});

test("令牌过期后会被扫掉（不无限堆积）", () => {
  const home = H();
  const digest = argvSha256(["node", "a.mjs"], home);
  const t = issueToken(home, { verb: "shell.run", template: "node.run_script", digest, cwd: home, now: T0, ttlMs: 1000 });
  const p = join(tokensDir(home), t.token + ".json");
  assert.ok(existsSync(p));
  // 用**明确的远期**时间：sweep 会拿文件 mtime 跟 now 比，拿“真实时间 + 1h”会随时钟漂移而翻车
  const n = sweepTokens(home, at(1000 + 86_400_000 * 3));
  assert.equal(n, 1);
  assert.equal(existsSync(p), false);
});

// ── 宿主层 ──────────────────────────────────────────────────

test("runArgv：拿到 stdout / 退出码；环境是白名单（密钥不传下去）", async () => {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  process.env.JJ_TEST_SECRET_KEY = "leak-me";
  try {
    const env = cleanEnv();
    assert.equal(env.JJ_TEST_SECRET_KEY, undefined);
    assert.equal(env.JJ_SHELL_CHILD, "1");
    const r = await runArgv([process.execPath, "-e",
      "console.log('out'); console.error('err'); console.log('k=' + String(process.env.JJ_TEST_SECRET_KEY));"],
    { cwd: join(home, "workspace"), timeoutMs: 20_000 });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /out/);
    assert.match(r.stderr, /err/);
    assert.match(r.stdout, /k=undefined/);
    assert.equal(r.timedOut, false);
  } finally { delete process.env.JJ_TEST_SECRET_KEY; }
});

test("runArgv：非零退出照样返回输出，不抛", async () => {
  const home = H();
  const r = await runArgv([process.execPath, "-e", "console.log('bye'); process.exit(3)"],
    { cwd: join(home, "workspace"), timeoutMs: 20_000 });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /bye/);
});

test("runArgv：输出爆炸 → 截断并杀掉", async () => {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  const r = await runArgv([process.execPath, "-e",
    "for (let i = 0; i < 20000; i++) console.log('x'.repeat(100));"],
  { cwd: join(home, "workspace"), timeoutMs: 20_000, maxBytes: 4096 });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length <= 8192, `stdout 被截断了：${r.stdout.length}`);
});

test("runArgv：超时杀的是**进程树**（孙子也停）", async () => {
  const home = H();
  const ws = join(home, "workspace");
  mkdirSync(ws, { recursive: true });
  const beat = join(ws, "beat.txt");
  writeFileSync(join(ws, "grand.mjs"),
    "import {appendFileSync} from 'node:fs';" + String.fromCharCode(10) +
    "setInterval(() => appendFileSync(" + JSON.stringify(beat) + ", 'x'), 50);");
  writeFileSync(join(ws, "parent.mjs"),
    "import {spawn} from 'node:child_process';" + String.fromCharCode(10) +
    "spawn(process.execPath, [" + JSON.stringify(join(ws, "grand.mjs")) + "], {stdio: 'ignore'});" +
    "setInterval(() => {}, 1000);");

  const r = await runArgv([process.execPath, join(ws, "parent.mjs")], { cwd: ws, timeoutMs: 600 });
  assert.equal(r.timedOut, true);

  // 等 400ms 让残余进程有机会继续写，然后比较文件大小
  const size1 = existsSync(beat) ? statSync(beat).size : 0;
  await new Promise((res) => setTimeout(res, 500));
  const size2 = existsSync(beat) ? statSync(beat).size : 0;
  assert.equal(size2, size1, `孙子进程还活着（${size1} → ${size2}）`);
});

// ── execute 集成：T3 令牌链 ─────────────────────────────────

test("execute：T3 不确认 → needsConfirm + 确切 argv；--yes 才跑，并写审计", async () => {
  const { home, db, ex } = await rigEx();
  writeFileSync(join(home, "workspace", "hi.mjs"), "console.log('hi from shell.run')");

  const need = await ex("shell.run", { template: "node.run_script", slots: { script: "hi.mjs" } });
  assert.equal(need.ok, false);
  assert.equal(need.code, "E_NEEDS_CONFIRM");
  assert.deepEqual(need.confirm?.argv, ["node", "hi.mjs"]);
  assert.equal(need.confirm?.cwd, join(home, "workspace"));

  const run = await ex("shell.run", { template: "node.run_script", slots: { script: "hi.mjs" } }, { approved: true });
  assert.equal(run.ok, true, run.output);
  assert.match(run.output, /hi from shell\.run/);
  assert.match(String(run.capability), /^cap_/);

  const row = db.prepare("SELECT tier,capability,host_profile,decision,argv_json FROM exec_audit ORDER BY rowid DESC LIMIT 1").get() as any;
  assert.equal(row.tier, "T3");
  assert.equal(row.capability, run.capability);
  assert.match(String(row.host_profile), /^direct\/node/);
  assert.equal(row.decision, "allowed");
  assert.match(String(row.argv_json), /"argv":\["node","hi\.mjs"\]/);
});

test("execute：T0/T1 模板不需要确认（只读命令不该打扰人）", async () => {
  const { ex } = await rigEx();
  const v = await ex("shell.run", { template: "node.version" });
  assert.equal(v.ok, true, v.output);
  assert.match(v.output, /\d+\.\d+/);
  assert.equal(v.tier, "T0");
});

test("execute：令牌被改过/重放都跑不了", async () => {
  const { home, ex } = await rigEx();
  writeFileSync(join(home, "workspace", "a.mjs"), "console.log('a')");
  writeFileSync(join(home, "workspace", "b.mjs"), "console.log('b')");

  const r1 = renderTemplate(home, "node.run_script", { script: "a.mjs" });
  const t = issueToken(home, { verb: "shell.run", template: r1.template, digest: r1.digest, cwd: r1.cwd });

  const swapped = await ex("shell.run", { template: "node.run_script", slots: { script: "b.mjs" }, token: t.token });
  assert.equal(swapped.code, "E_TOKEN_MISMATCH");

  const ok = await ex("shell.run", { template: "node.run_script", slots: { script: "a.mjs" }, token: t.token });
  assert.equal(ok.ok, true, ok.output);

  const replay = await ex("shell.run", { template: "node.run_script", slots: { script: "a.mjs" }, token: t.token });
  assert.equal(replay.code, "E_TOKEN_USED");
});

test("execute：JJ_SHELL=off 是总闸（连 T0 模板也停）", async () => {
  const { ex } = await rigEx();
  process.env.JJ_SHELL = "off";
  try {
    const r = await ex("shell.run", { template: "node.version" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "E_DISABLED");
  } finally { delete process.env.JJ_SHELL; }
});

// ── 迁移 ────────────────────────────────────────────────────

test("schema v6：老库（v5 无新列）打开后自动补列", () => {
  const home = H();
  const f = join(home, "old.db");
  const old = new DatabaseSync(f);
  old.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  old.exec("CREATE TABLE exec_audit (id TEXT PRIMARY KEY, ts TEXT NOT NULL, verb TEXT NOT NULL, tier TEXT NOT NULL," +
    " argv_json TEXT, cwd TEXT, exit_code INTEGER, duration_ms INTEGER, decision TEXT NOT NULL, deny_reason TEXT);");
  old.prepare("INSERT INTO meta(key,value) VALUES('schema_version','5')").run();
  old.close();

  const d = openDb(f);
  assert.equal(meta(d.db, "schema_version"), String(SCHEMA_VERSION));
  const cols = (d.db.prepare("PRAGMA table_info(exec_audit)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("capability"), cols.join(","));
  assert.ok(cols.includes("host_profile"));
  d.db.close();
  void readFileSync;
  void templateById;
});

// ── 沙箱（04 §6.4）：要了容器就关笼子里；引擎不在就拒跑，绝不偷偷降级 ──

test("planRun：默认直跑，provenance 记在 profile 里", () => {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  writeFileSync(join(home, "workspace", "s.mjs"), "");
  const r = renderTemplate(home, "node.run_script", { script: "s.mjs" });
  const p = planRun(r, { env: {} });
  assert.equal(p.kind, "direct");
  assert.deepEqual(p.argv, ["node", "s.mjs"]);
  assert.match(p.profile, /^direct\/node/);
});

test("planRun：要了 docker 就构造出关笼子的 argv", () => {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  writeFileSync(join(home, "workspace", "s.mjs"), "");
  const r = renderTemplate(home, "node.run_script", { script: "s.mjs" });
  const p = planRun(r, { env: { JJ_SHELL_SANDBOX: "docker", JJ_SHELL_IMAGE: "node:24-alpine" }, dockerOk: () => true });

  assert.equal(p.kind, "docker");
  assert.equal(p.argv[0], "docker");
  for (const must of ["run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL", "--tmpfs"]) {
    assert.ok(p.argv.includes(must), `argv 缺 ${must}: ${p.argv.join(" ")}`);
  }
  assert.ok(p.argv.includes("no-new-privileges"));
  // 只挂 workspace，工作目录 /w
  const vi = p.argv.indexOf("-v");
  assert.match(p.argv[vi + 1]!, /\/w$/);
  assert.equal(p.argv[p.argv.indexOf("-w") + 1], "/w");
  // 二进制必须走 --entrypoint（否则镜像自带 entrypoint 会吃掉它）
  const ei = p.argv.indexOf("--entrypoint");
  assert.equal(p.argv[ei + 1], "node");
  assert.ok(p.argv.indexOf("node:24-alpine") > ei, "镜像要在 --entrypoint 之后");
  assert.deepEqual(p.argv.slice(p.argv.indexOf("node:24-alpine") + 1), ["s.mjs"]);
  assert.match(p.profile, /^docker:node:24-alpine$/);
  assert.match(String(p.container), /^jj-[0-9a-f]{8}-/);
});

test("planRun：要了沙箱但引擎不在 → 拒跑（不静默降级）", () => {
  const home = H();
  const r = renderTemplate(home, "node.version");
  assert.throws(
    () => planRun(r, { env: { JJ_SHELL_SANDBOX: "docker" }, dockerOk: () => false }),
    /E_SANDBOX_UNAVAILABLE/,
  );
});

test("planRun：显式允许才降级，且 profile 里留下痕迹", () => {
  const home = H();
  const r = renderTemplate(home, "node.version");
  const p = planRun(r, { env: { JJ_SHELL_SANDBOX: "docker", JJ_SHELL_ALLOW_DIRECT: "1" }, dockerOk: () => false });
  assert.equal(p.kind, "direct");
  assert.ok(p.profile.endsWith("(降级)"), p.profile);
  assert.match(String(p.note), /显式降级/);
});

test("execute：沙箱不可用时连确认都不给（先拒，再谈确认）", async () => {
  const { ex } = await rigEx();
  process.env.JJ_SHELL_SANDBOX = "docker";
  delete process.env.JJ_SHELL_ALLOW_DIRECT;
  _resetDockerProbe();
  try {
    // 本机引擎若真在跑，这条断言就不成立——那时跳过
    if (dockerAvailable()) return;
    const r = await ex("shell.run", { template: "node.version" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "E_SANDBOX_UNAVAILABLE");
    assert.equal(r.needsConfirm, undefined, "不该先让人确认");
  } finally {
    delete process.env.JJ_SHELL_SANDBOX;
    _resetDockerProbe();
  }
});
