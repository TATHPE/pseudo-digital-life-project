/**
 * H-8：跑一次评测，把**口径**和结果一起焊死。
 *
 * 为什么要工具而不是手抄：手抄的数字没有出生证明。
 * 这里一次抓齐 —— commit（含是否有未提交改动）、日期、每个 role 用的模型、
 * embed 模型、衰减参数版本、用例文件的 sha256 与分组条数 —— 然后
 *   · 原始 JSON 落盘到 docs/eval-runs/<sha8>-<日期>.json
 *   · 在 docs/ops/24-基准与口径.md 的表里追加一行
 *
 * 纪律：**同一个 sha + 同一个模型 + 同一份用例**才能和旧数字比。
 * 换个模型、改个阈值、动一下提示，就要新开一行，旧数字不许混引（学自 Twig 的"口径焊死"）。
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();
const DOCS = join(ROOT, "..", "docs");
const DOC = join(DOCS, "24-基准与口径.md");
const RUNS = join(DOCS, "eval-runs");

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  return { out: String(r.stdout ?? "").trim(), code: r.status ?? 1 };
};

// ── ① 跑评测 ─────────────────────────────────────────
console.log("跑评测（jingjing eval --json）…");
const t0 = Date.now();
const run = spawnSync(process.execPath, ["src/cli/jingjing.ts", "eval", "--json"], { cwd: ROOT, encoding: "utf8" });
const ms = Date.now() - t0;
const raw = String(run.stdout ?? "");
const start = raw.indexOf("{");
if (start < 0) { console.error("评测没有输出 JSON：", raw.slice(0, 400), String(run.stderr ?? "").slice(0, 400)); process.exit(1); }
const report = JSON.parse(raw.slice(start));
if (!Array.isArray(report.gates)) { console.error("评测 JSON 形状不对"); process.exit(1); }

// ── ② 抓口径 ─────────────────────────────────────────
const sha = sh("git", ["rev-parse", "HEAD"]).out;
const dirty = sh("git", ["status", "--porcelain"]).out.length > 0;
const cfgPath = join(ROOT, "data", "config.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
const casesPath = join(ROOT, "data", "eval", "cases.jsonl");
const casesBuf = existsSync(casesPath) ? readFileSync(casesPath) : Buffer.from("");
const casesHash = createHash("sha256").update(casesBuf).digest("hex").slice(0, 12);
const byGroup = {};
for (const line of casesBuf.toString("utf8").split("\n")) {
  if (!line.trim()) continue;
  try { const j = JSON.parse(line); byGroup[j.group] = (byGroup[j.group] ?? 0) + 1; } catch { /* 坏行跳过 */ }
}
const decayVer = (() => {
  const src = readFileSync(join(ROOT, "src", "decay.ts"), "utf8");
  const m = src.match(/DECAY_PARAMS_VERSION\s*=\s*(\d+)/);
  return m ? m[1] : "?";
})();
const local = cfg.local ?? {};
const embed = local.embed ?? "?";
const casesCount = Object.values(byGroup).reduce((a, b) => a + b, 0);

// 本地日（YYYY-MM-DD）：.mjs 不能直接 import .ts，这里内联同一口径，别再用 UTC 切片
const tNow = new Date();
const today = `${tNow.getFullYear()}-${String(tNow.getMonth() + 1).padStart(2, "0")}-${String(tNow.getDate()).padStart(2, "0")}`;

const row = {
  date: today,
  sha: sha.slice(0, 8),
  dirty,
  cases: casesCount,
  casesHash,
  groups: byGroup,
  models: {
    local_default: local.default ?? "?",
    embed,
    express: cfg.express?.model ?? "?",
  },
  decayVer,
  gates: Object.fromEntries(report.gates.map((g) => [g.name, g.value])),
  pass: Boolean(report.pass),
  latency: report.latency ?? null,
  ms,
  json: report,
};

// ── ③ 落盘原始结果 ───────────────────────────────────
mkdirSync(RUNS, { recursive: true });
const rawPath = join(RUNS, `${row.sha}-${row.date}${dirty ? "-dirty" : ""}.json`);
writeFileSync(rawPath, JSON.stringify(row, null, 2), "utf8");
console.log("原始结果 →", rawPath);

// ── ④ 追加一行到口径表 ───────────────────────────────
if (!existsSync(DOC)) {
  console.error("找不到 docs/ops/24-基准与口径.md（先建骨架，别让工具替你写叙事）");
  process.exit(1);
}
const gate = (n) => (row.gates[n] === undefined ? "—" : String(row.gates[n]));
const line = [
  "|",
  row.date,
  "|",
  "`" + row.sha + (row.dirty ? "*" : "") + "`",
  "|",
  String(row.cases),
  "（" + Object.entries(row.groups).map(([k, v]) => k + " " + v).join(" / ") + "）",
  "|",
  gate("recall@k"), "|", gate("abstainF1"), "|", gate("trapRate"), "|", gate("contract"),
  "|",
  row.pass ? "✅" : "❌",
  "|",
].join(" ");
// 必须插进「结果」表里，不能追加到文件末尾（否则会跑到「口径变更声明」下面去）
const doc = readFileSync(DOC, "utf8").split(String.fromCharCode(10));
const secStart = doc.findIndex((l) => l.trim() === "## 结果");
if (secStart < 0) { console.error("docs/ops/24 里找不到「## 结果」小节"); process.exit(1); }
let lastRow = -1;
for (let i = secStart; i < doc.length; i++) {
  const l = doc[i].trim();
  if (l.startsWith("|")) lastRow = i;
  else if (lastRow >= 0 && l === "") break;   // 表格结束
}
if (lastRow < 0) { console.error("「结果」小节里没有表格"); process.exit(1); }
// 占位行（见下一行）直接替换，否则插在最后一行之后
if (doc[lastRow].includes("见下一行")) doc[lastRow] = line;
else doc.splice(lastRow + 1, 0, line);
writeFileSync(DOC, doc.join(String.fromCharCode(10)), "utf8");
console.log("口径表已追加一行：", line.trim());

if (!row.pass) process.exitCode = 1;
