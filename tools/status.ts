/**
 * 现状真源：把机器可验证的事实实测写进 STATUS.md（2026-11-17）。
 *
 * 为什么不是手写：现状散文分散在 HANDOFF §0.0 / README 表 / 22 / 24 四处，
 * 每次提交要人肉同步，已经漂移过两次（「771 条测试」「origin/main=5a58675」事故）。
 * 这里照 gen-map 的办法：**从机器里读事实**，`--check` 用「重新生成一遍再比」抓漂移。
 *
 * 只记可机械判定的事实：两仓 git 状态、六处版本号、schema、运行时依赖、
 * 源文件数、打包快照一致性。**不记测试数**（避免 check 递归跑测试；
 * 自检的唯一口径是 npm run check 的实测输出）。人工判断（真机验证级别 /
 * 分发状态 / 已接受边界）只写 ../docs/ops/22 §0.5，本文件不复述。
 *
 * 新鲜度比对豁免生成时间行与 git 状态行（HEAD / origin/main / 未提交改动）：
 * 它们随「提交」这个动作本身变化，若参与比对，每次提交后必红、再生成也追不上（自指）。
 * 闸门卡的是稳定事实：版本 / schema / 依赖 / 源文件数 / 快照一致性。git 行仍实测生成、
 * 绝不手写，跑 npm run status 即刷新；其他文档一律不引用具体 sha，只链接本文件。
 *
 * 这是**本地闸门**：bundle-src 与根仓都是本机事实，CI 里不存在，
 * 所以 process.env.CI 时自动跳过（不是假绿，是闸门适用范围之外）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersionConsistency, type VersionCheck } from "../src/release.ts";
import { checkDesktopBundle } from "./sync-desktop.ts";

const ROOT = resolve(import.meta.dirname, "..");

export interface GitFacts {
  repo: boolean;
  head: string;
  branch: string;
  dirty: number;
  origin: { sha: string; ahead: number; behind: number } | null;
  error: string;
}

export interface BundleFacts { ok: boolean; files: number; version: string; error: string }

export interface StatusFacts {
  repo: GitFacts;
  workspace: GitFacts;
  version: VersionCheck;
  schema: string;
  deps: string[];
  srcFiles: number;
  bundle: BundleFacts;
}

/** 只读 git 事实。不是仓库（夹具 / CI  checkout 的上层）就如实记 repo:false，不抛。 */
export function gitFacts(dir: string): GitFacts {
  const empty: GitFacts = { repo: false, head: "", branch: "", dirty: 0, origin: null, error: "" };
  if (!existsSync(join(dir, ".git"))) return empty;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true }).trim();
  try {
    const head = git("rev-parse", "--short", "HEAD");
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    // STATUS.md 自身不算漂移：它由本工具生成，生成后才出现在未提交清单里，
    // 不排除就会「生成 → check 必红」自指。其余未提交改动照常计数。
    const dirty = git("status", "--porcelain").split("\n")
      .filter((l) => l.trim() && l.slice(3).split(" -> ").pop() !== "STATUS.md").length;
    let origin: GitFacts["origin"] = null;
    if (git("remote").split("\n").includes("origin")) {
      try {
        const sha = git("rev-parse", "--short", "origin/main");
        const counts = git("rev-list", "--left-right", "--count", "HEAD...origin/main").split(/\s+/);
        origin = { sha, ahead: Number(counts[0] ?? 0), behind: Number(counts[1] ?? 0) };
      } catch { /* 有 origin 但没 origin/main（空远端）：如实记 null */ }
    }
    return { repo: true, head, branch, dirty, origin, error: "" };
  } catch (e) {
    return { ...empty, repo: true, error: String((e as Error).message).split("\n")[0] ?? "" };
  }
}

/** 与 gen-map 同口径：src 下全部 .ts。 */
function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

export function collectFacts(root = ROOT): StatusFacts {
  root = resolve(root);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const schema = readFileSync(join(root, "src/schema.ts"), "utf8").match(/SCHEMA_VERSION\s*=\s*(\d+)/)?.[1] ?? "MISSING";
  let bundle: BundleFacts;
  const app = join(root, "desktop/bundle-src/app");
  if (!existsSync(app)) {
    bundle = { ok: false, files: 0, version: "", error: "打包快照缺失（desktop/bundle-src/app 不存在）；先跑 npm run desktop:sync" };
  } else {
    try {
      const r = checkDesktopBundle(root);
      bundle = { ok: true, files: r.files, version: r.version, error: "" };
    } catch (e) {
      bundle = { ok: false, files: 0, version: "", error: (e as Error).message };
    }
  }
  return {
    repo: gitFacts(root),
    workspace: gitFacts(resolve(root, "..")),
    version: checkVersionConsistency(root),
    schema,
    deps: Object.keys(pkg.dependencies ?? {}).sort(),
    srcFiles: walkTs(join(root, "src")).length,
    bundle,
  };
}

function pushRepo(L: string[], g: GitFacts) {
  L.push("| 项 | 值 |");
  L.push("|---|---|");
  if (!g.repo) { L.push("| 仓库 | 不是 git 仓库（或不存在） |"); return; }
  if (g.error) { L.push(`| 仓库 | ❌ 读取失败：${g.error} |`); return; }
  L.push(`| HEAD | \`${g.head}\`（${g.branch}） |`);
  L.push(`| origin/main | ${g.origin ? `\`${g.origin.sha}\`（ahead ${g.origin.ahead} / behind ${g.origin.behind}）` : "无 origin/main（本地提交为主）"} |`);
  L.push(`| 未提交改动 | ${g.dirty} 个文件（不含本文件） |`);
}

/** 纯函数：同 facts 必逐字同输出。生成时间不在这里（check 比对时豁免时间行）。 */
export function renderStatus(f: StatusFacts): string {
  const L: string[] = [];
  L.push("# 当前事实（STATUS）");
  L.push("");
  L.push("> 机器事实只信本文件：`npm run status` 重生成，`npm run status:check` 抓漂移（挂在 npm run check 与 release:check 上）。");
  L.push("> 漂移比对豁免生成时间与 git 状态行（它们随提交动作变化）；版本 / schema / 依赖 / 源文件数 / 快照才是闸门卡的稳定事实。");
  L.push("> 人工判断（真机验证级别 / 分发状态 / 已接受边界）只写 `../docs/ops/22-待办与技术债.md` §0.5；");
  L.push("> 自检结果以 `npm run check` 实测输出为准，本文件不记测试数。");
  L.push("");
  L.push("## 代码仓（jingjing/）");
  L.push("");
  pushRepo(L, f.repo);
  L.push("");
  L.push("| 项 | 值 |");
  L.push("|---|---|");
  L.push(`| 版本（六处） | ${f.version.ok ? f.version.version + "，逐字一致" : "❌ 不一致：" + f.version.mismatches.map((m) => `${m.file}=${m.version}`).join("、")} |`);
  L.push(`| schema | v${f.schema} |`);
  L.push(`| 源文件（src/**/*.ts） | ${f.srcFiles} |`);
  L.push(`| 运行时依赖 | ${f.deps.length} 个：${f.deps.join(" / ")} |`);
  L.push(`| 打包快照（bundle-src） | ${f.bundle.ok ? `✅ 一致：${f.bundle.files} 个载荷文件（快照版本 ${f.bundle.version}）` : "❌ " + f.bundle.error} |`);
  L.push("");
  L.push("## 工作区根仓（../）");
  L.push("");
  pushRepo(L, f.workspace);
  L.push("");
  return L.join("\n");
}

const HEADER = "<!-- 自动生成，勿手改；重生成 npm run status，漂移由 npm run status:check 抓 -->\n";
// 豁免行：生成时间 + git 状态（随提交动作自指变化，见文件头注释）。
const VOLATILE_PREFIXES = ["生成时间：", "| HEAD |", "| origin/main |", "| 未提交改动 |"];
const stripVolatile = (t: string) => t.split("\n").filter((l) => !VOLATILE_PREFIXES.some((p) => l.startsWith(p))).join("\n");

export function writeStatus(root = ROOT): void {
  const text = HEADER + "生成时间：" + new Date().toISOString() + "\n" + renderStatus(collectFacts(root));
  writeFileSync(join(root, "STATUS.md"), text, "utf8");
}

/** 重新生成一遍再比（豁免行见 stripVolatile）：抓「稳定事实变了而 STATUS.md 没更新」。 */
export function checkStatus(root = ROOT): { ok: boolean; detail: string } {
  const file = join(root, "STATUS.md");
  if (!existsSync(file)) return { ok: false, detail: "缺 STATUS.md；先跑 npm run status" };
  const canonical = HEADER + renderStatus(collectFacts(root));
  const existing = stripVolatile(readFileSync(file, "utf8"));
  return stripVolatile(canonical) === existing
    ? { ok: true, detail: "STATUS.md 与实测一致" }
    : { ok: false, detail: "STATUS.md 与实测不一致；跑 npm run status 重生成" };
}

/** 闸门入口：CI 里跳过（bundle-src / 根仓是本机事实，CI 不存在），本地真查。 */
export function statusGate(root = ROOT): { ok: boolean; detail: string } {
  if (process.env.CI) return { ok: true, detail: "CI 环境跳过（STATUS 是本地闸门：bundle-src / 根仓不在 CI）" };
  return checkStatus(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const r = statusGate();
    console.log((r.ok ? "✅ " : "❌ ") + r.detail);
    if (!r.ok) process.exitCode = 1;
  } else {
    writeStatus();
    console.log("✅ 已生成 STATUS.md（机器事实实测；人工判断见 ../docs/ops/22 §0.5）");
  }
}