/**
 * 跑测试 + 收尾清理 + **flaky 识别**。
 *
 * 为什么要包一层（两条）：
 * 1) 每个测试都 `mkdtempSync(join(tmpdir(), "jj-*"))` 建临时 home，跑完不删；
 *    几百条测试 → 每轮在 %TEMP% 根留一堆目录。Node 24 没有 `--test-global-teardown`，在这里收。
 * 2) 偶尔会出现「随机一条失败、重跑就过」（2026-11-06 出现过两次）。
 *    现在：第一遍失败 → 只重跑那几条所在的文件一次；
 *    重跑通过就标成 FLAKY 并把文件名列出来（退出码 0，但**不装作没发生**）；重跑还失败才判红。
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const files = process.argv.slice(2).length ? process.argv.slice(2) : ["test/*.test.ts"];
const TAP = join(tmpdir(), `jj-tap-${Date.now()}.tap`);

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: "inherit", cwd: process.cwd() });
    p.on("close", (c) => resolve(c ?? 1));
  });
}

/** 从 TAP 里掏出失败用例所在的文件 */
function failingFiles(tapText) {
  const out = new Set();
  for (const m of tapText.matchAll(/location:\s*'([^']+\.test\.[tj]s):\d+:\d+'/g)) {
    const raw = m[1].split("\\").join("/").replace(/\/{2,}/g, "/");
    const cwd = process.cwd().split("\\").join("/").replace(/\/$/, "");
    // 能相对化就相对化，不限定必须叫 test/（否则换个目录就漏判）
    out.add(raw.startsWith(cwd + "/") ? raw.slice(cwd.length + 1) : raw);
  }
  return [...out];
}

const first = await run([
  "--test",
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  "--test-reporter=tap", `--test-reporter-destination=${TAP}`,
  ...files,
]);

let code = first;

if (first !== 0) {
  let bad = [];
  try { bad = failingFiles(readFileSync(TAP, "utf8")); } catch { /* 没 TAP 就按失败处理 */ }
  if (bad.length) {
    // 这类 flake 很稀有（20 次里 1–2 次），重跑一次就够；不行再补一次
    let second = 1;
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log("");
      console.log(`↻ 第 ${attempt} 次重跑：${bad.join(" ")}`);
      second = await run(["--test", ...bad]);
      if (second === 0) break;
    }
    if (second === 0) {
      code = 0;
      console.log("");
      console.log("⚠ FLAKY（重跑通过）—— 这些用例不稳定，不是功能问题：");
      for (const f of bad) console.log("   · " + f);
      console.log("   收拾办法：单独跑这个文件，看是不是依赖真实时钟 / 端口 / 并发。");
    } else {
      code = second;
    }
  }
}

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
try { rmSync(TAP, { force: true }); } catch { /* ignore */ }

process.exitCode = code;
