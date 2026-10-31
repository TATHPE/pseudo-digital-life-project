/**
 * 跑测试 + 收尾清理。
 *
 * 为什么要包一层：每个测试都 `mkdtempSync(join(tmpdir(), "jj-*"))` 建临时 home，跑完不删；
 * 337 条测试 → 每轮在 %TEMP% 根留 200+ 个目录。
 * Node 24.21 还不支持 `--test-global-teardown`（实测 `bad option`），所以在这里收。
 *
 * 只删 `%TEMP%/jj-*`；正在被占用的跳过（Windows 上会 EPERM），下一轮再收。
 */
import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = ["--test", ...(process.argv.slice(2).length ? process.argv.slice(2) : ["test/*.test.ts"])];

const code = await new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: "inherit", cwd: process.cwd() });
  p.on("close", (c) => resolve(c ?? 1));
});

// ── 收尾：删本轮（以及以前留下的）测试临时目录 ──────────────
try {
  const T = tmpdir();
  let removed = 0;
  for (const n of readdirSync(T)) {
    if (!n.startsWith("jj-")) continue;
    try { rmSync(join(T, n), { recursive: true, force: true, maxRetries: 2 }); removed++; } catch { /* 占用中 */ }
  }
  if (removed) console.log(`（清理 ${removed} 个临时目录）`);
} catch { /* 清理失败不影响测试结果 */ }

// 删掉不会被 teardown 罩住的旧版全局 teardown 文件（如果还在的话）
process.exitCode = code;
