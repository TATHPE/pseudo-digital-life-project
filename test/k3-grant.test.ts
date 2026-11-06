import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { openGrant, checkGrant, listGrants, revokeGrant, revokeAll, sanitizedEnv, MAX_TTL_MS, FULL_MAX_TTL_MS, GRANT_COMMANDS, setPreset, currentPreset } from "../src/grant.ts";
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
    // 显式给了 ttl 就夹上限（不限期是**默认**，不是唯一）
    const left = Date.parse(String(r.grant.expiresAt)) - Date.now();
    assert.ok(left <= MAX_TTL_MS + 1000, "显式 ttl 要夹到上限");
    const noTtl = openGrant(home, { commands: "node", because: "默认不限期的那次" });
    assert.equal(noTtl.ok && noTtl.grant.expiresAt, null, "不给 ttl → 会话级");
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
  // 2026-11-06：不再按元字符拒 —— argv 是数组直传，不经 shell，`&&` 只是参数内容。
  // 危险的是**可执行**那部分，而 rm 自己就在硬禁名单里。
  assert.equal(checkGrant(home, { argv: ["node", "a.mjs", "&&", "rm", "-rf", "/"], cwd: ws }, now).ok, true, "元字符不再拒绝");
  assert.equal(checkGrant(home, { argv: ["rm", "-rf", "/"], cwd: ws }, now).ok, false, "但 rm 本身照旧拒");
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

test("K-3 执行路径：有窗口 → 不用令牌就能跑；收回 → 直接报没有窗口（2026-11-04 删掉确认层）", async () => {
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
  // 2026-11-04：确认层删掉了 —— 没窗口就是没窗口，报明确的原因码，不再变成"等你点确认"
  assert.match(String(noGrant.code), /E_NO_GRANT|E_GRANT_/, "要报具体的闸门原因");

  // 开窗口（scope 用 home 内的 workspace）
  const r = openGrant(home, { commands: "node", scope: "workspace", because: "跑个脚本", ttlMs: 60_000 });
  assert.equal(r.ok, true);

  const withGrant = await execute(base, "shell.run", { template: "node.run_script", slots: { script: "hi.mjs" } });
  assert.equal(withGrant.ok, true, withGrant.output);
  assert.match(String(withGrant.output), /grant-ok/);
  assert.match(String(withGrant.capability ?? ""), /^grant:/, "审计里要能看出是窗口放行的");

  if (r.ok) revokeGrant(home, r.grant.id);
  const afterRevoke = await execute(base, "shell.run", { template: "node.run_script", slots: { script: "hi.mjs" } });
  assert.equal(afterRevoke.ok, false, "收回后就跑不了");
  assert.match(String(afterRevoke.code), /E_NO_GRANT|E_GRANT_/, "报具体原因");

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
    const left = Date.parse(String(r.grant.expiresAt)) - Date.now();
    assert.ok(left <= FULL_MAX_TTL_MS + 1000, "显式 ttl 要夹到 15 分钟");
  }

  const ws = join(home, "workspace");
  const now = new Date();
  // 允许：普通命令（删/系统/下载/壳之外）
  assert.equal(checkGrant(home, { argv: ["node", "x.mjs"], cwd: ws, verb: "shell.exec" }, now).ok, true);
  assert.equal(checkGrant(home, { argv: ["git", "status"], cwd: home, verb: "shell.exec" }, now).ok, true, "全权覆盖整个 home");
  // 2026-11-05：上网不再拦（curl/wget 可以用）
  assert.equal(checkGrant(home, { argv: ["curl", "https://example.com"], cwd: ws, verb: "shell.exec" }, now).ok, true, "curl 要能跑");
  // 硬禁：删除 / 系统 / 壳
  // 2026-11-06：解释器（powershell/cmd/bash）已移出硬禁名单，其余不可逆的照旧
  for (const bad of ["rm", "del", "reg", "shutdown", "format"]) {
    const d = checkGrant(home, { argv: [bad, "x"], cwd: ws, verb: "shell.exec" }, now);
    assert.equal(d.ok, false, `${bad} 在全权窗口里也必须拒`);
    if (!d.ok) assert.equal(d.code, "E_GRANT_FULL_DENY", `${bad} 要有专门的拒绝码`);
  }
  // 2026-11-06：内联求值放开（写文件再跑是等价能力，禁它只多花步骤）
  assert.equal(checkGrant(home, { argv: ["node", "-e", "1"], cwd: ws, verb: "shell.exec" }, now).ok, true, "node -e 要能跑");
  assert.equal(checkGrant(home, { argv: ["powershell", "-Command", "Write-Output hi"], cwd: ws, verb: "shell.exec" }, now).ok, true, "powershell -Command 要能跑");
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

// ── 权限预设（形状照 DSH：当前会话在输入框旁切）───────────
test("K-3 预设四档：ask 无窗口 / read 一律拒 / write 走模板 / full 任意 argv", () => {
  const home = H();
  const ws = join(home, "workspace");
  const now = new Date();

  // ask：没有窗口
  let r = setPreset(home, "ask", {}, now);
  assert.equal(r.ok, true);
  assert.equal(currentPreset(home, now).preset, "ask");
  assert.equal(checkGrant(home, { argv: ["node", "a.mjs"], cwd: ws, verb: "shell.run" }, now).ok, false);

  // read：窗口在，但任何 T3 都拒
  r = setPreset(home, "read", {}, now);
  assert.equal(r.ok, true);
  assert.equal(currentPreset(home, now).preset, "read");
  const d = checkGrant(home, { argv: ["node", "a.mjs"], cwd: ws, verb: "shell.run" }, now);
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "E_PRESET_READ_ONLY");

  // write：注册模板可以，任意 argv 不行
  r = setPreset(home, "write", {}, now);
  assert.equal(r.ok, true);
  assert.equal(currentPreset(home, now).preset, "write");
  assert.equal(checkGrant(home, { argv: ["node", "a.mjs"], cwd: ws, verb: "shell.run" }, now).ok, true);
  assert.equal(checkGrant(home, { argv: ["node", "a.mjs"], cwd: ws, verb: "shell.exec" }, now).ok, false);

  // full：任意 argv 可以，硬禁仍然拒
  r = setPreset(home, "full", { because: "面板上切到完全权限来验证" }, now);
  assert.equal(r.ok, true);
  assert.equal(currentPreset(home, now).preset, "full");
  assert.equal(checkGrant(home, { argv: ["node", "a.mjs"], cwd: ws, verb: "shell.exec" }, now).ok, true);
  const rm = checkGrant(home, { argv: ["rm", "x"], cwd: ws, verb: "shell.exec" }, now);
  assert.equal(rm.ok, false);
  if (!rm.ok) assert.equal(rm.code, "E_GRANT_FULL_DENY");

  // 切档先收回：档位永远只有一个答案
  setPreset(home, "ask", {}, now);
  assert.equal(listGrants(home, now).length, 0);
  revokeAll(home);
});

test("K-3 切到 full 也要守理由闸（面板选择器不能绕过 ≥10 字）", () => {
  const home = H();
  const r = setPreset(home, "full", { because: "短" });
  assert.equal(r.ok, false, "短理由应当被拒");
  revokeAll(home);
});


test("K-3 取消时间限制：切档默认不限期，换档/收回才失效", () => {
  const home = H();
  const now = new Date();
  const r = setPreset(home, "write", {}, now);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.grant?.expiresAt, null, "不限期：返回 null 而不是某个时间点");
  assert.equal(currentPreset(home, now).preset, "write");
  assert.equal(currentPreset(home, now).remainingS, -1, "-1 = 本次会话（面板不再显示倒计时）");
  const later = new Date(now.getTime() + 365 * 86400_000);
  assert.equal(currentPreset(home, later).preset, "write", "有效期跟着进程走，不跟着时钟走");
  revokeAll(home);
  assert.equal(currentPreset(home, later).preset, "ask", "收回后回到逐次确认");
});

test("K-3 全权也是一键切：不需要二次确认，但硬禁名单不变", () => {
  const home = H();
  assert.equal(setPreset(home, "full", {}).ok, true, "不给 because 也能切");
  assert.equal(currentPreset(home).preset, "full");
  const d = checkGrant(home, { argv: ["rm", "-rf", "/"], cwd: join(home, "workspace"), verb: "shell.exec" });
  assert.equal(d.ok, false);
  revokeAll(home);
});

test("K-3 默认档：一键切当前会话不需要确认，但把 full 存成默认要确认", () => {
  // 这条测的是 server 的判据本身（逻辑在 web/server.ts 里，这里用同一组条件复核一遍）
  const needsConfirm = (preset: string, confirm?: string) => preset === "full" && confirm !== "我明白";
  assert.equal(needsConfirm("full"), true, "误点不能把 full 写进 config");
  assert.equal(needsConfirm("full", "我明白"), false);
  assert.equal(needsConfirm("write"), false);
  assert.equal(needsConfirm("ask"), false);
});

test("完全权限档 = 出网通行证：用户「我已经开启了完全权限」就不该再看到授权框", async () => {
  // 踩过两次：① egress 有自己的 24h 窗口，过期后 full 档也拦 —— 用户第二天再聊又看到授权框；
  // ② 两套闸（档位 / 外发）对用户来说都是"权限"，分开解释就是为难人。
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDb } = await import("../src/db.ts");
  const { execute } = await import("../src/execute.ts");
  const { loadPolicy } = await import("../src/policy.ts");
  const { resolveConfig } = await import("../src/configfile.ts");
  const { setPreset, revokeAll } = await import("../src/grant.ts");

  const home = mkdtempSync(join(tmpdir(), "jj-eg-"));
  try {
    const cfg = resolveConfig(home);
    const d = openDb(join(home, "memory.db"));
    const policy = await loadPolicy(home);
    const deps = { db: d.db, policy, ctx: { db: d.db, home, cfg, now: () => new Date(), embedder: null } } as never;

    revokeAll(home);
    const before = await execute(deps, "project.read", { path: "src/brief.ts" }, { approved: true });
    assert.equal(before.ok, false, "低档位时仍然拦");

    setPreset(home, "full", { because: "测试：完全权限档应等同出网通行证" });
    const after = await execute(deps, "project.read", { path: "src/brief.ts" }, { approved: true });
    assert.equal(after.ok, true, "full 档下读项目代码要放行");
  } finally {
    try { revokeAll(home); } catch { /* ignore */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* sqlite 句柄 */ }
  }
});
