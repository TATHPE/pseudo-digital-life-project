/**
 * 单页（零前端依赖、零构建）。
 *
 * 排列参照 pi-web：左侧栏（会话/工具/记忆/设置）+ 右侧主列（对话）+ 底部输入。
 * 视觉参照《流浪地球》FUI：黑底、**白色细线**、等宽小标、角标、读数。
 * 配色铁律（改过两次，写死在这里）：
 *   **黑底 + 白边框 + 加粗白字** —— 结构（框线/分隔/小标/读数/按钮/胶囊）全部如此，
 *   `--ink #e9f0f2` 的各档透明度就够了，不靠颜色区分层级。
 *   **全站唯一保留青色的地方**：鲸鲸的回话气泡（底色 + 左侧竖线）。
 *   琥珀仍给你这一侧与待确认告警，红仍给被拒/错误。
 * 走过的弯路：把采样到的青 #0f97a4 当壁纸用满全站 → 一屏一种颜色、层次没了、10px 青字也更难读。
 *
 * 17 §4 的硬约束不变：没有「新对话」；时间空白可见；状态是"醒着/距上次"。
 * 07 §4 的克制不变：不做点赞/计数徽章——读数只显示系统量。
 *
 * 图标：鲸尾「Whale Tail」 by Lorc — https://game-icons.net/1x1/lorc/whale-tail.html
 *   许可 CC BY 3.0（https://creativecommons.org/licenses/by/3.0/）—— 使用时必须保留本条署名。
 *   原图为 512×512 单路径，未改形状；只用 currentColor 上色。
 *
 * 本文件是"生成代码"：模板字符串里的反斜杠会被吃掉一次，
 * 所以**不用任何反斜杠转义**（换行用 String.fromCharCode(10)），并有测试跑 node --check。
 */
export const PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pseudo Digital Life Project</title>
<!-- PWA（19 §7.5）：装到桌面后是独立窗口，不是浏览器标签页 -->
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon-180.png">
<meta name="theme-color" content="#0b0e0b">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="鲸鲸">
<style>
  :root {
    --void:#0b0e0b; --panel:#0e1512; --panel2:rgba(16,24,21,.72);
    /* 参照图的框线/小标其实是**白**的，青色只标"在动的东西"（数据/在线/激活）。
       之前把青色当成壁纸：一屏只有一种颜色，层次没了，10px 小字也更难读。 */
    --ink:#e9f0f2; --ink-dim:#b9c6c9;
    --line:rgba(233,240,242,.30); --line-dim:rgba(233,240,242,.13);
    --cyan:#0f97a4; --cyan-hi:#7fe6f2; --fg:#e9f0f2; --dim:#9fb0b3;
    --amber:#ffb454; --red:#ff5f56; --ok:#7fd18b;
    --mono:ui-monospace,"Cascadia Mono",Consolas,"Noto Sans Mono",monospace;
    --rail:252px; --head:56px; --readh:40px;

    /* ── 仪表带：照参照图的"标签 / 读数 / 单位"三件套，一格一读数 ── */
  }
  #readoutbar { grid-area:readout; display:flex; align-items:stretch; gap:0; overflow:hidden;
                background:rgba(8,11,10,.94); border-bottom:1px solid var(--line-dim); }
  .ro { position:relative; display:flex; flex-direction:column; justify-content:center; gap:1px;
        padding:3px 12px; border-right:1px solid var(--line-dim); min-width:0; flex:none; }
  .ro::after { content:""; position:absolute; top:3px; right:3px; width:5px; height:5px;
               border-top:1px solid var(--line); border-right:1px solid var(--line); }
  .ro:first-child { padding-left:18px; }
  .ro-l { font:8px/1 var(--mono); letter-spacing:.22em; color:var(--ink); font-weight:700; white-space:nowrap; }
  .ro-v { font:13px/1 var(--mono); color:var(--ink); font-weight:700; letter-spacing:.04em; white-space:nowrap; }
  .ro-v .u { font-size:9px; color:var(--ink-dim); font-weight:700; margin-left:3px; letter-spacing:0; }
  .ro-w { flex:1 1 auto; min-width:0; }
  /* 分段条：参照图里的刻度条 */
  .segs { display:flex; gap:1px; height:6px; align-items:stretch; margin-top:2px; min-width:120px; }
  .segs i { flex:1; background:rgba(233,240,242,.22); }
  .segs i.on { background:var(--ink); box-shadow:0 0 5px rgba(233,240,242,.5); }
  .segs i.hot { background:var(--amber); }

  /* ── 底部 ticker：一条横贯的状态带（手机上隐藏）── */
  .ticker { display:flex; align-items:center; gap:8px; padding:5px 26px; overflow:hidden;
            border-top:1px solid var(--line-dim); background:rgba(8,11,10,.94); }
  .ticker .tk { position:relative; font:9px/1 var(--mono); letter-spacing:.1em; color:var(--ink); font-weight:600;
                border:1px solid var(--line); background:#000; padding:4px 7px; white-space:nowrap; }
  .ticker .tk::after { content:""; position:absolute; top:2px; right:2px; width:4px; height:4px;
                       border-top:1px solid var(--line); border-right:1px solid var(--line); }
  .ticker .tk b { color:var(--ink); font-weight:700; }
  .ticker .tk.warn { color:var(--amber); border-color:rgba(255,180,84,.4); }
  .ticker .tk.bad { color:var(--red); border-color:rgba(255,95,86,.45); }
  .ticker .tk.fade { opacity:.55; }
  {
  }
  * { box-sizing:border-box; }
  /* hidden 属性必须压过类里的 display（.badge{display:inline-flex} 会让 hidden 失效，实测咬过） */
  [hidden] { display:none !important; }
  /* ── 原生控件适配：不加这一段，暗色界面里会出现灰白滚动条、
        亮色下拉弹层、系统蓝选中色 —— 一眼就出戏 ── */
  :root { color-scheme:dark; }
  /* 注意：Chromium 里一旦设了标准属性 scrollbar-width/scrollbar-color，
     就会忽略 ::-webkit-scrollbar* 伪元素（于是又变回系统滚动条 + 箭头按钮）。
     所以标准属性只给 Firefox（用 @supports 区分），Chromium 走 webkit 伪元素。 */
  @supports (-moz-appearance:none) {
    * { scrollbar-width:thin; scrollbar-color:rgba(233,240,242,.35) transparent; }
  }
  *::-webkit-scrollbar { width:6px; height:6px; }
  *::-webkit-scrollbar-track { background:transparent; }
  *::-webkit-scrollbar-thumb { background:rgba(233,240,242,.28); }
  *::-webkit-scrollbar-thumb:hover { background:rgba(233,240,242,.5); }
  *::-webkit-scrollbar-corner { background:transparent; }
  *::-webkit-scrollbar-button { display:none; }   /* 去掉 Windows 上下的箭头按钮 */
  ::selection { background:rgba(233,240,242,.30); color:#fff; }
  /* placeholder 是正文：原来 rgba(111,143,146,.75) 合成后 3.7:1，改 --dim（9.2:1） */
  input::placeholder, textarea::placeholder { color:var(--dim); opacity:1; }
  input::-ms-reveal, input::-ms-clear { display:none; }
  select { color-scheme:dark; }
  :focus-visible { outline:1px solid var(--ink); outline-offset:1px; }
  input, textarea { caret-color:var(--ink); }
  /* placeholder 也是正文：3.7:1 不够（检测器抓到 3 处），提到 --dim */
  ::placeholder { color:var(--dim); opacity:1; }
  /* Chrome/Edge 自动填充会强行刷浅黄底，只能这样压回去 */
  input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus {
    -webkit-text-fill-color:var(--fg);
    -webkit-box-shadow:0 0 0 1000px #0a100e inset;
    transition:background-color 9999s ease-out 0s;
  }
  button:disabled { opacity:.45; cursor:not-allowed; }
  select option { background:#0e1512; color:var(--fg); }
  html, body { height:100%; }
  /* 刘海屏/圆角屏：内容不能钻到状态栏或手势条底下（viewport-fit=cover 之后必须自己补） */
  header { padding-top:env(safe-area-inset-top); }
  #composer { padding-bottom:max(0px, env(safe-area-inset-bottom)); }
  aside { padding-bottom:calc(30px + env(safe-area-inset-bottom)); }
  body {
    margin:0; color:var(--fg); background:var(--void);
    font:15px/1.72 -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif;
    display:grid; grid-template-rows:var(--head) var(--readh) 1fr; grid-template-columns:var(--rail) 1fr;
    grid-template-areas:"head head" "readout readout" "side main"; height:100vh; overflow:hidden;
    background-image:
      radial-gradient(900px 420px at 60% -140px, rgba(233,240,242,.06), transparent 70%),
      repeating-linear-gradient(0deg, rgba(233,240,242,.04) 0 1px, transparent 1px 36px),
      repeating-linear-gradient(90deg, rgba(233,240,242,.03) 0 1px, transparent 1px 36px);
  }
  header { grid-area:head; display:flex; align-items:center; gap:14px; padding:0 18px;
           background:rgba(11,14,11,.9); border-bottom:1px solid var(--line-dim); }
  .brand { display:flex; align-items:center; gap:10px; color:#eafcff; }
  .brand .ico { width:26px; height:26px; color:var(--ink);
                filter:drop-shadow(0 0 6px rgba(127,230,242,.35)); }
  .ico { display:block; fill:currentColor; }
  .hud { display:inline-flex; align-items:center; gap:9px; font:11px/1 var(--mono); letter-spacing:.06em;
         color:var(--dim); border:1px solid var(--line-dim); background:rgba(8,13,11,.7); padding:6px 11px;
         white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:44vw; }
  .dot { width:6px; height:6px; border-radius:50%; background:var(--ink); flex:none;
         box-shadow:0 0 6px rgba(233,240,242,.8), 0 0 14px rgba(233,240,242,.35);
         animation:breathe 3.4s ease-in-out infinite; }
  @keyframes breathe { 0%,100%{opacity:1} 50%{opacity:.35} }
  .tname { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #menu { display:none; align-items:center; justify-content:center; width:34px; height:34px; flex:none;
          background:#000; border:1px solid var(--line); color:var(--ink); font-weight:700; cursor:pointer;
          font:16px/1 var(--mono); padding:0; }
  #menu:hover { border-color:var(--ink); background:rgba(233,240,242,.10); }
  .chip { margin-left:auto; font:10px/1 var(--mono); letter-spacing:.1em; color:var(--ink); font-weight:700;
          border:1px solid var(--line); background:#000; padding:6px 10px; }
  /* ── 侧栏：纯黑 + 白细线 + 格子状条目（照参照图的“框装读数”）── */
  aside { grid-area:side; border-right:1px solid var(--line); overflow-y:auto;
          background:#000; padding:12px 10px 30px; }
  .sec { margin-bottom:14px; }
  /* 分区标题：带粗左边的标签条（参照图的 NAVIGATOR 那种） */
  .sec h3 { margin:0 0 6px; padding:6px 8px; background:#000;
            border:1px solid var(--line); border-left:3px solid var(--ink);
            font:10px/1 var(--mono); letter-spacing:.18em; color:var(--ink); font-weight:700;
            display:flex; align-items:center; gap:8px; }
  .item { position:relative; display:block; width:100%; text-align:left; background:#000; border:1px solid var(--line-dim);
          color:var(--ink); padding:5px 9px; margin-bottom:2px; cursor:pointer; font:12px/1.5 inherit;
          overflow:hidden; }
  .item::after { content:""; position:absolute; top:3px; right:3px; width:5px; height:5px;
                 border-top:1px solid var(--line); border-right:1px solid var(--line); pointer-events:none; }
  .item:hover { border-color:var(--ink); background:rgba(233,240,242,.07); }
  .item .m { display:block; font:10px/1.5 var(--mono); color:var(--ink-dim); letter-spacing:.04em;
             overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .item .preview { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .item.on { border-color:var(--ink); background:rgba(233,240,242,.12); box-shadow:inset 2px 0 0 var(--ink); }
  .bar { display:block; height:2px; background:rgba(233,240,242,.18); margin-top:5px; }
  .bar i { display:block; height:100%; background:var(--ink); box-shadow:0 0 8px rgba(233,240,242,.45); }
  .tier { font:9px/1 var(--mono); color:var(--ink-dim); font-weight:700; border:1px solid var(--line); padding:2px 4px; margin-left:6px; }
  /* ── 主列 ───────────────────────────────── */
  /* 关键：flex/grid 子项默认 min-height:auto，内容会把输入框挤出视口（踩过） */
  main { grid-area:main; display:flex; flex-direction:column; min-width:0; min-height:0; }
  #scroll { flex:1 1 auto; min-height:0; overflow-y:auto; padding:22px 26px 26px; }
  aside { min-height:0; }
  .col { max-width:840px; margin:0 auto; }
  .day { display:flex; align-items:center; gap:10px; margin:26px 0 12px;
         font:10px/1 var(--mono); letter-spacing:.16em; color:var(--ink); font-weight:700; }
  .day::after { content:""; flex:1; height:1px; background:var(--line-dim); }
  .gap { display:flex; align-items:center; gap:12px; margin:16px 0; font:10px/1 var(--mono);
         letter-spacing:.14em; color:var(--ink-dim); }
  .gap::before, .gap::after { content:""; flex:1; height:1px;
         background:repeating-linear-gradient(90deg, var(--line) 0 5px, transparent 5px 10px); }
  .row { display:grid; grid-template-columns:28px 1fr; gap:12px; margin:14px 0; align-items:start; }
  /* 用户行：头像放右边，正文右对齐（像 pi-web 的对话排列） */
  .row.user { grid-template-columns:1fr 28px; }
  .row.user .av { order:2; }
  .row.user > div:nth-child(2) { order:1; }
  .row.user .meta { text-align:right; }
  /* 头像：图标放进框里居中用 flex（文字也用同一套，别用 line-height 兼管两者） */
  .av { width:28px; height:28px; border:1px solid var(--line-dim); display:flex;
        align-items:center; justify-content:center; font-size:12px;
        font-family:"Microsoft YaHei","PingFang SC",var(--mono); color:var(--ink); font-weight:700; }
  .av .ico { width:20px; height:20px; }
  .row.user .av { color:var(--amber); border-color:rgba(255,180,84,.3); }
  /* ── 头像框（可更换，存在 data/config.json 的 ui.avatar）── */
  body[data-av="plain"] .av { border-radius:0; }
  body[data-av="bare"] .av { border-color:transparent; }
  body[data-av="ring"] .av { border-radius:50%; }
  body[data-av="cut"] .av { clip-path:polygon(7px 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%,0 7px); }
  body[data-av="glow"] .av { box-shadow:0 0 0 1px rgba(233,240,242,.18), 0 0 10px rgba(233,240,242,.3);
                             animation:avglow 3.2s ease-in-out infinite; }
  @keyframes avglow { 0%,100%{box-shadow:0 0 0 1px rgba(233,240,242,.18), 0 0 10px rgba(233,240,242,.28)}
                      50%{box-shadow:0 0 0 1px rgba(127,230,242,.5), 0 0 16px rgba(127,230,242,.45)} }
  .avprev { display:flex; align-items:center; gap:10px; padding:4px 0; }
  /* 待确认卡（T3）：不是普通过知——它后面跟着一条会真的执行的命令 */
  .pend { border:1px solid rgba(255,180,84,.34); background:rgba(255,180,84,.06); padding:7px 8px; margin-bottom:6px; }
  .pend .cmd { display:block; font:11px/1.5 var(--mono); color:var(--amber); word-break:break-all; }
  .pend .dir { display:block; font:9px/1.4 var(--mono); color:var(--dim); word-break:break-all; margin-top:3px; }
  /* 指纹是事实性文本，不能用装饰性的低透明度：合成后只有 2.6:1（检测器抓到的） */
  .pend .fp { display:block; font:9px/1.4 var(--mono); color:var(--dim); }
  .pend .acts { display:flex; gap:6px; margin-top:7px; }
  .pend .acts button { font:10px/1 var(--mono); letter-spacing:.06em; padding:5px 9px; cursor:pointer;
                       background:transparent; color:var(--fg); border:1px solid var(--line-dim); }
  .pend .acts button.ok { color:var(--amber); border-color:rgba(255,180,84,.5); }
  .pend .acts button.ok:hover { background:rgba(255,180,84,.12); }
  .pend .acts button.no:hover { background:rgba(233,240,242,.08); }
  .pend .msg { display:block; font:9px/1.4 var(--mono); color:var(--dim); margin-top:5px; }
  .meta { font:10px/1 var(--mono); letter-spacing:.12em; color:var(--ink-dim); font-weight:600; margin:2px 0 7px; }
  .row.user .meta { color:rgba(255,180,84,.75); }
  .body > :first-child { margin-top:0; } .body > :last-child { margin-bottom:0; }
  .body p { margin:8px 0; } .body ul, .body ol { margin:8px 0; padding-left:22px; }
  .body li { margin:3px 0; }
  .body h1, .body h2, .body h3, .body h4 { margin:12px 0 6px; font-size:15px; letter-spacing:.02em; }
  .body code { font:12px/1.5 var(--mono); background:rgba(233,240,242,.10); padding:1px 5px; color:var(--ink); }
  .body pre.code { background:#070b09; border:1px solid var(--line-dim); padding:11px 13px; overflow-x:auto;
                   font:12px/1.6 var(--mono); color:#bfe9ef; }
  .body pre.code code { background:none; padding:0; color:inherit; }
  .body blockquote { margin:8px 0; padding:4px 0 4px 12px; border-left:2px solid var(--line); color:var(--dim); }
  .body a { color:var(--ink); text-decoration:underline; text-underline-offset:2px; } .body hr { border:0; border-top:1px solid var(--line-dim); margin:12px 0; }
  .body b { color:#eafcff; }
  /* 工具卡 */
  details.tool { margin:8px 0; border:1px solid var(--line-dim); background:rgba(233,240,242,.05);
                 font:11px/1.5 var(--mono); }
  details.tool summary { cursor:pointer; padding:7px 10px; color:var(--ink); font-weight:600; letter-spacing:.06em;
                 display:flex; gap:10px; align-items:center; }
  details.tool summary::marker { color:var(--ink); }
  .tms { color:var(--dim); margin-left:auto; }
  .targs, .tres { margin:0; padding:9px 12px; border-top:1px solid var(--line-dim);
                 white-space:pre-wrap; word-break:break-word; color:#a9c9cf; max-height:220px; overflow:auto; }
  .tres { border-top:0; color:var(--dim); }
  .cursor { display:inline-block; width:7px; height:14px; background:var(--ink);
            vertical-align:-2px; animation:breathe 1s steps(2) infinite; }
  .sys { font:10px/1.6 var(--mono); color:var(--red); letter-spacing:.06em; margin:8px 0; }
  /* 输入区 */
  form#composer { border-top:1px solid var(--line-dim); padding:12px 26px 16px;
                  background:rgba(11,14,11,.92); box-shadow:0 -1px 0 rgba(233,240,242,.12); }
  .wrap { max-width:840px; margin:0 auto; display:flex; gap:10px; align-items:center; }
  .prompt { font:13px/1 var(--mono); color:var(--ink); font-weight:700; flex:none; }
  input, select, textarea { width:100%; color:var(--fg); font:inherit; background:#000;
        border:1px solid var(--line); padding:11px 13px; transition:.15s; border-radius:0; }
  input:focus, select:focus, textarea:focus { outline:none; border-color:var(--ink);
        box-shadow:0 0 0 1px rgba(233,240,242,.4), 0 0 18px rgba(233,240,242,.18); }
  form#composer input, form#composer textarea { flex:1; min-width:0; }
  /* 单行起步、随内容长高（最多 180px）；不写 height 的话 textarea 会自己撑成一大块 */
  #m { height:42px; min-height:42px; max-height:180px; resize:none; overflow-y:auto; line-height:1.5; }
  .wrap { align-items:flex-end; }
  button.send { flex:none; width:42px; height:42px; cursor:pointer; color:var(--ink); font-weight:700;
        background:rgba(233,240,242,.12); border:1px solid var(--line); font:15px/1 var(--mono); }
  button.send:hover { background:var(--ink); color:#000; }
  /* 面板：设置 / 记忆 */
  .panelbox { background:rgba(6,9,8,.92); border:1px solid var(--line); padding:18px 18px 20px; margin-bottom:18px; position:relative; }
  .panelbox::before, .panelbox::after { content:""; position:absolute; width:11px; height:11px;
        border:1px solid var(--line); pointer-events:none; }
  .panelbox::before { top:-1px; left:-1px; border-right:0; border-bottom:0; }
  .panelbox::after { right:-1px; bottom:-1px; border-left:0; border-top:0; }
  .panelbox > h2 { margin:0 0 12px; font:10px/1 var(--mono); letter-spacing:.18em; color:var(--ink); }
  label { display:block; font:10px/1 var(--mono); letter-spacing:.1em; color:var(--ink-dim); margin:14px 0 6px; }
  .two { display:flex; gap:12px; } .two > * { flex:1; }
  .acts { margin-top:16px; display:flex; gap:12px; align-items:center; }
  .acts button { font:10px/1 var(--mono); letter-spacing:.1em; padding:9px 15px; cursor:pointer;
                 background:transparent; color:var(--dim); border:1px solid var(--line-dim); }
  .acts button:hover { color:#000; border-color:var(--ink); background:var(--ink); }
  .acts button.primary { color:var(--ink); border-color:var(--line); background:rgba(233,240,242,.06); }
  .acts button.primary:hover { background:var(--ink); color:#000; }
  textarea { min-height:190px; font:12px/1.8 var(--mono); }
  .hint { color:var(--dim); font:11px/1.8 var(--mono); margin:8px 0 0; }
  .ok { color:var(--ok); font:11px/1 var(--mono); } .err { color:var(--red); font:11px/1 var(--mono); }
  .banner { border:1px solid rgba(255,180,84,.4); background:rgba(255,180,84,.06);
            color:var(--amber); font:11px/1.7 var(--mono); padding:10px 13px; margin-bottom:16px; }
  .banner button { margin-left:8px; font:10px/1 var(--mono); background:transparent;
            color:var(--amber); border:1px solid rgba(255,180,84,.5); padding:5px 10px; cursor:pointer; }
  .frame { position:fixed; inset:8px; pointer-events:none; z-index:20; border:1px solid rgba(233,240,242,.10); }
  .frame i { position:absolute; width:14px; height:14px; border:1px solid var(--line); opacity:.8; }
  .frame i:nth-child(1) { top:-1px; left:-1px; border-right:0; border-bottom:0; }
  .frame i:nth-child(2) { top:-1px; right:-1px; border-left:0; border-bottom:0; }
  .frame i:nth-child(3) { bottom:-1px; left:-1px; border-right:0; border-top:0; }
  .frame i:nth-child(4) { bottom:-1px; right:-1px; border-left:0; border-top:0; }
  /* 角标也是文字：.32 合成后 2.6:1，改 ink-dim（7.6:1） */
  .frame b { position:absolute; font:9px/1 var(--mono); letter-spacing:.2em; color:var(--ink-dim); }
  .frame b.bl { bottom:5px; left:10px; } .frame b.br { bottom:5px; right:10px; }
  @media (max-width: 860px) {
    body { grid-template-columns:1fr; grid-template-rows:var(--head) 1fr; grid-template-areas:"head" "main"; }
    #readoutbar, .ticker { display:none; }
    /* 手机上 chip 占位后，长 placeholder 会换行顶出输入框（截图抓到的） */
    #composer .wrap { align-items:center; }
    #m { overflow:hidden; }
    /* 抽屉：手机上不能是半透明的——聊天内容会透出来，看不出哪层在上 */
    aside { position:fixed; z-index:12; top:var(--head); bottom:0; left:0; width:82vw; max-width:320px;
            transform:translateX(-102%); transition:.22s; border-right:1px solid var(--line);
            background:var(--void); }
    aside.open { transform:none; }
    /* 遮罩用 box-shadow 而不是伪元素：伪元素 z-index:-1 会被 aside 自己的背景盖住，等于没有 */
    aside.open { box-shadow:0 0 0 100vmax rgba(0,0,0,.5); }
    .chip { display:none; }
    /* 窄屏状态行分级：保留时间与计数，收起那句描述（它最长、最容易被截成半句） */
    #statetext { display:none; }
    #menu { display:inline-flex; }
    /* 底部装饰标签会和输入框叠在一起，手机上直接不要 */
    .frame b { display:none; }
  }
  /* ── 自定义头像 ────────────────────────────────── */
  .av .avi { width:100%; height:100%; object-fit:cover; display:block; }
  .avav { display:flex; align-items:center; gap:10px; margin:6px 0 10px; }
  .avav .av { width:40px; height:40px; flex:none; }
  .avav .av .ico { width:26px; height:26px; }
  .avav .acts { display:flex; gap:8px; flex-wrap:wrap; }
  .avav .acts button { font:10px/1 var(--mono); padding:6px 9px; cursor:pointer; background:transparent;
                        color:var(--fg); border:1px solid var(--line-dim); }
  .avav .acts button:hover { border-color:var(--line); }
  .avav input[type=file] { display:none; }

  /* ── 气泡：两侧一眼分得开；**全站唯一保留青色的地方**就是鲸鲸的回话 ── */
  .body { background:rgba(13,31,34,.94); border:1px solid var(--line-dim);
          border-left:2px solid var(--cyan); padding:12px 15px; display:inline-block; max-width:100%; }
  /* 用户气泡：inline-block 上的 margin-left:auto 不生效（auto 只作用于块级盒子），改成 block + fit-content 才真的靠右 */
  .row.user .body { background:rgba(38,28,14,.92); border-color:rgba(255,180,84,.34);
                    border-left:0; border-right:2px solid var(--amber); display:block;
                    width:fit-content; margin-left:auto; max-width:82%; text-align:left; }

  /* ── 侧栏分区可折叠（MEMORY / DOCS / ACTIONS）────── */
  .sec h3 button { all:unset; cursor:pointer; display:flex; align-items:center; gap:8px; width:100%;
                   font:10px/1 var(--mono); letter-spacing:.18em; color:var(--ink-dim); }
  .sec h3 button::after { content:"−"; margin-left:auto; color:var(--dim); font-size:12px; letter-spacing:0; }
  .sec.collapsed h3 button::after { content:"+"; }
  .sec h3 button .n { color:var(--dim); letter-spacing:0; }

  /* ── 证据链（P0 #1/#2）：召回行 + 可点引用 ──────────── */
  .recall { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin:0 0 6px;
            font:10px/1.4 var(--mono); color:var(--dim); }
  .recall b { color:var(--ink-dim); font-weight:400; letter-spacing:.1em; }
  .notice { font:10px/1.4 var(--mono); color:var(--amber); border:1px solid rgba(255,180,84,.45); padding:2px 6px; }
  .cite { font:10px/1 var(--mono); color:var(--ink); font-weight:700; border:1px solid var(--line);
          padding:3px 6px; cursor:pointer; white-space:nowrap; }
  .cite:hover { background:var(--ink); color:#000; }
  .cite.missing { color:var(--dim); text-decoration:line-through; cursor:default; }

  /* ── 角标（P1 #10）：待确认 / 新消息 ───────────────── */
  .badge { display:inline-flex; align-items:center; justify-content:center; min-width:16px; height:16px;
           padding:0 4px; border-radius:9px; background:var(--amber); color:#1a1206;
           font:10px/1 var(--mono); letter-spacing:0; }
  .badge.dim2 { background:var(--ink); color:#000; }

  /* ── 搜索（P1 #8）──────────────────────────────────── */
  .searchbox { width:100%; background:#000; border:1px solid var(--line); color:var(--ink);
               font:600 12px/1.4 inherit; padding:6px 8px; }
  .searchbox:focus { border-color:var(--line); outline:none; }
  .hit { display:block; width:100%; text-align:left; background:transparent; border:1px solid transparent;
         color:var(--fg); padding:6px 8px; cursor:pointer; font:12px/1.5 inherit; }
  .hit:hover { background:rgba(233,240,242,.08); border-color:var(--line); }
  .hit .m { display:block; font:10px/1.5 var(--mono); color:var(--dim);
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* ── 动作审计（P0 #3）──────────────────────────────── */
  .arow { display:grid; grid-template-columns:auto auto 1fr auto; gap:10px; align-items:baseline;
          padding:6px 8px; border-bottom:1px solid var(--line-dim); font:11px/1.5 var(--mono); }
  .arow .v { color:var(--fg); }
  .arow .t { color:var(--dim); }
  .arow .d-ok { color:var(--ok); } .arow .d-no { color:var(--red); } .arow .d-wait { color:var(--amber); }
  .arow .ms { color:var(--dim); }

  /* ── 面板内摄入（P1 #6）────────────────────────────── */
  #dlg-path.bad { border-color:#d9534f; box-shadow:inset 0 0 0 1px #d9534f; }
  .ingest #dlg-cands, .ingest #dlg-empty { margin:6px 0 4px; }
  .ingest #dlg-empty code { color:var(--ink-dim); font:11px/1.6 var(--mono); word-break:break-all; }
  .ingest .acts { margin-top:8px; }
  .ingest .acts button { width:100%; }
  /* 命令面板（F-3）：黑底、白细线、只有一个青色留给鲸鲸气泡 —— 这里一律不用青 */
  #pal { position:fixed; inset:0; z-index:60; background:rgba(4,6,5,.72); display:flex; align-items:flex-start; justify-content:center; padding-top:12vh; }
  #pal[hidden] { display:none !important; }
  .palbox { width:min(620px, 92vw); background:var(--bg); border:1px solid var(--line); box-shadow:0 18px 60px rgba(0,0,0,.6); }
  #palq { width:100%; background:transparent; border:0; border-bottom:1px solid var(--line-dim); color:var(--fg);
          font:13px/1 var(--mono); padding:12px 14px; outline:none; letter-spacing:.04em; }
  #pallist { max-height:46vh; overflow:auto; }
  #pallist .pi { display:flex; justify-content:space-between; gap:10px; padding:8px 14px; cursor:pointer;
                 font:11px/1.4 var(--mono); color:var(--ink-dim); border-bottom:1px solid rgba(255,255,255,.04); }
  #pallist .pi .k { color:var(--dim); font-size:10px; }
  #pallist .pi.on { background:rgba(255,255,255,.06); color:var(--ink); font-weight:600; }
  #palhint { padding:6px 14px 10px; }

  /* 撤销条（F-3）：贴在输入框上方，5 秒后自己消失 */
  #undo { position:fixed; left:50%; transform:translateX(-50%); bottom:96px; z-index:50;
          display:flex; gap:10px; align-items:center; padding:8px 12px;
          background:rgba(8,13,11,.96); border:1px solid var(--line); }
  #undo[hidden] { display:none !important; }
  #undo span { font:11px/1 var(--mono); color:var(--ink-dim); }
  #undo button { background:transparent; border:1px solid var(--line); color:var(--fg);
                 font:11px/1 var(--mono); padding:5px 10px; cursor:pointer; }
  #undo button:hover { border-color:var(--ink); }

  /* 能力表（F-2）：一行一类，点开看条目；降级项直接标红 */
  #cap-list { margin-top:6px; }
  /* 权限 chip：贴在输入框左边，当前会话可见可切（位置照 DeepSeek Harness） */
  .permchip { flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center;
    align-self:stretch; padding:0 12px; border:1px solid var(--line); background:transparent;
    color:var(--dim); font:inherit; font-size:12px; font-weight:600; border-radius:2px; cursor:pointer; }
  .permchip:hover { color:var(--fg); border-color:var(--fg); }
  #permpop .opt:focus-visible { outline:1px solid var(--fg); outline-offset:-1px; }
  /* 档位文字会变长（"完全权限 · 剩 15 分"）：给上限 + 省略号，别让它把输入框挤成一行两字 */
  .permchip { max-width:42%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .permchip:focus-visible { outline:1px solid var(--fg); outline-offset:2px; }
  .permchip.full { color:var(--fg); border-color:var(--fg); }
  #permpop { position:fixed; left:0; right:0; top:0; bottom:0; z-index:60; background:rgba(0,0,0,.72);
    display:flex; align-items:flex-end; justify-content:center; padding:0 16px 88px; }
  #permpop .permbox { width:100%; max-width:520px; border:1px solid var(--line); background:#000; padding:14px 16px; }
  #permpop .opt { display:block; width:100%; text-align:left; padding:10px; margin:6px 0;
    border:1px solid var(--line); background:transparent; color:var(--fg); font:inherit; cursor:pointer; }
  #permpop .opt:hover, #permpop .opt.on { border-color:var(--fg); }
  #permpop .opt b { display:block; font-weight:700; }
  #permpop .opt span { color:var(--dim); font-size:12px; }

  /* 提议卡 / 抽检 / 溯源：都跟全站同一套（黑底 · 白细线 · 加粗白字），不引入新颜色 */
  .surf .cmd { font-weight: 600; }
  .provbox { margin: 10px 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 2px; }
  .provbox .quote { margin: 6px 0; color: var(--fg); opacity: .85; font-style: normal; }
  .provbox .hist summary { cursor: pointer; color: var(--dim); }
  .provbox .oldver { margin-top: 8px; padding-left: 8px; border-left: 1px solid var(--line); opacity: .8; }
  #toollist .searchbox { margin: 6px 0; }
  .item.mini { padding: 4px 6px; font-size: 12px; }
  .dimmore { color: var(--dim); }

  .capbox { border:1px solid var(--line-dim); margin:4px 0; }
  .capbox > summary { padding:5px 7px; font:10px/1 var(--mono); letter-spacing:.12em;
                      color:var(--ink-dim); cursor:pointer; list-style:none; }
  .capbox > summary::-webkit-details-marker { display:none; }
  .capbox[open] > summary { color:var(--ink); border-bottom:1px solid var(--line-dim); }
  .capnames { padding:6px 7px; display:flex; flex-wrap:wrap; gap:4px 10px; }
  .capname { font:10px/1.6 var(--mono); color:var(--fg); }
  .capline { font:10px/1.8 var(--mono); color:var(--dim); padding:4px 2px; }
  .ingest { margin-top:6px; display:flex; flex-direction:column; gap:6px; }
  .ilab { font:9px/1.2 var(--mono); letter-spacing:.1em; color:var(--ink-dim); font-weight:700; margin:0; }
  .ingest select { font:11px/1.3 var(--mono); padding:6px 8px; }
  .ingest .rowmini { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .ingest label { display:flex; align-items:center; gap:5px; flex:none; white-space:nowrap;
                 font:10px/1 var(--mono); color:var(--dim); }
  .ingest button { font:10px/1 var(--mono); padding:6px 9px; background:#000; color:var(--ink); font-weight:700;
                   border:1px solid var(--line-dim); cursor:pointer; }
  .ingest button:hover { border-color:var(--line); background:rgba(233,240,242,.1); }
  #dlg-msg { min-height:12px; }

  /* ── 工具/动作列表折叠（P2 #20）────────────────────── */
  .fold { display:flex; align-items:center; gap:8px; width:100%; background:#000; border:1px solid var(--line); border-left:3px solid var(--ink);
          color:var(--ink); font:10px/1 var(--mono); letter-spacing:.18em; font-weight:700; padding:5px 8px; margin-bottom:2px; cursor:pointer; }
  .fold::after { content:""; flex:1; height:1px; background:transparent; }
  .fold .n { color:var(--ink-dim); letter-spacing:0; }

  /* ── 输入区：多行 + 停止（P1 #7 / P2 #16）────────────── */
  #m { resize:none; max-height:180px; overflow-y:auto; line-height:1.6; }
  #stop { display:none; background:rgba(255,95,86,.12); border:1px solid rgba(255,95,86,.5);
          color:var(--red); font:11px/1 var(--mono); padding:10px 12px; cursor:pointer; }
  #stop:hover { background:rgba(255,95,86,.2); }

  /* ── 回到最新（P2 #15）──────────────────────────────── */
  /* 「回到最新」只在对话里可能出现：
     display 由 body[data-view] + .on 两道同时决定，任何 JS 路径都不可能把它漏到别的界面 */
  #jump { position:absolute; right:26px; bottom:86px; display:none; align-items:center; gap:6px;
          background:#000; border:1px solid var(--line); color:var(--ink); font-weight:700;
          font:10px/1 var(--mono); letter-spacing:.1em; padding:8px 11px; cursor:pointer; z-index:8; }
  #jump:hover { background:rgba(233,240,242,.14); }
  body[data-view="chat"] #jump.on { display:inline-flex; }
  body:not([data-view="chat"]) #jump { display:none !important; }
  main { position:relative; }

  /* ── 骨架（P2 #19）：首屏别空着 ─────────────────────── */
  #chat:empty::before { content:"// 正在读取时间轴…"; display:block; padding:18px 2px;
                        font:10px/1 var(--mono); color:var(--dim); letter-spacing:.14em; }
  /* 空库（首次安装 / 清空后）：别让“正在读取”变成永久状态 */
  #chat .empty { padding:22px 2px; font:12px/1.9 var(--mono); color:var(--dim); letter-spacing:.06em; }
  #chat .empty b { color:var(--ink-dim); font-weight:600; }

  /* ── 记忆编辑（P1 #9）──────────────────────────────── */
  #mv-edit { width:100%; min-height:96px; resize:vertical; }
  .rowmini { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:8px 0 0; }
  .rowmini label { font:10px/1 var(--mono); color:var(--ink-dim); letter-spacing:.1em; }
  .rowmini select { font:11px/1 var(--mono); background:rgba(8,13,11,.8); color:var(--fg);
                    border:1px solid var(--line-dim); padding:5px 6px; }

  /* ── 悬停才出现的行内动作（P1 #13）──────────────────── */
  .row:hover .hintacts { opacity:1; }
  .hintacts { opacity:0; transition:.15s; margin-left:8px; }
  .hintacts button { background:transparent; border:1px solid var(--line-dim); color:var(--dim);
                     font:10px/1 var(--mono); padding:3px 6px; cursor:pointer; }
  .hintacts button:hover { color:var(--ink); border-color:var(--ink); }

  /* 对比度（P2 #22）：--dim 提亮到 AA；9px 抬到 10px */
  .pend .dir, .pend .fp, .item .m, .frame b { font-size:10px; }
</style></head>
<body data-av="plain">
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="whale" viewBox="0 0 512 512"><path fill="currentColor" d="M453.004 35.117c-65.314 46.61-189.755 41.018-213.559 125.426C184.41 101.41 98.625 83.031 21.771 63.209c6.532 139.103 71.38 147.437 192.44 194.547c23.71 25.786 29.786 49.93 19.254 82.705c46.403 5.1 71.504 15.468 106.754 27.742c-.708-71.67-25.14-108.928-75.518-175.035c11.058 4.233 44.979 37.02 56.578 58.607c109.419-42.421 147.64-112.074 131.725-216.658M180.178 353.9c-60.89-.24-114.034 19.49-158.426 74.221c167.075-48.84 292.003-13.21 471.893 7.895c-118.936-38.752-224.474-81.763-313.467-82.116m98.043 77.844c-99.28.255-206.34 18.738-256.866 63.139c168.002-26.61 356.801-28.408 470.8-4.967c1.102-35.337-101.418-58.46-213.934-58.172"/></symbol></svg>
<div class="frame"><i></i><i></i><i></i><i></i><b class="bl">LOCAL · 127.0.0.1</b><b class="br">MEMORY CORE</b></div>
<header>
  <button id="menu" aria-label="菜单" title="菜单">≡</button>
  <span class="brand" aria-label="鲸鲸"><svg class="ico" role="img" aria-hidden="false"><use href="#whale" /></svg></span>
  <span class="hud" title=""><i class="dot"></i><span id="state">…</span><span id="statetext"></span></span>
  <span id="pendbadge" class="badge" hidden>0</span>
  <span class="chip" id="modelchip">…</span>
</header>

<!-- 仪表带：参照图的"读数字段"。全部来自真实接口，没有装饰数字 -->
<div id="readoutbar" aria-label="系统读数">
  <div class="ro"><span class="ro-l">MEMORY</span><span class="ro-v" id="ro-mem">…</span></div>
  <div class="ro"><span class="ro-l">ACTIVE</span><span class="ro-v" id="ro-act">…</span></div>
  <div class="ro"><span class="ro-l">DOCS</span><span class="ro-v" id="ro-doc">…</span></div>
  <div class="ro"><span class="ro-l">CHUNKS</span><span class="ro-v" id="ro-chunks">…</span></div>
  <div class="ro ro-w"><span class="ro-l">ENERGY</span><span class="ro-v" id="ro-energy">…</span><div class="segs" id="ro-segs"></div></div>
  <div class="ro"><span class="ro-l">TODAY</span><span class="ro-v" id="ro-usd">…</span></div>
  <div class="ro"><span class="ro-l">RELEASE</span><span class="ro-v" id="ro-rel">…</span></div>
  <div class="ro"><span class="ro-l">UPTIME</span><span class="ro-v" id="ro-up">…</span></div>
</div>
</header>

<aside id="side">
  <div class="sec" id="pendsec" hidden><h3>PENDING · 待确认</h3><div id="pendlist"></div></div>
  <div class="sec" id="propsec" hidden><h3><button type="button" data-tog="prop">它想做的 <span class="n" id="propcount"></span></button></h3><div id="proplist"></div></div>
  <div class="sec" id="egrsec" hidden><h3><button type="button" data-tog="egr">它想读代码 <span class="n" id="egrcount"></span></button></h3>
    <p class="hint">表达模型在云端时，读源码等于把代码发出去。默认拒；你可以只批一次，或批一段时间。</p>
    <div id="egrlist"></div></div>
  <div class="sec" id="rcpsec" hidden><h3><button type="button" data-tog="rcp">它做完的事 <span class="n" id="rcpcount"></span></button></h3>
    <p class="hint">后台跑过的东西都在这里。<b>点了「知道了」才算我看见了</b> —— 三天没人看的，对应常驻指令会自动停用。</p>
    <div id="rcplist"></div></div>
  <div class="sec" id="threadsec" hidden><h3><button type="button" data-tog="thread">未闭合 <span class="n" id="threadcount"></span></button></h3>
    <p class="hint">它答应过、还没了结的事。办完了点一下；太久没动静的会标「拖了 N 天」。</p>
    <div id="threadlist"></div></div>
  <div class="sec" id="surfsec" hidden><h3><button type="button" data-tog="surf">抽检 <span class="n" id="surfcount"></span></button></h3>
    <p class="hint">这几根线是它自己连的，最没把握的排前面。判错了就点「不对」，当场断。</p>
    <div id="surflist"></div></div>
  <div class="sec"><input id="q" class="searchbox" placeholder="搜记忆 / 文档…（Ctrl+K）" autocomplete="off"></div>
  <div class="sec"><h3>最近</h3><div id="sesslist"></div></div>
  <!-- 内容在前、参考在后：TOOLS 有 16 项，放在中间会把 DOCS / MEMORY 挤到折叠线以下 -->
  <div class="sec" data-sec="docs"><h3><button type="button" data-tog="docs">DOCS <span class="n" id="doccount"></span></button></h3><div id="doclist"></div>
    <div class="ingest">
      <label class="ilab">加文档 · 只在本机读取，跟云端无关</label>
      <!-- 候选优先：sources/ 里有文件就直接选，没有才提示放哪 -->
      <div id="dlg-cands" hidden>
        <select id="dlg-pick" class="searchbox"></select>
      </div>
      <div id="dlg-empty" class="hint">
        还没有待摄入的文件。放这里：<br><code id="dlg-dir">data/sources</code>
      </div>
      <div class="rowmini">
        <button type="button" id="dlg-file-btn">选文件…</button>
        <input type="file" id="dlg-file" hidden multiple accept=".md,.markdown,.txt,.pdf,.docx,.pptx,.xlsx,.html,.htm,.epub,.csv,.json,.xml,.rtf,.ipynb">
        <span class="hint">或手动填路径 ↓</span>
      </div>
      <input id="dlg-path" class="searchbox" placeholder="data/ 里的相对路径，如 sources/笔记.md" autocomplete="off">
      <!-- 提示紧贴它抱怨的那个输入框（不是复选框，也不是按钮） -->
      <span id="dlg-msg" class="hint"></span>

      <!-- 这里**没有**隐私复选框：摄入是一个动作，去哪里是一个属性，
           两者放在同一个表单里怎么摆都会被读成“勾了才能摄”。
           所以摄入永远只在本机（默认最安全），能不能进云端是那篇文档之后的事。 -->
      <div class="acts"><button id="dlg-go" class="primary">摄入到本机</button></div>
      <p class="hint">录入后只在本机检索。要让它引用原文（随简报发给云端模型），
        打开那篇文档点「标为可发送」。</p>
    </div></div>
  <div class="sec" data-sec="mem"><h3><button type="button" data-tog="mem">MEMORY <span class="n" id="memcount"></span></button></h3><div id="memlist"></div></div>
  <div class="sec" data-sec="actions"><h3><button type="button" data-tog="actions">ACTIONS <span class="n" id="actcount"></span></button></h3><div id="auditlist"></div></div>
  <div class="sec"><button class="fold" id="foldtools">TOOLS <span class="n" id="toolcount"></span></button>
    <div id="toollist" hidden>
      <input id="toolq" class="searchbox" placeholder="筛工具名 / 说明…" autocomplete="off">
      <div id="toolrows"><button class="item on" data-view="chat">对话<span class="m">与鲸鲸说话</span></button></div>
      <button class="item dimmore" id="toolmore" hidden>显示全部</button>
    </div></div>
  <div class="sec"><h3>CONFIG</h3>
    <button class="item" data-view="cfg">设置<span class="m">接口 / 人格</span></button>
  </div>
</aside>

<div id="pal" hidden>
  <div class="palbox">
    <input id="palq" placeholder="去哪里 / 做什么…（Enter 执行，Esc 关闭）" autocomplete="off" spellcheck="false">
    <div id="pallist"></div>
    <p class="hint" id="palhint">↑↓ 选择 · Enter 执行 · Esc 关闭</p>
  </div>
</div>

<main>
  <button id="jump" type="button">↓ 回到最新 <span id="jumpn" class="badge dim2"></span></button>
  <div id="undo" hidden><span id="undo-text"></span><button id="undo-go">撤销</button></div>
    <div id="scroll"><div class="col">
    <div id="banner" class="banner" hidden></div>
    <div id="chat"></div>

    <div id="toolview" hidden>
      <div class="panelbox">
        <h2 id="t-title">工具 · TOOL</h2>
        <p class="hint" id="t-desc"></p>
        <p class="hint" id="t-tier"></p>
        <pre class="code" id="t-params" style="white-space:pre-wrap"></pre>
        <div class="acts"><button id="t-use">在输入框里试试</button></div>
      </div>
    </div>

    <div id="propview" hidden>
      <div class="panelbox">
        <h2 id="pv-title">它想做的一件事</h2>
        <p class="hint" id="pv-meta"></p>
        <p id="pv-why" style="white-space:pre-wrap"></p>
        <div id="pv-plan"></div>
        <p class="hint">命令（只是它写下的原样，**不会**自动执行）</p>
        <pre class="code" id="pv-argv" style="white-space:pre-wrap"></pre>
        <p class="hint" id="pv-touch"></p>
        <div class="acts">
          <button id="pv-yes" class="primary">做吧</button>
          <button id="pv-no">不做</button>
          <span id="pv-msg" class="hint"></span>
        </div>
      </div>
    </div>

    <div id="memview" hidden>
      <div class="panelbox">
        <h2>记忆 · MEMORY</h2>
        <p id="mv-text" style="white-space:pre-wrap"></p>
        <p class="hint" id="mv-meta"></p>
        <div id="mv-prov" class="provbox"></div>
        <label class="hint">改正文（纠错就改这里，不用碰数据库）</label>
        <textarea id="mv-edit" spellcheck="false"></textarea>
        <div class="rowmini">
          <label>重要性</label>
          <select id="mv-imp"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select>
          <label>敏感度</label>
          <select id="mv-sens"><option value="local_only">仅本地（不进云端）</option><option value="shareable">可发送</option></select>
        </div>
        <div class="acts">
          <button id="mv-save" class="primary">保存修改</button>
          <button id="mv-forget">忘记这条</button>
          <span id="mv-msg" class="hint"></span>
        </div>
      </div>
    </div>

    <div id="docview" hidden>
      <div class="panelbox">
        <h2 id="dv-title">文档 · DOC</h2>
        <p class="hint" id="dv-meta"></p>
        <div id="dv-chunks"></div>
        <div class="acts">
          <button id="dv-sens">标为可发送</button>
          <button id="dv-forget" class="primary">忘掉这篇</button>
          <span id="dv-msg" class="hint"></span>
        </div>
      </div>
    </div>

    <div id="auditview" hidden>
      <div class="panelbox">
        <h2>动作 · ACTIONS</h2>
        <p class="hint">来自 exec_audit：每一次能力调用（含被拒）都在这里。被拒的也留痕，这是"越权为零"能被验证的地方。</p>
        <p class="hint" id="av-meta"></p>
        <div id="av-list"></div>
      </div>
    </div>

    <div id="searchview" hidden>
      <div class="panelbox">
        <h2>搜索 · SEARCH</h2>
        <p class="hint" id="sv-meta"></p>
        <div id="sv-mem"></div>
        <div id="sv-docs"></div>
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
        <label>接入地址 · 云端 API 的 baseUrl（留空 = 官方默认）</label>
        <input id="c-base" placeholder="留空即用官方端点（deepseek → https://api.deepseek.com）">
        <p class="hint" id="c-ep">…</p>
        <label>api key（保存后只显示指纹）</label><input id="c-key" type="password" placeholder="sk-…" autocomplete="off">
        <div class="acts"><button id="c-save" class="primary">保存接口</button>
          <button id="c-test">测试连接</button>
          <!-- 清除密钥：没有它，想测本地模型就只能断网或填个坏 key，而坏 key 拿不回来 -->
          <button id="c-clear" hidden title="删掉存在本机的 key（会提示一次，再点确认）">清除密钥</button>
          <span id="c-msg" class="hint"></span></div>
        <p class="hint" id="c-usage">…</p>
        <p class="hint" id="c-cur">…</p>
      </div>

      <div class="panelbox">
        <h2>LOCAL · 本地模型</h2>
        <p class="hint" id="m-state">…</p>
        <div class="two">
          <div><label>共享默认 · route / extract / salience / conflict</label><select id="m-default"></select></div>
          <div><label>夜间整理 · 自传与反思</label><select id="m-night"></select></div>
        </div>
        <div class="two">
          <div><label>embedding · 换它必须重建索引</label><select id="m-embed"></select></div>
          <div><label>&nbsp;</label><button id="m-save" class="primary">保存本地模型</button></div>
        </div>
        <p class="hint" id="m-msg"></p>
      </div>

      <div class="panelbox">
        <h2>STANDING · 常驻指令</h2>
        <p class="hint">它在你不在的时候按点做事。只收注册过的模板，每次触发自己开 60 秒窗口，跑完写回执；
          <b>回执三天没人读就自动停用</b>。真正的触发要外部调 jingjing standing tick（面板不会偷偷跑）。</p>
        <div id="st-list"></div>
      </div>
      <div class="panelbox">
        <h2>CAPABILITIES · 能力</h2>
        <p class="hint" id="cap-sum">…</p>
        <div id="cap-list"></div>
        <p class="hint" id="cap-deg"></p>
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

      <div class="panelbox">
        <h2>AVATAR · 头像</h2>
        <p class="hint">只收 png / jpeg / webp（会验文件头，不信声明的类型）；SVG 不收 —— 它能带脚本。</p>
        <div class="avav"><span class="av" id="pv-agent"><svg class="ico" aria-hidden="true"><use href="#whale" /></svg></span>
          <div><div class="hint">鲸鲸</div>
            <div class="acts"><button type="button" id="up-agent">选图片</button><input type="file" id="f-agent" accept="image/png,image/jpeg,image/webp">
              <button type="button" id="rm-agent">恢复默认</button></div></div></div>
        <div class="avav"><span class="av" id="pv-user">U</span>
          <div><div class="hint">我</div>
            <div class="acts"><button type="button" id="up-user">选图片</button><input type="file" id="f-user" accept="image/png,image/jpeg,image/webp">
              <button type="button" id="rm-user">恢复默认</button></div></div></div>
        <span id="av-msg" class="hint"></span>
      </div>

      <div class="panelbox">
        <h2>APPEARANCE · 外观</h2>
        <div class="two">
          <div><label>头像框</label>
            <select id="a-frame">
              <option value="plain">plain · 直角细框</option>
              <option value="bare">bare · 无框</option>
              <option value="ring">ring · 圆</option>
              <option value="cut">cut · 切角</option>
              <option value="glow">glow · 呼吸光</option>
            </select></div>
          <div><label>预览</label>
            <div class="avprev"><span class="av"><svg class="ico" aria-hidden="true"><use href="#whale" /></svg></span>
            <span class="hint">选完立即生效并保存</span></div></div>
        </div>
        <p class="hint">存到 data/config.json（ui.avatar），换浏览器/换机器也跟着走<span id="a-msg"></span></p>
      </div>
    </div>
  </div></div>

  <div class="ticker" id="ticker"></div>
  <form id="composer"><div class="wrap">
    <button type="button" id="perm" class="permchip" title="当前会话的权限档（点开切换）">逐次确认</button>
    <textarea id="m" rows="1" placeholder="说点什么…"></textarea>
    <button id="stop" type="button" title="停止生成">■</button>
    <button class="send">▲</button>
  </div></form>
</main>

<div id="permpop" hidden role="dialog" aria-modal="true" aria-label="权限档"><div class="permbox">
  <p class="hint">这是<b>当前会话</b>的权限档。改完立刻生效，关掉面板就回到逐次确认。</p>
  <div id="permopts"></div>
  <div class="acts"><button type="button" id="permclose">关闭</button><span id="permmsg" class="hint"></span></div>
</div></div>
<script>
window.SOURCES_DIR = null;   // 服务端会把它替换成 data/sources 的绝对路径（点“摄入”的人才知道文件该放哪）
const $ = (s) => document.querySelector(s);
const NL2 = String.fromCharCode(10, 10);
// 标签页标题：待确认闪烁时也要闪回这个名字
const TITLE = 'Pseudo Digital Life Project';
// 占位符按屏宽给：手机上长提示会换行顶出输入框（截图抓到的）
var mEl = document.getElementById("m");
if (mEl) mEl.placeholder = innerWidth > 560 ? "说点什么…（Enter 发送 · Shift+Enter 换行）" : "说点什么…";
const H = { "x-jj": "1", "content-type": "application/json" };
const WHALE = "<svg class='ico' aria-hidden='true'><use href='#whale' /></svg>";
let view = "chat", TOOLS = [], MEMS = [];
let sideActive = null;   // 侧栏里最后点的那一项（文档/工具/记忆/日期都是多选一）


var chatScroll = 0;   // 切走前记下对话滚到哪了
function show(v) {
  // 切走时把滚动位置存下来：隐藏 #chat 会让 #scroll 的 scrollHeight 塌成 0，浏览器会把 scrollTop 归零
  if (view === "chat" && v !== "chat") chatScroll = $("#scroll").scrollTop;
  view = v;
  document.body.dataset.view = v;   // CSS 用它把「回到最新」锁在对话里
  for (const id of ["chat", "cfg", "toolview", "memview", "docview", "auditview", "searchview", "propview"]) $("#" + id).hidden = id !== v;
  $("#composer").style.display = v === "chat" ? "" : "none";
  // "回到最新"是对话专用的，别的界面不该出现
  if (v !== "chat") $("#jump").classList.remove("on");
  if (v === "chat") {
    requestAnimationFrame(function () {
      const el = $("#scroll");
      // 只在"离开前不是贴底"时恢复；贴底的话重新滚到底更符合直觉
      if (chatScroll > 0 && chatScroll < el.scrollHeight - el.clientHeight - 4) el.scrollTop = chatScroll;
      else { el.scrollTop = el.scrollHeight; chatScroll = 0; }
    });
  } else {
    // 切到面板（设置/记忆/文档/审计/搜索）时**必须回到顶部**：
    // 对话是自动贴底的，scrollTop 是个大值；带着它切过去，浏览器会把它夹到底部，
    // 表现就是"每次点进设置都在最下面"。
    //
    // 必须**同步**压一次：只靠 rAF 的话，异步内容（设置页要等 /api/config、/api/models）
    // 落地前的那一两帧能看到错位；headless 下 rAF 还可能更晚。
    // rAF 里再压一次是为了内容撑高之后仍然在顶。
    const sc = $("#scroll");
    sc.scrollTop = 0;
    requestAnimationFrame(function () { sc.scrollTop = 0; });
  }
  // 侧栏里除了几个导航项，其余都是多选一（工具 / 文档 / 记忆 / 日期）。
  // 只按 data-view 匹配会变成「点了 A，B C D 一起被框」。
  const navOnly = (b) => !b.dataset.doc && !b.dataset.tool && !b.dataset.mem && !b.dataset.day;
  for (const b of document.querySelectorAll("#side .item")) {
    b.classList.toggle("on", navOnly(b) && b.dataset.view === v);
  }
  if (sideActive && sideActive.isConnected && !navOnly(sideActive) && sideActive.dataset.view === v) {
    sideActive.classList.add("on");
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
  return p(d.getHours()) + ":" + p(d.getMinutes());
}
async function state() {
  const s = await (await fetch("/api/state")).json();
  $("#state").textContent = s.line;
  $("#statetext").textContent = s.state?.text ? " · " + s.state.text : "";
  var hud = document.querySelector(".hud"); if (hud) hud.title = s.line + (s.state?.text ? " · " + s.state.text : "");
  // 断电提示：只在重启后第一次显示（服务端只给一次）
  if (s.outage) {
    const b = $("#banner");
    const kind = s.outage.kind === "power" ? "断电" : s.outage.kind === "crash" ? "进程被杀" : "关机";
    b.hidden = false;
    b.innerHTML = "// " + kind + " " + String(s.outage.from).slice(5, 16).replace("T", " ") + " → " +
      String(s.outage.to).slice(5, 16).replace("T", " ") + " —— 那段我没有经历";
  }
  const g = (k) => (s.memories || []).find((m) => m.stage === k);
  // 读数进仪表带（原来那行拼在 hud 里，现在 hud 只留一句话状态）
  var mem = ((g("active") || {}).c || 0) + ((g("fading") || {}).c || 0) + ((g("dormant") || {}).c || 0);
  var act = (g("active") || {}).c || 0;
  var e1 = $("#ro-mem"); if (e1) e1.innerHTML = mem + "<span class='u'>条</span>";
  var e2 = $("#ro-act"); if (e2) e2.innerHTML = act + "<span class='u'>条</span>";
  var en = (s.state && typeof s.state.energy === "number") ? s.state.energy : null;
  var e3 = $("#ro-energy");
  if (e3 && en !== null) {
    e3.innerHTML = Math.round(en * 100) + "<span class='u'>%</span>";
    // E-6 第二步：energy 的唯一恢复点在夜间整备；它没跑就得说清，否则只能看着数字掉
    var nrc = document.querySelector(".ro-w");
    if (nrc) {
      nrc.title = s.nightlySkipped
        ? "energy 只在夜间整备后恢复 —— 现在夜间未运行（" + String(s.nightlySkipped).slice(11, 19) + " · 缺模型）"
        : "energy：每轮对话 -2%，夜间整备 +25%";
    }
    var segs = $("#ro-segs");
    if (segs) {
      var n = 14, on = Math.round(en * n);
      var html = "";
      for (var i = 0; i < n; i++) html += "<i class='" + (i < on ? (en < 0.25 ? "hot" : "on") : "") + "'></i>";
      segs.innerHTML = html;
    }
  }
}
function rowHtml(b) {
  const isUser = b.role === "user";
  const body = isUser ? escapeHtml(b.text).replace(/&lt;br&gt;/g, "<br>") : (b.html || escapeHtml(b.text));
  const tools = (b.tools || []).join("");
  const recall = isUser ? "" : recallHtml(b.cites || [], b.omitted || 0, b.omittedDocs || 0);
  const resend = isUser ? " <span class='hintacts'><button class='resend'>重发</button></span>" : "";
  return "<div class='row " + b.role + "'><div class='av'>" + avHtml(isUser) + "</div><div>" +
    "<div class='meta'>" + (isUser ? "USER · " : "") + clock(b.ts) + resend + "</div>" +
    recall +
    "<div class='body md'>" + body + tools + "</div></div></div>";
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function timeline() {
  const blocks = await (await fetch("/api/timeline")).json();
  const el = $("#chat"); el.innerHTML = "";
  if (!blocks.length) {
    // 空库不是“加载中”：首次安装和清空数据后都会走到这里
    el.insertAdjacentHTML("beforeend",
      "<div class='empty'>// 还没有任何经历。" +
      "<b>说一句试试</b>——它会记住，也会忘。<br>" +
      "// 夜里整理记忆需要本地模型；现在没装，所以只会追加不会整理。</div>");
    return;
  }
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
// 待确认的 T3：侧栏一张卡。确认 = 服务端现场签发令牌并执行，页面拿不到令牌。
async function pending() {
  let list = [];
  try { list = await (await fetch("/api/pending")).json(); } catch (e) { return; }
  const sec = $("#pendsec"), box = $("#pendlist");
  const open = (list || []).filter((p) => p.status === "pending" && !p.expired);
  paintPendBadge(open.length);
  loadProposals(); loadSurfaceReview(); loadThreads(); loadReceipts(); loadStanding(); loadPermission(); loadEgress();
  sec.hidden = open.length === 0;
  if (!open.length) { box.innerHTML = ""; return; }
  box.innerHTML = open.map((p) =>
    "<div class='pend' data-pend='" + p.id + "'>" +
    "<span class='cmd'>" + escapeHtml(p.argv.join(" ")) + "</span>" +
    "<span class='dir'>" + escapeHtml(p.cwd) + "</span>" +
    "<span class='fp'>指纹 " + escapeHtml(String(p.digest || "").slice(0, 8)) + " · 15 分钟内有效</span>" +
    "<div class='acts'><button class='ok' data-act='confirm'>确认执行</button>" +
    "<button class='no' data-act='reject'>拒绝</button></div>" +
    "<span class='msg'></span></div>").join("");
}
$("#pendlist").onclick = async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const card = btn.closest("[data-pend]");
  const id = card.dataset.pend;
  const msg = card.querySelector(".msg");
  btn.disabled = true;
  msg.textContent = "处理中…";
  try {
    const j = await (await fetch("/api/pending/" + id, {
      method: "POST", headers: H, body: JSON.stringify({ action: btn.dataset.act }),
    })).json();
    msg.textContent = j.ok ? (btn.dataset.act === "confirm" ? "已执行" : "已拒绝") : (j.error || "FAILED");
  } catch (err) { msg.textContent = "网络错误"; }
  await pending(); await timeline(); await state();
};
// ── DOCS：摄入过的文档（点击看分块）──────────────────────────
async function ingestCandidates() {
  var list = [];
  try { list = await (await fetch("/api/ingest/candidates")).json(); } catch (e) { return; }
  var sel = $("#dlg-pick");
  if (!sel) return;
  var has = !!(list && list.length);
  $("#dlg-cands").hidden = !has;          // 候选优先：有就直接选，没有才提示放哪
  $("#dlg-empty").hidden = has;
  if (window.SOURCES_DIR) { var d = $("#dlg-dir"); if (d) d.textContent = window.SOURCES_DIR; }
  sel.innerHTML = has
    ? "<option value=''>data/sources 里待摄入的 " + list.length + " 个文件…</option>" +
      list.map(function (x) { return "<option value='" + escapeHtml(x.path) + "'>" + escapeHtml(x.path) + "</option>"; }).join("")
    : "";
}
async function docs() {
  ingestCandidates();
  let list = [];
  try { list = await (await fetch("/api/docs")).json(); } catch (e) { return; }
  const box = $("#doclist");
  var dc = $("#doccount"); if (dc) dc.textContent = (list ? list.length : 0) + " 篇";
  if (!list || !list.length) {
    // 路径和“怎么放”由下面的摄入区负责说，这里只报事实（否则同一句话在侧栏里重复三遍）
    box.innerHTML = "<div class='hint' style='padding:4px 2px'>还没有文档。在下面加一篇。</div>";
    return;
  }
  box.innerHTML = list.map((d) =>
    "<button class='item' data-view='docview' data-doc='" + escapeHtml(d.id) + "'>" +
    escapeHtml(d.title || d.id) + "<span class='m'>" + d.chunks + " 块 · " + (d.sensitivity === "shareable" ? "可发送" : "仅本地") + "</span></button>").join("");
}
async function openDoc(id) {
  show("docview");
  $("#dv-title").textContent = "DOC · " + id;
  $("#dv-meta").textContent = "…";
  $("#dv-chunks").innerHTML = "";
  const j = await (await fetch("/api/docs/" + id)).json();
  if (!j || !j.doc) { $("#dv-meta").textContent = j.error || "E_NO_DOC"; return; }
  $("#dv-title").textContent = j.doc.title || id;
  $("#dv-sens").dataset.doc = id;
  dvSens = j.doc.sensitivity === "shareable" ? "shareable" : "local_only";
  paintSens();
  $("#dv-meta").textContent = (j.doc.rel_path || "") + " · " + j.doc.n_chunks + " 块 · " + (j.doc.converter || "") + " · " + (j.doc.bytes || 0) + " 字节";
  $("#dv-chunks").innerHTML = (j.chunks || []).map((c) =>
    "<div class='ck'><div class='ck-h'>#" + c.ord + "　" + escapeHtml(c.heading_path || "(无章节)") + "　<span class='ck-t'>" + c.n_tokens + " tok</span></div>" +
    "<pre class='ck-b'>" + escapeHtml(c.text.slice(0, 1200)) + (c.text.length > 1200 ? String.fromCharCode(10) + "…（截断）" : "") + "</pre></div>").join("");
}
// 敏感度开关：默认「仅本地」，点了才会进云端简报（02 §10.1）
let dvSens = "local_only";
function paintSens() {
  const b = $("#dv-sens");
  b.textContent = dvSens === "shareable" ? "当前：可发送（点一下改回仅本地）" : "当前：仅本地（点一下标为可发送）";
  b.className = dvSens === "shareable" ? "primary" : "";
}
$("#dv-sens").onclick = async () => {
  const m = $("#dv-title").textContent.match(/^DOC · (doc_[0-9a-f]+)$/);
  const id = m ? m[1] : $("#dv-sens").dataset.doc;
  if (!id) return;
  const next = dvSens === "shareable" ? "local_only" : "shareable";
  const j = await (await fetch("/api/docs/" + id + "/sensitivity", { method: "POST", headers: H, body: JSON.stringify({ value: next }) })).json();
  const msg = $("#dv-msg");
  if (j.ok) { dvSens = j.value; paintSens(); msg.className = "ok"; msg.textContent = "已保存"; await docs(); }
  else { msg.className = "err"; msg.textContent = j.error || "FAILED"; }
};
$("#dv-forget").onclick = async () => {
  const id = $("#dv-title").textContent.startsWith("DOC · ") ? $("#dv-title").textContent.slice(6) : "";
  const meta = $("#dv-meta").textContent;
  const realId = (meta && $("#dv-title").textContent.match(/^DOC · (doc_[0-9a-f]+)$/) ? $("#dv-title").textContent.slice(6) : "");
  const target = realId || id;
  if (!target) return;
  const j = await (await fetch("/api/docs/" + target + "/forget", { method: "POST", headers: H, body: "{}" })).json();
  const m = $("#dv-msg");
  if (j.ok) {
    m.className = "ok"; m.textContent = "已忘掉 " + j.chunks + " 块"; await docs(); show("chat");
    // F-3：5 秒内可反悔（作废是写 deleted_at，恢复是把它们清掉并重插 FTS）
    offerUndo("已忘掉 " + j.chunks + " 块 · 5 秒内可撤销", async function () {
      const r2 = await (await fetch("/api/docs/" + target + "/restore", { method: "POST", headers: H, body: "{}" })).json();
      if (r2.ok) { await docs(); await timeline(); }
    });
  }
  else { m.className = "err"; m.textContent = j.error || "FAILED"; }
};
// ── 记忆纠错（P1 #9）──────────────────────────────────
$("#mv-save").onclick = async () => {
  const id = $("#mv-save").dataset.id;
  if (!id) return;
  const body = {
    text: $("#mv-edit").value,
    importance: Number($("#mv-imp").value),
    sensitivity: $("#mv-sens").value,
  };
  const j = await (await fetch("/api/memories/" + id, { method: "PUT", headers: H, body: JSON.stringify(body) })).json();
  const m = $("#mv-msg");
  if (j.ok) {
    m.className = "ok"; m.textContent = "已保存（改了正文会重算向量）";
    await memories(); await timeline();
  } else { m.className = "err"; m.textContent = j.error || "FAILED"; }
};

// ── 面板内摄入（P1 #6）────────────────────────────────
$("#dlg-go").onclick = async () => {
  const p = $("#dlg-path").value.trim();
  const msg = $("#dlg-msg");
  const markBad = (on) => { const el = $("#dlg-path"); if (el) el.classList.toggle("bad", on); };
  if (!p) {
    markBad(true);
    msg.className = "err";
    const n = $("#dlg-pick") ? $("#dlg-pick").options.length - 1 : 0;
    // 侧栏很窄：长句会挤成四行，而且和上面空状态的说明重复。
    // 这里只说"该做什么"，路径已经在上面写清了。
    msg.textContent = n > 0
      ? "先从上面的下拉里选一个（有 " + n + " 个待摄入）"
      : "还没有可摄入的文件 —— 见上面的两条路";
    return;
  }
  markBad(false);
  msg.className = "hint"; msg.textContent = "摄入中…（转换 + 分块 + 向量）";
  const j = await (await fetch("/api/ingest", {
    method: "POST", headers: H,
    // 摄入永远只在本机；能不能进云端是文档属性，在 docview 里单独改
    body: JSON.stringify({ path: p, shareable: false }),
  })).json();
  if (j.ok) {
    msg.className = "ok";
    msg.textContent = "完成：" + j.files + " 个文件 · " + j.chunks + " 块" + (j.skipped ? "（跳过 " + j.skipped + "）" : "");
    $("#dlg-path").value = "";
    await docs();
  } else {
    msg.className = "err";
    msg.textContent = j.error + (j.hint ? " · " + j.hint : "");
  }
};
$("#dlg-file-btn").onclick = () => $("#dlg-file").click();
$("#dlg-file").addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  if (!files.length) return;
  const msg = $("#dlg-msg");
  for (const f of files) {
    msg.className = "hint";
    msg.textContent = "上传 " + f.name + "…";
    let up;
    try {
      up = await (await fetch("/api/ingest/upload?name=" + encodeURIComponent(f.name), {
        method: "POST", headers: { "x-jj": "1", "content-type": "application/octet-stream" }, body: f,
      })).json();
    } catch (err) { msg.className = "err"; msg.textContent = "上传失败：" + err.message; return; }
    if (!up.ok) { msg.className = "err"; msg.textContent = up.error + (up.hint ? " · " + up.hint : ""); return; }
    $("#dlg-path").value = up.path;
  }
  $("#dlg-go").click();                     // 传完直接摄入（路径已填好）
});
$("#dlg-pick").addEventListener("change", (e) => {
  if (e.target.value) $("#dlg-path").value = e.target.value;
});
$("#dlg-path").addEventListener("input", () => {
  $("#dlg-path").classList.remove("bad");
  const m = $("#dlg-msg"); if (m && m.className === "err") { m.className = "hint"; m.textContent = ""; }
});
$("#dlg-path").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#dlg-go").click(); } });

// ── 测试连接 + 今日花费（P1 #11/#12）──────────────────
$("#c-test").onclick = async () => {
  const m = $("#c-msg");
  m.className = "hint"; m.textContent = "测试中…";
  const j = await (await fetch("/api/test-cloud", { method: "POST", headers: H, body: "{}" })).json();
  if (j.ok) { m.className = "ok"; m.textContent = "通了 · " + j.ms + "ms · " + j.reply; }
  else { m.className = "err"; m.textContent = (j.error || "FAILED") + (j.hint ? " · " + j.hint : ""); }
};
async function usage() {
  try {
    const u = await (await fetch("/api/usage")).json();
    const el = $("#c-usage");
    if (el) {
      el.textContent = "今日 $" + u.todayUsd.toFixed(4) + " / 预算 $" + u.budgetUsd +
        " · " + u.calls + " 次调用 · in " + u.inTokens + " / out " + u.outTokens + " tok";
    }
  } catch (e) { /* 面板离线时忽略 */ }
}

// ── 审计：侧栏常驻刷新 ────────────────────────────────
async function auditTick() { await audit(); }

// ── 仪表带 + ticker（照参照图的读数字段，但每个数都来自真接口）──
async function readout() {
  var h = null, u = null, docs = null, last = null;
  try {
    var rs = await Promise.all([
      fetch("/health").then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch("/api/usage").then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch("/api/docs").then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch("/api/audit?limit=1").then(function (r) { return r.json(); }).catch(function () { return null; }),
    ]);
    h = rs[0]; u = rs[1]; docs = rs[2]; last = rs[3];
  } catch (e) { /* 离线时保持上一次读数 */ }

  var docN = docs ? docs.length : 0;
  var chunkN = docs ? docs.reduce(function (n, d) { return n + (d.chunks || 0); }, 0) : 0;
  var set = function (id, html) { var el = $(id); if (el) el.innerHTML = html; };
  set("#ro-doc", docN + "<span class='u'>篇</span>");
  set("#ro-chunks", chunkN + "<span class='u'>块</span>");
  if (u) set("#ro-usd", "$" + Number(u.todayUsd || 0).toFixed(3) + "<span class='u'>/" + (u.budgetUsd || 2) + "</span>");
  if (h) {
    set("#ro-rel", (h.release ? String(h.release).slice(4, 8) + "·" + String(h.release).slice(-4) : "—"));
    var up = Number(h.uptimeS || 0);
    var upText = up >= 3600 ? Math.floor(up / 3600) + "h" + Math.floor((up % 3600) / 60) + "m" : Math.floor(up / 60) + "m";
    set("#ro-up", upText);
  }

  // ticker：最近一个动作 / 待确认 / 降级或冻结 —— 都是"现在是什么状态"
  var tk = [];
  if (last && last.rows && last.rows.length) {
    var a = last.rows[0];
    var cls = a.decision === "allowed" ? "" : a.decision === "needs_confirm" ? " warn" : " bad";
    tk.push("<span class='tk" + cls + "'>最近 <b>" + escapeHtml(a.verb) + "</b> " + escapeHtml(a.decision) + "</span>");
  }
  var pn = Number(($("#pendbadge") || {}).textContent || 0);
  if (pn > 0) tk.push("<span class='tk warn'>待确认 <b>" + pn + "</b></span>");
  if (h && h.frozen) tk.push("<span class='tk warn'>自我更新冻结</span>");
  if (h && h.degraded && h.degraded.length) tk.push("<span class='tk bad'>降级 " + escapeHtml(h.degraded.join(",")) + "</span>");
  if (h && last && typeof last.total === "number") tk.push("<span class='tk fade'>动作累计 <b>" + last.total + "</b></span>");
  if (u) tk.push("<span class='tk fade'>今日调用 <b>" + u.calls + "</b></span>");
  var tb = $("#ticker"); if (tb) tb.innerHTML = tk.join("");
}

// ── 头像：默认用鲸尾/U，上传后用图片（P1）────────────────
var AV = { agent: null, user: null };
function avHtml(isUser) {
  var role = isUser ? "user" : "agent";
  if (AV[role]) return "<img class='avi' alt='' src='" + AV[role] + "'>";
  return isUser ? "U" : WHALE;
}
async function loadAvatars() {
  try {
    var j = await (await fetch("/api/avatars")).json();
    AV.agent = j.agent ? j.agent.url : null;
    AV.user = j.user ? j.user.url : null;
  } catch (e) { /* 离线就都用默认 */ }
  paintPreview();
}
function paintPreview() {
  var a = $("#pv-agent"), u = $("#pv-user");
  if (!a || !u) return;
  a.innerHTML = avHtml(false);
  u.innerHTML = avHtml(true);
}
async function uploadAvatar(role, file) {
  if (!file) return;
  var msg = $("#av-msg");
  if (file.size > 512 * 1024) { msg.className = 'err'; msg.textContent = '图片太大（≤512KB）'; return; }
  var dataUrl = await new Promise(function (res, rej) {
    var r = new FileReader();
    r.onload = function () { res(String(r.result)); };
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  var j = await (await fetch("/api/avatar", { method: "POST", headers: H, body: JSON.stringify({ role: role, dataUrl: dataUrl }) })).json();
  if (j.ok) {
    AV[role] = j.url; paintPreview(); await timeline();
    msg.className = 'ok'; msg.textContent = '已更换（' + role + '）';
  } else { msg.className = 'err'; msg.textContent = (j.error || 'FAILED') + (j.hint ? ' · ' + j.hint : ''); }
}
async function resetAvatar(role, btn) {
  var j = await (await fetch("/api/avatar?role=" + role, { method: "DELETE", headers: H })).json();
  if (j.ok) { AV[role] = null; paintPreview(); await timeline();
    var msg = $('#av-msg'); msg.className = 'ok'; msg.textContent = '已恢复默认'; }
}
["agent", "user"].forEach(function (role) {
  $("#up-" + role).onclick = function () { $("#f-" + role).click(); };
  $("#f-" + role).onchange = function (e) { uploadAvatar(role, e.target.files && e.target.files[0]); };
  $("#rm-" + role).onclick = function () { resetAvatar(role); };
});

// ── 侧栏分区折叠（MEMORY / DOCS / ACTIONS）──────────────
var SECT = (function () {
  try { return JSON.parse(localStorage.getItem('jj-sections') || '{}'); } catch (e) { return {}; }
})();
function applySections() {
  document.querySelectorAll(".sec[data-sec]").forEach(function (el) {
    var k = el.dataset.sec;
    el.classList.toggle('collapsed', !!SECT[k]);
    var body = el.querySelector('div');
    if (body) body.hidden = !!SECT[k];
  });
}
document.addEventListener("click", function (e) {
  var b = e.target.closest('[data-tog]');
  if (!b) return;
  var k = b.dataset.tog;
  SECT[k] = !SECT[k];
  try { localStorage.setItem('jj-sections', JSON.stringify(SECT)); } catch (err) { /* 隐私模式 */ }
  applySections();
});

// ── 证据：召回行 + 可点引用（P0 #1/#2）──────────────────
function recallHtml(cites, omitted, omittedDocs) {
  if ((!cites || !cites.length) && !omitted && !omittedDocs) return "";
  var chips = (cites || []).map(function (c) {
    var kind = c.indexOf("doc:") === 0 ? "doc" : "mem";
    return "<span class='cite' data-cite='" + escapeHtml(c) + "' data-kind='" + kind + "'>" + escapeHtml(c) + "</span>";
  }).join("");
  var omit = [];
  if (omitted) omit.push(omitted + " 条记忆");
  if (omittedDocs) omit.push(omittedDocs + " 段文档");
  var tail = omit.length ? "<span>· 另有 " + omit.join("、") + "仅本地</span>" : "";
  return "<div class='recall'><b>依据</b>" + (chips || "<span>无</span>") + tail + "</div>";
}
async function openCite(cite) {
  if (cite.indexOf("doc:") === 0) {
    var m = cite.match(/^doc:(doc_[0-9a-f]+)#(\d+)$/);
    if (m) { await openDoc(m[1]); return; }
    return;
  }
  var mm = cite.match(/^mem:(\d+)$/);
  if (mm) { await openMemory(Number(mm[1])); return; }
}
document.addEventListener("click", function (e) {
  var c = e.target.closest("[data-cite]");
  if (c && c.dataset.cite) { e.preventDefault(); openCite(c.dataset.cite); }
});
document.addEventListener("keydown", function (e) {
  var c = document.activeElement;
  if (c && c.classList && c.classList.contains("cite") && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault(); openCite(c.dataset.cite);
  }
});

// ── 动作审计（P0 #3）────────────────────────────────────
async function audit() {
  var rows = [], total = 0;
  try { var j = await (await fetch("/api/audit?limit=40")).json(); rows = j.rows || []; total = j.total || rows.length; } catch (e) { return; }
  var ac = $("#actcount"); if (ac) ac.textContent = total + " 条";
  var box = $("#auditlist");
  if (!rows || !rows.length) { box.innerHTML = "<div class='hint' style='padding:4px 2px'>还没有动作</div>"; return; }
  box.innerHTML = rows.slice(0, 8).map(function (r) {
    var cls = r.decision === "allowed" ? "d-ok" : r.decision === "needs_confirm" ? "d-wait" : "d-no";
    return "<button class='item' data-view='auditview' title='" + escapeHtml(r.verb + " " + (r.reason || r.decision)) + "'>" +
      escapeHtml(r.verb) + "<span class='m'><span class='" + cls + "'>" + escapeHtml(r.decision) + "</span> · " +
      escapeHtml(r.tier) + " · " + clock(r.ts) + "</span></button>";
  }).join("") +
    // 这行必须是真的控件：以前写成 hint，写着“点开看全部”却点不动
    "<button class='item' data-view='auditview'><span class='preview'>查看全部（最近 " + rows.length + " / 共 " + total + " 条）</span>" +
    "<span class='m'>exec_audit · 含被拒绝的调用</span></button>";
}
async function openAudit() {
  show("auditview");
  var rows = [], total = 0;
  try { var j2 = await (await fetch("/api/audit?limit=80")).json(); rows = j2.rows || []; total = j2.total || rows.length; } catch (e) { rows = []; }
  var am = $("#av-meta"); if (am) am.textContent = "exec_audit 共 " + total + " 条 · 下面显示最近 " + rows.length + " 条（含被拒绝的）";
  $("#av-list").innerHTML = (rows || []).map(function (r) {
    var cls = r.decision === "allowed" ? "d-ok" : r.decision === "needs_confirm" ? "d-wait" : "d-no";
    return "<div class='arow'><span class='t'>" + escapeHtml(clock(r.ts)) + "</span>" +
      "<span class='v'>" + escapeHtml(r.verb) + "</span>" +
      "<span><span class='" + cls + "'>" + escapeHtml(r.decision) + "</span>" +
      (r.reason ? " · " + escapeHtml(r.reason) : "") + "</span>" +
      "<span class='ms'>" + (r.ms ? r.ms + "ms" : "") + "</span></div>";
  }).join("") || "<div class='hint'>没有动作</div>";
}

// ── 搜索（P1 #8）────────────────────────────────────────
var searchTimer = null;
async function doSearch(q) {
  if (!q.trim()) { show("chat"); return; }
  show("searchview");
  $("#sv-meta").textContent = "搜索「" + q + "」…";
  $("#sv-mem").innerHTML = ""; $("#sv-docs").innerHTML = "";
  var j = null;
  try { j = await (await fetch("/api/search?q=" + encodeURIComponent(q))).json(); } catch (e) { $("#sv-meta").textContent = "搜索失败"; return; }
  $("#sv-meta").textContent = "「" + q + "」· 记忆 " + j.mem.length + " 条 · 文档 " + j.docs.length + " 段";
  $("#sv-mem").innerHTML = j.mem.length
    ? "<h3 style='font:10px/1 var(--mono);color:var(--ink-dim);letter-spacing:.18em;margin:12px 0 6px'>MEMORY</h3>" + j.mem.map(function (h) {
      return "<button class='hit' data-view='memview' data-mem='" + h.id + "'>" + escapeHtml(h.text.slice(0, 90)) +
        "<span class='m'>" + h.stage + " · " + h.weight.toFixed(2) + " · " + (h.sensitivity === "shareable" ? "可发送" : "仅本地") + " · mem:" + h.id + "</span></button>";
    }).join("")
    : "";
  $("#sv-docs").innerHTML = j.docs.length
    ? "<h3 style='font:10px/1 var(--mono);color:var(--ink-dim);letter-spacing:.18em;margin:14px 0 6px'>DOCS</h3>" + j.docs.map(function (h) {
      return "<button class='hit' data-cite='" + escapeHtml(h.cite) + "'>" + escapeHtml(h.text.slice(0, 90)) +
        "<span class='m'>" + escapeHtml(h.title) + " › " + escapeHtml(h.headingPath || "—") + " · " + (h.sensitivity === "shareable" ? "可发送" : "仅本地") + "</span></button>";
    }).join("")
    : "";
}

// ── 输入区：多行自适应 + Enter 发送 + 快捷键（P2 #16/#17）──────
function fitComposer() {
  var m = $("#m");
  m.style.height = "auto";
  m.style.height = Math.min(180, m.scrollHeight) + "px";
}
$("#m").addEventListener("input", fitComposer);
$("#m").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").dispatchEvent(new Event("submit", { cancelable: true }));
  }
});
// ── F-3 命令面板：Ctrl+K 到任何地方（导航 + 少量安全的动作）──────
var PAL_ACTIONS = [
  { id: "chat", label: "对话", key: "视图", run: function () { show("chat"); } },
  { id: "cfg", label: "设置（接口 / 本地模型 / 能力 / 人格）", key: "视图", run: function () { show("cfg"); loadConfig(); } },
  { id: "mem", label: "记忆", key: "视图", run: function () { memories(); } },
  { id: "docs", label: "文档 DOCS", key: "视图", run: function () { docs(); } },
  { id: "audit", label: "动作审计", key: "视图", run: function () { audit(); } },
  { id: "tools", label: "工具列表", key: "视图", run: function () { $("#foldtools").click(); } },
  { id: "new", label: "说点什么（聚焦输入框）", key: "动作", run: function () { show("chat"); $("#m").focus(); } },
  { id: "ingest", label: "加文档（跳到 DOCS 的摄入区）", key: "动作", run: function () { docs(); setTimeout(function () { var el = $("#dlg-path"); if (el) el.focus(); }, 300); } },
  { id: "cap", label: "看能力与降级项", key: "动作", run: function () { show("cfg"); setTimeout(function () { var el = $("#cap-sum"); if (el) el.scrollIntoView({ block: "center" }); }, 600); } },
];
var palOpen = false, palIdx = 0, palShown = PAL_ACTIONS;

function palRender() {
  var q = ($("#palq").value || "").trim().toLowerCase();
  palShown = PAL_ACTIONS.filter(function (a) { return !q || (a.label + " " + a.id).toLowerCase().indexOf(q) >= 0; });
  if (palIdx >= palShown.length) palIdx = 0;
  $("#pallist").innerHTML = palShown.length
    ? palShown.map(function (a, i) {
        return "<div class='pi" + (i === palIdx ? " on" : "") + "' data-pal='" + a.id + "'>" +
          "<span>" + escapeHtml(a.label) + "</span><span class='k'>" + a.key + "</span></div>";
      }).join("")
    : "<div class='pi'><span>没有匹配的条目</span></div>";
}
function palShow(on) {
  palOpen = on;
  $("#pal").hidden = !on;
  if (on) { $("#palq").value = ""; palIdx = 0; palRender(); $("#palq").focus(); }
}
function palRun(id) {
  var a = PAL_ACTIONS.find(function (x) { return x.id === id; });
  palShow(false);
  if (a) a.run();
}
$("#palq").addEventListener("input", function () { palIdx = 0; palRender(); });
$("#pallist").addEventListener("click", function (e) {
  var row = e.target.closest("[data-pal]");
  if (row) palRun(row.dataset.pal);
});
$("#pal").addEventListener("click", function (e) { if (e.target === $("#pal")) palShow(false); });

// ── F-3 撤销条：破坏性操作 5 秒内可反悔 ────────────────────
var undoState = null, undoTimer = 0;
function offerUndo(text, fn, ms) {
  undoState = fn;
  $("#undo-text").textContent = text;
  $("#undo").hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(function () { undoState = null; $("#undo").hidden = true; }, ms || 5000);
}
$("#undo-go").onclick = async function () {
  var fn = undoState;
  undoState = null; $("#undo").hidden = true; clearTimeout(undoTimer);
  if (fn) await fn();
};

document.addEventListener("keydown", function (e) {
  var mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); palShow(true); return; }
  if (palOpen) {
    if (e.key === "Escape") { e.preventDefault(); palShow(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); palIdx = Math.min(palShown.length - 1, palIdx + 1); palRender(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); palRender(); return; }
    if (e.key === "Enter") { e.preventDefault(); if (palShown[palIdx]) palRun(palShown[palIdx].id); return; }
  }
  if (e.key === "Escape") {
    if (view !== "chat") { show("chat"); return; }
    if ($("#side").classList.contains("open")) { $("#side").classList.remove("open"); return; }
  }
  if (e.key === "ArrowUp" && document.activeElement === $("#m") && !$("#m").value) {
    e.preventDefault();
    var last = [...document.querySelectorAll(".row.user .body")].pop();
    if (last) { $("#m").value = last.textContent || ""; fitComposer(); }
  }
});

// ── 搜索输入（防抖）────────────────────────────────────
$("#q").addEventListener("input", function (e) {
  var q = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function () { doSearch(q); }, 300);
});
$("#q").addEventListener("keydown", function (e) {
  if (e.key === "Escape") { $("#q").value = ""; show("chat"); }
});

// ── 工具面板折叠（P2 #20）──────────────────────────────
$("#foldtools").onclick = function () {
  var box = $("#toollist");
  box.hidden = !box.hidden;
  if (!box.hidden) renderTools();
};

// ── 版本 / 冻结状态（P0 #4）────────────────────────────

// ── 待确认角标（P1 #10）────────────────────────────────
var lastPendCount = 0, titleTimer = null, flashLeft = 0;
function paintPendBadge(n) {
  var b = $("#pendbadge");
  b.hidden = n === 0;
  b.style.display = n === 0 ? "none" : "inline-flex";
  b.textContent = String(n);
  if (n > lastPendCount) {
    clearInterval(titleTimer);
    flashLeft = 6;
    var on = false;
    titleTimer = setInterval(function () {
      on = !on;
      document.title = on ? "● 有待确认" : TITLE;
      if (!on) { flashLeft--; if (flashLeft <= 0) { clearInterval(titleTimer); document.title = TITLE; } }
    }, 700);
  }
  lastPendCount = n;
}

// ── 回到最新（P2 #15）────────────────────────────────
var follow = true;
function nearBottom() {
  var el = $("#scroll");
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
$("#scroll").addEventListener("scroll", function () {
  if (view !== "chat") return;
  follow = nearBottom();
  $("#jump").classList.toggle("on", !follow);
  if (follow) $("#jumpn").textContent = "";
});
$("#jump").onclick = function () {
  $("#jump").classList.remove("on");
  follow = true; scrollBottom();
  $("#jumpn").textContent = "";
};

// ── 停止生成（P1 #7）──────────────────────────────────
var inflight = null;
function setStreaming(on) {
  $("#stop").style.display = on ? "inline-block" : "none";
  var send = $(".send"); if (send) send.style.display = on ? "none" : "";
}
$("#stop").onclick = function () {
  if (inflight) { try { inflight.abort(); } catch (e) { /* 已结束 */ } }
};

// ── 重发（P1 #13）──────────────────────────────────────
document.addEventListener("click", function (e) {
  var b = e.target.closest(".resend");
  if (!b) return;
  var row = b.closest(".row");
  var body = row && row.querySelector(".body");
  if (!body) return;
  $("#m").value = body.textContent || "";
  fitComposer();
  $("#m").focus();
});

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
var TOOLQ = "", TOOLALL = false;
async function tools() {
  const ts = await (await fetch("/api/tools")).json();
  TOOLS = ts;
  var cnt = $("#toolcount"); if (cnt) cnt.textContent = ts.length + " 项";
  paintTools();
}
/** F-1 #3：16 项全铺开会把 DOCS/MEMORY 挤到折叠线以下，所以默认只给 6 项 + 搜索 */
function paintTools() {
  var q = TOOLQ.trim().toLowerCase();
  var rows = TOOLS.map(function (t, i) { return { t: t, i: i }; })
    .filter(function (x) { return !q || (x.t.name + " " + x.t.description).toLowerCase().indexOf(q) >= 0; });
  var shown = TOOLALL || q ? rows : rows.slice(0, 6);
  $("#toolrows").innerHTML = shown.length
    ? shown.map(function (x) {
      return "<button class='item' data-view='toolview' data-tool='" + x.i + "'><span class='preview tname'>" + x.t.name +
        "<span class='tier'>" + x.t.tier + "</span></span><span class='m'>" + escapeHtml(x.t.description) + "</span></button>";
    }).join("")
    : "<div class='hint'>没有匹配的工具</div>";
  var more = $("#toolmore");
  more.hidden = Boolean(q) || TOOLALL || rows.length <= 6;
  more.textContent = "显示全部 " + rows.length + " 项";
}
$("#toolq").addEventListener("input", function () { TOOLQ = this.value; paintTools(); });
$("#toolmore").addEventListener("click", function () { TOOLALL = true; paintTools(); });
const renderTools = () => tools();
var MEMPAGE = 8;   // 侧栏先给 8 条；点「看更早的」按 8→40→200 往上翻
async function memories(limit) {
  var lim = limit || MEMPAGE;
  const rows = await (await fetch("/api/memories?limit=" + lim)).json();
  MEMS = rows;
  MEMPAGE = lim;
  var mc = $("#memcount"); if (mc) mc.textContent = rows.length + " 条";
  const more = rows.length >= MEMPAGE
    ? "<button class='item dimmore' id='memmore'>看更早的（已显示 " + rows.length + " 条）</button>"
    : "";
  $("#memlist").innerHTML = rows.slice(0, MEMPAGE).map((r) =>
    "<button class='item' data-view='memview' data-mem='" + r.id + "'>" +
    "<span class='preview'>" + escapeHtml(r.text) + "</span>" +
    "<span class='m'>" + r.weight.toFixed(2) + " · " + r.stage + "</span>" +
    "<span class='bar'><i style='width:" + Math.round(r.weight * 100) + "%'></i></span></button>").join("") + more;
  const mb = $("#memmore");
  if (mb) mb.onclick = function () { memories(Math.min(200, MEMPAGE * 5)); };
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
// ── 它想做的事（K-2）：一张卡说清 做什么 / 为什么 / 会动哪些文件 ──
var PROPS = [];
async function loadProposals() {
  var rows;
  try { rows = await (await fetch("/api/proposals?status=open")).json(); }
  catch (e) { return; }
  PROPS = Array.isArray(rows) ? rows : [];
  var sec = $("#propsec"), n = PROPS.length;
  $("#propcount").textContent = n ? n + " 件" : "";
  sec.hidden = n === 0;
  $("#proplist").innerHTML = PROPS.map(function (x) {
    return "<button class='item' data-prop='" + escapeHtml(x.id) + "'>" +
      "<span class='preview'>" + escapeHtml(x.title) + "</span>" +
      "<span class='m'>" + escapeHtml(x.risk) + " 风险" + (x.seen > 1 ? " · 提过 " + x.seen + " 次" : "") + "</span></button>";
  }).join("");
}
function openProposal(id) {
  var x = PROPS.filter(function (y) { return y.id === id; })[0];
  if (!x) return;
  $("#pv-title").textContent = x.title;
  $("#pv-meta").textContent = x.id + " · " + x.risk + " 风险 · 提到过 " + x.seen + " 次 · " +
    String(x.at).slice(0, 19) + " · 来源 " + (x.from || "agent");
  $("#pv-why").textContent = x.why;
  $("#pv-plan").innerHTML = (x.plan || []).length
    ? "<ol class='hint'>" + x.plan.map(function (t) { return "<li>" + escapeHtml(t) + "</li>"; }).join("") + "</ol>"
    : "";
  $("#pv-argv").textContent = (x.argv || []).length ? x.argv.join(" ") : "（不是一条命令能做完的）";
  $("#pv-touch").textContent = (x.touches || []).length ? "会动：" + x.touches.join(", ") : "会动：（它没写）";
  $("#pv-msg").textContent = "";
  var send = async function (action) {
    $("#pv-msg").textContent = "处理中…";
    try {
      var r = await (await fetch("/api/proposals/" + encodeURIComponent(id), {
        method: "POST", headers: H, body: JSON.stringify({ action: action }),
      })).json();
      if (r.ok) {
        $("#pv-msg").className = "ok";
        $("#pv-msg").textContent = action === "accept" ? "已同意（执行仍要授权）" : "已拒绝";
        await loadProposals();
        if (action === "accept") { $("#pv-msg").textContent += " —— 现在可以照上面的命令自己跑"; }
      } else { $("#pv-msg").className = "err"; $("#pv-msg").textContent = r.error || "失败"; }
    } catch (e) { $("#pv-msg").className = "err"; $("#pv-msg").textContent = "请求失败"; }
  };
  $("#pv-yes").onclick = function () { send("accept"); };
  $("#pv-no").onclick = function () { send("reject"); };
  show("propview");
}
$("#proplist").onclick = function (e) {
  var b = e.target.closest("button[data-prop]");
  if (b) openProposal(b.dataset.prop);
};

// 极小的提示：写进底部 ticker，5 秒后由 readout 自己刷回真实状态
var TICK_MSG = null, TICK_TIMER = null;
function pushTicker(msg) {
  TICK_MSG = msg;
  var tb = document.getElementById("ticker");
  if (tb) tb.innerHTML = "<span class='tk'>" + escapeHtml(msg) + "</span>";
  if (TICK_TIMER) clearTimeout(TICK_TIMER);
  TICK_TIMER = setTimeout(function () { TICK_MSG = null; readout(); }, 5000);
}

// ── 代码外发（H-7）：它想读、被挡下、等人批 ─────────────
async function loadEgress() {
  var st;
  try { st = await (await fetch("/api/egress")).json(); } catch (e) { return; }
  var rows = (st && st.pending) || [];
  $("#egrcount").textContent = st.until ? "开放中" : (rows.length ? rows.length + " 条" : "");
  $("#egrsec").hidden = !rows.length && !st.until;
  var head = st.until
    ? "<div class='pend'><span class='cmd'>代码外发：开放中（到 " + escapeHtml(String(st.until).slice(11, 16)) + "）</span>" +
      "<div class='acts'><button class='no' data-egr='revoke'>收回</button></div></div>"
    : (st.forced ? "<p class='hint'>当前由 JJ_PROJECT_EGRESS=1 强制放行（无人值守模式）。</p>" : "");
  $("#egrlist").innerHTML = head + rows.map(function (r) {
    return "<div class='pend' data-egrpath='" + escapeHtml(r.path) + "'>" +
      "<span class='cmd'>" + escapeHtml(r.path) + "</span>" +
      "<span class='dir'>" + escapeHtml(String(r.at).slice(0, 16)) + " · " + escapeHtml(r.verb) + "</span>" +
      "<div class='acts'>" +
        "<button class='ok' data-egr='once'>只这一次</button>" +
        "<button class='ok' data-egr='window'>10 分钟内都行</button>" +
        "<button class='no' data-egr='deny'>拒绝</button>" +
      "</div><span class='msg'></span></div>";
  }).join("");
}
$("#egrlist").onclick = async function (e) {
  var b = e.target.closest("button[data-egr]");
  if (!b) return;
  var card = b.closest("[data-egrpath]");
  var act = b.dataset.egr;
  var body = { action: act === "window" ? "window" : act };
  if (act === "once" && card) body.path = card.dataset.egrpath;
  if (act === "deny") { if (card) card.remove(); var left = $("#egrlist").children.length; $("#egrcount").textContent = left ? left + " 条" : ""; $("#egrsec").hidden = left === 0; return; }
  await fetch("/api/egress", { method: "POST", headers: H, body: JSON.stringify(body) });
  await loadEgress();
};
// ── 权限档：当前会话在输入框旁切；设置只放「以后新建会话的默认值」──
var PERM = { preset: "ask", remainingS: 0 };
var PERM_LABEL = { ask: "逐次确认", read: "仅可查看", write: "工作区内修改", full: "完全权限" };
async function loadPermission() {
  try { PERM = await (await fetch("/api/permission")).json(); } catch (e) { return; }
  paintPermission();
}
function paintPermission() {
  var b = document.getElementById("perm");
  if (!b) return;
  // 会话级：不再显示倒计时（它不会自己过期；换了档或关掉进程才变）
  b.textContent = PERM_LABEL[PERM.preset] || PERM.preset;
  b.className = "permchip" + (PERM.preset === "full" ? " full" : "");
}
async function setPermission(preset) {
  var r;
  try {
    r = await (await fetch("/api/permission", {
      method: "POST", headers: H, body: JSON.stringify({ preset: preset }),
    })).json();
  } catch (e) { return false; }
  if (r.ok) { await loadPermission(); return true; }
  var msg = document.getElementById("permmsg");
  if (msg) msg.textContent = r.why || r.code || "切换失败";
  return false;
}
function renderPermOptions() {
  var cur = PERM.preset;
  var box = document.getElementById("permopts");
  box.innerHTML = (PERM.presets || []).map(function (x) {
    var on = x.id === cur ? " on" : "";
    var warn = x.id === "full" ? " ⚠" : "";
    return "<button class='opt" + on + "' data-preset='" + escapeHtml(x.id) + "' aria-current='" + (x.id === cur ? "true" : "false") + "'>" +
      "<b>" + escapeHtml(x.label) + warn + "</b><span>" + escapeHtml(x.hint) + "</span></button>";
  }).join("");
}
document.getElementById("perm").addEventListener("click", function () {
  renderPermOptions();
  document.getElementById("permpop").hidden = false;
  var on = document.querySelector("#permopts .opt.on");
  if (on) on.focus();
});
document.getElementById("permclose").addEventListener("click", function () {
  document.getElementById("permpop").hidden = true;
});
document.getElementById("permpop").addEventListener("click", function (e) {
  if (e.target.id === "permpop") document.getElementById("permpop").hidden = true;
});
document.getElementById("permopts").addEventListener("click", async function (e) {
  var b = e.target.closest("button[data-preset]");
  if (!b) return;
  var preset = b.dataset.preset;
  // 一键切：选中就生效，没有二次确认（安全边界在"哪些命令永久拒绝"，不在"多点几下手"）
  if (await setPermission(preset)) document.getElementById("permpop").hidden = true;
});
document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") return;
  var pop = document.getElementById("permpop");
  if (pop && !pop.hidden) { pop.hidden = true; document.getElementById("perm").focus(); }
});

// /permission 斜杠命令：带参直接切，不带参打开选择器（同 DSH）
async function handleSlash(text) {
  // 不用正则：page.ts 是模板字符串，反斜杠在这一层就会被吃掉（踩过）
  var t = String(text || "").trim();
  if (t !== "/permission" && t.indexOf("/permission ") !== 0) return false;
  var arg = t === "/permission" ? "" : t.slice(11).trim().split(" ")[0].toLowerCase();
  if (!arg) { document.getElementById("perm").click(); return true; }
  var alias = { full: "full", write: "write", read: "read", ask: "ask" };
  var preset = alias[arg];
  if (!preset) { pushTicker("未知档位：" + arg + "（可用 ask / read / write / full）"); return true; }
  if (await setPermission(preset)) pushTicker("权限已切到 " + preset);
  return true;
}

// ── 回执（D-3 前置）：送达 ≠ 已读 ───────────────────
async function loadReceipts() {
  var j;
  try { j = await (await fetch("/api/receipts")).json(); } catch (e) { return; }
  var rows = (j && j.items) || [];
  $("#rcpcount").textContent = rows.length ? rows.length + " 条" : "";
  $("#rcpsec").hidden = rows.length === 0;
  $("#rcplist").innerHTML = rows.map(function (r) {
    return "<div class='pend rcp' data-rcp='" + escapeHtml(r.id) + "'>" +
      "<span class='cmd'>" + (r.ok ? "" : "<span class='err'>失败 </span>") + escapeHtml(r.title) + "</span>" +
      "<span class='dir'>" + escapeHtml(String(r.at).slice(0, 16)) + (r.source ? " · " + escapeHtml(r.source) : "") + "</span>" +
      "<div class='acts'><button class='ok' data-act='seen'>知道了</button></div>" +
      "<span class='msg'></span></div>";
  }).join("") || "<p class='hint'>没有待读回执。</p>";
}
$("#rcplist").onclick = async function (e) {
  var b = e.target.closest("button[data-act=seen]");
  if (!b) return;
  var card = b.closest("[data-rcp]");
  b.disabled = true;
  await fetch("/api/receipts/" + card.dataset.rcp + "/seen", { method: "POST", headers: H });
  await loadReceipts();
};

// ── 常驻指令（D-3）：只读列表 + 停用 ─────────────────
async function loadStanding() {
  var rows;
  try { rows = await (await fetch("/api/standing")).json(); } catch (e) { return; }
  rows = Array.isArray(rows) ? rows : [];
  var el = $("#st-list");
  if (!el) return;
  el.innerHTML = rows.length ? rows.map(function (o) {
    return "<div class='pend' data-std='" + escapeHtml(o.id) + "'>" +
      "<span class='cmd'>" + escapeHtml(o.id) + " · " + escapeHtml(o.when) + " · " + escapeHtml(o.template) + "</span>" +
      "<span class='dir'>" + (o.enabled ? "启用" : "<span class='err'>已停用</span>") +
        " · 到期 " + escapeHtml(String(o.expiresAt).slice(0, 10)) + " · 为什么：" + escapeHtml(o.because) + "</span>" +
      (o.enabled ? "<div class='acts'><button class='no' data-act='off'>停用</button></div>" : "") +
      (o.disabledReason ? "<span class='hint'>" + escapeHtml(o.disabledReason) + "</span>" : "") +
      "<span class='msg'></span></div>";
  }).join("") : "<p class='hint'>还没有常驻指令。加一条：jingjing standing add --id x --when 09:00 --run node.run_script --because 理由（必须写为什么）</p>";
}
$("#st-list").onclick = async function (e) {
  var b = e.target.closest("button[data-act=off]");
  if (!b) return;
  var card = b.closest("[data-std]");
  b.disabled = true;
  await fetch("/api/standing/" + card.dataset.std + "/disable", { method: "POST", headers: H, body: JSON.stringify({ reason: "面板上停用" }) });
  await loadStanding();
};
// ── 线索层：未闭合的事（"这件事发展到哪一步"）────────
async function loadThreads() {
  var rows;
  try { rows = await (await fetch("/api/threads")).json(); } catch (e) { return; }
  rows = Array.isArray(rows) ? rows : [];
  $("#threadcount").textContent = rows.length ? rows.length + " 件" : "";
  $("#threadsec").hidden = rows.length === 0;
  $("#threadlist").innerHTML = rows.map(function (t) {
    var age = t.ageDays > 0 ? "立下 " + t.ageDays + " 天" : "今天立的";
    return "<div class='pend thr' data-thr='" + t.id + "'>" +
      "<span class='cmd'>" + escapeHtml(String(t.text).slice(0, 40)) + "</span>" +
      "<span class='dir'>" + escapeHtml(age) + (t.aging ? " · 拖了 " + t.ageDays + " 天" : "") +
      (t.quote ? " · 原话「" + escapeHtml(String(t.quote).slice(0, 20)) + "」" : "") + "</span>" +
      "<div class='acts'><button class='ok' data-act='done'>了结了</button></div>" +
      "<span class='msg'></span></div>";
  }).join("");
}
$("#threadlist").onclick = async function (e) {
  var btn = e.target.closest("button[data-act=done]");
  if (!btn) return;
  var card = btn.closest("[data-thr]");
  var msg = card.querySelector(".msg");
  btn.disabled = true;
  msg.textContent = "处理中…";
  try {
    var r = await (await fetch("/api/threads/" + card.dataset.thr + "/close", {
      method: "POST", headers: H, body: JSON.stringify({ note: "人点了了结" }),
    })).json();
    if (r.ok) { msg.textContent = "已了结（历史仍查得到）"; setTimeout(function () { loadThreads(); }, 600); }
    else { msg.textContent = r.error || "失败"; btn.disabled = false; }
  } catch (err) { msg.textContent = "请求失败"; btn.disabled = false; }
};

// ── 抽检（J-5b）：把最没把握的线送到眼前，当场能断 ──
async function loadSurfaceReview() {
  var rows;
  try { rows = await (await fetch("/api/surface/review")).json(); } catch (e) { return; }
  rows = Array.isArray(rows) ? rows : [];
  $("#surfcount").textContent = rows.length ? rows.length + " 根" : "";
  $("#surfsec").hidden = rows.length === 0;
  $("#surflist").innerHTML = rows.map(function (r) {
    return "<div class='pend surf' data-key='" + escapeHtml(r.key) + "' data-src='" + r.src_id + "' data-dst='" + r.dst_id + "' data-rel='" + escapeHtml(r.rel) + "'>" +
      "<span class='cmd'>" + escapeHtml(String(r.a_text).slice(0, 26)) + " ↔ " + escapeHtml(String(r.b_text).slice(0, 26)) + "</span>" +
      "<span class='dir'>为什么连：" + escapeHtml(r.why || "（没有理由）") + " · 把握 " + Number(r.weight).toFixed(2) + "</span>" +
      "<div class='acts'><button class='ok' data-act='yes'>对</button><button class='no' data-act='no'>不对，断掉</button></div>" +
      "<span class='msg'></span></div>";
  }).join("");
}
$("#surflist").onclick = async function (e) {
  var btn = e.target.closest("button[data-act]");
  if (!btn) return;
  var card = btn.closest("[data-key]");
  var msg = card.querySelector(".msg");
  btn.disabled = true;
  msg.textContent = "处理中…";
  var body = { src_id: Number(card.dataset.src), dst_id: Number(card.dataset.dst), rel: card.dataset.rel, ok: btn.dataset.act === "yes" };
  try {
    var r = await (await fetch("/api/surface/review", { method: "POST", headers: H, body: JSON.stringify(body) })).json();
    msg.textContent = r.ok ? (r.cut ? "已断" : "已记下") : (r.error || "失败");
    setTimeout(function () { card.remove(); var left = $("#surflist").children.length; $("#surfcount").textContent = left ? left + " 根" : ""; $("#surfsec").hidden = left === 0; }, 700);
  } catch (err) { msg.textContent = "请求失败"; btn.disabled = false; }
};

async function openMemory(id) {
  const r = await (await fetch("/api/memories/" + id)).json();
  $("#mv-text").textContent = r.text;
  $("#mv-meta").textContent = "id " + r.id + " · " + r.layer + "/" + r.kind + " · " + r.stage +
    " · 权重 " + Number(r.weight).toFixed(2) + " · " + r.sensitivity + " · " + r.taint +
    " · 打分 " + (r.scored_by || "未记录") +
    " · 建于 " + String(r.created_at).slice(0, 19);
  $("#mv-msg").textContent = "";
  $("#mv-edit").value = r.text;
  $("#mv-imp").value = String(r.importance ?? 3);
  $("#mv-sens").value = r.sensitivity === "shareable" ? "shareable" : "local_only";
  // F-1 #5：一条记忆必须能回答"它从哪来、改过什么"
  var prov = r.provenance || { changes: [], doc: null };
  var bits = [];
  var fromText = r.source_kind === "doc" ? "文档" : r.source_kind === "extract" ? "夜间抽取" : r.source_kind === "user" ? "你说的话" : (r.source_kind || "未知");
  bits.push("<div class='hint'>来自：" + escapeHtml(fromText) + (r.source_ref ? " · " + escapeHtml(String(r.source_ref).slice(0, 120)) : "") + "</div>");
  if (r.quote) bits.push("<div class='quote'>原话：「" + escapeHtml(r.quote) + "」</div>");
  if (prov.doc) bits.push("<button class='item mini' data-doc='" + escapeHtml(prov.doc.id) + "'>打开来源文档：" + escapeHtml(prov.doc.title) + "</button>");
  if (r.superseded_by) bits.push("<div class='hint'>被 #" + r.superseded_by + " 取代（旧的留着可追溯）</div>");
  if ((prov.changes || []).length) {
    bits.push("<details class='hist'><summary>改过 " + prov.changes.length + " 次（点开看旧正文）</summary>" +
      prov.changes.map(function (c) {
        return "<div class='oldver'><span class='dim2'>" + String(c.at).slice(0, 19) + " · " + escapeHtml(c.by) + "</span><br>" + escapeHtml(c.old) + "</div>";
      }).join("") + "</details>");
  }
  $("#mv-prov").innerHTML = bits.join("");
  var docBtn = $("#mv-prov").querySelector("button[data-doc]");
  if (docBtn) docBtn.onclick = function () { openDoc(docBtn.dataset.doc); };
  $("#mv-save").dataset.id = String(id);
  $("#mv-forget").onclick = async () => {
    const j = await (await fetch("/api/memories/" + id + "/forget", { method: "POST", headers: H })).json();
    if (!j.ok) { $("#mv-msg").className = "err"; $("#mv-msg").textContent = j.error || "失败"; return; }
    $("#mv-msg").className = "ok";
    // F-3：忘记是可撤回的（软删）。5 秒内点一下就回来，过期才真的算忘了
    $("#mv-msg").innerHTML = "已忘记 · <button class='item mini' id='mv-undo'>撤销</button>（5 秒）";
    await memories();
    const undo = $("#mv-undo");
    const timer = setTimeout(() => { $("#mv-msg").innerHTML = "已忘记"; }, 5000);
    if (undo) undo.onclick = async () => {
      clearTimeout(timer);
      const r = await (await fetch("/api/memories/" + id + "/restore", { method: "POST", headers: H })).json();
      if (r.ok) { $("#mv-msg").className = "ok"; $("#mv-msg").textContent = "已撤回（权重按原样，没补回来）"; await memories(); }
      else { $("#mv-msg").className = "err"; $("#mv-msg").textContent = r.error || "撤回失败"; }
    };
  };
  show("memview");
}
function scrollBottom() {
  const s = $("#scroll"); s.scrollTop = s.scrollHeight;
}
async function loadUi() {
  try {
    const u = await (await fetch("/api/ui")).json();
    const av = u && u.avatar ? u.avatar : "plain";
    document.body.dataset.av = av;
    const s = $("#a-frame");
    if (s) s.value = av;
  } catch (e) {
    // 面板照常能用：外观是装饰，读不到就不改
  }
}

// 官方默认：baseUrl 留空时服务端就用这些（与 src/transport.ts 的 endpointOf 一致）
var PROVIDER_DEFAULTS = {
  deepseek: { base: "https://api.deepseek.com", model: "deepseek-chat" },
  anthropic: { base: "https://api.anthropic.com", model: "claude-sonnet-4-20250514" },
  openai: { base: "https://api.openai.com", model: "gpt-4o" }
};
function paintEndpoint() {
  var pv = $("#c-provider").value;
  var d = PROVIDER_DEFAULTS[pv] || { base: "", model: "" };
  var typed = $("#c-base").value.trim();
  $("#c-base").placeholder = d.base ? ("留空 = " + d.base) : "";
  $("#c-model").placeholder = d.model;
  var ep = $("#c-ep");
  if (ep) ep.textContent = "实际请求：" + (typed || d.base) + "/…（" + pv + "）" +
    (typed ? "　← 自定义地址（局域网 / 中转 / 自建）" : "　← 官方默认");
}
$("#c-provider").addEventListener("change", function () {
  var d = PROVIDER_DEFAULTS[$("#c-provider").value];
  if (d && !$("#c-model").value.trim()) $("#c-model").value = d.model;
  paintEndpoint();
});
$("#c-base").addEventListener("input", paintEndpoint);

async function loadConfig() {
  loadModels();
  loadCapabilities();
  const c = await (await fetch("/api/config")).json();
  $("#c-provider").value = c.provider;
  $("#c-model").value = c.model;
  $("#c-base").value = c.baseUrl || "";
  $("#modelchip").textContent = c.provider.toUpperCase() + " · " + c.model;
  $("#c-clear").hidden = !c.hasKey;          // 没有 key 就不显示"清除"（避免点了没反应）
  $("#c-cur").textContent = "当前 " + c.provider + " / " + c.model +
    (c.hasKey ? " · key " + c.keyFingerprint + " (" + c.secretStore + ")" : " · 还没配 key") +
    " · 预算 $" + c.budgetUsd + "/天";
  const b = $("#banner");
  if (!c.hasKey) {
    b.hidden = false;
    // 以前这里写「仅本地推理」——那是假话：没有 key 时聊天直接 401，本地只有兜底模型回一句
    b.innerHTML = "// 还没配云端 key —— 现在是你本地那个小模型在硬撑（质量差），点这里配 <button id='go-cfg'>去设置</button>";
    $("#go-cfg").onclick = () => show("cfg");
  } else { b.hidden = true; }
  paintEndpoint();
  return c;
}
// ── 本地模型（C-4）：与云端接口分开管 ─────────────────────
let MODELS = null;
function fillModels(el, cur, installed, extraEmpty) {
  const names = installed.slice();
  if (cur && !names.includes(cur)) names.unshift(cur);
  const opts = (extraEmpty ? ["<option value=''>（未配置）</option>"] : [])
    .concat(names.map(function (n) {
      // Ollama 的 tag 常带 :latest：bge-m3 与 bge-m3:latest 是同一个模型
      const missing = (installed.includes(n) || installed.includes(n + ":latest")) ? "" : " · 未安装";
      return "<option value='" + escapeHtml(n) + "'>" + escapeHtml(n) + missing + "</option>";
    }));
  el.innerHTML = opts.join("");
  el.value = cur || (extraEmpty ? "" : (names[0] || ""));
}
// ── 能力自述（B-0 / F-2）：数据全部来自 /api/capabilities，面板只负责显示 ──
var CAP_CLASSES = [
  ["tool", "工具"], ["command", "命令"], ["hook", "钩子"],
  ["cron", "定时"], ["panel", "面板"], ["provider", "供应商"],
];
async function loadCapabilities() {
  var c;
  try { c = await (await fetch("/api/capabilities")).json(); }
  catch (e) { $("#cap-sum").textContent = "查不到能力表（服务没起来？）"; return; }
  var counts = CAP_CLASSES.map(function (p) { return p[1] + " " + ((c.classes[p[0]] || []).length); });
  $("#cap-sum").textContent = counts.join(" · ");
  $("#cap-list").innerHTML = CAP_CLASSES.map(function (p) {
    var id = p[0], items = c.classes[id] || [];
    if (!items.length) return "<div class='capline dim2'>" + p[1] + "：0（未实现）</div>";
    var names = items.slice(0, 60).map(function (x) {
      return "<span class='capname'>" + escapeHtml(x.name) + "</span>" +
        (x.tier ? " <span class='dim2'>" + x.tier + "</span>" : "") +
        (x.source === "mcp" ? " <span class='dim2'>mcp</span>" : "");
    }).join("");
    return "<details class='capbox'><summary>" + p[1] + " · " + items.length + "</summary>" +
      "<div class='capnames'>" + names + "</div></details>";
  }).join("");
  var deg = c.degraded || [];
  $("#cap-deg").innerHTML = deg.length
    ? "<span class='err'>降级 " + deg.length + " 项</span><br>" +
      "<span class='err'>" + deg.map(escapeHtml).join(" · ") + "</span>" +
      (c.notes && c.notes.length ? "<br><span class='dim2'>" + c.notes.map(escapeHtml).join("；") + "</span>" : "")
    : "<span class='dim2'>无降级</span>";
}

async function loadModels(force) {
  if (MODELS && !force) { paintModels(MODELS); return; }   // 进设置别每次都重新探测
  $("#m-state").textContent = "查询本地模型…";
  let m;
  try { m = await (await fetch("/api/models")).json(); } catch (e) {
    $("#m-state").textContent = "查不到本地模型（服务没起来？）"; return;
  }
  MODELS = m;
  paintModels(m);
}
function paintModels(m) {
  const byRole = {};
  (m.roles || []).forEach(function (r) { byRole[r.role] = r; });
  var envAny = (byRole["route"] && byRole["route"].source === "env") || (byRole["night"] && byRole["night"].source === "env") || (byRole["embed"] && byRole["embed"].source === "env");
  $("#m-state").textContent = m.online
    ? "端点 " + m.endpoint + " · 已装 " + (m.installed.length ? m.installed.join(", ") : "（无）") + (envAny ? " · 部分值被 JJ_MODEL_* 环境变量覆盖（改这里不生效）" : "")
    : "端点 " + m.endpoint + " 连不上：" + (m.error || "") + " —— 先启动 Ollama";
  fillModels($("#m-default"), (byRole["route"] || {}).model || "", m.installed, true);
  fillModels($("#m-night"), (byRole["night"] || {}).model || "", m.installed, true);
  fillModels($("#m-embed"), (byRole["embed"] || {}).model || "", m.installed, true);
}
$("#m-save").addEventListener("click", async function () {
  const btn = this;
  btn.disabled = true;
  $("#m-msg").textContent = "保存中…";
  try {
    const body = { default: $("#m-default").value, night: $("#m-night").value, embed: $("#m-embed").value };
    const r = await fetch("/api/models", { method: "PUT", headers: H, body: JSON.stringify(body) });
    const j = await r.json();
    $("#m-msg").textContent = j.ok ? "已保存：下次夜间整备与重启面板后生效" : ("失败：" + (j.error || r.status));
    await loadModels(true);
  } catch (e) {
    $("#m-msg").textContent = "保存失败：" + e.message;
  } finally { btn.disabled = false; }
});

async function loadPersona(file) {
  const p = await (await fetch("/api/persona")).json();
  $("#p-text").value = p.files[file] || "";
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("#side .item");
  if (!t || !t.dataset.view) return;
  const v = t.dataset.view;
  sideActive = t;
  for (const b of document.querySelectorAll("#side .item")) b.classList.toggle("on", b === t);
  if (v === "cfg") { show("cfg"); loadConfig().then(() => loadPersona($("#p-file").value)); return; }
  if (v === "toolview") { openTool(Number(t.dataset.tool)); return; }
  if (v === "memview") { openMemory(Number(t.dataset.mem)); return; }
  if (v === "docview") { openDoc(t.dataset.doc); return; }
  if (v === "auditview") { openAudit(); return; }
  show("chat");
  if (t.dataset.day) jumpToDay(t.dataset.day);
});
$("#p-file").onchange = (e) => loadPersona(e.target.value);
// 头像框：改完立刻套上（不等服务端），再把选择存住
$("#a-frame").onchange = async (e) => {
  const v = e.target.value;
  document.body.dataset.av = v;
  const j = await (await fetch("/api/ui", { method: "PUT", headers: H, body: JSON.stringify({ avatar: v }) })).json();
  const m = $("#a-msg");
  if (j.ok) { m.className = "ok"; m.textContent = "  · SAVED"; }
  else { m.className = "err"; m.textContent = "  · " + (j.error || "FAILED"); }
};
// 移动端：点主区域收起抽屉
document.addEventListener("click", (e) => {
  const side = $("#side");
  if (!side.classList.contains("open")) return;
  if (e.target.closest("#side")) return;
  side.classList.remove("open");
});
// 清除密钥：两步确认（第一次只是"你确定？"，4 秒后自动复位）
let clearArmed = 0;
$("#c-clear").onclick = async () => {
  const btn = $("#c-clear"), m = $("#c-msg");
  if (Date.now() - clearArmed > 4000) {
    clearArmed = Date.now();
    btn.textContent = "再点一次 = 真的清除";
    m.className = "err"; m.textContent = "会删掉本机存的 key（可重新填回）；没 key 时云端会回落本地，本地也没模型就直接报错";
    setTimeout(() => { btn.textContent = "清除密钥"; }, 4000);
    return;
  }
  clearArmed = 0;
  btn.disabled = true;
  try {
    const j = await (await fetch("/api/config", { method: "PUT", headers: H, body: JSON.stringify({ key: null }) })).json();
    m.className = j.ok ? "ok" : "err";
    m.textContent = j.ok
      ? (j.removed ? "已清除本机的 key。没有 key 时云端会回落本地模型" : "本来就没有 key")
      : ("失败：" + (j.error || "?"));
    await loadConfig();
  } finally {
    btn.disabled = false;
    btn.textContent = "清除密钥";
  }
};
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
  // 斜杠命令先过一道：/permission 之类的本地动作不该被当成聊天发出去
  if (await handleSlash(text)) { $("#m").value = ""; fitComposer(); return; }
  if (inflight) return;                       // 上一轮还没完就别叠
  $("#m").value = ""; fitComposer();
  const el = $("#chat");
  el.insertAdjacentHTML("beforeend", rowHtml({ role: "user", ts: new Date().toISOString(), text }));
  const id = "live-" + Date.now();
  el.insertAdjacentHTML("beforeend",
    "<div class='row agent' id='" + id + "'><div class='av'>" + avHtml(false) + "</div><div>" +
    "<div class='meta'>处理中…</div><div class='recall'></div><div class='body md'><span class='cursor'></span></div></div></div>");
  const box = document.querySelector("#" + id + " .md");
  const meta = document.querySelector("#" + id + " .meta");
  const recallBox = document.querySelector("#" + id + " .recall");
  let acc = "", cites = [], omitted = 0, omittedDocs = 0;
  inflight = new AbortController();
  setStreaming(true);
  try {
    const res = await fetch("/api/say", {
      method: "POST", headers: H, body: JSON.stringify({ text }), signal: inflight.signal,
    });
    if (!res.ok) {
      const j = await res.json();
      box.innerHTML = "<span class='sys'>E: " + escapeHtml(j.error || res.status) + "</span>" +
        " <button class='resend' data-retry='" + escapeHtml(text) + "'>重试</button>";
      return;
    }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const r = await reader.read(); if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const frames = buf.split(NL2); buf = frames.pop() || "";
      for (const f of frames) {
        const mm = f.match(/^data: (.*)$/m); if (!mm) continue;
        const d = JSON.parse(mm[1]);
        if (d.type === "brief") {
          // 证据链（P0 #1）：这一轮它到底调了哪几条记忆/文档
          cites = d.cites || []; omitted = d.omitted || 0; omittedDocs = d.omittedDocs || 0;
          recallBox.innerHTML = recallHtml(cites, omitted, omittedDocs);
        }
        if (d.type === "notice") {
          recallBox.insertAdjacentHTML("beforeend", "<span class='notice'>" + escapeHtml(d.text) + "</span>");
        }
        if (d.type === "delta") { acc += d.text; box.innerHTML = escapeHtml(acc) + "<span class='cursor'></span>"; }
        if (d.type === "tool") {
          meta.textContent = "调用 " + d.name;
          box.insertAdjacentHTML("beforeend",
            "<details class='tool'><summary><span class='tn'>" + escapeHtml(d.name) + "</span>" +
            "<span class='tms'>运行中…</span></summary><pre class='targs'>" + escapeHtml(d.args || "") + "</pre></details>");
        }
        if (d.type === "tool_result") {
          const cards = box.querySelectorAll("details.tool");
          const last = cards[cards.length - 1];
          if (last) { last.querySelector(".tms").textContent = d.ms + "ms";
            last.insertAdjacentHTML("beforeend", "<pre class='tres'>" + escapeHtml(d.result) + "</pre>"); }
        }
        if (d.type === "error") {
          box.insertAdjacentHTML("beforeend", "<div class='sys'>E: " + escapeHtml(d.message) + "</div>");
        }
        if (d.type === "done") { meta.textContent = clock(new Date().toISOString()); }
      }
      if (follow) scrollBottom();
else { const n = Number($("#jumpn").textContent || 0) + 1; $("#jumpn").textContent = String(n); $("#jump").classList.add("on"); }
    }
  } catch (err) {
    const aborted = err && (err.name === "AbortError");
    box.insertAdjacentHTML("beforeend",
      "<div class='sys'>" + (aborted ? "已停止" : "网络错误：" + escapeHtml(err.message || err)) + "</div>" +
      (aborted ? "" : " <button class='resend' data-retry='" + escapeHtml(text) + "'>重试</button>"));
  } finally {
    inflight = null;
    setStreaming(false);
    const meta2 = document.querySelector("#" + id + " .meta");
    if (meta2 && meta2.textContent === "处理中…") meta2.textContent = clock(new Date().toISOString()) + (acc ? "" : " · 无内容");
  }
  await timeline(); await state(); await memories(); await pending(); await audit();
};
// PWA：注册离线壳。注册失败不能影响面板本身（手机上走 http 时浏览器会直接拒绝）
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("/sw.js").catch(function () { /* 忽略：离线壳是增强，不是前提 */ });
}
// 手机上侧栏是抽屉：没有这个按钮，SESSIONS/DOCS/MEMORY/TOOLS/CONFIG 全都不可达
$("#menu").onclick = (e) => { e.stopPropagation(); $("#side").classList.toggle("open"); };
loadAvatars(); applySections(); state(); timeline(); sessions(); tools(); memories(); docs(); audit(); readout(); loadConfig(); loadUi(); pending(); usage(); loadProposals(); loadSurfaceReview(); loadThreads(); loadReceipts(); loadStanding();
setInterval(() => { state(); pending(); audit(); readout(); }, 20000);
</script>
</body></html>`;

