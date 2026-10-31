import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { openGrant, checkGrant, listGrants, revokeGrant, revokeAll, sanitizedEnv, MAX_TTL_MS, GRANT_COMMANDS } from "../src/grant.ts";
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
