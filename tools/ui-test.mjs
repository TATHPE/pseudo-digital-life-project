/** headless Edge + CDP：真点、真发、检查布局（输入框必须在视口内） */
const URL_PAGE = process.argv[2] ?? "http://127.0.0.1:7700/";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9333;
const [VW, VH] = (process.env.UI_VIEWPORT ?? '1440x900').split('x').map(Number);
import { spawn } from "node:child_process";

const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox",
  `--user-data-dir=${process.env.TEMP || "/tmp"}/jj-edge-${Date.now()}`, "--hide-scrollbars",
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
// 指定 UI_VIEWPORT 时用设备模拟（--window-size 在 Windows 上会被 DPI 缩放成别的尺寸）
if (process.env.UI_VIEWPORT) {
  await send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 2, mobile: true });
}
await send("Page.navigate", { url: URL_PAGE }); await sleep(2500);

const out = [];
const check = (n, ok, d = "") => out.push([n, ok, d]);
/** 库是空的就跳过（首次安装/清空后就是这样），既不算红也不算绿 */
const skip = (n, why) => out.push([n, null, why]);

// 布局：输入框必须在视口内且可见
const box = await js(`(() => { const r = document.querySelector('#composer').getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, w: Math.round(r.width) }; })()`);
check("输入框在视口内", box && box.bottom <= box.vh + 1 && box.top > 0, JSON.stringify(box));

// 侧栏可点：工具 → 工具详情（工具列表现在默认折叠，先展开）
check("工具项可点", await js(`(() => {
  const fold = document.querySelector('#foldtools');
  if (fold && document.querySelector('#toollist').hidden) fold.click();
  const b = document.querySelector('#side .item[data-view=toolview]');
  if (!b) return false; b.click();
  return !document.querySelector('#toolview').hidden;
})()`));
const toolTitle = await js(`document.querySelector('#t-title').textContent`);
check("工具详情有内容", typeof toolTitle === "string" && toolTitle.length > 3, toolTitle);

// 记忆 → 记忆详情（空库时没有可点的项，跳过而不是报错）
const hasMem = await js("!!document.querySelector('#side .item[data-view=memview]')");
if (hasMem) {
  check("记忆项可点", await js(`(() => {
    const b = document.querySelector('#side .item[data-view=memview]');
    if (!b) return false; b.click();
    return true;
  })()`));
  await sleep(900);
  check("记忆详情打开了", (await js(`!document.querySelector('#memview').hidden`)) === true,
    await js(`document.querySelector('#mv-meta').textContent`));
} else {
  skip("记忆项可点", "库里没有记忆（初始状态）");
  skip("记忆详情打开了", "同上；用 jingjing remember \"…\" 造一条再跑") }

// 设置
check("设置可点", await js(`(() => { document.querySelector('#side .item[data-view=cfg]').click(); return !document.querySelector('#cfg').hidden; })()`));

// 会话跳转（点第二天的会话后仍在对话视图）
check("会话可点回到对话", await js(`(() => {
  const b = [...document.querySelectorAll('#side .item[data-view=chat]')].pop();
  if (!b) return false; b.click(); return !document.querySelector('#chat').hidden;
})()`));

// 发一句话（比较“消息数”而不是文本长度：空库时占位文案可能比一条回复还长）
const countMsgs = `document.querySelectorAll('#chat .row').length`;
const before = await js(countMsgs);
await js(`(() => { const i = document.querySelector('#m'); i.value = '用三个字回答：在吗';
  document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true })); return true; })()`);
await sleep(6000);
const after = await js(countMsgs);
check("发送后有新内容", after >= before + 2, `${before} → ${after} 条`);
check("无 JS 运行时错误", errs.length === 0, errs.slice(0, 2).join(" | "));

// 图标：标签页 favicon 是静态 /icon.svg（以前是运行时 data URI，viewBox 写死导致空白）
check("favicon 指向 /icon.svg 且能取到", (await js(`(async () => {
  const l = document.querySelector('link[rel=icon][type="image/svg+xml"]');
  if (!l) return false;
  const r = await fetch(l.href);
  if (!r.ok) return false;
  const t = await r.text();
  return t.includes('viewBox="0 0 512 512"') && t.includes("M453.004");
})()`)) === true);

// 头像：默认是鲸尾 symbol；用户传了自定义图之后就是 <img>（两种都算对）
check("头像默认鲸尾 / 自定义为图片", await js(`(() => {
  const av = document.querySelector(".row.agent .av");
  if (!av) return false;
  const use = av.querySelector("svg use");
  const img = av.querySelector("img.avi");
  return (!!use && use.getAttribute("href") === "#whale") ||
         (!!img && String(img.getAttribute("src")).indexOf("/avatar/agent") === 0);
})()`));
check("换头像框立即生效", await js(`(() => {
  const s = document.querySelector("#a-frame");
  if (!s) return false;
  s.value = "ring";
  s.dispatchEvent(new Event("change"));
  return document.body.dataset.av === "ring";
})()`));
check("侧栏分区可折叠", await js(`(() => {
  const b = document.querySelector('[data-tog=mem]');
  if (!b) return false;
  const sec = b.closest('.sec');
  b.click();
  const hidden = sec.querySelector('div').hidden;
  b.click();
  return hidden === true && sec.querySelector('div').hidden === false;
})()`));

// 视图切换："回到最新"是对话专用的；滚回对话时不该跳回顶部
await js(`(() => { document.querySelector("#side .item[data-view=chat]").click(); return true; })()`);
await sleep(400);
const scrolled = await js(`(() => { const el=document.querySelector("#scroll");
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 400);
  el.dispatchEvent(new Event("scroll")); return Math.round(el.scrollTop); })()`);
await js(`document.querySelector("#side .item[data-view=cfg]").click()`); await sleep(500);
// 「回到最新」只能在对话里出现：把几个能滚的视图都切一遍，各自滚到中间看它冒不冒出来
const jumpSeen = [];
for (const sel of ['#doclist .item[data-doc]', '#side .item[data-view=cfg]', '#auditlist .item']) {
  const clicked = await js('(function(){ var b=document.querySelector("' + sel.replace("'", "") + '"); if(!b) return false; b.click(); return true; })()');
  if (!clicked) { jumpSeen.push(sel + '=skip'); continue; }
  await sleep(600);
  await js('(function(){ var el=document.querySelector("#scroll"); el.scrollTop=Math.floor(el.scrollHeight/2); el.dispatchEvent(new Event("scroll")); })()');
  await sleep(200);
  const disp = await js('getComputedStyle(document.querySelector("#jump")).display');
  jumpSeen.push(sel + '=' + disp);
}
check("非对话界面都没有「回到最新」", jumpSeen.every((x) => x.endsWith('=none') || x.endsWith('=skip')), jumpSeen.join(' | '));
await js(`document.querySelector("#side .item[data-view=chat]").click()`); await sleep(700);
const back = await js(`Math.round(document.querySelector("#scroll").scrollTop)`);
check("切回对话保住滚动位置", Math.abs(back - scrolled) <= 8, `${scrolled} → ${back}`);

// 侧栏多选一：点第 2 篇文档时，第 1 篇不能还挂着框
await js(`(() => { document.querySelector("#side .item[data-doc]").click(); return true; })()`); await sleep(600);
await js(`(() => { const d = document.querySelectorAll("#doclist .item[data-doc]"); if (d[1]) d[1].click(); return true; })()`); await sleep(600);
const onCount = await js(`({ total: document.querySelectorAll("#side .item.on").length, docs: document.querySelectorAll("#doclist .item.on").length })`);
check("侧栏同时只有一项被框", onCount.total === 1 && onCount.docs <= 1, JSON.stringify(onCount));

// 切到面板必须回到顶部：对话是自动贴底的，带着 scrollTop 切过去会落到设置的最底部
check("进设置回到顶部", await js(`(() => {
  document.querySelector("#side .item[data-view=chat]").click();
  document.querySelector("#side .item[data-view=cfg]").click();
  return document.querySelector("#scroll").scrollTop;
})()`) === 0);
check("回对话仍贴底", await js(`(async () => {
  document.querySelector("#side .item[data-view=chat]").click();
  await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  const el = document.querySelector("#scroll");
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
})()`) === true);
check("分区标题是带粗左边的标签条 + 格子有角标", await js(`(() => {
  const h = document.querySelector(".sec h3");
  const s = getComputedStyle(h);
  const tick = getComputedStyle(document.querySelector(".item"), "::after");
  return s.borderLeftWidth === "3px" && tick.borderTopWidth === "1px";
})()`));

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
