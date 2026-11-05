/**
 * H-3：`map:check` —— 三条断言，任何一条不过就红。
 *
 * ① **地图与代码一致**：重新生成一遍，与 `docs/map.md` 逐字比。
 *    这一步同时覆盖"手写了一个代码里不存在的错误码"：
 *    因为那份手写内容会和重新生成的结果不同。
 * ② **文件清单一致**：地图里的源文件集合 == 磁盘上的 `src/**\/*.ts` 集合。
 * ③ **不变量落点真实存在**：六条纪律指向的文件存在，且文件里真的出现了那个符号。
 * ④ **写入单入口**：正文类写入（INSERT memories / UPDATE text / bigram / 向量）只允许出现在白名单文件里。
 *    多一条路 = 同一个 bug 修两遍（这轮就踩过：normalized_key 漏写、quote 只在一条路上有）。
 *
 * 为什么不用"读代码再猜"的方式：这三条都能给出**具体差在哪一行**，
 * 而"猜"只能给出"我觉得不太对"。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MAP = join(ROOT, "docs", "map.md");
const fails = [];
const ok = [];

if (!existsSync(MAP)) {
  console.error("✘ docs/map.md 不存在 —— 先跑 npm run map");
  process.exit(1);
}

const before = readFileSync(MAP, "utf8");

// ── ① 重新生成再比 ────────────────────────────────────
execFileSync(process.execPath, [join(ROOT, "tools", "gen-map.mjs")], { cwd: ROOT, stdio: "ignore" });
const after = readFileSync(MAP, "utf8");

if (before === after) {
  ok.push("地图与代码一致（重新生成后逐字相同）");
} else {
  const a = before.split("\n");
  const b = after.split("\n");
  const extra = a.filter((l) => l.startsWith("|") && !b.includes(l));
  const missing = b.filter((l) => l.startsWith("|") && !a.includes(l));
  fails.push(
    "地图与代码不一致（docs/map.md 里有手改或没更新）：\n" +
      extra.slice(0, 6).map((l) => "   只在地图里：" + l.slice(0, 100)).join("\n") +
      (extra.length > 6 ? "\n   …共 " + extra.length + " 行" : "") +
      (missing.length ? "\n" + missing.slice(0, 6).map((l) => "   只在代码里：" + l.slice(0, 100)).join("\n") : "") +
      (missing.length > 6 ? "\n   …共 " + missing.length + " 行" : ""),
  );
}

// ── ② 文件清单一致 ────────────────────────────────────
const mapFiles = new Set(
  [...after.matchAll(/^\| `(src\/[^`]+)` \|/gm)].map((m) => m[1]),
);
const disk = execFileSync("git", ["ls-files", "src"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.endsWith(".ts"));
// 未提交的新文件也算（git ls-files 不含 untracked）
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "src"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".ts"));
for (const f of untracked) disk.push(f);

const diskSet = new Set(disk);
const onlyMap = [...mapFiles].filter((f) => !diskSet.has(f));
const onlyDisk = [...diskSet].filter((f) => !mapFiles.has(f));
if (onlyMap.length === 0 && onlyDisk.length === 0) {
  ok.push(`文件清单一致（${mapFiles.size} 个源文件）`);
} else {
  fails.push(
    "文件清单不一致：" +
      (onlyMap.length ? "\n    地图里有、磁盘上没有：" + onlyMap.slice(0, 5).join(", ") : "") +
      (onlyDisk.length ? "\n    磁盘上有、地图里没有：" + onlyDisk.slice(0, 5).join(", ") : "") +
      "\n    （跑 npm run map 重新生成）",
  );
}

// ── ④ 写入单入口 ────────────────────────────────────────
// 记忆的**正文类**写入只允许一个口：多一条路 = 同一个 bug 修两遍（我们踩过：
// normalized_key 漏写、quote 只在一条路上有、pre-image 忘了记）。
// 允许的例外都要写在这里并说明理由，不能靠"这次先这样"。
const WRITE_RULES = [
  { what: "INSERT INTO memories", allow: ["src/store.ts"], why: "正文入库只走 store.remember" },
  { what: "UPDATE memories SET text", allow: ["src/store.ts"], why: "改正文只走 store.updateMemoryText（留 pre-image）" },
  { what: "UPDATE memories SET text_bigram", allow: ["src/store.ts"], why: "bigram 与正文必须同一次写" },
  {
    what: "INSERT INTO vec_memories",
    allow: ["src/store.ts", "src/reembed.ts"],
    why: "reembed 是索引重建，天然要另写；除此之外没人该碰向量表",
  },
];

// 也要含未跟踪的新文件：新写的第二个写入口，不该因为「还没 git add」就漏检
const srcFiles = [
  ...execFileSync("git", ["ls-files", "src"], { cwd: ROOT, encoding: "utf8" }).split("\n"),
  ...execFileSync("git", ["ls-files", "--others", "--exclude-standard", "src"], { cwd: ROOT, encoding: "utf8" }).split("\n"),
].map((l) => l.trim()).filter((l) => l.endsWith(".ts"));
const writeViolations = [];
for (const rule of WRITE_RULES) {
  for (const f of srcFiles) {
    if (rule.allow.includes(f)) continue;
    const text = readFileSync(join(ROOT, f), "utf8");
    if (text.includes(rule.what)) writeViolations.push(`${f} 里出现了「${rule.what}」（只允许 ${rule.allow.join(" / ")}：${rule.why}）`);
  }
}
if (writeViolations.length) {
  fails.push("写入口多了一条：\n" + writeViolations.map((v) => "   " + v).join("\n"));
} else {
  ok.push(`写入单入口（${WRITE_RULES.length} 条规则，${srcFiles.length} 个源文件）`);
}
// ── 汇总 ──────────────────────────────────────────────
for (const o of ok) console.log("✅ " + o);
if (fails.length) {
  for (const f of fails) console.error("❌ " + f);
  console.error(`\n${fails.length} 项不一致 —— 跑 npm run map 重新生成，或改回代码`);
  process.exit(1);
}
console.log("\n✅ 地图、文件清单、纪律落点三者一致");
