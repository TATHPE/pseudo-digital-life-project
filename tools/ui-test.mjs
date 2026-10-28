/** headless Edge + CDP：真点、真发、检查布局（输入框必须在视口内） */
const URL_PAGE = process.argv[2] ?? "http://127.0.0.1:7700/";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9333;
import { spawn } from "node:child_process";

const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
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
await send("Page.navigate", { url: URL_PAGE }); await sleep(2500);

const out = [];
const check = (n, ok, d = "") => out.push([n, ok, d]);

// 布局：输入框必须在视口内且可见
const box = await js(`(() => { const r = document.querySelector('#composer').getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, w: Math.round(r.width) }; })()`);
check("输入框在视口内", box && box.bottom <= box.vh + 1 && box.top > 0, JSON.stringify(box));

// 侧栏可点：工具 → 工具详情
check("工具项可点", await js(`(() => {
  const b = document.querySelector('#side .item[data-view=toolview]');
  if (!b) return false; b.click();
  return !document.querySelector('#toolview').hidden;
})()`));
const toolTitle = await js(`document.querySelector('#t-title').textContent`);
check("工具详情有内容", typeof toolTitle === "string" && toolTitle.length > 3, toolTitle);

// 记忆 → 记忆详情
check("记忆项可点", await js(`(() => {
  const b = document.querySelector('#side .item[data-view=memview]');
  if (!b) return false; b.click();
  return true;
})()`));
await sleep(900);
check("记忆详情打开了", (await js(`!document.querySelector('#memview').hidden`)) === true,
  await js(`document.querySelector('#mv-meta').textContent`));

// 设置
check("设置可点", await js(`(() => { document.querySelector('#side .item[data-view=cfg]').click(); return !document.querySelector('#cfg').hidden; })()`));

// 会话跳转（点第二天的会话后仍在对话视图）
check("会话可点回到对话", await js(`(() => {
  const b = [...document.querySelectorAll('#side .item[data-view=chat]')].pop();
  if (!b) return false; b.click(); return !document.querySelector('#chat').hidden;
})()`));

// 发一句话
const before = await js(`document.querySelector('#chat').textContent.length`);
await js(`(() => { const i = document.querySelector('#m'); i.value = '用三个字回答：在吗';
  document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true })); return true; })()`);
await sleep(6000);
const after = await js(`document.querySelector('#chat').textContent.length`);
check("发送后有新内容", after > before, `${before} → ${after}`);
check("无 JS 运行时错误", errs.length === 0, errs.slice(0, 2).join(" | "));

ws.close(); proc.kill();
let bad = 0;
for (const [n, ok, d] of out) { console.log(`${ok ? "✅" : "❌"} ${n}${d ? "  — " + String(d).slice(0, 70) : ""}`); if (!ok) bad++; }
console.log(bad ? `\n❌ ${bad} 项失败` : "\n✅ 交互全部通过");
process.exitCode = bad ? 1 : 0;
