import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openDb } from "../src/db.ts";
import { ensurePolicy, loadPolicy, globOk, DEFAULT_POLICY } from "../src/policy.ts";
import { execute } from "../src/execute.ts";
import { safePath, verbs, verbByName, verbCatalog } from "../src/verbs.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-exec-"));
async function rig() {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  const d = openDb(join(home, "m.db"));
  const policy = await loadPolicy(home);
  return { home, db: d.db, policy, ctx: { home, now: () => new Date("2026-10-28T12:00:00Z") } };
}

test("策略：默认放行 T0，拒绝 T4，T2 要确认", async () => {
  const p = await loadPolicy(H());
  assert.equal((await p.authorize("fs.read", "T0", "docs/a.md")).allow, true);
  const t4 = await p.authorize("shell.admin", "T4", "any");
  assert.equal(t4.allow, false);
  assert.equal(t4.reason, "E_DENIED");
  const t2 = await p.authorize("msg.notify", "T2", "notify");
  assert.equal(t2.allow, true);
  assert.equal(t2.strength, "enforce", "T2 是外部动作，默认就要确认");
  assert.equal((await p.authorize("net.fetch", "T2", "https://x")).strength, "enforce");
});

test("globOk：裸 * 不炸，前缀匹配正确", () => {
  assert.equal(globOk("anything", "*"), true);
  assert.equal(globOk("workspace/a.md", "/workspace/*"), false, "策略里的 target 用相对 home 的路径，不带前导斜杠");
  assert.equal(globOk("workspace/a.md", "workspace/*"), true);
  assert.equal(globOk("workspace/a/b.md", "workspace/*"), true, "子目录也算在 workspace/ 下");
  assert.equal(globOk("workspace", "workspace/*"), false, "目录本身不带斜杠，不算匹配（策略里写 workspace/* 指其内部）");
  assert.equal(globOk("etc/passwd", "workspace/*"), false);
});

test("能力表：shell.run / shell.exec 都是 T3，且 shell.exec 只能在全权限窗口里跑", async () => {
  // M5.3 时这条断言是"表里根本没有 shell.run"；5.6 之后它开了一个口子，
  // 于是断言换成"口子必须是窄的"。K-3 又加了一个更宽的口子（任意 argv），
  // 所以这里的不变量从"不存在"升级为"**存在但自己也会拒绝**"：
  //   · timer 外的东西（进程/包安装/删文件）仍然不存在
  //   · shell.exec 的 run() 在**没有授权窗口**时必须直接抛，不靠调用方自觉
  const names = verbs.map((v) => v.name);
  for (const bad of ["shell.admin", "fs.delete", "fs.raw", "pkg.install", "proc.spawn", "net.shell"]) {
    assert.ok(!names.includes(bad), `不该有 ${bad}`);
  }
  const shell = verbByName("shell.run")!;
  assert.equal(shell.tier, "T3", "shell.run 必须默认是最高档");
  assert.equal(shell.reversible, false);
  assert.equal(typeof shell.capability, "function", "没有 argv 渲染器就签不出令牌");
  assert.equal(typeof shell.tierFor, "function", "档位必须跟着模板走");
  assert.ok(names.includes("fs.trash"), "删除只提供回收站语义");
  assert.equal(verbByName("fs.write")!.tier, "T1");

  // K-3：任意 argv 的那个口子 —— 存在，但**自己**会拒绝
  const exec = verbByName("shell.exec")!;
  assert.equal(exec.tier, "T3");
  assert.equal(typeof exec.capability, "function");
  await assert.rejects(
    () => exec.run({ argv: ["node", "--version"] }, { home: "/tmp", now: () => new Date() }) as never,
    /E_GRANT_NEEDS_FULL/,
    "没有全权限窗口时 shell.exec 必须自己拒（run 是 async，要用 rejects）",
  );
});

test("路径白名单：越界与符号链接逃逸都拒绝", async () => {
  const { home, ctx } = await rig();
  assert.throws(() => safePath(home, "../../.ssh/id_rsa", false), /E_PATH_DENIED/);
  assert.throws(() => safePath(home, "/etc/passwd", false), /E_PATH_DENIED/);
  // 目录联接逃逸：home 外放真文件，用 junction 指过去，必须拒绝
  const outside = join(home, "..", "jj-out-" + String(process.pid) + ".txt");
  writeFileSync(outside, "SECRET");
  try {
    symlinkSync(join(home, ".."), join(home, "workspace", "up"), "junction");
    assert.throws(() => safePath(home, "workspace/up/" + basename(outside), false), /E_PATH_DENIED/);
  } finally { rmSync(outside, { force: true }); }
});

test("执行：fs.write 只允许 workspace/，写前留快照", async () => {
  const { db, policy, ctx, home } = await rig();
  const bad = await execute({ db, policy, ctx }, "fs.write", { path: "docs/a.md", content: "x" });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /E_OUTSIDE_WORKSPACE|E_DENIED/);

  const ok1 = await execute({ db, policy, ctx }, "fs.write", { path: "workspace/a.md", content: "v1" });
  assert.equal(ok1.ok, true, ok1.output);
  const ok2 = await execute({ db, policy, ctx }, "fs.write", { path: "workspace/a.md", content: "v2" });
  assert.equal(ok2.ok, true, ok2.output);
  assert.equal(readFileSync(join(home, "workspace/a.md"), "utf8"), "v2");
  const snaps = readdirSync(join(home, "snapshots"));
  assert.ok(snaps.length >= 1, "覆盖写要留快照");
  assert.equal(readFileSync(join(home, "snapshots", snaps[0]!), "utf8"), "v1");
});

test("执行：回收站可恢复（trash → restore）", async () => {
  const { db, policy, ctx, home } = await rig();
  await execute({ db, policy, ctx }, "fs.write", { path: "workspace/tmp.txt", content: "要删的" });
  const t = await execute({ db, policy, ctx }, "fs.trash", { path: "workspace/tmp.txt" });
  assert.equal(t.ok, true, t.output);
  assert.equal(existsSync(join(home, "workspace/tmp.txt")), false);
  const r = await execute({ db, policy, ctx }, "fs.restore", { name: "tmp.txt" });
  assert.equal(r.ok, true, r.output);
  assert.equal(readFileSync(join(home, "workspace/tmp.txt"), "utf8"), "要删的");
});

test("执行：每条调用都进 exec_audit（含被拒绝的）", async () => {
  const { db, policy, ctx } = await rig();
  await execute({ db, policy, ctx }, "fs.list", { path: "workspace" });
  await execute({ db, policy, ctx }, "fs.read", { path: "../../etc/passwd" });
  await execute({ db, policy, ctx }, "shell.admin", { cmd: "whoami" });
  const rows = db.prepare("SELECT verb,tier,decision,deny_reason FROM exec_audit ORDER BY id").all() as any[];
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.decision, "allowed");
  assert.equal(rows[1]!.decision, "error");
  assert.match(String(rows[1]!.deny_reason), /E_PATH_DENIED/);
  assert.equal(rows[2]!.decision, "denied", "能力表里没有 shell.admin");
});

test("执行：T2 没 approved → needs_confirm，且不产生副作用", async () => {
  const { db, policy, ctx, home } = await rig();
  const r = await execute({ db, policy, ctx }, "msg.notify", { text: "你好" });
  assert.equal(r.needsConfirm, true);
  assert.equal(existsSync(join(home, "inbox")), false);
  const ok = await execute({ db, policy, ctx }, "msg.notify", { text: "你好" }, { approved: true });
  assert.equal(ok.ok, true, ok.output);
});

test("能力目录可枚举，模型据此知道能干什么", () => {
  const cat = verbCatalog();
  assert.ok(cat.length >= 8);
  assert.ok(cat.every((c) => c.name && c.tier && c.description));
});

test("策略文件：不存在时自动生成默认策略", () => {
  const home = H();
  const p = ensurePolicy(home);
  assert.ok(existsSync(p));
  assert.equal(readFileSync(p, "utf8"), DEFAULT_POLICY);
  assert.match(DEFAULT_POLICY, /deny,\s+T4/);
});
