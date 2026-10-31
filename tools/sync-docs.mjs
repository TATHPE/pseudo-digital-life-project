/**
 * H-2 ①：把设计文档同步进代码仓（`docs/`）。
 *
 * 为什么要有这一步：设计文档本来住在上层的文档仓（`D:/LLM/docs`），
 * 但别人 clone 代码仓时看不到它们 —— 而 `project.read` 的白名单里明明有 `docs/`，
 * 结果就是"能力表里写着自己能读 docs，实际那个目录不存在"。
 *
 * 做法：**单向生成**。文档仓是唯一真源，这里是产物；每个文件顶部写清"别在这儿改"。
 * 这样既不会两份手改打架，clone 下来也能读到全部设计口径。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

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
    "<!-- 真源：" + "D:/LLM/docs/" + name + "（改完跑 npm run docs:sync） -->",
    "",
  ].join(String.fromCharCode(10));

const files = readdirSync(SRC).filter((f) => f.endsWith(".md")).sort();
let n = 0;
const index = [
  "# 设计文档（同步副本）",
  "",
  "> 这些文件由 `npm run docs:sync` 从**上层文档仓**生成，**不要在这里改**（会被覆盖）。",
  "> 改法：在文档仓改完，回到代码仓跑 `npm run docs:sync`。",
  "",
  "| 文件 | 大小 |",
  "|---|---|",
];

for (const f of files) {
  const src = join(SRC, f);
  const body = readFileSync(src, "utf8");
  writeFileSync(join(DST, f), header(f) + body, "utf8");
  index.push(`| [${f}](${f}) | ${(body.length / 1024).toFixed(1)} KB |`);
  n++;
}

// HANDOFF 一起带上：它是"接手这个项目先读什么"
const handoff = join(ROOT, "..", "HANDOFF.md");
if (existsSync(handoff)) {
  copyFileSync(handoff, join(DST, "HANDOFF.md"));
  index.push("| [HANDOFF.md](HANDOFF.md) | 上手清单（同样由上层仓同步） |");
  n++;
}

index.push("", "共 " + n + " 个文件。");
writeFileSync(join(DST, "README.md"), index.join(String.fromCharCode(10)) + String.fromCharCode(10), "utf8");

console.log(`已同步 ${n} 个文件 → ${relative(ROOT, DST)}`);
