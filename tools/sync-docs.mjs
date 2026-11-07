/**
 * H-2 ①：把**对外**的设计文档同步进代码仓（`docs/`）。
 *
 * 为什么只同步一部分（2026-11-06 用户定）：仓库是公开的，
 * 交接文档（HANDOFF）、待办（22）、计划（19）与决策记录属于**内部笔记**，
 * 里面有本机路径、用户名、没做完的判断 —— 不该跟着代码一起公开。
 *
 * 做法：**单向生成 + 白名单**。文档仓仍是唯一真源；这里只挑 PUBLIC 里的。
 * 每个文件顶部写清"别在这儿改"，但**不再写死 D:/LLM 的具体路径**。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** 公开的设计文档：只放"讲设计"的，不放"讲进度/决策/交接"的 */
export const PUBLIC = [
  "design/0-定义-数字生命.md",
  "design/01-记忆动力学.md",
  "design/02-存储与索引层.md",
  "runtime/04-执行层与权限分级.md",
  "runtime/11-技能与插件兼容.md",
  "runtime/13-模型与API配置方案.md",
  "design/17-界面与上下文.md",
  "runtime/18-断电与自我更新.md",
  "runtime/21-语言与技术栈选择.md",
  "ops/23-发布-桌面端-首次配置.md",
  "ops/24-基准与口径.md",
  "ops/25-常驻指令-设计记录.md",
  "runtime/26-降级与编排.md",
];

const ROOT = process.cwd();
const SRC = join(ROOT, "..", "docs");
const DST = join(ROOT, "docs");

if (!existsSync(SRC)) {
  console.error("找不到上层文档仓：" + SRC);
  process.exit(1);
}
mkdirSync(DST, { recursive: true });

const header = (name) =>
  [
    "<!-- 自动生成，别在这个文件里改 -->",
    "<!-- 真源：文档仓的 " + name + "（改完跑 npm run docs:sync） -->",
    "",
  ].join(String.fromCharCode(10));

// 2026-11-07：上层 docs/ 分了子目录（design/runtime/ops/history），
// 所以不能只 readdir 顶层 —— 要按 PUBLIC 里的相对路径逐个 existsSync。
const have = { has: (f) => existsSync(join(SRC, f)) };
const files = PUBLIC.filter((f) => have.has(f));
const missing = PUBLIC.filter((f) => !have.has(f));
if (missing.length) console.error("上层文档仓缺这些（已跳过）：" + missing.join(" "));

let n = 0;
const index = [
  "# 设计文档（同步副本）",
  "",
  "> 这些文件由 `npm run docs:sync` 从文档仓按**白名单**生成，不要在这里改（会被覆盖）。",
  "> 只同步「讲设计」的文档；交接、待办、计划、决策记录属于内部笔记，不在本仓。",
  "",
  "| 文件 | 大小 |",
  "|---|---|",
];

for (const f of files) {
  const src = join(SRC, f);
  const body = readFileSync(src, "utf8");
  mkdirSync(dirname(join(DST, f)), { recursive: true });
  writeFileSync(join(DST, f), header(f) + body, "utf8");
  index.push(`| [${f}](${f}) | ${(body.length / 1024).toFixed(1)} KB |`);
  n++;
}

// 以前同步过、现在不在白名单里的：从仓库里删掉（否则它们会一直留在公开仓）
const stale = readdirSync(DST).filter(
  (f) => f.endsWith(".md") && !["README.md", "map.md", ...PUBLIC].includes(f),
);
for (const f of stale) {
  try {
    unlinkSync(join(DST, f));
    console.log("移出公开仓：" + f);
  } catch { /* 删不掉就算了 */ }
}

index.push("", "共 " + n + " 个文件。");
writeFileSync(join(DST, "README.md"), index.join(String.fromCharCode(10)) + String.fromCharCode(10), "utf8");

console.log(`已同步 ${n} 个文件 → ${relative(ROOT, DST)}`);
