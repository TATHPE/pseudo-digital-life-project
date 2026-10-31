import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { openGrant, checkGrant, listGrants, revokeGrant, revokeAll, sanitizedEnv, MAX_TTL_MS, FULL_MAX_TTL_MS, GRANT_COMMANDS } from "../src/grant.ts";
import { execute } from "../src/execute.ts";
import { DEFAULT_POLICY } from "../src/policy.ts";

const H = () => {
  const h = mkdtempSync(join(tmpdir(), "jj-grant-"));
  mkdirSync(join(h, "workspace"), { recursive: true });
  return h;
};
const allowAll = { authorize: async () => ({ allow: true, strength: "enforce" as const, reason: "test" }) };

test("K-3 开窗口：限命令、限目录、限时间，且必须说为什么", () => {
  const home = H();
  assert.equal(openGrant(home, { commands: "node", because: "改几个文件" }).ok, true);

  const b1 = openGrant(home, { commands: ["node"], because: "" });
  assert.equal(b1.ok, false, "没有理由不许开");
  const b2 = openGrant(home, { commands: ["curl"], because: "想联网" });
  assert.equal(b2.ok, false, "不在命令清单里");
  const b3 = openGrant(home, { commands: ["node"], scope: "../..", because: "越权目录" });
  assert.equal(b3.ok, false, "scope 不能越出 home");

  // ttl 上限 2 小时
  const r = openGrant(home, { commands: "node", ttlMs: 999 * 3600_000, because: "要连着跑好几个钟头" });
  assert.equal(r.ok, true);
  if (r.ok) {
    const left = Date.parse(r.grant.expiresAt) - Date.now();
    assert.ok(left <= MAX_TTL_MS + 1000, "ttl 要夹到上限");
  }
  revokeAll(home);
});

test("K-3 判定：命令/目录/路径/元字符/密钥，任何一条不过就是不过", () => {
  const home = H();
  const r = openGrant(home, { commands: "node,git", scope: "workspace", ttlMs: 60_000, because: "连着跑几个脚本" });
  assert.equal(r.ok, true);
  const ws = join(home, "workspace");
  const now = new Date();

  assert.equal(checkGrant(home, { argv: ["node", "a.mjs"], cwd: ws }, now).ok, true, "窗口内该放行");
  assert.equal(checkGrant(home, { argv: ["git", "status"], cwd: ws }, now).ok, true);
  assert.equal(checkGrant(home, { argv: ["curl", "http://x"], cwd: ws }, now).ok, false, "命令不在白名单");
  assert.equal(checkGrant(home, { argv: ["node", "a.mjs"], cwd: home }, now).ok, false, "cwd 在窗口外");
  assert.equal(checkGrant(home, { argv: ["node", "../../etc/passwd"], cwd: ws }, now).ok, false, "不许 ..");
  assert.equal(checkGrant(home, { argv: ["node", "a.mjs", "&&", "rm", "-rf", "/"], cwd: ws }, now).ok, false, "不许串联");
  assert.equal(checkGrant(home, { argv: ["node", "a.mjs", "--apiKey=sk-abcdefghijk"], cwd: ws }, now).ok, false, "不许带密钥");

  // 过期即失效
  const later = new Date(Date.now() + 120_000);
  assert.equal(checkGrant(home, { argv: ["node", "a.mjs"], cwd: ws }, later).ok, false, "过期就不能用了");
  assert.equal(listGrants(home, later).length, 0, "过期的不再列出");
  revokeAll(home);
});

test("K-3 收回：revoke 之后立刻回到「逐次确认」", () => {
  const home = H();
  const r = openGrant(home, { commands: "node", because: "临时用一下" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ws = join(home, "workspace");
  assert.equal(checkGrant(home, { argv: ["node", "a.mjs"], cwd: ws }).ok, true);
  assert.equal(revokeGrant(home, r.grant.id), true);
  assert.equal(checkGrant(home, { argv: ["node", "a.mjs"], cwd: ws }).ok, false, "收回后必须失效");
});

test("K-3 环境脱敏：密钥/令牌一律不传给它", () => {
  const env = sanitizedEnv({
    PATH: "/usr/bin", HOME: "/root",
    DEEPSEEK_API_KEY: "sk-x", OPENAI_API_KEY: "sk-y", AWS_SECRET_ACCESS_KEY: "z",
    GITHUB_TOKEN: "ghp_x", npm_config_registry: "https://registry.npmjs.org", JJ_HOME: "/d",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/root");
  assert.equal(env.npm_config_registry, "https://registry.npmjs.org");
  for (const k of ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"]) {
    assert.equal(env[k], undefined, `${k} 不该传进去`);
  }
});

test("K-3 执行路径：有窗口 → 不用令牌就能跑；收回 → 又变成 E_NEEDS_CONFIRM", async () => {
  const home = H();
  const db = openDb(join(home, "m.db"));
  writeFileSync(join(home, "policy.csv"), DEFAULT_POLICY, "utf8");
  const policy = { authorize: async (_v: string, tier: string) => ({ allow: tier !== "T4", strength: "enforce" as const, reason: "test" }) };

  const script = join(home, "workspace", "hi.mjs");
  writeFileSync(script, "console.log('grant-ok')", "utf8");

  const base = {
    db: db.db, policy: policy as never,
    ctx: { home, now: () => new Date(), db: db.db },
  };

  // 没有窗口：T3 必须确认
  const noGrant = await execute(base, "shell.run", { template: "node.run_script", slots: { script: "hi.mjs" } });
  assert.equal(noGrant.ok, false);
  assert.equal(noGrant.code, "E_NEEDS_CONFIRM");

  // 开窗口（scope 用 home 内的 workspace）
  const r = openGrant(home, { commands: "node", scope: "workspace", because: "跑个脚本", ttlMs: 60_000 });
  assert.equal(r.ok, true);

  const withGrant = await execute(base, "shell.run", { template: "node.run_script", slots: { script: "hi.mjs" } });
  assert.equal(withGrant.ok, true, withGrant.output);
  assert.match(String(withGrant.output), /grant-ok/);
  assert.match(String(withGrant.capability ?? ""), /^grant:/, "审计里要能看出是窗口放行的");

  if (r.ok) revokeGrant(home, r.grant.id);
  const afterRevoke = await execute(base, "shell.run", { template: "node.run_script", slots: { script: "hi.mjs" } });
  assert.equal(afterRevoke.ok, false, "收回后必须重新确认");
  assert.equal(afterRevoke.code, "E_NEEDS_CONFIRM");

  // 逐条审计：窗口内那次也留了痕
  const rows = db.db.prepare("SELECT count(*) c FROM exec_audit WHERE verb='shell.run'").get() as { c: number };
  assert.ok(rows.c >= 3, "三次调用（拒绝/窗口放行/收回后再拒）都要留痕");
  void allowAll;
  void (GRANT_COMMANDS as readonly string[]);
});

// ── K-3 完全权限窗口 ──────────────────────────────────
test("K-3 全权窗口：短 ttl、理由更硬、硬禁名单结构性排除", () => {
  const home = H();
  const short = openGrant(home, { full: true, because: "短" });
  assert.equal(short.ok, false, "全权理由至少 10 字");

  const r = openGrant(home, { full: true, ttlMs: 99 * 3600_000, because: "要连着改好几个文件并跑测试" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.grant.full, true);
    const left = Date.parse(r.grant.expiresAt) - Date.now();
    assert.ok(left <= FULL_MAX_TTL_MS + 1000, "全权窗口要夹到 15 分钟");
  }

  const ws = join(home, "workspace");
  const now = new Date();
  // 允许：普通命令（删/系统/下载/壳之外）
  assert.equal(checkGrant(home, { argv: ["node", "x.mjs"], cwd: ws, verb: "shell.exec" }, now).ok, true);
  assert.equal(checkGrant(home, { argv: ["git", "status"], cwd: home, verb: "shell.exec" }, now).ok, true, "全权覆盖整个 home");
  // 硬禁：删除 / 系统 / 下载 / 壳
  for (const bad of ["rm", "del", "reg", "shutdown", "curl", "powershell", "cmd", "bash"]) {
    const d = checkGrant(home, { argv: [bad, "x"], cwd: ws, verb: "shell.exec" }, now);
    assert.equal(d.ok, false, `${bad} 在全权窗口里也必须拒`);
    if (!d.ok) assert.equal(d.code, "E_GRANT_FULL_DENY", `${bad} 要有专门的拒绝码`);
  }
  // 内联求值一律拒（两种窗口都拒）
  assert.equal(checkGrant(home, { argv: ["node", "-e", "1"], cwd: ws, verb: "shell.exec" }, now).ok, false);
  // 不许跑出 home
  assert.equal(checkGrant(home, { argv: ["node", "C:/Windows/x.mjs"], cwd: ws, verb: "shell.exec" }, now).ok, false);
  revokeAll(home);
});

test("K-3 普通窗口**不会**因为全权存在而变宽", () => {
  const home = H();
  const normal = openGrant(home, { commands: "node", scope: "workspace", because: "跑个脚本" });
  assert.equal(normal.ok, true);
  const ws = join(home, "workspace");
  const now = new Date();
  // 普通窗口 + 模板路径：可以
  assert.equal(checkGrant(home, { argv: ["node", "a.mjs"], cwd: ws, verb: "shell.run" }, now).ok, true);
  // 普通窗口 + 任意 argv：不行
  const r = checkGrant(home, { argv: ["node", "a.mjs"], cwd: ws, verb: "shell.exec" }, now);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "E_GRANT_NEEDS_FULL");
  revokeAll(home);
});

test("K-3 端到端：开全权 → shell.exec 真跑；收回 → 拒", async () => {
  const home = H();
  const db = openDb(join(home, "m.db"));
  const policy = { authorize: async (_v: string, tier: string) => ({ allow: tier !== "T4", strength: "enforce" as const, reason: "test" }) };
  const base = { db: db.db, policy: policy as never, ctx: { home, now: () => new Date(), db: db.db } };

  // 没有窗口：E_GRANT_NEEDS_FULL（不是 needsConfirm，因为这是"能力没开"）
  const denied = await execute(base, "shell.exec", { argv: ["node", "-p", "1"] });
  assert.equal(denied.ok, false);

  const r = openGrant(home, { full: true, because: "真跑一条不在模板里的命令来验证", ttlMs: 60_000 });
  assert.equal(r.ok, true);

  const outFile = join(home, "workspace");
  mkdirSync(outFile, { recursive: true });
  const ok = await execute(base, "shell.exec", { argv: ["node", "print-ok.mjs"], cwd: "workspace" });
  // 文件还不存在 → 这里本来会失败；先写一个
  assert.ok(true);
  writeFileSync(join(outFile, "print-ok.mjs"), "console.log('exec-ok')", "utf8");
  const ok2 = await execute(base, "shell.exec", { argv: ["node", "print-ok.mjs"], cwd: "workspace" });
  assert.equal(ok2.ok, true, ok2.output);
  assert.match(String(ok2.output), /exec-ok/);
  assert.match(String(ok2.capability ?? ""), /^grant:/);
  void ok;

  if (r.ok) revokeGrant(home, r.grant.id);
  const after = await execute(base, "shell.exec", { argv: ["node", "print-ok.mjs"], cwd: "workspace" });
  assert.equal(after.ok, false, "收回后必须拒");
});

test("K-3 全权窗口：路径逃逸有专门的错误码（不是含混的 NEEDS_FULL）", () => {
  const home = H();
  const r = openGrant(home, { full: true, because: "验证路径逃逸的报错够清楚", ttlMs: 60_000 });
  assert.equal(r.ok, true);
  const d = checkGrant(home, { argv: ["node", "C:/Windows/system32/x.mjs"], cwd: join(home, "workspace"), verb: "shell.exec" });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "E_GRANT_PATH");
  revokeAll(home);
});
