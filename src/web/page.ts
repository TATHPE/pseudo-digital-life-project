/**
 * 单页（零前端依赖、零构建）。
 *
 * 排列参照 pi-web：左侧栏（会话/工具/记忆/设置）+ 右侧主列（对话）+ 底部输入。
 * 视觉参照《流浪地球》FUI：黑底、青细线、等宽小标、角标、读数。
 * 色值采样自参考截图：底 #0b0e0b，青 #0f97a4，高光 #7fe6f2。
 *
 * 17 §4 的硬约束不变：没有「新对话」；时间空白可见；状态是"醒着/距上次"。
 * 07 §4 的克制不变：不做点赞/计数徽章——读数只显示系统量。
 *
 * 本文件是"生成代码"：模板字符串里的反斜杠会被吃掉一次，
 * 所以**不用任何反斜杠转义**（换行用 String.fromCharCode(10)），并有测试跑 node --check。
 */
export const PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>鲸鲸 · JJ-OS</title>
<style>
  :root {
    --void:#0b0e0b; --panel:#0e1512; --panel2:rgba(16,24,21,.72);
    --line:rgba(15,151,164,.34); --line-dim:rgba(15,151,164,.14);
    --cyan:#0f97a4; --cyan-hi:#7fe6f2; --fg:#dbeff0; --dim:#6f8f92;
    --amber:#ffb454; --red:#ff5f56; --ok:#7fd18b;
    --mono:ui-monospace,"Cascadia Mono",Consolas,"Noto Sans Mono",monospace;
    --rail:252px;
  }
  * { box-sizing:border-box; }
  /* ── 原生控件适配：不加这一段，暗色界面里会出现灰白滚动条、
        亮色下拉弹层、系统蓝选中色 —— 一眼就出戏 ── */
  :root { color-scheme:dark; }
  /* 注意：Chromium 里一旦设了标准属性 scrollbar-width/scrollbar-color，
     就会忽略 ::-webkit-scrollbar* 伪元素（于是又变回系统滚动条 + 箭头按钮）。
     所以标准属性只给 Firefox（用 @supports 区分），Chromium 走 webkit 伪元素。 */
  @supports (-moz-appearance:none) {
    * { scrollbar-width:thin; scrollbar-color:rgba(15,151,164,.42) transparent; }
  }
  *::-webkit-scrollbar { width:6px; height:6px; }
  *::-webkit-scrollbar-track { background:transparent; }
  *::-webkit-scrollbar-thumb { background:rgba(15,151,164,.32); }
  *::-webkit-scrollbar-thumb:hover { background:rgba(127,230,242,.55); }
  *::-webkit-scrollbar-corner { background:transparent; }
  *::-webkit-scrollbar-button { display:none; }   /* 去掉 Windows 上下的箭头按钮 */
  ::selection { background:rgba(15,151,164,.38); color:#eafcff; }
  input::placeholder, textarea::placeholder { color:rgba(111,143,146,.75); }
  input::-ms-reveal, input::-ms-clear { display:none; }
  select { color-scheme:dark; }
  :focus-visible { outline:1px solid var(--cyan); outline-offset:1px; }
  input, textarea { caret-color:var(--cyan-hi); }
  /* Chrome/Edge 自动填充会强行刷浅黄底，只能这样压回去 */
  input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus {
    -webkit-text-fill-color:var(--fg);
    -webkit-box-shadow:0 0 0 1000px #0a100e inset;
    transition:background-color 9999s ease-out 0s;
  }
  button:disabled { opacity:.45; cursor:not-allowed; }
  select option { background:#0e1512; color:var(--fg); }
  html, body { height:100%; }
  body {
    margin:0; color:var(--fg); background:var(--void);
    font:15px/1.72 -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif;
    display:grid; grid-template-rows:56px 1fr; grid-template-columns:var(--rail) 1fr;
    grid-template-areas:"head head" "side main"; height:100vh; overflow:hidden;
    background-image:
      radial-gradient(900px 420px at 60% -140px, rgba(15,151,164,.14), transparent 70%),
      repeating-linear-gradient(0deg, rgba(15,151,164,.05) 0 1px, transparent 1px 36px),
      repeating-linear-gradient(90deg, rgba(15,151,164,.04) 0 1px, transparent 1px 36px);
  }
  header { grid-area:head; display:flex; align-items:center; gap:14px; padding:0 18px;
           background:rgba(11,14,11,.9); border-bottom:1px solid var(--line-dim); }
  .brand { font-size:16px; font-weight:600; letter-spacing:.14em; color:#eafcff; }
  .brand small { font:10px/1 var(--mono); color:var(--cyan); letter-spacing:.16em; margin-left:8px; }
  .hud { display:inline-flex; align-items:center; gap:9px; font:11px/1 var(--mono); letter-spacing:.06em;
         color:var(--dim); border:1px solid var(--line-dim); background:rgba(8,13,11,.7); padding:6px 11px;
         white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:44vw; }
  .dot { width:6px; height:6px; border-radius:50%; background:var(--cyan-hi); flex:none;
         box-shadow:0 0 6px var(--cyan-hi), 0 0 14px rgba(127,230,242,.5);
         animation:breathe 3.4s ease-in-out infinite; }
  @keyframes breathe { 0%,100%{opacity:1} 50%{opacity:.35} }
  .tname { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip { margin-left:auto; font:10px/1 var(--mono); letter-spacing:.1em; color:var(--cyan);
          border:1px solid var(--line-dim); padding:6px 10px; }
  /* ── 侧栏 ───────────────────────────────── */
  aside { grid-area:side; border-right:1px solid var(--line-dim); overflow-y:auto;
          background:linear-gradient(180deg, rgba(12,19,16,.9), rgba(11,14,11,.6)); padding:14px 12px 30px; }
  .sec { margin-bottom:20px; }
  .sec h3 { margin:0 0 8px; font:10px/1 var(--mono); letter-spacing:.18em; color:var(--cyan);
            display:flex; align-items:center; gap:8px; }
  .sec h3::after { content:""; flex:1; height:1px; background:var(--line-dim); }
  .item { display:block; width:100%; text-align:left; background:transparent; border:1px solid transparent;
          color:var(--fg); padding:6px 9px; cursor:pointer; font:12px/1.5 inherit;
          overflow:hidden; }
  .item:hover { border-color:var(--line-dim); background:rgba(15,151,164,.06); }
  .item .m { display:block; font:10px/1.5 var(--mono); color:var(--dim); letter-spacing:.04em;
             overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .item .preview { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .item.on { border-color:var(--line); background:rgba(15,151,164,.1); }
  .bar { display:block; height:2px; background:rgba(15,151,164,.16); margin-top:5px; }
  .bar i { display:block; height:100%; background:var(--cyan); box-shadow:0 0 8px rgba(15,151,164,.7); }
  .tier { font:9px/1 var(--mono); color:var(--dim); border:1px solid var(--line-dim); padding:2px 4px; margin-left:6px; }
  /* ── 主列 ───────────────────────────────── */
  /* 关键：flex/grid 子项默认 min-height:auto，内容会把输入框挤出视口（踩过） */
  main { grid-area:main; display:flex; flex-direction:column; min-width:0; min-height:0; }
  #scroll { flex:1 1 auto; min-height:0; overflow-y:auto; padding:22px 26px 26px; }
  aside { min-height:0; }
  .col { max-width:840px; margin:0 auto; }
  .day { display:flex; align-items:center; gap:10px; margin:26px 0 12px;
         font:10px/1 var(--mono); letter-spacing:.16em; color:var(--cyan); }
  .day::after { content:""; flex:1; height:1px; background:var(--line-dim); }
  .gap { display:flex; align-items:center; gap:12px; margin:16px 0; font:10px/1 var(--mono);
         letter-spacing:.14em; color:rgba(111,143,146,.9); }
  .gap::before, .gap::after { content:""; flex:1; height:1px;
         background:repeating-linear-gradient(90deg, var(--line) 0 5px, transparent 5px 10px); }
  .row { display:grid; grid-template-columns:28px 1fr; gap:12px; margin:14px 0; align-items:start; }
  /* 用户行：头像放右边，正文右对齐（像 pi-web 的对话排列） */
  .row.user { grid-template-columns:1fr 28px; }
  .row.user .av { order:2; }
  .row.user > div:nth-child(2) { order:1; }
  .row.user .meta { text-align:right; }
  /* 用 text-align + line-height 居中，别用 grid 居中单个 CJK 字形（实测会偏出框） */
  .av { width:28px; height:28px; border:1px solid var(--line-dim); display:block;
        text-align:center; line-height:26px; font-size:12px;
        font-family:"Microsoft YaHei","PingFang SC",var(--mono); color:var(--cyan); }
  .row.user .av { color:var(--amber); border-color:rgba(255,180,84,.3); }
  .meta { font:10px/1 var(--mono); letter-spacing:.12em; color:var(--dim); margin:2px 0 7px; }
  .row.user .meta { color:rgba(255,180,84,.75); }
  .body { background:var(--panel2); border:1px solid var(--line-dim);
          border-left:2px solid var(--line); padding:12px 15px; display:inline-block; max-width:100%; }
  .row.user .body { background:var(--panel2); border-color:rgba(255,180,84,.22);
                    border-left:0; border-right:2px solid var(--amber);
                    margin-left:auto; max-width:82%; text-align:left; }
  .body > :first-child { margin-top:0; } .body > :last-child { margin-bottom:0; }
  .body p { margin:8px 0; } .body ul, .body ol { margin:8px 0; padding-left:22px; }
  .body li { margin:3px 0; }
  .body h1, .body h2, .body h3, .body h4 { margin:12px 0 6px; font-size:15px; letter-spacing:.02em; }
  .body code { font:12px/1.5 var(--mono); background:rgba(15,151,164,.12); padding:1px 5px; color:var(--cyan-hi); }
  .body pre.code { background:#070b09; border:1px solid var(--line-dim); padding:11px 13px; overflow-x:auto;
                   font:12px/1.6 var(--mono); color:#bfe9ef; }
  .body pre.code code { background:none; padding:0; color:inherit; }
  .body blockquote { margin:8px 0; padding:4px 0 4px 12px; border-left:2px solid var(--line); color:var(--dim); }
  .body a { color:var(--cyan-hi); } .body hr { border:0; border-top:1px solid var(--line-dim); margin:12px 0; }
  .body b { color:#eafcff; }
  /* 工具卡 */
  details.tool { margin:8px 0; border:1px solid var(--line-dim); background:rgba(15,151,164,.05);
                 font:11px/1.5 var(--mono); }
  details.tool summary { cursor:pointer; padding:7px 10px; color:var(--cyan-hi); letter-spacing:.06em;
                 display:flex; gap:10px; align-items:center; }
  details.tool summary::marker { color:var(--cyan); }
  .tms { color:var(--dim); margin-left:auto; }
  .targs, .tres { margin:0; padding:9px 12px; border-top:1px solid var(--line-dim);
                 white-space:pre-wrap; word-break:break-word; color:#a9c9cf; max-height:220px; overflow:auto; }
  .tres { border-top:0; color:var(--dim); }
  .cursor { display:inline-block; width:7px; height:14px; background:var(--cyan-hi);
            vertical-align:-2px; animation:breathe 1s steps(2) infinite; }
  .sys { font:10px/1.6 var(--mono); color:var(--red); letter-spacing:.06em; margin:8px 0; }
  /* 输入区 */
  form#composer { border-top:1px solid var(--line-dim); padding:12px 26px 16px;
                  background:rgba(11,14,11,.92); box-shadow:0 -1px 0 rgba(15,151,164,.18); }
  .wrap { max-width:840px; margin:0 auto; display:flex; gap:10px; align-items:center; }
  .prompt { font:13px/1 var(--mono); color:var(--cyan); flex:none; }
  input, select, textarea { width:100%; color:var(--fg); font:inherit; background:rgba(8,13,11,.8);
        border:1px solid var(--line-dim); padding:11px 13px; transition:.15s; border-radius:0; }
  input:focus, select:focus, textarea:focus { outline:none; border-color:var(--cyan);
        box-shadow:0 0 0 1px rgba(15,151,164,.4), 0 0 18px rgba(15,151,164,.18); }
  form#composer input { flex:1; }
  button.send { flex:none; width:42px; height:42px; cursor:pointer; color:var(--cyan-hi);
        background:rgba(15,151,164,.12); border:1px solid var(--line); font:15px/1 var(--mono); }
  button.send:hover { background:var(--cyan); color:#0b0e0b; }
  /* 面板：设置 / 记忆 */
  .panelbox { background:var(--panel2); border:1px solid var(--line-dim); padding:18px 18px 20px; margin-bottom:18px; position:relative; }
  .panelbox::before, .panelbox::after { content:""; position:absolute; width:11px; height:11px;
        border:1px solid var(--cyan); pointer-events:none; }
  .panelbox::before { top:-1px; left:-1px; border-right:0; border-bottom:0; }
  .panelbox::after { right:-1px; bottom:-1px; border-left:0; border-top:0; }
  .panelbox > h2 { margin:0 0 12px; font:10px/1 var(--mono); letter-spacing:.18em; color:var(--cyan); }
  label { display:block; font:10px/1 var(--mono); letter-spacing:.1em; color:var(--dim); margin:14px 0 6px; }
  .two { display:flex; gap:12px; } .two > * { flex:1; }
  .acts { margin-top:16px; display:flex; gap:12px; align-items:center; }
  .acts button { font:10px/1 var(--mono); letter-spacing:.1em; padding:9px 15px; cursor:pointer;
                 background:transparent; color:var(--dim); border:1px solid var(--line-dim); }
  .acts button:hover { color:var(--cyan-hi); border-color:var(--line); }
  .acts button.primary { color:var(--cyan-hi); border-color:var(--line); background:rgba(15,151,164,.1); }
  .acts button.primary:hover { background:var(--cyan); color:#0b0e0b; }
  textarea { min-height:190px; font:12px/1.8 var(--mono); }
  .hint { color:var(--dim); font:11px/1.8 var(--mono); margin:8px 0 0; }
  .ok { color:var(--ok); font:11px/1 var(--mono); } .err { color:var(--red); font:11px/1 var(--mono); }
  .banner { border:1px solid rgba(255,180,84,.4); background:rgba(255,180,84,.06);
            color:var(--amber); font:11px/1.7 var(--mono); padding:10px 13px; margin-bottom:16px; }
  .banner button { margin-left:8px; font:10px/1 var(--mono); background:transparent;
            color:var(--amber); border:1px solid rgba(255,180,84,.5); padding:5px 10px; cursor:pointer; }
  .frame { position:fixed; inset:8px; pointer-events:none; z-index:20; border:1px solid rgba(15,151,164,.1); }
  .frame i { position:absolute; width:14px; height:14px; border:1px solid var(--cyan); opacity:.8; }
  .frame i:nth-child(1) { top:-1px; left:-1px; border-right:0; border-bottom:0; }
  .frame i:nth-child(2) { top:-1px; right:-1px; border-left:0; border-bottom:0; }
  .frame i:nth-child(3) { bottom:-1px; left:-1px; border-right:0; border-top:0; }
  .frame i:nth-child(4) { bottom:-1px; right:-1px; border-left:0; border-top:0; }
  .frame b { position:absolute; font:9px/1 var(--mono); letter-spacing:.2em; color:rgba(15,151,164,.5); }
  .frame b.bl { bottom:5px; left:10px; } .frame b.br { bottom:5px; right:10px; }
  @media (max-width: 860px) {
    body { grid-template-columns:1fr; grid-template-areas:"head" "main"; }
    aside { position:fixed; z-index:12; top:56px; bottom:0; left:0; width:82vw; max-width:320px;
            transform:translateX(-102%); transition:.22s; border-right:1px solid var(--line); }
    aside.open { transform:none; }
    .chip { display:none; }
  }
</style></head>
<body>
<div class="frame"><i></i><i></i><i></i><i></i><b class="bl">JJ-OS · LOCAL · 127.0.0.1</b><b class="br">MEMORY CORE</b></div>
<header>
  <span class="brand">鲸鲸<small>JJ-OS v0.2</small></span>
  <span class="hud"><i class="dot"></i><span id="state">…</span><span id="readout"></span></span>
  <span class="chip" id="modelchip">…</span>
</header>

<aside id="side">
  <div class="sec"><h3>SESSIONS</h3><div id="sesslist"></div></div>
  <div class="sec"><h3>TOOLS</h3><div id="toollist"><button class="item on" data-view="chat">对话<span class="m">与鲸鲸说话</span></button></div></div>
  <div class="sec"><h3>MEMORY</h3><div id="memlist"></div></div>
  <div class="sec"><h3>CONFIG</h3>
    <button class="item" data-view="cfg">设置<span class="m">接口 / 人格</span></button>
  </div>
</aside>

<main>
  <div id="scroll"><div class="col">
    <div id="banner" class="banner" hidden></div>
    <div id="chat"></div>

    <div id="toolview" hidden>
      <div class="panelbox">
        <h2 id="t-title">TOOL</h2>
        <p class="hint" id="t-desc"></p>
        <p class="hint" id="t-tier"></p>
        <pre class="code" id="t-params" style="white-space:pre-wrap"></pre>
        <div class="acts"><button id="t-use">在输入框里试试</button></div>
      </div>
    </div>

    <div id="memview" hidden>
      <div class="panelbox">
        <h2>MEMORY ENTRY</h2>
        <p id="mv-text" style="white-space:pre-wrap"></p>
        <p class="hint" id="mv-meta"></p>
        <div class="acts">
          <button id="mv-forget" class="primary">忘记这条</button>
          <span id="mv-msg" class="hint"></span>
        </div>
      </div>
    </div>

    <div id="cfg" hidden>
      <div class="panelbox">
        <h2>ENDPOINT · 接口</h2>
        <div class="two">
          <div><label>provider</label>
            <select id="c-provider">
              <option value="deepseek">deepseek</option>
              <option value="anthropic">anthropic</option>
              <option value="openai">openai</option>
            </select></div>
          <div><label>model</label><input id="c-model" placeholder="deepseek-chat"></div>
        </div>
        <label>baseUrl（可选）</label><input id="c-base" placeholder="https://api.deepseek.com">
        <label>api key（保存后只显示指纹）</label><input id="c-key" type="password" placeholder="sk-…" autocomplete="off">
        <div class="acts"><button id="c-save" class="primary">保存接口</button><span id="c-msg" class="hint"></span></div>
        <p class="hint" id="c-cur">…</p>
      </div>

      <div class="panelbox">
        <h2>PERSONA · 人格</h2>
        <div class="two">
          <div><label>文件</label>
            <select id="p-file">
              <option value="core">core · 我是谁</option>
              <option value="voice">voice · 语气样本</option>
              <option value="values">values · 立场与代价</option>
              <option value="boundaries">boundaries · 禁区</option>
              <option value="evidence">evidence · 证据优先级</option>
              <option value="tools">tools · 工具与目录</option>
            </select></div>
          <div><label>提示</label><p class="hint">语气靠样本锚定，不靠形容词</p></div>
        </div>
        <textarea id="p-text" spellcheck="false"></textarea>
        <div class="acts"><button id="p-save" class="primary">保存人格</button><span id="p-msg" class="hint"></span></div>
      </div>
    </div>
  </div></div>

  <form id="composer"><div class="wrap">
    <span class="prompt">&gt;</span>
    <input id="m" placeholder="说点什么…（它能查记忆、读文件、调工具）" autocomplete="off">
    <button class="send">▲</button>
  </div></form>
</main>
<script>
const $ = (s) => document.querySelector(s);
const NL2 = String.fromCharCode(10, 10);
const H = { "x-jj": "1", "content-type": "application/json" };
let view = "chat", TOOLS = [], MEMS = [];

function show(v) {
  view = v;
  for (const id of ["chat", "cfg", "toolview", "memview"]) $("#" + id).hidden = id !== v;
  $("#composer").style.display = v === "chat" ? "" : "none";
  for (const b of document.querySelectorAll("#side .item")) {
    b.classList.toggle("on", b.dataset.view === v);
  }
  $("#side").classList.remove("open");
}
function gapText(ms) {
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  if (d > 0) return d + " 天 " + h + " 小时";
  if (h > 0) return h + " 小时 " + (m % 60) + " 分";
  return m + " 分钟";
}
function clock(iso) {
  const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
async function state() {
  const s = await (await fetch("/api/state")).json();
  $("#state").textContent = s.line + (s.state?.text ? " · " + s.state.text : "");
  // 断电提示：只在重启后第一次显示（服务端只给一次）
  if (s.outage) {
    const b = $("#banner");
    const kind = s.outage.kind === "power" ? "断电" : s.outage.kind === "crash" ? "进程被杀" : "关机";
    b.hidden = false;
    b.innerHTML = "// " + kind + " " + String(s.outage.from).slice(5, 16).replace("T", " ") + " → " +
      String(s.outage.to).slice(5, 16).replace("T", " ") + " —— 那段我没有经历";
  }
  const g = (k) => (s.memories || []).find((m) => m.stage === k);
  $("#readout").textContent = "MEM " + (((g("active") || {}).c || 0) + ((g("fading") || {}).c || 0)) +
    " · ACT " + ((g("active") || {}).c || 0);
}
function rowHtml(b) {
  const isUser = b.role === "user";
  const body = isUser ? escapeHtml(b.text).replace(/&lt;br&gt;/g, "<br>") : (b.html || escapeHtml(b.text));
  const tools = (b.tools || []).join("");
  return "<div class='row " + b.role + "'><div class='av'>" + (isUser ? "U" : "鲸") + "</div><div>" +
    "<div class='meta'>" + (isUser ? "USER" : "鲸鲸") + " · " + clock(b.ts) + "</div>" +
    "<div class='body md'>" + body + tools + "</div></div></div>";
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function timeline() {
  const blocks = await (await fetch("/api/timeline")).json();
  const el = $("#chat"); el.innerHTML = "";
  for (const b of blocks) {
    if (b.type === "day") {
      el.insertAdjacentHTML("beforeend", "<div class='day'>" + b.label +
        (b.gapMs ? "  //  距上次 " + gapText(b.gapMs) : "") + "</div>");
    } else if (b.type === "gap") {
      el.insertAdjacentHTML("beforeend", "<div class='gap'>// 信号中断 " + b.label + "</div>");
    } else {
      el.insertAdjacentHTML("beforeend", rowHtml(b));
    }
  }
  scrollBottom();
}
async function sessions() {
  const blocks = await (await fetch("/api/timeline")).json();
  const days = blocks.filter((b) => b.type === "day");
  const lastMsg = blocks.filter((b) => b.type === "msg").slice(-1)[0];
  $("#sesslist").innerHTML =
    "<button class='item on' data-view='chat'>现在<span class='m'>" +
    (lastMsg ? clock(lastMsg.ts) : "还没聊过") + "</span></button>" +
    days.slice(-5).reverse().map((d) =>
      "<button class='item' data-view='chat' data-day='" + d.label + "'>" +
      "<span class='preview'>" + d.label + "</span>" +
      "<span class='m'>" + (d.gapMs ? "距上次 " + gapText(d.gapMs) : "—") + "</span></button>").join("");
}
/** 点会话 → 滚到那一天的标题 */
function jumpToDay(label) {
  const els = [...document.querySelectorAll("#chat .day")];
  const el = els.find((e) => e.textContent.startsWith(label));
  if (el) el.scrollIntoView({ block: "start" });
}
async function tools() {
  const ts = await (await fetch("/api/tools")).json();
  TOOLS = ts;
  $("#toollist").innerHTML = ts.map((t, i) =>
    "<button class='item' data-view='toolview' data-tool='" + i + "'><span class='preview tname'>" + t.name +
    "<span class='tier'>" + t.tier + "</span></span><span class='m'>" + escapeHtml(t.description) + "</span></button>").join("");
}
async function memories() {
  const rows = await (await fetch("/api/memories")).json();
  MEMS = rows;
  $("#memlist").innerHTML = rows.slice(0, 8).map((r) =>
    "<button class='item' data-view='memview' data-mem='" + r.id + "'>" +
    "<span class='preview'>" + escapeHtml(r.text) + "</span>" +
    "<span class='m'>" + r.weight.toFixed(2) + " · " + r.stage + "</span>" +
    "<span class='bar'><i style='width:" + Math.round(r.weight * 100) + "%'></i></span></button>").join("");
}
async function openTool(i) {
  const t = TOOLS[i]; if (!t) return;
  $("#t-title").textContent = t.name;
  $("#t-desc").textContent = t.description;
  $("#t-tier").textContent = "档位 " + t.tier + " · 参数 " + Object.keys((t.parameters || {}).properties || {}).join(", ");
  $("#t-params").textContent = JSON.stringify(t.parameters || {}, null, 2);
  $("#t-use").onclick = () => { show("chat"); $("#m").value = "用 " + t.name + " "; $("#m").focus(); };
  show("toolview");
}
async function openMemory(id) {
  const r = await (await fetch("/api/memories/" + id)).json();
  $("#mv-text").textContent = r.text;
  $("#mv-meta").textContent = "id " + r.id + " · " + r.layer + "/" + r.kind + " · " + r.stage +
    " · 权重 " + Number(r.weight).toFixed(2) + " · " + r.sensitivity + " · " + r.taint +
    " · 建于 " + String(r.created_at).slice(0, 19);
  $("#mv-msg").textContent = "";
  $("#mv-forget").onclick = async () => {
    const j = await (await fetch("/api/memories/" + id + "/forget", { method: "POST", headers: H })).json();
    if (j.ok) { $("#mv-msg").className = "ok"; $("#mv-msg").textContent = "已忘记"; await memories(); }
    else { $("#mv-msg").className = "err"; $("#mv-msg").textContent = j.error || "失败"; }
  };
  show("memview");
}
function scrollBottom() {
  const s = $("#scroll"); s.scrollTop = s.scrollHeight;
}
async function loadConfig() {
  const c = await (await fetch("/api/config")).json();
  $("#c-provider").value = c.provider;
  $("#c-model").value = c.model;
  $("#c-base").value = c.baseUrl || "";
  $("#modelchip").textContent = c.provider.toUpperCase() + " · " + c.model;
  $("#c-cur").textContent = "当前 " + c.provider + " / " + c.model +
    (c.hasKey ? " · key " + c.keyFingerprint + " (" + c.secretStore + ")" : " · 还没配 key") +
    " · 预算 $" + c.budgetUsd + "/天";
  const b = $("#banner");
  if (!c.hasKey) {
    b.hidden = false;
    b.innerHTML = "// 未配置 API key —— 仅本地推理，云端不会回答 <button id='go-cfg'>去设置</button>";
    $("#go-cfg").onclick = () => show("cfg");
  } else { b.hidden = true; }
  return c;
}
async function loadPersona(file) {
  const p = await (await fetch("/api/persona")).json();
  $("#p-text").value = p.files[file] || "";
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("#side .item");
  if (!t || !t.dataset.view) return;
  const v = t.dataset.view;
  for (const b of document.querySelectorAll("#side .item")) b.classList.toggle("on", b === t);
  if (v === "cfg") { show("cfg"); loadConfig().then(() => loadPersona($("#p-file").value)); return; }
  if (v === "toolview") { openTool(Number(t.dataset.tool)); return; }
  if (v === "memview") { openMemory(Number(t.dataset.mem)); return; }
  show("chat");
  if (t.dataset.day) jumpToDay(t.dataset.day);
});
$("#p-file").onchange = (e) => loadPersona(e.target.value);
// 移动端：点主区域收起抽屉
document.addEventListener("click", (e) => {
  const side = $("#side");
  if (!side.classList.contains("open")) return;
  if (e.target.closest("#side")) return;
  side.classList.remove("open");
});
$("#c-save").onclick = async () => {
  const body = { provider: $("#c-provider").value, model: $("#c-model").value.trim() };
  const base = $("#c-base").value.trim(); if (base) body.baseUrl = base;
  const key = $("#c-key").value.trim(); if (key) body.key = key;
  const j = await (await fetch("/api/config", { method: "PUT", headers: H, body: JSON.stringify(body) })).json();
  const m = $("#c-msg");
  if (j.ok) { m.className = "ok"; m.textContent = "SAVED"; $("#c-key").value = ""; await loadConfig(); }
  else { m.className = "err"; m.textContent = j.error || "FAILED"; }
};
$("#p-save").onclick = async () => {
  const body = { file: $("#p-file").value, content: $("#p-text").value, because: $("#p-because").value.trim() };
  const j = await (await fetch("/api/persona", { method: "PUT", headers: H, body: JSON.stringify(body) })).json();
  const m = $("#p-msg");
  if (j.ok) { m.className = "ok"; m.textContent = j.changed ? "SAVED · 已留版本与理由" : "NO CHANGE"; $("#p-because").value = ""; }
  else { m.className = "err"; m.textContent = j.error || "FAILED"; }
};

$("#composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#m").value.trim(); if (!text) return;
  $("#m").value = "";
  const el = $("#chat");
  el.insertAdjacentHTML("beforeend", rowHtml({ role: "user", ts: new Date().toISOString(), text }));
  const id = "live-" + Date.now();
  el.insertAdjacentHTML("beforeend",
    "<div class='row agent' id='" + id + "'><div class='av'>鲸</div><div>" +
    "<div class='meta'>鲸鲸 · 处理中…</div><div class='body md'><span class='cursor'></span></div></div></div>");
  const box = document.querySelector("#" + id + " .md");
  const meta = document.querySelector("#" + id + " .meta");
  let acc = "";
  try {
    const res = await fetch("/api/say", { method: "POST", headers: H, body: JSON.stringify({ text }) });
    if (!res.ok) { const j = await res.json(); box.innerHTML = "<span class='sys'>E: " + (j.error || res.status) + "</span>"; return; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const r = await reader.read(); if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const frames = buf.split(NL2); buf = frames.pop() || "";
      for (const f of frames) {
        const mm = f.match(/^data: (.*)$/m); if (!mm) continue;
        const d = JSON.parse(mm[1]);
        if (d.type === "delta") { acc += d.text; box.innerHTML = escapeHtml(acc) + "<span class='cursor'></span>"; }
        if (d.type === "tool") {
          meta.textContent = "鲸鲸 · 调用 " + d.name;
          box.insertAdjacentHTML("beforeend",
            "<details class='tool' open><summary><span class='tn'>" + escapeHtml(d.name) + "</span>" +
            "<span class='tms'>运行中…</span></summary><pre class='targs'>" + escapeHtml(d.args || "") + "</pre></details>");
        }
        if (d.type === "tool_result") {
          const cards = box.querySelectorAll("details.tool");
          const last = cards[cards.length - 1];
          if (last) { last.querySelector(".tms").textContent = d.ms + "ms";
            last.insertAdjacentHTML("beforeend", "<pre class='tres'>" + escapeHtml(d.result) + "</pre>"); }
        }
        if (d.type === "error") box.insertAdjacentHTML("beforeend", "<div class='sys'>E: " + escapeHtml(d.message) + "</div>");
        if (d.type === "done") { meta.textContent = "鲸鲸 · " + clock(new Date().toISOString()); }
      }
      scrollBottom();
    }
  } catch (err) {
    box.innerHTML = "<span class='sys'>网络错误：" + escapeHtml(err.message || err) + "</span>";
  }
  await timeline(); await state(); await memories();
};
state(); timeline(); sessions(); tools(); memories(); loadConfig(); setInterval(state, 30000);
</script>
</body></html>`;
