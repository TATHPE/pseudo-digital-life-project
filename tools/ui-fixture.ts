/**
 * 面板 UI 测试的夹具：起一个**独立**的服务（独立 JJ_HOME + 7701 端口），
 * 里面预置"有提议、有抽检线、有记忆溯源"的数据，然后跑 ui-test。
 *
 * 为什么必须这样：之前的 ui-test 直接打死面板（127.0.0.1:7700 / data/），
 * 而新加的两条断言是**破坏性**的（点「不做」会把提议拒掉、点「不对」会把线断掉）——
 * 在真数据上跑一次，人攒的提议就没了。测试不该改用户的东西。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { createProposal } from "../src/proposals.ts";
import { pushReceipt } from "../src/notify.ts";
import { addStanding } from "../src/standing.ts";
import { appendEvent, newEventId } from "../src/journal.ts";

const ROOT = process.cwd();
const HOME = join(ROOT, "tmp", "ui-home");
const PORT = 7701;

// 每次从零开始，避免上一轮的"已拒/已断"状态影响断言
if (existsSync(HOME)) rmSync(HOME, { recursive: true, force: true });
mkdirSync(join(HOME, "inbox"), { recursive: true });

const d = openDb(join(HOME, "memory.db"));
const now = new Date();

// ① 一条带原话 + 改过痕迹的记忆（F-1 #5 的断言要用）
const m1 = remember(d.db, {
  layer: "contract", kind: "promise", subject: "生日",
  text: "下周三生日提醒已建立，会提前买蛋糕", importance: 5, salience: 0.9,
  sensitivity: "shareable", sourceKind: "extract", sourceRef: "夜间抽取（2026-10-31）",
  quote: "我妈下周三生日，记得提醒我提前买蛋糕", scoredBy: "extract:qwen2.5:7b-instruct", now,
});
d.db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
  .run(now.toISOString(), "memory_text_changed", "human:panel", String(m1),
    JSON.stringify({ before: "00000000", after: "11111111", by: "human:panel", before_text: "下周三生日，提前买蛋糕" }));

// ② 两根本该被抽检的线（weight 低的一根排前面）
const a = remember(d.db, { layer: "narrative", kind: "episode", text: "她说过讨厌被叫小朋友", now });
const b = remember(d.db, { layer: "narrative", kind: "episode", text: "今天被同事叫小朋友有点烦", now });
const c = remember(d.db, { layer: "narrative", kind: "episode", text: "每周三晚上要交周报", now });
const e = remember(d.db, { layer: "narrative", kind: "episode", text: "周三晚上他问我周报交了没", now });
d.db.prepare("INSERT INTO memory_links(src_id,dst_id,rel,weight,why,created_at) VALUES(?,?,?,?,?,?)")
  .run(a, b, "related", 0.38, "都提到「小朋友」这个称呼（推的，没核实）", now.toISOString());
d.db.prepare("INSERT INTO memory_links(src_id,dst_id,rel,weight,why,created_at) VALUES(?,?,?,?,?,?)")
  .run(c, e, "related", 0.55, "都跟周三周报有关（推的）", now.toISOString());

// F-3 分页夹具：多造几条，让侧栏「看更早的」真的能翻（初始只给 8 条）
for (let i = 1; i <= 9; i++) {
  remember(d.db, {
    layer: "narrative", kind: "episode",
    text: `第 ${i} 条用来测分页的记忆：随便聊了点日常${i}`,
    importance: 2, salience: 0.4, sensitivity: "shareable", sourceKind: "extract", now,
  });
}
// ③ 一张等回应的提议
createProposal(HOME, {
  title: "给记忆列表加分页",
  why: "侧栏只铺 40 条，翻不到旧记忆，人会以为它们没了",
  plan: ["后端收 limit/offset", "侧栏加「看更早的」"],
  argv: ["node", "tools/run-tests.mjs"],
  touches: ["jingjing/src/web/page.ts"],
}, now);

// ④ 两条对话：UI 测试里「头像默认鲸尾」需要一条 agent 行，也让面板不是空白
for (const [i, ev] of [
  { kind: "utterance", text: "在吗" },
  { kind: "agent_reply", text: "在。刚刚把今天的对话翻了一遍。" },
].entries()) {
  appendEvent(join(HOME, "inbox"), {
    v: 1, id: newEventId(), ts: new Date(Date.now() - 60000 + i * 1000).toISOString(),
    kind: ev.kind, actor: ev.kind === "utterance" ? "user" : "agent", payload: { text: ev.text },
  });
}

// ⑤ D-3 夹具：一条待读回执 + 一条常驻指令（面板要能显示、能标读、能停用）
pushReceipt(HOME, { kind: "standing", ok: true, title: "std-check 跑完了：node.run_script",
  body: "exit=0 std-ok", source: "standing:std-check" }, now);
addStanding(HOME, { id: "std-check", when: "daily 09:00", template: "node.run_script",
  slots: { script: "x.mjs" }, because: "每天看一眼日志里有没有 E_", notify: "panel" }, now);
// ── 起服务（独立端口，不与日常面板抢 7700）────────────
const log = join(ROOT, "tmp", "ui-home-serve.log");
const srv = spawn(process.execPath, ["src/cli/jingjing.ts", "serve", String(PORT)], {
  cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, JJ_HOME: HOME },
});
let srvErr = "";
srv.stderr.on("data", (x) => { srvErr += String(x); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { up = true; break; } } catch { /* wait */ }
}
if (!up) {
  console.error("❌ 夹具服务起不来：" + srvErr.slice(0, 300));
  srv.kill();
  process.exit(1);
}

const code = await new Promise<number>((resolve) => {
  const t = spawn(process.execPath, ["tools/ui-test.mjs", `http://127.0.0.1:${PORT}/`], { cwd: ROOT, stdio: "inherit" });
  t.on("close", (c) => resolve(c ?? 1));
});

srv.kill();
console.log(`（夹具 ${HOME} · 日志 ${log}）`);
process.exitCode = code;
