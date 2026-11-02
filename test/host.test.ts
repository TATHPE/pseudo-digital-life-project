import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { loadPolicy } from "../src/policy.ts";
import { execute } from "../src/execute.ts";
import { detectShells, resolveShell, scriptArgv, profileOf } from "../src/host.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-host-"));

test("解释器探测：Windows 上默认挑 PowerShell 5.1（系统自带）", () => {
  const found = detectShells();
  if (process.platform !== "win32") {
    assert.ok(found.bash.kind !== "none" || found.none.kind === "none", "非 Windows 上看 bash");
    return;
  }
  assert.equal(found.powershell.kind, "powershell", "系统自带的一定找得到");
  assert.match(found.powershell.path, /powershell\.exe$/i);
  assert.equal(found.powershell.label, "ps5.1");
});

test("默认 auto → PowerShell；profile 记 win-local/ps5.1", () => {
  const home = H();
  const r = resolveShell(home);
  assert.equal(r.wanted, "auto");
  assert.equal(r.fellBack, false);
  if (process.platform === "win32") {
    assert.equal(r.shell.kind, "powershell");
    assert.equal(profileOf(r.shell), "win-local/ps5.1");
  }
});

test("点名要一个没装的解释器 → 退回自动，且**说明原因**（不静默变 direct）", () => {
  const home = H();
  writeFileSync(join(home, "config.json"), JSON.stringify({ host: { shell: "gitbash", gitbashPath: "C:/nope/bash.exe" } }), "utf8");
  const r = resolveShell(home);
  assert.equal(r.wanted, "gitbash");
  // 机器上真装了 Git Bash 的话这里会 selected；否则必须 fellBack 且**不是** none
  if (r.fellBack) {
    assert.ok(r.reason && r.reason.length > 0, "回退要说明原因");
    assert.notEqual(r.shell.kind, "none", "退回自动也不能掉到 direct");
  }
});

test("scriptArgv：解释器前缀在前、脚本在中、参数在后", () => {
  const shell = { kind: "powershell" as const, path: "X:/ps.exe", label: "ps5.1", argv: ["X:/ps.exe", "-File"] };
  assert.deepEqual(scriptArgv(shell, "w.ps1", ["a", "b"]), ["X:/ps.exe", "-File", "w.ps1", "a", "b"]);
  const none = { kind: "none" as const, path: "", label: "direct", argv: [] };
  assert.deepEqual(scriptArgv(none, "x.sh"), ["x.sh"]);
});

test("script.run：用配置的解释器真跑一个脚本；越界与无窗口都拒", async () => {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  const isWin = process.platform === "win32";
  const script = isWin ? "hello.ps1" : "hello.sh";
  writeFileSync(join(home, "workspace", script), isWin ? "Write-Output 'hi'\n" : "echo hi\n", "utf8");
  const d = openDb(join(home, "m.db"));
  const policy = await loadPolicy(home);
  const grant = { id: "grn_test", commands: [], scope: "*", full: true };
  const ctx = { home, now: () => new Date("2026-11-01T00:00:00Z"), env: {}, grant };

  const ok = await execute({ db: d.db, policy, ctx }, "script.run", { script: "workspace/" + script }, { approved: true });
  assert.equal(ok.ok, true, ok.output);
  assert.match(ok.output, /hi/, "脚本真的跑了");
  assert.match(ok.output, /win-local\/ps5\.1|linux-local\/bash/, "审计里要看得到宿主");

  const esc = await execute({ db: d.db, policy, ctx }, "script.run", { script: "../evil.ps1" });
  assert.equal(esc.ok, false);
  assert.match(esc.output, /E_BAD_ARGV/);

  const outside = await execute({ db: d.db, policy, ctx }, "script.run", { script: "evil.ps1" });
  assert.equal(outside.ok, false, "不在 workspace/ 下也要拒");

  const noGrant = await execute({ db: d.db, policy, ctx: { home, now: () => new Date(), env: {} } }, "script.run", { script: "workspace/" + script }, { approved: true });
  assert.equal(noGrant.ok, false);
  assert.match(noGrant.output, /E_GRANT_NEEDS_FULL/);
});
