/**
 * 性能基线（2026-11-14 P2 产品化）。分两层，别混为一谈：
 *
 *  · **闸门层（CI）**：纯函数耗时，用跨机器的绝对上限判退化。
 *    buildBrief / estimateTokens 是每轮对话都跑的热路径，一旦有人把它们改成 O(n²)
 *    或塞进同步 IO，这里会先红，而不是等用户觉得「她变慢了」。
 *  · **观测层（本地）**：真实冷启动耗时，从 data/logs/shell.log 的 start→healthy 时间戳统计。
 *    它依赖具体机器与开机状态，**不放进 CI 闸门**，只写进基线文件供发版前后对照。
 *    同源还有一层 [boot] 行（listen/desk/health/mcp 四段打点），同样只在这里统计 p50/p95。
 *
 * 用法：
 *   node --experimental-strip-types tools/bench-baseline.ts            # 生成 docs/ops/perf-baseline.json
 *   node --experimental-strip-types tools/bench-baseline.ts --ci        # 只跑闸门，不写文件
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrief } from "../src/brief.ts";
import { estimateTokens } from "../src/tokens.ts";
import type { BriefInput, PersonaFiles } from "../src/types.ts";
import { parseBootLines, summarizeBootTiming } from "./boot-timing.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "ops", "perf-baseline.json");
const CI = process.argv.includes("--ci");

/** 绝对上限：实测这些纯函数都在 1ms 内，留几十倍余量给慢 CI/冷 JIT，只抓数量级退化。 */
const LIMITS = { brief_p95_ms: 40, tokens_p95_ms: 5 } as const;

const persona: PersonaFiles = {
  core: "你叫鲸鲸。说话短、具体、不编。",
  boundaries: "不确定的事说不知道；不编共同经历。",
  evidenceOrder: "先看出处，再看时间；没有证据就不要下结论。",
  toolSchemas: "remember(text) / search(q) / beat()",
  toolDirectory: "记忆、检索、心跳、导出备份。",
};
const briefInput: BriefInput = {
  now: new Date("2026-11-14T12:00:00+08:00"),
  persona,
  contracts: ["用户希望被称呼为小林"],
  recalled: [],
  user: "今天还有什么没做完的？",
};
const tokenSample = "情境简报 P10 候选证据与契约层条目；".repeat(40);

interface Stat { p50: number; p95: number; max: number; iters: number }

function measure(fn: () => void, iters: number): Stat {
  for (let i = 0; i < Math.min(20, iters); i++) fn(); // 预热，别把 JIT 算进 p95
  const xs: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    fn();
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  const at = (q: number) => Number(xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!.toFixed(4));
  return { p50: at(0.5), p95: at(0.95), max: at(1), iters };
}

/** 从壳的真实日志里统计 start → healthy，不需要起进程、不会留下常驻服务。 */
function startupFromLog(): Record<string, number | string | null> | null {
  const candidates = [
    process.env.JJ_HOME ? join(process.env.JJ_HOME, "logs", "shell.log") : "",
    "D:/Pseudo Digital Life Project/data/logs/shell.log",
    join(ROOT, "data", "logs", "shell.log"),
  ].filter(Boolean);
  const path = candidates.find((p) => existsSync(p));
  if (!path) return null;
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const starts: number[] = [], healthy: number[] = [];
  for (const l of lines) {
    const m = l.match(/^\[(\d+)\]\s*(.*)$/);
    if (!m) continue;
    const ts = Number(m[1]);
    if (m[2]!.startsWith("start:")) starts.push(ts);
    if (m[2]!.startsWith("healthy")) healthy.push(ts);
  }
  const gaps: number[] = [];
  for (const h of healthy) {
    const s = starts.filter((x) => x <= h).pop();
    if (s !== undefined && s <= h) gaps.push(h - s);
  }
  gaps.sort((a, b) => a - b);
  const at = (q: number) => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))]! : null;
  return {
    source: path, samples: gaps.length,
    p50_s: at(0.5), p95_s: at(0.95), max_s: gaps.at(-1) ?? null,
    missing_healthy: Math.max(0, starts.length - healthy.length),
  };
}

// ── 观测层：[boot] 四段打点（纯观测，--ci 分支完全不碰）──────────────
/** shell.log 候选路径：与 startupFromLog 同一份口径，单独列出来只为复用。 */
function findShellLog(): string | null {
  const candidates = [
    process.env.JJ_HOME ? join(process.env.JJ_HOME, "logs", "shell.log") : "",
    "D:/Pseudo Digital Life Project/data/logs/shell.log",
    join(ROOT, "data", "logs", "shell.log"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * 解析 [boot] 行，统计四段耗时的 p50/p95。**找不到就明确写「无打点数据」，不伪造数字**。
 * 返回对象可直接塞进 baseline.boot；仅在非 --ci 分支调用。
 */
function bootFromLog(): Record<string, unknown> {
  const path = findShellLog();
  if (!path) return { note: "无打点数据（找不到 shell.log）" };
  const samples = parseBootLines(readFileSync(path, "utf8"));
  if (!samples.length) return { source: path, note: "无打点数据（shell.log 里没有 [boot] 行）" };
  return { source: path, ...summarizeBootTiming(samples)! };
}

function describeBoot(obs: Record<string, unknown>): string {
  if (typeof obs.note === "string") return `  [boot] 打点      ${obs.note}`;
  const m = obs.mcp as { p50: number; p95: number };
  return `  [boot] 打点      mcp p50=${m.p50}ms p95=${m.p95}ms  样本=${String(obs.samples)}  MCP失败=${String(obs.mcpFailed)}`;
}

const brief = measure(() => { buildBrief(briefInput); }, 300);
const tokens = measure(() => { estimateTokens(tokenSample); }, 1500);
const briefOut = buildBrief(briefInput);
const gates: Array<[string, number, number, boolean]> = [
  ["brief_p95_ms", brief.p95, LIMITS.brief_p95_ms, brief.p95 <= LIMITS.brief_p95_ms],
  ["tokens_p95_ms", tokens.p95, LIMITS.tokens_p95_ms, tokens.p95 <= LIMITS.tokens_p95_ms],
];
const contentOk = briefOut.tokens > 0 && briefOut.tokens <= 2600;

if (CI) {
  for (const [name, got, limit, ok] of gates) {
    console.log(`${ok ? "✅" : "❌"} ${name}: ${got} ms（上限 ${limit} ms）`);
  }
  console.log(`${contentOk ? "✅" : "❌"} 装配输出 tokens=${briefOut.tokens}（0 < n ≤ 2600）`);
  const bad = gates.filter(([, , , ok]) => !ok).length + (contentOk ? 0 : 1);
  console.log(bad ? `❌ ${bad} 项性能/正确性退化` : "✅ 性能基线闸门通过");
  process.exitCode = bad ? 1 : 0;
} else {
  const bootObs = bootFromLog();
  const baseline = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    note: "纯函数指标是 CI 闸门（跨机器绝对上限）；启动指标来自本机真实日志，CI 不判，仅供发版前后对照。",
    limits: LIMITS,
    pure: { buildBrief: brief, estimateTokens: tokens, briefTokens: briefOut.tokens },
    startup: startupFromLog(),
    boot: bootObs,
  };
  writeFileSync(OUT, JSON.stringify(baseline, null, 2) + "\n");
  console.log("已写出 docs/ops/perf-baseline.json");
  console.log(`  buildBrief      p50=${brief.p50} ms  p95=${brief.p95} ms`);
  console.log(`  estimateTokens  p50=${tokens.p50} ms  p95=${tokens.p95} ms`);
  console.log(`  装配输出        ${briefOut.tokens} tokens`);
  console.log(baseline.startup
    ? `  真实启动        p50=${String(baseline.startup.p50_s)} s  p95=${String(baseline.startup.p95_s)} s  样本 ${String(baseline.startup.samples)}  缺 healthy ${String(baseline.startup.missing_healthy)}`
    : "  真实启动        无 shell.log（CI/新机器），该项留空");
  console.log(describeBoot(bootObs));
  process.exitCode = contentOk ? 0 : 1;
}
