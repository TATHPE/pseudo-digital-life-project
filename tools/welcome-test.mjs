// 首次配置引导页（/welcome）的独立断言：它和主面板是两张页面，混在一起跑会互相污染。
// 用法：node tools/welcome-test.mjs [url]（默认 7701 夹具）
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const URL_PAGE = process.argv[2] ?? "http://127.0.0.1:7701/welcome";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PROFILE = `${process.env.TEMP}/jj-edge-w-${Date.now()}`;
const PORT = 9931;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(EDGE, ["--headless=new","--disable-gpu","--no-sandbox",`--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`,"--window-size=1200,900","about:blank"], { stdio: "ignore" });
let t; for (let i=0;i<40;i++){ await sleep(250); try{ const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); t=l.find(x=>x.type==="page"); if(t?.webSocketDebuggerUrl) break; }catch{} }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map(); const out = []; const errs = [];
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") errs.push((m.params.exceptionDetails.exception?.description || "").split(String.fromCharCode(10))[0]); };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }))?.result?.value;
const check = (n, ok, d) => out.push([n, ok, d]);

await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate", { url: URL_PAGE }); await sleep(2500);

check("是引导页而不是主面板", await js("document.title.indexOf('第一次见面') >= 0"), await js("document.title"));
check("八个步骤的进度点都在", (await js("document.querySelectorAll('#dots i').length")) === 8);
check("当前步骤有标题和说明", await js("!!(document.querySelector('.card h2') && document.querySelector('.card p'))"));
check("有「先用着，回头再配」的出口", await js("!!document.getElementById('skip')"));
check("出口指向主面板（?skip=1）", await js("String(document.getElementById('skip').onclick).indexOf('skip=1') >= 0"));

// 一个字都不答也能拿到草稿（模板兜底）—— 引导不能卡死在"模型没写出来"
const draft = await js(`(async () => {
  const r = await fetch('/api/setup/interview', { method: 'POST', headers: {'x-jj':'1','content-type':'application/json'}, body: JSON.stringify({ action: 'draft', answers: {} }) });
  const j = await r.json();
  if (!j.ok) return 'FAIL:' + (j.error || j.why);
  const n = Object.values(j.draft.blocks || {}).reduce((a, b) => a + b.length, 0);
  return (j.via === 'template' && n > 0) ? true : 'via:' + j.via + ' n:' + n;
})()`);
check("一个字不答也有草稿（模板兜底，不卡死）", draft);

check("没有 JS 运行时错误", errs.length === 0, errs.join(" | "));

ws.close(); proc.kill(); try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
let bad = 0;
for (const [n, ok, d] of out) { console.log(`${ok ? "✅" : "❌"} ${n}${d && ok !== true ? "  — " + String(d).slice(0, 90) : ""}`); if (!ok) bad++; }
console.log(bad ? `\n❌ ${bad} 项失败` : "\n✅ 引导页全部通过");
process.exit(bad ? 1 : 0);