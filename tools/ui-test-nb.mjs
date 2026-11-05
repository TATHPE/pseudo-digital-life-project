/** headless Edge + CDP：真点、真发、检查布局。
 *  2026-11-05：面板换了（记录本），这套断言也跟着换 —— 旧面板已从程序里撤下，
 *  它那 58 条断言留在 git history 里（33a78ca 之前）。 */
const URL_PAGE = process.argv[2] ?? "http://127.0.0.1:7701/?skip=1";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9333;
const [VW, VH] = (process.env.UI_VIEWPORT ?? "1440x900").split("x").map(Number);
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const PROFILE = `${process.env.TEMP || "/tmp"}/jj-edge-${Date.now()}`;
const cleanupProfile = () => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 占用中就算了 */ } };
process.on("exit", cleanupProfile);

const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox",
  `--user-data-dir=${PROFILE}`, "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, `--window-size=${VW},${VH}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
    if (target?.webSocketDebuggerUrl) break;
  } catch { /* wait */ }
}
if (!target) { console.log("❌ CDP 连不上"); proc.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errs = [];
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") errs.push(m.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;

await send("Runtime.enable"); await send("Page.enable");
if (process.env.UI_VIEWPORT) {
  await send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
}
await send("Page.navigate", { url: URL_PAGE }); await sleep(2500);

const out = [];
const check = (n, ok, d = "") => out.push([n, ok, d]);
const skip = (n, why) => out.push([n, null, why]);

// ① 壳：三列都在，输入框在视口内
const layout = await js(`(() => {
  const q = (s) => document.querySelector(s);
  const r = q('#nb-say') ? q('#nb-say').getBoundingClientRect() : null;
  return {
    log: !!q('#nb-log'), view: !!q('#nb-view'), board: !!q('#nb-board'),
    rail: !!q('.nb-rail'), tabs: document.querySelectorAll('.nb-tab').length,
    days: document.querySelectorAll('.nb-day').length,
    inputBottom: r ? Math.round(r.bottom) : -1, vh: innerHeight,
    top: !!q('.nb-top')
  };
})()`);
check("记录本三列都在（目录 / 正文 / 切口）", layout && layout.log && layout.rail && layout.top);
check("输入框在视口内", layout && layout.inputBottom > 0 && layout.inputBottom <= layout.vh, JSON.stringify(layout));
check("切口四个签", layout && layout.tabs === 4, String(layout && layout.tabs));
if (layout && layout.days > 0) check("左栏按天有记录", true, layout.days + " 天");
else skip("左栏按天有记录", "库里还没有对话");

// ② 正文：消息带页边时间戳
const entries = await js(`document.querySelectorAll('#nb-log .nb-e').length`);
if (entries > 0) {
  check("每条有页边时间戳", await js(`(() => {
    const e = document.querySelector('#nb-log .nb-e');
    const g = e && e.querySelector('.g');
    return !!g && /\\d{2}:\\d{2}/.test(g.textContent || '');
  })()`));
  check("她的话是青色左边线", await js(`(() => {
    const her = document.querySelector('#nb-log .nb-e.her .nb-say');
    if (!her) return true;   // 库里只有用户消息时不算错
    return getComputedStyle(her).borderLeftColor.includes('15, 151, 164');
  })()`));
} else skip("每条有页边时间戳", "空库");

// ③ 切口签能开合
check("点切口签能展开面板", await js(`(async () => {
  const t = document.querySelector('.nb-tab[data-t="3"]');
  if (!t) return false;
  t.click();
  await new Promise((r) => setTimeout(r, 500));
  const p = document.getElementById('nb-panel');
  return p && !p.hidden && p.textContent.length > 4;
})()`));
check("再点一次收起来", await js(`(async () => {
  const t = document.querySelector('.nb-tab[data-t="3"]');
  t.click();
  await new Promise((r) => setTimeout(r, 300));
  const p = document.getElementById('nb-panel');
  return p && p.hidden === true;
})()`));

// ④ 去处：记忆 → 列表 → 详情 → 回来
const memOk = await js(`(async () => {
  const go = document.querySelector('.nb-go[data-v="mem"]');
  if (!go) return 'NO_MEM';
  go.click();
  await new Promise((r) => setTimeout(r, 900));
  return document.querySelectorAll('#nb-mlist [data-mem]').length;
})()`);
if (memOk === 'NO_MEM') check("记忆页能打开", false, "左栏没有记忆入口");
else if (!memOk) skip("记忆列表有条目", "库里还没有记忆");
else {
  check("记忆页能打开且列出条目", true, memOk + " 条");
  check("点一条能进详情（有种类/来源/采集）", await js(`(async () => {
    const row = document.querySelector('#nb-mlist [data-mem]');
    row.click();
    await new Promise((r) => setTimeout(r, 700));
    const t = document.getElementById('nb-view').textContent || '';
    return /种类/.test(t) && /来源/.test(t) && /采集/.test(t);
  })()`));
  check("详情能回到列表", await js(`(async () => {
    const b = document.getElementById('nb-mback') || document.getElementById('nb-mback3');
    if (!b) return false;
    b.click();
    await new Promise((r) => setTimeout(r, 600));
    return !!document.querySelector('#nb-mlist');
  })()`));
}

// ⑤ 其余去处都能渲染，不白屏、不报错
for (const [v, label, marker] of [["docs", "文档", "nb-docs"], ["cap", "能力", "nb-cap"], ["cfg", "设置", "nb-cfg"]]) {
  check(label + "页能打开", await js(`(async () => {
    const b = document.querySelector('.nb-go[data-v="${v}"]');
    if (!b) return false;
    b.click();
    // 有些页要等接口回来（能力页还会顺带探一遍本地端点）：轮询，不赌一个固定延时
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const el = document.getElementById('${marker}');
      const t = (el && el.textContent) || '';
      if (t.length > 6 && t.indexOf('读取中') < 0) return true;
    }
    return false;
  })()`));
}
check("校样页能打开", await js(`(async () => {
  const b = document.querySelector('.nb-go[data-v="git"]');
  if (!b) return false;
  b.click();
  await new Promise((r) => setTimeout(r, 900));
  const el = document.getElementById('nb-git');
  return !!el && (el.textContent || '').length > 3;
})()`));

// ⑥ 她收着的
check("「她收着的」能翻出来", await js(`(async () => {
  const b = document.getElementById('nb-board-btn');
  if (!b) return false;
  b.click();
  await new Promise((r) => setTimeout(r, 900));
  const el = document.getElementById('nb-board');
  return el && !el.hidden && /她收着的/.test(el.textContent || '');
})()`));

// ⑦ 回到记录
check("能回到记录页", await js(`(async () => {
  const b = document.getElementById('nb-board-btn');
  b.click();
  await new Promise((r) => setTimeout(r, 400));
  const log = document.getElementById('nb-log');
  return log && !log.hidden;
})()`));

// ⑧ 没有 JS 运行时错误
check("没有 JS 运行时错误", errs.length === 0, errs.slice(0, 2).join(" | "));

ws.close(); proc.kill();
let bad = 0, skipped = 0;
for (const [n, ok, d] of out) {
  const mark = ok === null ? "⏭" : ok ? "✅" : "❌";
  console.log(`${mark} ${n}${d ? "  — " + String(d).slice(0, 80) : ""}`);
  if (ok === null) skipped++; else if (!ok) bad++;
}
if (bad) console.log(`\n❌ ${bad} 项失败` + (skipped ? `｜⏭ ${skipped} 项跳过` : ""));
else console.log("\n✅ 交互全部通过" + (skipped ? `｜⏭ ${skipped} 项跳过（空库）` : ""));
process.exitCode = bad ? 1 : 0;
