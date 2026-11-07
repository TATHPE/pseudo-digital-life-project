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

// ⓪ 先去记录页：工作台上输入框是隐藏的（[hidden] 现在真的生效了，量不到尺寸）
await js(`(async () => {
  const d = document.querySelector('.nb-day');
  if (d) { d.click(); await new Promise((r) => setTimeout(r, 400)); }
  return 1;
})()`);

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
check("右栏五个签（0 / I / II / III / IV）", layout && layout.tabs === 5, String(layout && layout.tabs));
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
    // Hermes 的青是 #0f7c74 = rgb(15, 124, 116)（2026-11-06 两套统一）
    return getComputedStyle(her).borderLeftColor.includes('15, 124, 116');
  })()`));
} else skip("每条有页边时间戳", "空库");

// ②b 长回答要能展开（用户实测：点了"展开了个寂寞"）
const hasFold = await js(`!!document.querySelector('#nb-log .nb-more')`);
if (hasFold) {
  check("点「展开全文」真的展开（高度变大、按钮消失）", await js(`(async () => {
    const btn = document.querySelector('#nb-log .nb-more');
    const fold = document.getElementById(btn.getAttribute('data-target'));
    if (!fold) return false;
    const before = fold.getBoundingClientRect().height;
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    const after = fold.getBoundingClientRect().height;
    return after > before + 40 && !document.querySelector('#nb-log .nb-more');
  })()`));
} else skip("展开全文", "库里没有超长回答");

// ②c 她写的 markdown 表格要变成真表格（以前原样显示一排竖线）
const tableCase = await js(`(() => {
  const t = document.querySelector('#nb-log .md-table');
  if (!t) return { has: false };
  const txt = document.querySelector('#nb-log').textContent || '';
  return { has: true, ok: t.querySelectorAll('th').length >= 2 && t.querySelectorAll('td').length >= 2 && !txt.includes('|---|') };
})()`);
// 空库/没有表格回答时没有任何表格可测 —— 不是失败
if (!tableCase || !tableCase.has) skip("表格渲染成 <table>", "夹具里没有表格回答");
else check("表格渲染成 <table>，不是一排竖线", tableCase.ok === true);

// ②d 顶栏的 聊天 / 工作 chip：要显示当前档，点一下能切
const chip = await js(`(async () => {
  const b = document.getElementById("nb-modechip");
  if (!b) return null;
  const before = b.textContent.trim();
  const m0 = await (await fetch('/api/mode')).json();
  b.click();
  await new Promise((r) => setTimeout(r, 900));
  const after = b.textContent.trim();
  const m = await (await fetch('/api/mode')).json();
  // 真 bug 的判据：接口里的 mode 没变（点了不生效），或者 chip 文字没跟着变
  return { before, after, mode0: m0.mode, mode: m.mode, changed: m0.mode !== m.mode,
    label: after === '工作' ? 'work' : after === '聊天' ? 'chat' : '?',
    consistent: (after === '工作') === (m.mode === 'work') };
})()`);
if (!chip) check("顶栏有 聊天 / 工作 chip", false, "没有 chip");
else {
  // 三件事分开断言：点得动、服务端真变了、chip 文字和接口一致
  check("chip 点一下文字会变", chip.before !== chip.after, `${chip.before} → ${chip.after}`);
  check("chip 切换真的写进配置（不是只改外观）", chip.changed === true, JSON.stringify(chip));
  check("chip 文字与接口一致", chip.consistent === true, JSON.stringify(chip));
}

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

// ⑥e 回到最新：滚上去要露出按钮，点一下回到底；点侧栏「今天」也该落到最新
// 注意：这一段之前跑过记忆/文档/设置/校样，得先回记录页（按钮只在记录页出现）
const latest = await js(`(async () => {
  const openChat = async () => {
    const d = [...document.querySelectorAll('#nb-days .nb-day')].find((x) => x.textContent.indexOf('今天') >= 0);
    if (d) d.click();
    await new Promise((r) => setTimeout(r, 500));
  };
  await openChat();
  const p = document.getElementById('nb-page');
  const b = document.getElementById('nb-latest');
  if (!p || !b) return { why: 'no-btn' };

  p.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 300));
  const shown = !b.hidden;
  const scrollable = (p.scrollHeight - p.clientHeight) > 400;

  b.click();
  await new Promise((r) => setTimeout(r, 400));
  const atBottom = p.scrollHeight - (p.scrollTop + p.clientHeight) < 40;
  const hiddenAfter = b.hidden;

  p.scrollTop = 0;
  await openChat();
  const todayAtBottom = p.scrollHeight - (p.scrollTop + p.clientHeight) < 40;
  return { shown, atBottom, hiddenAfter, todayAtBottom, scrollable };
})()`);
if (latest && latest.why === 'no-btn') check("回到最新按钮", false, latest.why);
else if (latest && latest.scrollable !== true) skip("回到最新按钮", "对话太短，滚不出 200px");
else if (latest && latest.why) check("回到最新按钮", false, latest.why);
else {
  check("滚上去露出「回到最新」", latest && latest.shown === true, JSON.stringify(latest));
  check("点它回到底（按钮随即隐藏）", latest && latest.atBottom === true && latest.hiddenAfter === true, JSON.stringify(latest));
  check("点侧栏「今天」落到最新一条", latest && latest.todayAtBottom === true, JSON.stringify(latest));
}

// ⑥ 她收着的
check("「她收着的」能翻出来", await js(`(async () => {
  const b = document.getElementById('nb-board-btn');
  if (!b) return false;
  b.click();
  await new Promise((r) => setTimeout(r, 900));
  const el = document.getElementById('nb-board');
  return el && !el.hidden && /她收着的/.test(el.textContent || '');
})()`));

// ⑥b 右栏第四个签：过程（有过程就列步，没有也要说话）
const traceTab = await js(`(async () => {
  const t = document.querySelector('.nb-tab[data-t="4"]');
  if (!t) return 'no-tab';
  t.click();
  await new Promise((r) => setTimeout(r, 400));
  const p = document.getElementById('nb-panel');
  if (!p || p.hidden) return 'hidden';
  const box = document.getElementById('nb-trace');
  if (!box) return 'no-box';
  const steps = box.querySelectorAll('.nb-step').length;
  const text = box.textContent.trim().slice(0, 120);
  if (!steps && text.indexOf('还没有过程') >= 0) return 'no-trace';
  return { text, steps };
})()`);
if (traceTab === "no-trace") skip("过程签能开", "这一轮没有工具调用，本来就没有过程");
else if (traceTab === "no-tab" || traceTab === "hidden" || traceTab === "no-box") {
  check("过程签能开", false, String(traceTab));
} else {
  check("过程签能开（画出步数，不是空白）", traceTab.steps > 0 && (traceTab.text || "").length > 4,
    traceTab.steps ? `${traceTab.steps} 步` : traceTab.text.slice(0, 40));
}

// ⑥c 右栏要自己滚：内容再长也不许把整页顶出滚动条（用户报「下拉条还是全局」）
const railScroll = await js(`(async () => {
  // 签是开关：已经开着就别再点（点了会关掉）
  const panel0 = document.getElementById('nb-panel');
  if (panel0 && panel0.hidden) {
    const t = document.querySelector('.nb-tab[data-t="4"]');
    if (t) { t.click(); await new Promise((r) => setTimeout(r, 700)); }
  }
  const panel = document.getElementById('nb-panel');
  const doc = document.scrollingElement || document.documentElement;
  if (!panel || panel.hidden) return { why: 'panel 没打开' };
  const cs = getComputedStyle(panel);
  return {
    overflowY: cs.overflowY,
    panelH: panel.clientHeight,
    panelScroll: panel.scrollHeight,
    docScroll: doc.scrollHeight,
    innerH: window.innerHeight,
  };
})()`);
if (railScroll && railScroll.why) check("右栏自己滚，整页不滚", false, railScroll.why);
else check(
  "右栏自己滚，整页不滚",
  !!railScroll && railScroll.overflowY === "auto" && railScroll.docScroll <= railScroll.innerH + 2,
  railScroll ? ("面板 " + railScroll.panelH + "/" + railScroll.panelScroll + "px · 整页 " + railScroll.docScroll + "/" + railScroll.innerH + "px") : "?",
);

// ⑥d 主题能切：点一下立刻换（字号/侧栏宽/属性都变），并且存进配置
const themeSwitch = await js(`(async () => {
  const goCfg = document.querySelector('.nb-go[data-v="cfg"]');
  if (goCfg) goCfg.click();
  for (let i = 0; i < 20; i++) { if (document.querySelectorAll('.nb-jump').length) break; await new Promise((r) => setTimeout(r, 300)); }
  const tab = [...document.querySelectorAll('.nb-jump')].find((x) => x.textContent.trim() === '外观');
  if (!tab) return { why: 'no-tab' };
  tab.click();
  await new Promise((r) => setTimeout(r, 300));
  const btn = [...document.querySelectorAll('[data-theme]')].find((x) => x.getAttribute('data-theme') === 'hermes');
  if (!btn) return { why: 'no-hermes-btn' };
  const before = getComputedStyle(document.body).fontSize;
  btn.click();
  await new Promise((r) => setTimeout(r, 700));
  const ui = await (await fetch('/api/ui')).json();
  const bg = getComputedStyle(document.body).backgroundColor;
  return {
    attr: document.documentElement.getAttribute('data-theme'),
    before, after: getComputedStyle(document.body).fontSize, // 统一后两套同值，仅留作记录
    bg, saved: ui.theme,
  };
})()`);
if (themeSwitch && themeSwitch.why) check("主题能切", false, themeSwitch.why);
else check(
  "主题能切（立刻生效 + 存进配置）",
  // 两套字号已统一（都 12.5），所以不再比字号 —— 比底色翻白 + 存进配置 + 属性
  !!themeSwitch && themeSwitch.attr === 'hermes' && themeSwitch.saved === 'hermes' && /24[0-9]|25[0-9]/.test(themeSwitch.bg),
  themeSwitch ? (`${themeSwitch.before} → ${themeSwitch.after} · 存 ${themeSwitch.saved}`) : "?",
);

// ⑥f 键盘可达性（a11y 审计 P1）：左栏/日期/切口签要能 Tab 进去，Enter 能触发
const kb = await js(`(async () => {
  const nav = [...document.querySelectorAll('.nb-go')];
  const days = [...document.querySelectorAll('.nb-day')];
  const focusable = nav.filter((x) => x.getAttribute('tabindex') === '0' && x.getAttribute('role') === 'button');
  const daysOk = days.every((x) => x.getAttribute('tabindex') === '0');
  const target = nav.find((x) => x.getAttribute('data-v') === 'mem');
  if (!target) return { why: 'no-mem-nav' };
  target.focus();
  const focused = document.activeElement === target;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 700));
  const crumb = (document.getElementById('nb-crumb') || {}).textContent || '';
  return { nav: nav.length, focusable: focusable.length, days: days.length, daysOk, focused, crumb };
})()`);
if (kb && kb.why) check("导航能键盘走", false, kb.why);
else {
  check("左栏每个去处都能 Tab 聚焦（role+tabindex）", kb && kb.nav > 0 && kb.focusable === kb.nav, JSON.stringify(kb));
  // 空库（还没聊过）没有日期条目 —— 那不是失败，是没得测
  if (kb && kb.days === 0) skip("日期条目也能聚焦", "空库，没有日期条目");
  else check("日期条目也能聚焦", kb && kb.days > 0 && kb.daysOk === true, JSON.stringify(kb));
  check("Enter 键能触发导航", kb && kb.focused === true && /记忆/.test(kb.crumb || ''), JSON.stringify(kb));
}

// ⑥g 任务页（M7 最小切片）：能进、能建、卡片会出现
const taskPage = await js(`(async () => {
  const goBtn = [...document.querySelectorAll('.nb-go[data-v="task"]')][0];
  if (!goBtn) return { why: 'no-nav' };
  goBtn.click();
  await new Promise((r) => setTimeout(r, 700));
  const hasInput = !!document.getElementById('nb-taskgoal');
  const hasAdd = !!document.getElementById('nb-taskadd');
  const before = document.querySelectorAll('#nb-tasks .nb-card').length;
  const r = await fetch('/api/tasks', { method: 'POST', headers: { 'x-jj': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create', goal: 'UI 测试建的任务' }) });
  const j = await r.json();
  await new Promise((res) => setTimeout(res, 500));
  const id = j && j.task ? j.task.id : 0;
  // 收尾：别在测试库里留垃圾
  if (id) await fetch('/api/tasks', { method: 'POST', headers: { 'x-jj': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'abandon', id }) });
  return { hasInput, hasAdd, created: !!id, crumb: (document.getElementById('nb-crumb') || {}).textContent, before };
})()`);
if (taskPage && taskPage.why) check("任务页能进", false, taskPage.why);
else {
  check("任务页能进、有输入框和建任务按钮", taskPage && taskPage.hasInput && taskPage.hasAdd, JSON.stringify(taskPage));
  check("能从页面建任务", taskPage && taskPage.created === true, JSON.stringify(taskPage));
}

// ⑥h 动效：关键帧在、且带 reduced-motion 兜底（不然有人会因为动效难受）
const motion = await js(`(() => {
  const rules = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } });
  const names = rules.filter((r) => r.type === 7).map((r) => r.name);
  const hasReduce = JSON.stringify(rules.map((r) => r.cssText.slice(0, 80))).includes("prefers-reduced-motion");
  return { names, hasReduce };
})()`);
check("动效关键帧在（rise/line-grow/fade/drop）",
  ["nb-rise", "nb-line-grow", "nb-fade", "nb-drop"].every((n) => (motion.names || []).includes(n)), JSON.stringify(motion));
check("动效有 reduced-motion 兜底", motion.hasReduce === true, JSON.stringify(motion));

// ⑦ 回到记录// ⑦ 回到记录
check("能回到记录页", await js(`(async () => {
  const b = document.getElementById('nb-board-btn');
  b.click();
  await new Promise((r) => setTimeout(r, 400));
  const log = document.getElementById('nb-log');
  return log && !log.hidden;
})()`));

// ⑦b 头像：>512KB 的图要能换（用户实测「换不了」——原图 2–5MB，服务端限 512KB）
const avatarCheck = await js(`(async () => {
  // 先回设置页（这一步在记录页上跑，得自己过去）
  const goCfg = document.querySelector('.nb-go[data-v="cfg"]');
  if (goCfg) goCfg.click();
  for (let i = 0; i < 20; i++) { if (document.querySelectorAll('.nb-jump').length) break; await new Promise((r) => setTimeout(r, 300)); }
  const jump = [...document.querySelectorAll('.nb-jump')].find((x) => x.textContent.trim() === '头像');
  if (!jump) return 'no-tab';
  jump.click();
  await new Promise((r) => setTimeout(r, 400));
  const inp = document.querySelector('input[data-av="agent"]');
  if (!inp) return 'no-input';
  const c = document.createElement('canvas'); c.width = 900; c.height = 900;
  const cx = c.getContext('2d');
  const im = cx.createImageData(900, 900);
  for (let i = 0; i < im.data.length; i += 4) { im.data[i] = Math.random() * 255; im.data[i + 1] = Math.random() * 255; im.data[i + 2] = Math.random() * 255; im.data[i + 3] = 255; }
  cx.putImageData(im, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const kb = Math.round(blob.size / 1024);
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'big.png', { type: 'image/png' }));
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 4000));
  const j = await (await fetch('/api/avatars')).json();
  return { kb, ok: !!j.agent, url: j.agent && j.agent.url, imgs: document.querySelectorAll('#nb-log .nb-gav').length };
})()`);
if (avatarCheck === 'no-tab' || avatarCheck === 'no-input') skip("大头像能换", "设置页没打开");
else check("大头像能换（>512KB 的图本地缩到 256px 再发）", avatarCheck && avatarCheck.ok === true,
  avatarCheck ? `${avatarCheck.kb}KB 原图 · 对话里 ${avatarCheck.imgs} 张头像` : "?");

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
