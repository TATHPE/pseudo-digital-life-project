import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { loadPolicy } from "../src/policy.ts";
import { execute } from "../src/execute.ts";
import {
  enableSuper, disableSuper, readSuper, superEnabled, isRescuePath, isDiskFormatting,
} from "../src/supergrant.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-super-"));

test("默认是关的；文件坏了也当没开（不给自己开后门）", () => {
  const home = H();
  assert.equal(superEnabled(home), false);
  writeFileSync(join(home, "super.json"), "{ 半个 json", "utf8");
  assert.equal(superEnabled(home), false);
});

test("点一下就能开（确认步骤已取消，2026-11-01）；关随时可以", () => {
  const home = H();
  // 不写理由也能开 —— 只管留痕，不拦人
  const ok = enableSuper(home, {});
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.state.enabled, true);
    assert.equal(ok.state.because, "（没写理由）", "没写就说没写，不假装有理由");
  }
  assert.equal(superEnabled(home), true);
  // 写了理由就记下来
  const withWhy = enableSuper(home, { because: "要它自己迁移记忆库" });
  assert.equal(withWhy.ok, true);
  if (withWhy.ok) assert.equal(withWhy.state.because, "要它自己迁移记忆库");

  const off = disableSuper(home);
  assert.equal(off.ok, true);
  assert.equal(superEnabled(home), false);
  assert.equal(readSuper(home).because, undefined, "关了就不留旧理由");
});

test("两条永不放开：磁盘格式化 / 回收站与快照", () => {
  for (const b of ["format", "format.com", "mkfs", "mkfs.ext4", "diskpart", "diskpart.exe"]) {
    assert.equal(isDiskFormatting(b), true, b + " 该被认出来");
  }
  for (const b of ["rm", "node", "git", "del"]) assert.equal(isDiskFormatting(b), false, b + " 不该被误判");

  const home = "C:/x/data";
  assert.equal(isRescuePath(home, "C:/x/data/trash/2026/a.bin"), true);
  assert.equal(isRescuePath(home, "C:/x/data/snapshots/s1"), true);
  assert.equal(isRescuePath(home, "C:/x/data/memory.db"), false);
});

test("super 开启后：记忆库本体能直接改了（默认是 E_CORE_PROTECTED）", async () => {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  writeFileSync(join(home, "memory.db"), "fake", "utf8");
  const d = openDb(join(home, "m.db"));
  const policy = await loadPolicy(home);
  const ctx = { home, now: () => new Date("2026-11-01T00:00:00Z"), env: {} };

  const before = await execute({ db: d.db, policy, ctx }, "fs.write", { path: "memory.db", content: "x" });
  assert.equal(before.ok, false, "默认必须挡住");
  assert.match(before.output, /E_CORE_PROTECTED/);

  enableSuper(home, { because: "测超级权限放开记忆核心" });
  const after = await execute({ db: d.db, policy, ctx }, "fs.write", { path: "memory.db", content: "x" });
  assert.equal(after.ok, true, "开了 super 就该能写：" + after.output);

  disableSuper(home);
  const again = await execute({ db: d.db, policy, ctx }, "fs.write", { path: "memory.db", content: "y" });
  assert.equal(again.ok, false, "关掉之后立刻恢复拦截");
});

test("super 开启后：回收站里的一律不动", async () => {
  const home = H();
  mkdirSync(join(home, "trash", "2026"), { recursive: true });
  writeFileSync(join(home, "trash", "2026", "gone.md"), "x", "utf8");
  const d = openDb(join(home, "m.db"));
  const policy = await loadPolicy(home);
  const ctx = { home, now: () => new Date("2026-11-01T00:00:00Z"), env: {} };
  enableSuper(home, { because: "测回收站不放开" });
  const r = await execute({ db: d.db, policy, ctx }, "fs.write", { path: "trash/2026/gone.md", content: "y" });
  assert.equal(r.ok, false);
  assert.match(r.output, /E_SUPER_KEEP/);
});

test("权限的两个硬矛盾（2026-11-03）：默认解释器能跑脚本、用户切 ask 不被重启覆盖", async () => {
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setPreset, currentPreset, checkGrant, revokeAll, chosenPreset } = await import("../src/grant.ts");
  const { applyDefaultPosture } = await import("../src/posture.ts");
  const { disableSuper } = await import("../src/supergrant.ts");

  const home = mkdtempSync(join(tmpdir(), "jj-perm-"));
  try {
    mkdirSync(join(home, "workspace"), { recursive: true });
    const script = join(home, "workspace", "x.ps1");
    writeFileSync(script, "Write-Output ok\n");

    disableSuper(home);
    setPreset(home, "full", { because: "测试用：验证默认解释器能跑脚本" });

    // ① 矛盾一：默认解释器是 PowerShell，而它在 FULL_DENY 里 → script.run 之前永远被拒
    const ok = checkGrant(home, { argv: ["powershell", "-NoProfile", "-File", script], cwd: home, verb: "script.run", asInterpreter: true });
    assert.equal(ok.ok, true, "script.run 用默认解释器跑 home 内的脚本，必须放行");

    // 2026-11-06：-Command 也放开了（写文件再跑是等价能力，禁它只多花步骤）
    const inlineOk = checkGrant(home, { argv: ["powershell", "-NoProfile", "-Command", "whoami"], cwd: home, verb: "shell.exec" });
    assert.equal(inlineOk.ok, true, "powershell -Command 现在能跑（审计照留）");

    // 脚本在 home 外也拒
    const out = checkGrant(home, { argv: ["powershell", "-File", "C:/Windows/System32/evil.ps1"], cwd: home, verb: "script.run", asInterpreter: true });
    assert.equal(out.ok, false, "脚本必须在 home 内");

    // ② 2026-11-04：档位 UI 删了 → 永远 full（JJ_PARANOID=1 例外）
    setPreset(home, "ask", { because: "假装用户上次选过 ask" });
    revokeAll(home);                                  // 模拟进程重启（窗口只在内存）
    const r = applyDefaultPosture({} as never, home, { env: {} });
    assert.equal(r.preset, "full", "永远 full：UI 没了，旧的 ask 不可能再改回来");
    assert.equal(currentPreset(home).preset, "full");
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
