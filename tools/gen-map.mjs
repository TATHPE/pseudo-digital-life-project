/**
 * H-3：生成 `docs/map.md`（项目地图）。
 *
 * 为什么不是手写：手写的清单三天后一定和代码不一致，而且没人会去核对。
 * 这里只做一件事 —— **从代码里读出事实**，写进一张表；
 * 然后 `tools/map-check.mjs` 用"重新生成一遍再比"的方式抓不一致。
 *
 * 读什么（都是可机械判定的事实）：
 *   · 文件清单（src/**\/*.ts）与每个文件首行注释的目的
 *   · 错误码 E_*（谁抛的）
 *   · verbs（名字 / 档位 / 文件）
 *   · CLI 子命令（src/commands.ts 的 CLI_COMMANDS）
 *   · 六条纪律落点（人工维护的一小段，check 会验证它指向的文件与符号真的存在）
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "docs", "map.md");

/** 八条纪律的落点：check 会验证 文件存在 且 该文件里出现过 symbol */
const INVARIANTS = [
  ["一条执行路径", "src/execute.ts", "export async function execute"],
  ["没接上 = 没做完", "tools/ui-test.mjs", "check("],
  ["闸门先于模型", "src/nightly.ts", "export function isNoise"],
  ["参数有界", "src/decayparams.ts", "RANGES"],
  ["内容只是资料", "src/verbs.ts", "E_NEEDS_EGRESS"],
  ["改功能先列清单", "AGENTS.md", "改一个功能先列清单"],
  ["写入单入口", "src/store.ts", "export function updateMemoryText"],
  ["L0 字节级不变", "test/l0-prefix.test.ts", "PINNED_PREFIX_HASH"],
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, "src")).sort();
const rel = (p) => relative(ROOT, p).split("\\").join("/");

/** 文件头第一句有信息量的话（跳过空行与装饰线） */
function purposeOf(text) {
  const lines = text.split(String.fromCharCode(10)).slice(0, 12);
  for (const l of lines) {
    const t = l.replace(/^[\s/*#-]+/, "").trim();
    if (!t) continue;
    if (t.startsWith("@") || t.length < 6) continue;
    return t.slice(0, 70);
  }
  return "";
}

const codeRe = /\bE_[A-Z0-9]{2,}[A-Z0-9_]*\b/g;
const codes = new Map();
const fileRows = [];

for (const p of files) {
  const text = readFileSync(p, "utf8");
  const name = rel(p);
  fileRows.push([name, purposeOf(text)]);
  for (const m of text.matchAll(codeRe)) {
    const code = m[0];
    if (!codes.has(code)) codes.set(code, new Set());
    codes.get(code).add(name);
  }
}

// verbs：name/tier 成对出现
const verbSrc = readFileSync(join(ROOT, "src", "verbs.ts"), "utf8");
const verbRows = [...verbSrc.matchAll(/name:\s*"([a-z][a-z0-9_.]*)",\s*tier:\s*"(T\d)"/g)]
  .map((m) => [m[1], m[2]])
  .sort((a, b) => a[0].localeCompare(b[0]));

// CLI 子命令
const cmdSrc = readFileSync(join(ROOT, "src", "commands.ts"), "utf8");
const cmds = [...cmdSrc.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);

const lines = [];
lines.push("<!-- 自动生成：npm run map（别手改；改了 map:check 会红） -->");
lines.push("# 项目地图（H-3）");
lines.push("");
lines.push(
  "> 这张表由 `tools/gen-map.mjs` 从代码里读出来，`npm run map:check` 会**重新生成一遍再比**：",
  "> 只要代码变了而这里没更新，check 就红。**它是防「文档说的和代码不一样」的那道闸。**",
);
lines.push("");
lines.push("## 统计");
lines.push("");
lines.push("| 项 | 数量 |");
lines.push("|---|---|");
lines.push(`| 源文件（src/**/*.ts） | ${files.length} |`);
lines.push(`| 错误码 E_* | ${codes.size} |`);
lines.push(`| verbs | ${verbRows.length} |`);
lines.push(`| CLI 子命令 | ${cmds.length} |`);
lines.push("");

lines.push("## 六条纪律落点");
lines.push("");
lines.push("| 纪律 | 文件 | 符号 |");
lines.push("|---|---|---|");
for (const [name, file, sym] of INVARIANTS) lines.push(`| ${name} | \`${file}\` | \`${sym}\` |`);
lines.push("");

lines.push("## 错误码 E_*");
lines.push("");
lines.push("| 错误码 | 抛出位置 |");
lines.push("|---|---|");
for (const [code, where] of [...codes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`| \`${code}\` | ${[...where].sort().map((w) => "`" + w + "`").join(" ")} |`);
}
lines.push("");

lines.push("## verbs（能力目录）");
lines.push("");
lines.push("| verb | 档位 |");
lines.push("|---|---|");
for (const [name, tier] of verbRows) lines.push(`| \`${name}\` | ${tier} |`);
lines.push("");

lines.push("## CLI 子命令");
lines.push("");
lines.push(cmds.map((c) => "`" + c + "`").join(" · "));
lines.push("");

lines.push("## 源文件");
lines.push("");
lines.push("| 文件 | 干什么 |");
lines.push("|---|---|");
for (const [name, why] of fileRows) lines.push(`| \`${name}\` | ${why.replace(/\|/g, "/")} |`);
lines.push("");

writeFileSync(OUT, lines.join(String.fromCharCode(10)), "utf8");
console.log(`已生成 ${rel(OUT)}：${files.length} 文件 / ${codes.size} 错误码 / ${verbRows.length} verbs / ${cmds.length} 命令`);
if (!existsSync(OUT)) process.exit(1);
