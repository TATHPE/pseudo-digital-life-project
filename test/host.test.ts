import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { loadPolicy } from "../src/policy.ts";
import { execute } from "../src/execute.ts";
import { detectShells, resolveShell, scriptArgv, profileOf, withUtf8Output } from "../src/host.ts";

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

test("PowerShell 输出编码：只包 -Command，不动 -File 与别的命令", () => {
  const ps = "C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe";
  const a = withUtf8Output([ps, "-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem"]);
  assert.equal(a.wrapped, true);
  assert.match(a.argv[4]!, /\[Console\]::OutputEncoding=\[Text\.Encoding\]::UTF8/);
  assert.match(a.argv[4]!, /Get-ChildItem/, "用户命令要在前奏之后原样保留");

  // -File：跑脚本文件，参数语义不能被改
  const f = withUtf8Output([ps, "-File", "a.ps1", "-x"]);
  assert.equal(f.wrapped, false);
  assert.deepEqual(f.argv, [ps, "-File", "a.ps1", "-x"]);

  // 不是 PowerShell 就不碰
  assert.equal(withUtf8Output(["node", "-e", "1"]).wrapped, false);
  assert.equal(withUtf8Output(["git", "status"]).wrapped, false);

  // pwsh 也包（大写 / .exe 都认）
  assert.equal(withUtf8Output(["C:/x/PWSH.EXE", "-Command", "1"]).wrapped, true);
});

test("按扩展名选解释器：.mjs 给 node，.ps1 给 PowerShell（不能一律用配置的那个）", () => {
  // 实测事故：她写了 patch-market.mjs，script.run 却用 PowerShell 去跑 →
  // 直接报「Windows PowerShell」+ 乱码退出码（exit=4294770688）。
  const ps = { kind: "powershell" as const, label: "ps5.1", argv: ["powershell", "-NoProfile", "-NonInteractive", "-File"] };
  const bash = { kind: "bash" as const, label: "bash", argv: ["C:/Program Files/Git/bin/bash.exe"] };

  const mjs = scriptArgv(ps as never, "C:/data/workspace/x.mjs");
  assert.match(String(mjs[0]), /node/i, ".mjs 必须用 node 跑：" + mjs[0]);
  assert.equal(mjs[1], "C:/data/workspace/x.mjs");

  const py = scriptArgv(ps as never, "x.py");
  assert.match(String(py[0]), /python/i, ".py 要用 python");

  // .ps1 即使配的是 bash，也得换回 PowerShell（-File 必须在）
  const ps1 = scriptArgv(bash as never, "x.ps1");
  assert.match(ps1.join(" "), /powershell|pwsh/i, ".ps1 必须用 PowerShell：" + ps1.join(" "));
  assert.ok(ps1.includes("-File"), "要带 -File");

  // .sh 走 bash；配置是 ps 也要换
  const sh = scriptArgv(ps as never, "x.sh");
  assert.match(String(sh[0]), /bash/i, ".sh 要用 bash");

  // 认不出扩展名 → 保持原行为（用配置的）
  const other = scriptArgv(ps as never, "x.unknown");
  assert.equal(other[0], "powershell");
});
