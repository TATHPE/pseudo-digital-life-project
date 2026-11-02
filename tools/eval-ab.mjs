/**
 * 查询改写的 A/B 对照：**同一份代码、同一份数据**，只切 JJ_QUERY_REWRITE 跑两次。
 *
 * 为什么不用活库：eval 用例会**随时间腐化**（10-31 那条「下周三生日」的 valid_to 已经过了，
 * 记忆按设计失效，用例必然红）。所以对照要跑在**冻结夹具库**上 —— 数据不动，只动代码开关。
 *
 * 用法：node tools/eval-ab.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HOME = "tmp/eval-rewrite/data";
const needle = "┃"; // 只用来对齐输出，不参与判定

if (!existsSync(join(HOME, "memory.db"))) {
  console.log("夹具库不存在，正在生成…");
  execFileSync(process.execPath, ["--experimental-strip-types", "tmp/make-eval-fixture2.mjs"], { stdio: "inherit" });
}

const run = (on) => {
  const env = { ...process.env, JJ_HOME: HOME, ...(on ? {} : { JJ_QUERY_REWRITE: "0" }) };
  // eval 有门不过时退出码是 1 —— 那是**被测结果**，不是脚本失败，所以不看退出码
  const out = spawnSync(process.execPath, ["src/cli/jingjing.ts", "eval"], { env, encoding: "utf8" }).stdout ?? "";
  const pick = (label) => {
    const line = out.split("\n").find((l) => l.includes(label)) ?? "";
    const m = line.match(/([0-9.]+)/);
    return m ? Number(m[1]) : NaN;
  };
  const fails = [...out.matchAll(/❌ (\S+)\s+(\w+)/g)].map((m) => m[1] + "(" + m[2] + ")");
  return {
    recall: pick("recall@k"),
    abstainF1: pick("abstainF1"),
    fail: fails.filter((f) => /^(rw|orig|ab|recall|abstain|trap|contract)-/.test(f)),
  };
};

const off = run(false);
const on = run(true);
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(3) : "-");
const delta = (a, b) => (a === b ? "±0" : (b - a > 0 ? "+" : "") + (b - a).toFixed(3));

console.log("");
console.log("  " + needle + " 指标        " + needle + " 改写关  " + needle + " 改写开  " + needle + " 差");
console.log("  " + "-".repeat(46));
console.log("  " + needle + " recall@k    " + needle + " " + fmt(off.recall).padEnd(7) + " " + needle + " " + fmt(on.recall).padEnd(7) + " " + needle + " " + delta(off.recall, on.recall));
console.log("  " + needle + " abstainF1   " + needle + " " + fmt(off.abstainF1).padEnd(7) + " " + needle + " " + fmt(on.abstainF1).padEnd(7) + " " + needle + " " + delta(off.abstainF1, on.abstainF1));
console.log("");
console.log("  改写关失败：" + (off.fail.join(" ") || "无"));
console.log("  改写开失败：" + (on.fail.join(" ") || "无"));
console.log("");
