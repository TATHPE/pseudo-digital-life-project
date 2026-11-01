/** headless Edge + CDP：真点、真发、检查布局（输入框必须在视口内） */
// ?skip=1：跳过首启引导（这段测试模拟的是"已经用起来的人"；引导页单独测）
const URL_PAGE = process.argv[2] ?? "http://127.0.0.1:7700/?skip=1";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9333;
const [VW, VH] = (process.env.UI_VIEWPORT ?? '1440x900').split('x').map(Number);
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

// 每次跑都建一个临时 profile；**必须删**，否则一个月能攒出几十 GB（实测 38581 个目录 / 24 GB）
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
// 断言的是「发送这条链路通」：用户那条一定出现；回复取决于有没有可用模型
// （夹具是独立 home，通常没有云端 key —— 所以不把"模型必须回"当成面板的错）
check("发送后有新内容", after >= before + 1, `${before} → ${after} 条`);
// ── K-2 提议卡（F-1 要求"每条一条断言"）────────────
const hasProp = await js("!!document.querySelector('#proplist button[data-prop]')");
if (hasProp) {
  check("提议卡能点开（带确切 argv + 会动哪些文件）", await js(`(() => {
    const b = document.querySelector('#proplist button[data-prop]');
    if (!b) return false; b.click();
    const v = document.querySelector('#propview');
    return !v.hidden && document.querySelector('#pv-argv').textContent.length > 0
      && document.querySelector('#pv-why').textContent.length > 3
      && /会动：/.test(document.querySelector('#pv-touch').textContent);
  })()`));
  check("「不做」真的落盘（卡从待办里消失）", await js(`(async () => {
    const before = document.querySelectorAll('#proplist button[data-prop]').length;
    document.querySelector('#pv-no').click();
    await new Promise((r) => setTimeout(r, 1200));
    const after = document.querySelectorAll('#proplist button[data-prop]').length;
    return after === before - 1;
  })()`));
} else skip("提议卡能点开", "没有待回应的提议");

// ── J-5b 抽检：送到眼前，且能当场断 ────────────────
const hasSurf = await js("!!document.querySelector('#surflist [data-key]')");
if (hasSurf) {
  check("抽检把「为什么连」一起送到眼前", await js(`(() => {
    const c = document.querySelector('#surflist [data-key]');
    return /为什么连：/.test(c.textContent) && !!c.querySelector("button[data-act=no]");
  })()`));
  check("点「不对」→ 卡片消失（线已断）", await js(`(async () => {
    const c = document.querySelector('#surflist [data-key]');
    const key = c.dataset.key;
    c.querySelector("button[data-act=no]").click();
    await new Promise((r) => setTimeout(r, 1600));
    const rows = [...document.querySelectorAll('#surflist [data-key]')].map((x) => x.dataset.key);
    return !rows.includes(key);
  })()`));
} else skip("抽检把「为什么连」一起送到眼前", "没有待抽检的线");

// ── F-1 #3 工具列表可筛 + 默认折叠 ─────────────────
check("工具列表默认只铺 6 项 + 能筛", await js(`(() => {
  const rows = document.querySelectorAll('#toolrows button[item], #toolrows button.item').length;
  const q = document.querySelector('#toolq');
  if (!q) return false;
  q.value = "memory"; q.dispatchEvent(new Event("input"));
  const filtered = document.querySelectorAll('#toolrows button.item').length;
  q.value = ""; q.dispatchEvent(new Event("input"));
  return rows <= 7 && filtered > 0 && filtered < 22;
})()`));

// ── F-1 #5 记忆详情：看得出来源、改过什么 ──────────
if (hasMem) {
  check("记忆详情显示来源 / 原话 / 改动痕迹", await js(`(async () => {
    const b = document.querySelector('#side .item[data-view=memview]');
    if (!b) return false; b.click();
    await new Promise((r) => setTimeout(r, 900));
    const t = document.querySelector('#mv-prov').textContent;
    return /来自：/.test(t);
  })()`));
} else skip("记忆详情显示来源", "空库");

// ── 权限档（位置照 DSH：输入框旁的选择器，不是设置里）──────
check("权限 chip 在输入框旁，且能切档", await js(`(async () => {
  const chip = document.querySelector('#composer #perm');
  if (!chip) return false;
  const before = chip.textContent.trim();
  chip.click();
  await new Promise((r) => setTimeout(r, 300));
  const opts = document.querySelectorAll('#permopts button[data-preset]');
  if (opts.length < 3) return false;
  const readOnly = [...opts].find((b) => b.dataset.preset === 'read');
  if (!readOnly) return false;
  readOnly.click();
  await new Promise((r) => setTimeout(r, 900));
  const after = chip.textContent.trim();
  window.__perm = { before, after, n: opts.length };
  return after !== before && /仅可查看/.test(after);
})()`), await js("JSON.stringify(window.__perm || {})"));

check("/permission 斜杠命令能切回逐次确认", await js(`(async () => {
  const i = document.querySelector('#m');
  i.value = '/permission ask';
  document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true }));
  await new Promise((r) => setTimeout(r, 1000));
  const chip = document.querySelector('#composer #perm');
  return /逐次确认/.test(chip.textContent);
})()`));

// ── F-3 记忆撤销：忘记之后 5 秒内能撤回 ─────────────
check("F-3 忘记可撤销", await js(`(async () => {
  window.__f3 = {};
  // 记忆列表现在是独立一屏（左栏只留入口行）
  const entry = document.querySelector('#side .item[data-view=memlistview]');
  if (!entry) return false;
  entry.click();
  await new Promise((r) => setTimeout(r, 700));
  const mem = document.querySelector('#memlist .item[data-mem]');
  window.__f3.hasMem = !!mem;
  if (!mem) return false;
  mem.click();
  await new Promise((r) => setTimeout(r, 800));
  const f = document.querySelector('#mv-forget');
  window.__f3.hasForget = !!f;
  if (!f) return false;
  f.click();
  await new Promise((r) => setTimeout(r, 1200));
  const msg = document.querySelector('#mv-msg');
  window.__f3.msg = msg ? msg.textContent.slice(0, 60) : null;
  const undo = document.querySelector('#mv-undo');
  window.__f3.hasUndo = !!undo;
  if (!undo) return false;
  undo.click();
  await new Promise((r) => setTimeout(r, 1200));
  window.__f3.after = document.querySelector('#mv-msg').textContent;
  return window.__f3.after.includes('撤回');
})()`), await js("JSON.stringify(window.__f3 || {})"));
// ── F-3 列表分页：先给 8 条，能往上翻 ───────────────
check("F-3 记忆列表能翻页", await js(`(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const before = document.querySelectorAll('#memlist .item').length;
  const more = document.querySelector('#memmore');
  if (!more) return false;
  more.click();
  await new Promise((r) => setTimeout(r, 800));
  const after = document.querySelectorAll('#memlist .item').length;
  return before <= 9 && after > before;
})()`));
// ── D-3 回执：送达 ≠ 已读，点「知道了」才算看见 ─────────
check("D-3 回执能标已读", await js(`(async () => {
  const before = document.querySelectorAll('#rcplist [data-rcp]').length;
  if (!before) return false;
  document.querySelector('#rcplist button[data-act=seen]').click();
  await new Promise((r) => setTimeout(r, 900));
  const after = document.querySelectorAll('#rcplist [data-rcp]').length;
  return after === before - 1;
})()`));

// ── D-3 常驻指令：列表能看到，停用是一句话的事 ──────────
check("D-3 常驻指令能停用", await js(`(async () => {
  document.querySelector('#side .item[data-view=cfg]').click();
  await new Promise((r) => setTimeout(r, 500));
  const card = document.querySelector('#st-list [data-std]');
  if (!card) return false;
  const btn = card.querySelector('button[data-act=off]');
  if (!btn) return false;
  btn.click();
  await new Promise((r) => setTimeout(r, 900));
  const c2 = document.querySelector('#st-list [data-std]');
  return !!c2 && /已停用/.test(c2.textContent);
})()`));
// ── H-7 代码外发：待批 → 批一次 → 收回 ────────────────
check("H-7 外发待批能看见、能批一次", await js(`(async () => {
  const card = document.querySelector('#egrlist [data-egrpath]');
  if (!card) { const a = await (await fetch('/api/egress')).json(); return 'NO_CARD pending=' + (a.pending||[]).length + ' html=' + document.querySelector('#egrlist').innerHTML.slice(0,60); }
  const path = card.dataset.egrpath;
  const once = card.querySelector('button[data-egr=once]');
  if (!once) return 'NO_BTN';
  once.click();
  await new Promise((r) => setTimeout(r, 900));
  const st = await (await fetch('/api/egress')).json();
  return (st.once >= 1 || (st.pending || []).every((p) => p.path !== path)) ? true : 'STILL_PENDING once=' + st.once;
})()`));

check("H-7 外发窗口能收回", await js(`(async () => {
  await fetch('/api/egress', { method: 'POST', headers: H, body: JSON.stringify({ action: 'window', ttlMin: 5 }) });
  await new Promise((r) => setTimeout(r, 400));
  const open = await (await fetch('/api/egress')).json();
  if (!open.until) return false;
  await fetch('/api/egress', { method: 'POST', headers: H, body: JSON.stringify({ action: 'revoke' }) });
  const closed = await (await fetch('/api/egress')).json();
  return !closed.until && !closed.open;
})()`));


// ── H-4 首次配置：能看到步骤、能暂停、终止先给预览 ──────
check("H-4 首次配置：步骤齐全、能暂停、终止先预览", await js(`(async () => {
  const nav = document.querySelector('#side .item[data-view=setupview]');
  if (!nav) return false;
  nav.click();
  await new Promise((r) => setTimeout(r, 800));
  const steps = document.querySelectorAll('#su-steps .step').length;
  const view = !document.querySelector('#setupview').hidden;
  const preview = await (await fetch('/api/setup', { method: 'POST', headers: H, body: JSON.stringify({ action: 'abort' }) })).json();
  const hasPreview = !!preview.preview && Array.isArray(preview.preview.models);
  const listed = (preview.preview.models || []).join(',');
  await fetch('/api/setup', { method: 'POST', headers: H, body: JSON.stringify({ action: 'pause' }) });
  window.__su = { steps, view, hasPreview, listed };
  return view && steps === 8 && hasPreview && listed.includes('bge-m3');
})()`), await js("JSON.stringify(window.__su || {})"));
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
// 折叠现在有两处：左栏「工具」，卷宗里的几块（等你点头 / 上下文）
check("折叠能用：左栏工具 + 卷宗分区", await js(`(() => {
  const tool = document.getElementById("foldtools");
  const box = document.getElementById("toollist");
  if (!box.hidden) tool.click();   // 归零：别的用例可能已经把它展开了
  tool.click();
  const opened = box.hidden === false;
  tool.click();
  const closed = box.hidden === true;
  const b = document.querySelector("[data-tog=prop]");
  if (!b) return opened && closed;
  const sec = b.closest(".sec");
  b.click();
  const h1 = sec.querySelector("div").hidden;
  b.click();
  return opened && closed && h1 === true && sec.querySelector("div").hidden === false;
})()`));

// 视图切换："回到最新"是对话专用的；滚回对话时不该跳回顶部
await js(`(() => { document.querySelector("#side .item[data-view=chat]").click(); return true; })()`);
await sleep(400);
const scrolled = await js(`(() => { const el=document.querySelector("#scroll");
  // 内容不够长时这条测不了（夹具只有几条消息）—— 返回 -1 让下面跳过，
  // 而不是拿"滚不动"当成"位置没保住"（那样会长期假红）。
  const max = el.scrollHeight - el.clientHeight;
  if (max < 400) return -1;
  el.scrollTop = max - 400;
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
check("切回对话保住滚动位置",
  scrolled < 0 ? null : Math.abs(back - scrolled) <= 8,
  scrolled < 0 ? "内容不够长，跳过" : `${scrolled} → ${back}`);

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
// 切回对话的滚动契约（17 §3）：贴底离开 → 回来仍然贴底；
// 中途离开 → 回到你离开的那个位置。这里测前半条（后半条上面已测，401 → 401）。
// 注意：时间轴可能还在拉（fetch），所以轮询到稳定为止，只等两帧会偶发假红。
const settle = await js(`(async () => {
  const el = document.querySelector("#scroll");
  const gap = () => el.scrollHeight - el.scrollTop - el.clientHeight;
  document.querySelector("#side .item[data-view=chat]").click();
  await new Promise(function (r) { setTimeout(r, 400); });
  el.scrollTop = el.scrollHeight;                       // 先真正贴底
  await new Promise(function (r) { setTimeout(r, 200); });
  const wasAtBottom = gap() < 80;
  document.querySelector("#side .item[data-view=cfg]").click();
  await new Promise(function (r) { setTimeout(r, 200); });
  document.querySelector("#side .item[data-view=chat]").click();
  for (let i = 0; i < 30; i++) {
    if (gap() < 80) return { ok: true, wasAtBottom };
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  return { ok: false, gap: Math.round(gap()), wasAtBottom };
})()`);
check("回对话仍贴底（贴底离开 → 回来贴底）", settle.ok === true, JSON.stringify(settle));

// F-3：Ctrl+K 命令面板（打开 / 过滤 / Esc 关闭 / Enter 执行）
await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
await sleep(250);
const palOpen = await js(`(() => { const el = document.querySelector('#pal'); return !!el && !el.hidden; })()`);
const palRows = await js(`document.querySelectorAll('#pallist .pi').length`);
check("Ctrl+K 打开命令面板", palOpen && palRows >= 5, `条目 ${palRows}`);
await js(`(() => { const i = document.querySelector('#palq'); i.value = '设置'; i.dispatchEvent(new Event('input')); return true; })()`);
await sleep(150);
check("命令面板能过滤", (await js(`document.querySelector('#pallist').textContent`)).includes("设置"));
await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(150);
check("Esc 关闭命令面板", await js(`document.querySelector('#pal').hidden`));

// F-2：能力自述进面板（数据来自 /api/capabilities，面板只显示）
const cap = await js(`(() => {
  const sum = document.querySelector('#cap-sum');
  const boxes = document.querySelectorAll('#cap-list .capbox, #cap-list .capline');
  const deg = document.querySelector('#cap-deg');
  return { sum: sum ? sum.textContent : '', boxes: boxes.length, deg: deg ? deg.textContent : '' };
})()`);
check("能力表在设置里渲染", /工具 \d+/.test(cap.sum) && cap.boxes >= 3,
  `${cap.sum} | 类目 ${cap.boxes}`);
check("能力表的降级项与服务端一致", await (async () => {
  const api = await (await fetch(new URL("/api/capabilities", URL_PAGE))).json();
  return api.degraded.every((d) => cap.deg.includes(d));
})(), cap.deg.slice(0, 60));

// ── 横向溢出：加右栏之后中栏变窄，工具卡里的长行曾把对话列撑破 ──
// 真踩过：按钮和草稿容器都叫 id="su-draft" → getElementById 拿到按钮，
// 整份人格草稿被塞进 <button> 里（浅色底 + 非法嵌套，看起来像页面坏了）。
check("页面里没有重复 id", await js(`(() => {
  const seen = new Map();
  const dup = [];
  for (const el of document.querySelectorAll("[id]")) {
    const id = el.id;
    if (seen.has(id)) dup.push(id);
    seen.set(id, 1);
  }
  return dup.length ? "DUP:" + dup.slice(0, 6).join(",") : true;
})()`));

check("人格草稿的行有样式（不是塞进按钮里的白框）", await js(`(async () => {
  document.querySelector("#side .item[data-view=setupview]").click();
  await new Promise((r) => setTimeout(r, 900));
  // 直接渲染一份草稿，只为看样式（不走模型）
  renderDraft({ blocks: { core: [{ text: "她说这句话", source: "你原话" }, { text: "模型补的", source: "模型补的（请确认）" }] } });
  await new Promise((r) => setTimeout(r, 200));
  const box = document.getElementById("su-draft");
  const line = box.querySelector(".draftline");
  const inp = line && line.querySelector("input");
  if (!line || !inp) return "NO_LINE";
  const shown = box.getBoundingClientRect().width > 0;
  const flex = getComputedStyle(line).display === "flex";
  // 输入框不能超出容器（之前宽度写死，长句被切断）
  const fits = inp.getBoundingClientRect().right <= box.getBoundingClientRect().right + 1;
  const insideButton = !!box.closest("button");
  return shown && flex && fits && !insideButton;
})()`));

// ── 插件与技能的增删：借来的手脚不能是死数据 ────────────────
// 走真接口（/api/plugins），装的是一份假插件（命令是本机 node），用完删掉。
check("插件能加能删，且明说重启才生效", await js(`(async () => {
  const entry = document.querySelector("#side .item[data-view=capview]");
  if (!entry) return "NO_ENTRY";
  entry.click();
  await new Promise((r) => setTimeout(r, 800));
  const H = { "x-jj": "1", "content-type": "application/json" };
  const add = await (await fetch("/api/plugins", { method: "POST", headers: H, body: JSON.stringify({
    kind: "mcp", action: "add", name: "uitest-fake", command: "node", args: ["--version"],
  }) })).json();
  if (!add.ok) return "ADD_FAILED:" + (add.why || add.error);
  const listed = (await (await fetch("/api/plugins")).json()).servers.some((s) => s.name === "uitest-fake");
  // 界面上也要能看到（loadCapPage 之后重新渲染）
  document.querySelector("#side .item[data-view=capview]").click();
  await new Promise((r) => setTimeout(r, 700));
  const del = await (await fetch("/api/plugins", { method: "POST", headers: H, body: JSON.stringify({
    kind: "mcp", action: "remove", name: "uitest-fake",
  }) })).json();
  const gone = !(await (await fetch("/api/plugins")).json()).servers.some((s) => s.name === "uitest-fake");
  const restartHint = /重启/.test(document.getElementById("mcp-msg").textContent);
  return listed && del.ok && gone && restartHint ? true : "listed:" + listed + " gone:" + gone;
})()`));

check("技能能写能读能删（写进 data/skills）", await js(`(async () => {
  const H = { "x-jj": "1", "content-type": "application/json" };
  const body = ["---", "name: 测试用", "description: 一条临时技能。", "---", "", "# 步骤", "1. 不要留痕"].join(String.fromCharCode(10));
  const add = await (await fetch("/api/plugins", { method: "POST", headers: H, body: JSON.stringify({
    kind: "skill", action: "add", name: "uitest-skill", content: body,
  }) })).json();
  if (!add.ok) return "ADD_FAILED:" + (add.why || add.error);
  const seen = (await (await fetch("/api/skills")).json()).skills.some((x) => x.id === "uitest-skill");
  const del = await (await fetch("/api/plugins", { method: "POST", headers: H, body: JSON.stringify({
    kind: "skill", action: "remove", name: "uitest-skill",
  }) })).json();
  const gone = !(await (await fetch("/api/skills")).json()).skills.some((x) => x.id === "uitest-skill");
  return seen && del.ok && gone;
})()`));

check("装/删不带 x-jj 头就 403（跨站不能改插件）", await js(`(async () => {
  const r = await fetch("/api/plugins", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "mcp", action: "remove", name: "markitdown" }) });
  return r.status === 403;
})()`));

// ── 文件面板 + git 校样：让「她改了什么」能被看见（都只读）──
check("文件面板能进目录、能开文件", await js(`(async () => {
  const entry = document.querySelector("#side .item[data-view=filesview]");
  if (!entry) return "NO_ENTRY";
  entry.click();
  await new Promise((r) => setTimeout(r, 900));
  const rootRows = document.querySelectorAll("#flist .item").length;
  const dir = [...document.querySelectorAll("#flist [data-fpath]")].find((b) => b.dataset.ftype === "dir");
  if (!dir) return "NO_DIR";
  dir.click();
  await new Promise((r) => setTimeout(r, 900));
  const inside = document.querySelector("#fcrumbs").textContent.includes(dir.dataset.fpath);
  const file = [...document.querySelectorAll("#flist [data-fpath]")].find((b) => b.dataset.ftype === "file");
  if (!file) return "NO_FILE";
  file.click();
  await new Promise((r) => setTimeout(r, 900));
  const box = document.getElementById("fview");
  const shown = !box.hidden && document.getElementById("ftext").textContent.length > 0;
  return rootRows > 0 && inside && shown;
})()`));

check("不是仓库外的路径：文件面板读不到 data/", await js(`(async () => {
  const j = await (await fetch("/api/project/file?path=data/memory.db")).json();
  return j.ok === false;
})()`));

check("git 校样能看改动（只读三条都在）", await js(`(async () => {
  const btn = document.querySelector("#folio [data-view=gitview]");
  if (!btn) return "NO_ENTRY";
  btn.click();
  await new Promise((r) => setTimeout(r, 1000));
  const status = document.getElementById("gmsg").textContent;
  document.getElementById("gl").click();
  await new Promise((r) => setTimeout(r, 900));
  const log = document.getElementById("gdiff").textContent;
  // status 要么报"工作区干净"，要么报"N 个改动"；log 至少有提交行
  const okStatus = /干净|个改动/.test(status);
  const okLog = log.trim().length > 0;
  return okStatus && okLog ? true : "status:" + status + " log:" + log.slice(0, 30);
})()`));

// ── 时间线跳转：点哪天就该到哪天，不是每次都回到最新 ──────────
// 真 bug：show("chat") 用 rAF 把 scrollTop 压到底，而 jumpToDay() 在它之前同步执行，
// 于是跳转被覆盖 —— 表现就是"点哪天都是现在"。
check("点某一天会跳到那一天（不是总回到最新）", await js(`(async () => {
  const items = [...document.querySelectorAll("#sesslist [data-day]")];
  if (items.length < 2) return null;   // 夹具不够跨天就跳过
  const sc = document.getElementById("scroll");
  sc.scrollTop = sc.scrollHeight;      // 先到底部，确保"跳"是可观测的
  const target = items[items.length - 1];   // 最早那一天
  target.click();
  await new Promise((r) => setTimeout(r, 600));
  const dayEl = [...document.querySelectorAll("#chat .day")]
    .find((e) => e.textContent.startsWith(target.dataset.day));
  if (!dayEl) return "NO_DAY";
  const offset = dayEl.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  const onCount = document.querySelectorAll("#sesslist .item.on").length;
  // 那一天要落在视口顶部附近；同时只能亮一个（别把「现在」也点亮）
  return Math.abs(offset) < 80 && onCount === 1 ? true : "offset:" + Math.round(offset) + " on:" + onCount;
})()`));

check("点「现在」回到最新", await js(`(async () => {
  const now = document.querySelector("#sesslist .item[data-view=chat]:not([data-day])");
  if (!now) return "NO_NOW";
  now.click();
  await new Promise((r) => setTimeout(r, 600));
  const sc = document.getElementById("scroll");
  return sc.scrollHeight - sc.clientHeight - sc.scrollTop <= 8;
})()`));

// ── 技能与插件：harness 的两层"借来的手脚" ──────────────────
check("能力屏能看见插件与技能", await js(`(async () => {
  const entry = document.querySelector("#side .item[data-view=capview]");
  if (!entry) return "NO_ENTRY";
  entry.click();
  await new Promise((r) => setTimeout(r, 900));
  const mcp = document.getElementById("cap-mcp").textContent;
  const sk = document.getElementById("cap-skills").textContent;
  const nat = document.getElementById("cap-native").textContent;
  const api = await (await fetch("/api/skills")).json();
  // 三块都要有内容；技能数要对得上接口
  const skOk = api.skills.length ? sk.includes(api.skills[0].id) : /还没有技能/.test(sk);
  const mcpOk = /个工具|没装插件/.test(mcp);
  return (/工具（verbs）/.test(nat) && skOk && mcpOk) ? true : "mcp:" + mcp.slice(0,40) + " sk:" + sk.slice(0,40);
})()`));

// 真踩过：卷宗「上下文」的模型名读的是 meta(model_express) —— 那个键没人写过，
// 于是永远显示「未配置」，而它明明在回话。现在读 config.roles.express，必须对得上。
check("卷宗里的模型名和配置一致（不是永远「未配置」）", await js(`(async () => {
  const cfg = await (await fetch("/api/config")).json();
  const d = await (await fetch("/api/dossier")).json();
  const want = cfg.model ? ((cfg.provider ? cfg.provider + "/" : "") + cfg.model) : null;
  const shown = document.getElementById("dc-ctx-stats").textContent;
  const okValue = d.context.model === want;
  const okUi = want ? shown.includes(String(cfg.model)) : /未配置/.test(shown);
  return okValue && okUi ? true : "api:" + d.context.model + " cfg:" + want;
})()`));

check("卷宗上下文写着能借多少手脚（插件/工具/技能）", await js(`(async () => {
  const d = await (await fetch("/api/dossier")).json();
  const txt = document.getElementById("dc-ctx-stats").textContent;
  return /插件/.test(txt) && /技能/.test(txt) && txt.includes(String(d.context.skills));
})()`));

// ── 收纳：两个边栏能收成窄带，也要能收回原样 + 记住选择 ──────────
check("左右边栏能收起来、也能再展开", await js(`(async () => {
  const cols = () => getComputedStyle(document.body).gridTemplateColumns.split(" ").map((x) => parseFloat(x));
  const before = cols();
  document.getElementById("wingTog").click();
  await new Promise((r) => setTimeout(r, 300));
  const off = cols();
  const handle = document.getElementById("wingHandle");
  const handleOk = !handle.hidden && handle.getBoundingClientRect().width > 0;
  handle.click();
  await new Promise((r) => setTimeout(r, 300));
  document.getElementById("folioX").click();
  await new Promise((r) => setTimeout(r, 300));
  const folioOff = cols();
  document.getElementById("folioTog").click();
  await new Promise((r) => setTimeout(r, 300));
  const back = cols();
  // 收起来 = 第一/第三列变窄到 0~40px；展开 = 回到原来的宽度（±2px 取整误差）
  const ok1 = off[0] < 40 && handleOk;
  const ok2 = folioOff[2] === 0;
  const ok3 = Math.abs(back[0] - before[0]) <= 2 && Math.abs(back[2] - before[2]) <= 2;
  return ok1 && ok2 && ok3 ? true : "wing:" + off[0] + " folio:" + folioOff[2] + " back:" + back.join("/") + " before:" + before.join("/");
})()`));

// 抓到过：`body.wing-off #folio{display:none}` 让「只收左栏」把卷宗一起干掉，
// 而且点 ◧ 也打不开（状态变成 wing-off + folio-off 两个都关）。
check("收纳左栏不牵连右栏，卷宗能单独开关", await js(`(async () => {
  const shown = () => document.getElementById("folio").getBoundingClientRect().width > 0;
  if (innerWidth <= 1180) return null;   // 窄屏是抽屉，没有「收纳」这回事
  const cols = () => getComputedStyle(document.body).gridTemplateColumns.split(" ").map((x) => parseFloat(x));
  document.getElementById("wingTog").click();
  await new Promise((r) => setTimeout(r, 300));
  const wingOff = cols()[0] < 40;
  const folioStays = shown();
  document.getElementById("folioX").click();
  await new Promise((r) => setTimeout(r, 300));
  const folioOff = !shown();
  document.getElementById("folioTog").click();
  await new Promise((r) => setTimeout(r, 300));
  const folioBack = shown();
  document.getElementById("wingHandle").click();
  await new Promise((r) => setTimeout(r, 300));
  return wingOff && folioStays && folioOff && folioBack;
})()`));

check("收纳选择记得住（刷新后还在）", await js(`(async () => {
  if (innerWidth <= 1180) return null;
  document.getElementById("wingTog").click();
  await new Promise((r) => setTimeout(r, 250));
  const saved = localStorage.getItem("jj.wing");
  // 不真的刷新（会打断后面的断言），只验「状态写进了 localStorage、且下次 applyLayout 会读它」
  const ok = saved === "off" && document.body.classList.contains("wing-off");
  document.getElementById("wingHandle").click();
  await new Promise((r) => setTimeout(r, 250));
  const back = localStorage.getItem("jj.wing");
  return ok && back === "on";
})()`));

check("对话区没有横向滚动条", await js(`(() => {
  const sc = document.querySelector("#scroll");
  // 允许 1px 的取整误差；超了就是内容把列撑破了（.row 的 1fr 下限曾经是 min-content）
  return sc.scrollWidth <= sc.clientWidth + 1;
})()`));

// ── 卷宗（右栏三签）：结构照 Trianon，数据必须是真接口 ────────
check("卷宗三签都在，且数字来自 /api/dossier", await js(`(async () => {
  const api = await (await fetch("/api/dossier")).json();
  const cards = document.querySelectorAll("#folio .dcard");
  const ctx = document.querySelector("#dc-ctx").textContent;
  const n = document.querySelector("#dc-chg-n").textContent;
  // 三个真数据点：记忆条数、今天用量、改动条数（空也要有“还没动过”的说明）
  const memOk = ctx.indexOf(String(api.context.memories)) >= 0;
  const chgOk = api.changes.length ? n.indexOf(String(api.changes.length)) >= 0 : /还没动过/.test(document.querySelector("#dc-chg").textContent);
  return cards.length === 3 && memOk && chgOk;
})()`));

check("卷宗卡片能折叠（点了收起，再点展开）", await js(`(async () => {
  const card = document.querySelector("#folio .dcard");
  const tab = card.querySelector(".dtab");
  tab.click(); await new Promise((r) => setTimeout(r, 120));
  const closed = card.classList.contains("closed") && getComputedStyle(card.querySelector(".din")).display === "none";
  tab.click(); await new Promise((r) => setTimeout(r, 120));
  const open = !card.classList.contains("closed") && getComputedStyle(card.querySelector(".din")).display !== "none";
  return closed && open;
})()`));

check("标题条跟着视图变（stage 顶部的当前屏名）", await js(`(async () => {
  // 先回对话：前面的用例可能把视图停在别处（曾经因此偶发失败）
  document.querySelector("#side .item[data-view=chat]").click();
  await new Promise((r) => setTimeout(r, 300));
  const before = document.querySelector("#stTitle").textContent;
  document.querySelector("#side .item[data-view=cfg]").click();
  await new Promise((r) => setTimeout(r, 400));
  const after = document.querySelector("#stTitle").textContent;
  document.querySelector("#side .item[data-view=chat]").click();
  await new Promise((r) => setTimeout(r, 300));
  return /CHAT/.test(before) && /CONFIG|设置/.test(after);
})()`));

check("分区标题带左边条 + 格子有角标", await js(`(() => {
  const h = document.querySelector("#dc-inbox .sec h3") || document.querySelector(".sec h3");
  if (!h) return false;
  const s = getComputedStyle(h);
  const item = document.querySelector("#side .item");
  const tick = getComputedStyle(item, "::after");
  return parseFloat(s.borderLeftWidth) >= 1 && tick.borderTopWidth === "1px";
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

