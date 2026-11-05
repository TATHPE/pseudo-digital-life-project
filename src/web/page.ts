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
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<meta name="theme-color" content="#0b0e0b">
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
    --rail:240px; --folio:330px; --head:56px; --readh:40px;

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
  /* html 自己也要给底色：只给 body 的话，导航过来/重绘时会先闪一帧白 */
  html { background:var(--void); }
  html, body { height:100%; }
  /* 刘海屏/圆角屏：内容不能钻到状态栏或手势条底下（viewport-fit=cover 之后必须自己补） */
  header { padding-top:env(safe-area-inset-top); }
  #composer { padding-bottom:max(0px, env(safe-area-inset-bottom)); }
  aside { padding-bottom:calc(30px + env(safe-area-inset-bottom)); }
  body {
    margin:0; color:var(--fg); background:var(--void);
    font:15px/1.72 -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif;
    display:grid; grid-template-rows:var(--head) var(--readh) 1fr;
    grid-template-columns:var(--rail) minmax(0,1fr) var(--folio);
    grid-template-areas:"head head head" "readout readout readout" "side main folio";
    height:100vh; overflow:hidden;
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
  /* 列宽下限必须是 0：1fr 的隐含下限是 min-content，工具卡里一条长 argv 就能把整列撑破
     （加了右栏卷宗之后中栏变窄，这个问题才露出来 —— 横向滚动条就是这么来的） */
  .row { display:grid; grid-template-columns:28px minmax(0,1fr); gap:12px; margin:14px 0; align-items:start; }
  /* 用户行：头像放右边，正文右对齐（像 pi-web 的对话排列） */
  .row.user { grid-template-columns:minmax(0,1fr) 28px; }
  .row.user .av { order:2; }
  .row.user > div:nth-child(2) { order:1; }
  .row.user .meta { text-align:right; }
  /* 头像：图标放进框里居中用 flex（文字也用同一套，别用 line-height 兼管两者） */
  .av { width:28px; height:28px; border:1px solid var(--line-dim); display:flex;
        align-items:center; justify-content:center; font-size:12px;
        font-family:"Microsoft YaHei","PingFang SC",var(--mono); color:var(--ink); font-weight:700; }
  .av .ico { width:20px; height:20px; }
  .row.user .av { color:var(--amber); border-color:rgba(255,180,84,.3); }
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
                 white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere;
                 color:#a9c9cf; max-height:220px; overflow:auto; }
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
  /* ── 三列骨架（照 Trianon：wing ｜ stage ｜ folio）──────────
     结构抄它，配色仍是我们的：黑底 + 白细线 + 加粗白字。
     wing = 左栏（品牌 / 搜索 / 工作区 / 今天 / 各分区）
     stage = 中栏（标题条 + 对话 + 输入）
     folio = 右栏「卷宗」三张可折卡（Plan / Changes / Context） */
  .wingtop { margin-bottom:10px; }
  .wmark { display:flex; align-items:baseline; gap:8px; padding:2px 2px 8px;
           border-bottom:1px solid var(--line-dim); margin-bottom:8px; }
  .wmark b { font:15px/1 var(--mono); letter-spacing:.3em; color:var(--ink); font-weight:700;
             flex:none; white-space:nowrap; }
  .wmark span { font:8px/1.4 var(--mono); letter-spacing:.14em; color:var(--ink-dim);
                min-width:0; overflow:hidden; }
  .wsearch { position:relative; margin-bottom:10px; }
  .wsearch kbd { position:absolute; right:6px; top:50%; transform:translateY(-50%);
                 font:9px/1 var(--mono); color:var(--ink-dim); border:1px solid var(--line-dim);
                 padding:3px 4px; background:#000; pointer-events:none; }
  .wsec { display:flex; align-items:center; gap:8px; margin:10px 0 5px;
          font:9px/1 var(--mono); letter-spacing:.26em; color:var(--ink-dim); font-weight:700; }
  .wsec::after { content:""; flex:1; height:1px; background:var(--line-dim); }
  .witem { border:1px solid var(--line-dim); background:#000; color:var(--ink);
           font:12px/1.5 inherit; padding:5px 9px; margin-bottom:6px; }
  .witem .m { display:block; font:9px/1.5 var(--mono); color:var(--ink-dim); letter-spacing:.04em; }
  /* 中栏标题条：会话名 + 状态 + 卷宗开关 */
  #stagebar { display:flex; align-items:center; gap:10px; flex:none; height:44px; padding:0 22px;
              border-bottom:1px solid var(--line-dim); background:rgba(8,11,10,.9); }
  #stagebar .stt { font:12px/1 var(--mono); letter-spacing:.14em; color:var(--ink); font-weight:700;
                   overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #stagebar .sts { font:9px/1 var(--mono); letter-spacing:.18em; color:var(--ink-dim); white-space:nowrap; }
  #stagebar .str { margin-left:auto; display:flex; align-items:center; gap:8px; }
  #folioTog { display:none; background:#000; border:1px solid var(--line); color:var(--ink);
              font:10px/1 var(--mono); letter-spacing:.1em; padding:6px 9px; cursor:pointer; }
  #folioTog:hover { background:rgba(233,240,242,.1); }
  /* 右栏：卷宗 */
  #folio { grid-area:folio; min-height:0; overflow-y:auto; background:#000;
           border-left:1px solid var(--line); padding:12px 12px 30px; }
  #folio .fcap { display:flex; align-items:baseline; gap:8px; margin-bottom:10px;
                 padding-bottom:7px; border-bottom:1px solid var(--line-dim); }
  #folio .fcap b { font:13px/1 var(--mono); letter-spacing:.3em; color:var(--ink); font-weight:700; }
  #folio .fcap span { font:8px/1 var(--mono); letter-spacing:.18em; color:var(--ink-dim); }
  .dcard { border:1px solid var(--line); background:#000; margin-bottom:9px; position:relative; }
  .dcard::after { content:""; position:absolute; top:3px; right:3px; width:5px; height:5px;
                  border-top:1px solid var(--line); border-right:1px solid var(--line); pointer-events:none; }
  .dtab { display:flex; align-items:center; gap:8px; width:100%; text-align:left; cursor:pointer;
          background:#000; border:0; border-bottom:1px solid var(--line-dim); color:var(--ink);
          font:10px/1 var(--mono); letter-spacing:.2em; font-weight:700; padding:8px 9px; }
  .dtab:hover { background:rgba(233,240,242,.07); }
  .dtab i { font-style:normal; color:var(--ink-dim); letter-spacing:.1em; }
  .dtab b { font-weight:700; }
  .dtab .n { margin-left:auto; font:9px/1 var(--mono); color:var(--ink-dim); letter-spacing:.08em; }
  .dcard.closed .din { display:none; }
  .dcard.closed .dtab { border-bottom:0; }
  .din { padding:8px 9px; font:11px/1.62 var(--mono); color:var(--ink); }
  .dline { display:flex; gap:8px; padding:4px 0; border-bottom:1px solid rgba(233,240,242,.07); }
  .dline:last-child { border-bottom:0; }
  .dline .k { color:var(--ink-dim); flex:none; }
  .dline .t { color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dline .v { margin-left:auto; color:var(--ink); font-weight:700; flex:none; }
  .dempty { color:var(--ink-dim); font:10px/1.6 var(--mono); letter-spacing:.04em; }
  .dact { margin-top:7px; display:flex; gap:6px; flex-wrap:wrap; }
  .dact button { background:#000; border:1px solid var(--line-dim); color:var(--ink);
                 font:10px/1 var(--mono); padding:5px 7px; cursor:pointer; }
  .dact button:hover { border-color:var(--ink); background:rgba(233,240,242,.08); }
  /* 过程：思考、工具、结果。会话栏只留最终回答，过程都在这里 */
  #tracebox .tr { border-left:2px solid var(--line-dim); padding:3px 0 3px 7px; margin:0 0 5px;
                  font:10px/1.55 var(--mono); color:var(--ink-dim); white-space:pre-wrap; word-break:break-word; }
  #tracebox .tr.think { border-left-color:var(--amber); color:#d8c79a; }
  #tracebox .tr.tool { border-left-color:var(--ink); color:var(--ink); }
  #tracebox .tr.res { border-left-color:rgba(127,209,139,.5); color:#a9c9a9; max-height:150px; overflow:auto; }
  #tracebox .tr.err { border-left-color:var(--red); color:#e6a0a0; }
  /* 历史消息里那份「这一轮的过程」：默认收起，点开回看 */
  /* 「步」：一段推理 + 它的动作。当前步展开，做完的折起来 */
  .trg { margin:0 0 6px; border-left:1px dashed var(--line-dim); padding-left:6px; }
  .trg > summary { cursor:pointer; font-size:10px; letter-spacing:.12em; color:var(--ink-dim);
    padding:1px 0 3px; list-style:none; }
  .trg > summary::-webkit-details-marker { display:none; }
  .trg > summary::before { content:'▸ '; }
  .trg[open] > summary::before { content:'▾ '; }
  .trg > summary:hover { color:var(--ink); }
  .histtrace { margin:6px 0 2px; }
  .histtrace summary { cursor:pointer; padding:2px 0; }
  .histtrace .tr { border-left:2px solid var(--line-dim); padding:3px 0 3px 7px; margin:0 0 5px; font-size:12px; line-height:1.6; white-space:pre-wrap; }
  .histtrace .tr.think { border-left-color:var(--amber); color:#d8c79a; }
  .histtrace .tr.res { border-left-color:rgba(127,209,139,.5); color:#a9c9a9; max-height:180px; overflow:auto; }
  .histtrace .tr.err { border-left-color:var(--red); color:#e6a0a0; }
  #tracebox .tr.who { font-size:9px; letter-spacing:.14em; color:var(--ink-dim); display:block; margin-bottom:2px; }
  .dchg { white-space:pre-wrap; word-break:break-all; font:10px/1.55 var(--mono);
          color:var(--ink-dim); max-height:200px; overflow:auto; margin:0; }
  .dbar { height:3px; background:rgba(233,240,242,.16); margin-top:5px; }
  .dbar i { display:block; height:100%; background:var(--ink); }
  /* 卷宗里的分区：从左栏搬过来，尺寸要收（这里是 330px 宽，不是 240px 的侧栏） */
  #dc-inbox .sec, #dc-ctx .sec { margin:0 0 8px; }
  #dc-inbox .sec h3, #dc-ctx .sec h3 { margin:0 0 4px; padding:2px 0 2px 6px; background:none;
    border:0; border-left:2px solid var(--line); font:9px/1.2 var(--mono); letter-spacing:.16em;
    color:var(--ink-dim); font-weight:700; }
  #dc-inbox .sec h3 .n, #dc-ctx .sec h3 .n { color:var(--ink-dim); font-weight:700; }
  #dc-inbox .hint, #dc-ctx .hint, #surfsec .hint { font:9px/1.5 var(--mono); color:var(--ink-dim); margin:3px 0; }
  #dc-inbox .pend, #dc-ctx .pend { border:1px solid var(--line-dim); background:#000; padding:6px 7px; margin:0 0 5px; }
  #dc-inbox .pend .cmd, #dc-ctx .pend .cmd { font:10px/1.4 var(--mono); color:var(--ink); word-break:break-all; }
  #dc-inbox .pend .dir, #dc-ctx .pend .dir { font:9px/1.4 var(--mono); color:var(--ink-dim); }
  #dc-inbox .pend .fp { font:9px/1.4 var(--mono); color:var(--ink-dim); }
  #dc-inbox .acts, #dc-ctx .acts { display:flex; gap:5px; flex-wrap:wrap; margin-top:5px; }
  #dc-inbox .acts button, #dc-ctx .acts button { font:9px/1 var(--mono); padding:4px 6px; background:#000;
    color:var(--ink); border:1px solid var(--line-dim); cursor:pointer; }
  #dc-inbox .acts button:hover, #dc-ctx .acts button:hover { border-color:var(--ink); }
  #dc-inbox .item, #dc-ctx .item { font:10px/1.45 var(--mono); padding:4px 6px; }
  #dc-inbox .item .m, #dc-ctx .item .m { font:9px/1.4 var(--mono); }
  #dc-inbox .dempty, #dc-ctx .dempty { margin:2px 0 0; }
  .addbox { margin:10px 0 4px; padding:8px 0 0; border-top:1px dashed var(--line-dim); }
  .addarea { width:100%; min-height:96px; resize:vertical; margin-top:6px;
             font:11px/1.5 var(--mono); padding:8px; }
  .hint.ok { color:var(--ok); }
  .hint.err { color:var(--red); }
  /* 文件面板 / git 校样 */
  .filerow { display:flex; gap:8px; align-items:center; margin:8px 0; flex-wrap:wrap; }
  .filerow button { font:10px/1 var(--mono); padding:6px 9px; background:#000; color:var(--ink);
                    border:1px solid var(--line-dim); cursor:pointer; }
  .filerow button:hover { border-color:var(--ink); }
  .filerow .searchbox { flex:1 1 220px; min-width:0; }
  .fhead { display:flex; gap:10px; align-items:center; margin:10px 0 6px;
           font:10px/1.4 var(--mono); color:var(--ink); border-bottom:1px solid var(--line-dim); padding-bottom:5px; }
  .fhead button { margin-left:auto; font:9px/1 var(--mono); padding:4px 7px; background:#000;
                  color:var(--ink-dim); border:1px solid var(--line-dim); cursor:pointer; }
  .fcode { max-height:52vh; overflow:auto; white-space:pre; font:11px/1.55 var(--mono); }
  .glines { margin:6px 0; }

  /* 能力屏：一行一个（名字在左、数在右），和入口行同一套语气 */
  .cap-h { margin:18px 0 6px; padding:2px 0 2px 8px; border-left:3px solid var(--ink);
           font:10px/1.3 var(--mono); letter-spacing:.18em; color:var(--ink); font-weight:700; }
  .capline { display:flex; align-items:baseline; gap:10px; padding:5px 0;
             border-bottom:1px solid rgba(233,240,242,.07); }
  .capline .k { font:12px/1.4 var(--mono); color:var(--ink); font-weight:700; }
  .capline .v { margin-left:auto; font:10px/1 var(--mono); color:var(--ink-dim); white-space:nowrap; }
  .capline.bad .k { color:var(--amber); }
  #capview .hint { font:11px/1.6 var(--mono); }

  /* 入口行（去处）：一行一个，名字在左、计数在右（flex 而不是靠 text-align） */
  #side .wingtop > .item, #side .wingtop > #foldtools { display:flex; align-items:baseline;
    justify-content:space-between; gap:8px; margin-bottom:3px; }
  #side .wingtop > .item .m, #side .wingtop > #foldtools .n { display:inline; flex:none;
    text-align:right; font:9px/1 var(--mono); color:var(--ink-dim); white-space:nowrap; }

  /* ── 收纳：两个边栏都能收成一条窄带，状态记在 localStorage ──────────
     收起来不是删掉：窄带上留一个能点开的把手，键盘 Tab 也够得着。 */
  /* 收纳只在宽屏成立：≤1180 时两个边栏本来就是抽屉，再叠一层「收起」只会互相打架
     （之前左栏一收，右栏卷宗跟着 display:none，点了也打不开 —— 就是这条的锅） */
  @media (min-width: 1181px) {
  body.wing-off { --rail:34px; }
  body.wing-off #side > *:not(#wingHandle) { display:none; }
  body.wing-off #side { padding:0; overflow:hidden; }
  body.wing-off #wingHandle { writing-mode:vertical-rl; letter-spacing:.4em; width:100%; height:100%;
                               display:flex; align-items:center; justify-content:flex-start;
                               padding:12px 0; border:0; background:#000; color:var(--ink);
                               font:10px/1 var(--mono); font-weight:700; cursor:pointer; }
  body.wing-off #wingHandle:hover { color:var(--fg); background:rgba(233,240,242,.08); }
  #wingTog { margin-left:auto; background:#000; border:1px solid var(--line-dim); color:var(--ink-dim);
             font:10px/1 var(--mono); padding:4px 6px; cursor:pointer; }
  #wingTog:hover { color:var(--ink); border-color:var(--ink); }
  body.folio-off #folio { display:none; }
  body.folio-off { --folio:0px; }
  body.folio-off #folioTog { display:inline-block; }
  #folioX { background:#000; border:1px solid var(--line-dim); color:var(--ink-dim); font:10px/1 var(--mono);
            padding:4px 7px; cursor:pointer; margin-left:auto; }
  #folioX:hover { color:var(--ink); border-color:var(--ink); }
  }   /* @media (min-width:1181px)：收纳规则结束 */
  /* 1181–1440px：卷宗变窄；≤1180px：卷宗收成抽屉（照它把 folio 抽出来的做法） */
  @media (max-width: 1440px) { :root { --folio:290px; --rail:220px; } }
  @media (max-width: 1366px) { .ro:nth-last-child(-n+2) { display:none; } }
  @media (max-width: 1180px) {
    body { grid-template-columns:var(--rail) 1fr;
           grid-template-areas:"head head" "readout readout" "side main"; }
    #folioTog { display:inline-block; }
    #folio { position:fixed; z-index:13; top:var(--head); bottom:0; right:0; width:min(88vw,360px);
             transform:translateX(102%); transition:.2s; box-shadow:-14px 0 30px rgba(0,0,0,.6); }
    body.folio-open #folio { transform:none; }
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
  .body { min-width:0; overflow-wrap:anywhere;
          background:rgba(13,31,34,.94); border:1px solid var(--line-dim);
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
  /* 首次配置：一屏一步，行高够点（手机上也是） */
  #su-steps .step { display:flex; gap:10px; align-items:flex-start; padding:10px; border:1px solid var(--line-dim); margin:6px 0; }
  #su-steps .step.now { border-color:var(--fg); }
  #su-steps .step.done { opacity:.55; }
  #su-steps .k { font:11px/1.4 var(--mono); color:var(--fg); font-weight:700; min-width:86px; }
  #su-steps .v { font:11px/1.6 var(--mono); color:var(--dim); }
  #su-steps .step.now .v { color:var(--fg); }
  /* 谁在说话：云端/本地 —— 只用白与灰，不加新颜色 */
  .who { font:9px/1 var(--mono); letter-spacing:.08em; border:1px solid var(--line); padding:2px 5px; margin-right:6px; }
  .who.cloud { color:var(--fg); border-color:var(--line); }
  .who.local { color:var(--dim); border-color:var(--line-dim); }
  #su-panel { margin-top:14px; border:1px solid var(--line); padding:12px; }
  #su-panel textarea { width:100%; min-height:64px; }
  #su-panel .q { margin:10px 0; }
  #su-panel .q label { display:block; font:11px/1.6 var(--mono); color:var(--fg); font-weight:700; margin-bottom:4px; }
  #su-draft { margin-top:10px; }
  #su-draft .draftline { display:flex; gap:8px; align-items:baseline; padding:4px 0;
                         border-bottom:1px solid var(--line-dim); }
  #su-draft .draftline .src { font:9px/1.4 var(--mono); padding:1px 4px; border:1px solid var(--line);
                              color:var(--dim); white-space:nowrap; flex:none; }
  #su-draft .draftline.mine .src { color:var(--fg); border-color:var(--fg); }
  /* 输入框必须在行内收缩：宽度写死会把长句切掉（截图里 "name: 未提供具体内容（仅出:"） */
  #su-draft .draftline input { flex:1 1 auto; min-width:0; width:auto; font:12px/1.5 var(--mono); }
  #su-draft .acts { margin-top:12px; }
  #su-panel .reply { white-space:pre-wrap; border-left:1px solid var(--line); padding-left:10px; margin:8px 0; }
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
  #modelpicker { position:fixed; left:0; right:0; top:0; bottom:0; z-index:60; background:rgba(0,0,0,.72);
    display:flex; align-items:flex-end; justify-content:center; padding:0 16px 88px; }
  #modelpicker .permbox { width:100%; max-width:520px; border:1px solid var(--line); background:#000; padding:14px 16px; }
  #modelpicker label { display:block; font:9px/1 var(--mono); letter-spacing:.16em; color:var(--dim); margin:10px 0 4px; }
  #modelpicker input, #modelpicker select { width:100%; background:#000; color:var(--fg); border:1px solid var(--line-dim); padding:8px 10px; font:12px/1.5 var(--mono); }
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
  /* 记忆的两个视图（2026-11-04）：断片记录占 92%，不能再让它排在「关于你」前面 */
  .memscope { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0 6px; }
  .memscope button { font:11px/1 var(--mono); letter-spacing:.06em; color:var(--dim);
                     background:transparent; border:1px solid var(--line-dim); padding:6px 9px; cursor:pointer; }
  .memscope button:hover { color:var(--ink); border-color:var(--ink); }
  .memscope button[aria-pressed="true"] { color:var(--ink); font-weight:700; border-color:var(--ink);
                                          box-shadow: inset 2px 0 0 var(--ink); }
  .memscope .n { opacity:.7; margin-left:5px; }
  /* 「关于你」的缺口卡：只在记忆屏、只在「关于你」视图里出现，不弹窗 */
  #gapcard { border:1px dashed var(--line-dim); padding:10px; margin:10px 0 4px; }
  #gapcard .gapq { font:12px/1.7 var(--mono); color:var(--ink-dim); margin-bottom:8px; }
  #gapcard .gapchips { display:flex; gap:6px; flex-wrap:wrap; }
  #gapcard .gapchips button { font:12px/1.2 var(--mono); color:var(--ink); background:transparent;
                              border:1px solid var(--line-dim); padding:7px 10px; cursor:pointer; }
  #gapcard .gapchips button:hover { border-color:var(--ink); }

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
  /* 两档模式（学 Coopanion 的 normal / advanced）：默认只留常用的，其余收在高级里 */
  body:not(.advanced) #side .item[data-adv] { display:none; }
  #idle-run { margin:8px 0 0; display:flex; align-items:center; justify-content:space-between; gap:6px;
    width:100%; font-size:11px; letter-spacing:.08em; padding:5px 8px;
    border:1px solid var(--line-dim); background:transparent; color:var(--ink-dim); cursor:pointer; }
  #idle-run:hover { color:var(--ink); border-color:var(--line); }
  #idle-run[disabled] { opacity:.55; cursor:default; }
  #idle-run .m { color:var(--ink-dim); font-size:10px; }
  #adv-toggle { margin:6px 0 0; font-size:11px; letter-spacing:.08em; padding:5px 8px;
    border:1px solid var(--line-dim); background:transparent; color:var(--ink-dim); cursor:pointer; width:100%; }
  #adv-toggle:hover { color:var(--ink); border-color:var(--line); }
  /* 状态灯（学自 Coopanion 的 rail lamps）：入口上直接亮一个点，不用点进去才知道哪里有事 */
  #side .item { position:relative; }
  #side .item .lamp { position:absolute; right:7px; top:50%; width:6px; height:6px; margin-top:-3px;
    border-radius:50%; display:none; }
  #side .item .lamp.on { display:block; }
  #side .item .lamp.warn { background:var(--amber); box-shadow:0 0 6px rgba(232,160,32,.55); }
  #side .item .lamp.wait { background:#8fd0ff; box-shadow:0 0 6px rgba(143,208,255,.55); }
  #side .item .lamp.bad  { background:var(--red); box-shadow:0 0 6px rgba(255,95,86,.6); }
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
<body>
<!--BOOT-->
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="whale" viewBox="0 0 512 512"><path fill="currentColor" d="M453.004 35.117c-65.314 46.61-189.755 41.018-213.559 125.426C184.41 101.41 98.625 83.031 21.771 63.209c6.532 139.103 71.38 147.437 192.44 194.547c23.71 25.786 29.786 49.93 19.254 82.705c46.403 5.1 71.504 15.468 106.754 27.742c-.708-71.67-25.14-108.928-75.518-175.035c11.058 4.233 44.979 37.02 56.578 58.607c109.419-42.421 147.64-112.074 131.725-216.658M180.178 353.9c-60.89-.24-114.034 19.49-158.426 74.221c167.075-48.84 292.003-13.21 471.893 7.895c-118.936-38.752-224.474-81.763-313.467-82.116m98.043 77.844c-99.28.255-206.34 18.738-256.866 63.139c168.002-26.61 356.801-28.408 470.8-4.967c1.102-35.337-101.418-58.46-213.934-58.172"/></symbol></svg>
<div class="frame"><i></i><i></i><i></i><i></i><b class="bl">LOCAL · 127.0.0.1</b><b class="br">MEMORY CORE</b></div>
<header>
  <span class="brand" aria-label="她" data-agent-aria><svg class="ico" role="img" aria-hidden="false"><use href="#whale" /></svg></span>
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
  <button id="wingHandle" type="button" title="展开左栏（Ctrl+B）" aria-label="展开左栏" hidden><span data-agent>鲸鲸</span></button>
  <div class="wingtop">
    <div class="wmark"><b><span data-agent>鲸鲸</span></b><span id="wingstate">…</span>
      <button id="wingTog" type="button" title="收起左栏（Ctrl+B）" aria-label="收起左栏">«</button></div>

    <div class="wsec">今 天</div>
    <div id="sesslist"></div>

    <div class="wsec">去 处</div>
    <button class="item" type="button" data-view="memlistview">记忆<span class="m" id="memcount">…</span><i class="lamp" id="lamp-mem"></i></button>
    <button class="item" type="button" data-view="docsview">文档<span class="m" id="doccount">…</span></button>
    <button class="item" type="button" data-view="auditview">动作<span class="m" id="actcount">…</span><i class="lamp" id="lamp-act"></i></button>
    <button class="item" type="button" data-view="capview">能力<span class="m" id="capcount">…</span><i class="lamp" id="lamp-cap"></i></button>
    <button class="item" type="button" data-view="filesview" data-adv>文件<span class="m" id="filecount">项目</span></button>
    <button class="item" type="button" id="foldtools">工具<span class="m" id="toolcount">…</span></button>
    <div id="toollist" hidden>
      <input id="toolq" class="searchbox" placeholder="筛工具名 / 说明…" autocomplete="off">
      <div id="toolrows"><button class="item on" data-view="chat">对话<span class="m">与<span data-agent>鲸鲸</span>说话</span></button></div>
      <button class="item dimmore" id="toolmore" data-adv hidden>显示全部</button>
    </div>
    <button class="item" type="button" data-view="cfg">设置<span class="m">接口 / 人格</span><i class="lamp" id="lamp-cfg"></i></button>
    <button type="button" id="idle-run" class="railbtn" title="读一遍最近的对话，提炼记忆与「她对你的理解」。跑几十秒，可以继续聊天">
      <span>闲时整理</span><span class="m" id="idle-when">…</span>
    </button>
    <button type="button" id="adv-toggle" aria-pressed="false">显示高级项</button>
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
  <div id="stagebar">
    <span class="stt" id="stTitle">对话</span>
    <span class="sts" id="stSub"></span>
    <span class="str"><span class="sts" id="stState"></span>
      <button id="folioTog" type="button" title="卷宗 · Plan / Changes / Context">◧ 卷宗</button>
    </span>
  </div>
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

    <div id="docsview" hidden>
      <div class="panelbox">
        <h2>文档 · DOCS</h2>
        <p class="hint" id="dv-listmeta">只在本机读取与检索；要让它把原文随简报发出去，打开那篇点「标为可发送」。</p>
        <div id="doclist"></div>
        <div class="ingest">
          <label class="ilab">加文档 · 只在本机读取，跟云端无关</label>
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
          <span id="dlg-msg" class="hint"></span>
          <div class="acts"><button id="dlg-go" class="primary">摄入到本机</button></div>
        </div>
      </div>
    </div>

    <div id="memlistview" hidden>
      <div class="panelbox">
        <h2>记忆 · MEMORY</h2>
        <p class="hint">按活跃度排；点一条看正文、出处与它的来历。</p>
        <input id="q" class="searchbox" placeholder="搜记忆 / 文档…（Ctrl+K 也能到这儿）" autocomplete="off">
        <div id="gapcard" hidden></div>
        <div class="memscope" id="memscope"></div>
        <div id="memlist"></div>
      </div>
    </div>

    <div id="filesview" hidden>
      <div class="panelbox">
        <h2>文件 · PROJECT</h2>
        <p class="hint">只读：两个根（<code>jingjing/</code> 代码 · <code>docs/</code> 设计文档）。
          <code>data/</code>、密钥、<code>.git</code> 一律拒 —— 这是 <code>project.read</code> 的白名单，不是前端过滤。</p>
        <div class="filerow">
          <input id="fq" class="searchbox" placeholder="按文件名筛…（如 recall / 22-）" autocomplete="off">
          <button id="froot" type="button">看项目根</button>
        </div>
        <div id="fcrumbs" class="hint"></div>
        <div id="flist"></div>
        <div id="fview" hidden>
          <div class="fhead"><span id="fpath"></span><button id="fclose" type="button">关闭</button></div>
          <pre class="code fcode" id="ftext"></pre>
        </div>
      </div>
    </div>

    <div id="gitview" hidden>
      <div class="panelbox">
        <h2>校样 · GIT</h2>
        <p class="hint">只读：只跑 <code>git status</code> / <code>git diff</code> / <code>git log</code>，
          参数写死在服务端（模型给不了 argv）。走的是同一条闸门，审计里能看到。</p>
        <div class="filerow">
          <button id="gs" class="primary" type="button">看改动</button>
          <button id="gst" type="button">stat 摘要</button>
          <button id="gl" type="button">最近提交</button>
          <span class="hint" id="gmsg"></span>
        </div>
        <div id="gfiles" class="glines"></div>
        <pre class="code fcode" id="gdiff"></pre>
      </div>
    </div>

    <div id="capview" hidden>
      <div class="panelbox">
        <h2>能力 · CAPABILITIES</h2>
        <p class="hint">它能借到的手脚分四类：<b>插件</b>（MCP server 提供的工具）、<b>技能</b>（SKILL.md，说明书）、
          <b>原生工具</b>（verbs，走同一条闸门）、<b>命令</b>（CLI）。降级项会明说是哪一项缺什么。</p>

        <h3 class="cap-h">插件 · MCP</h3>
        <div id="cap-mcp"></div>
        <div class="addbox">
          <div class="filerow">
            <input id="mcp-name" class="searchbox" placeholder="名字（小写，如 markitdown）" autocomplete="off">
            <input id="mcp-cmd" class="searchbox" placeholder="命令（如 ollama / D:/tools/x.exe）" autocomplete="off">
            <input id="mcp-args" class="searchbox" placeholder="参数（空格分隔，可空）" autocomplete="off">
            <button id="mcp-add" type="button">加插件</button>
          </div>
          <p class="hint" id="mcp-msg">装完要<b>重启面板</b>才生效 —— MCP 是启动时读的，这里不假装已经加载。</p>
        </div>

        <h3 class="cap-h">技能 · SKILL.md</h3>
        <p class="hint" id="cap-skills-dirs"></p>
        <div id="cap-skills"></div>
        <div class="addbox">
          <div class="filerow">
            <input id="sk-id" class="searchbox" placeholder="目录名（小写，如 weekly-recap）" autocomplete="off">
            <button id="sk-add" type="button">写一份</button>
          </div>
          <textarea id="sk-body" class="searchbox addarea" spellcheck="false"
            placeholder="---
name: 周末回顾
description: 周日晚上把这一周压成三句话。
---

# 步骤
1. …"></textarea>
          <p class="hint" id="sk-msg">写进 data/skills/&lt;名字&gt;/SKILL.md；下一轮对话它的名字就会进简报索引（正文按需取）。</p>
        </div>

        <h3 class="cap-h">原生工具 · VERBS</h3>
        <div id="cap-native"></div>

        <h3 class="cap-h">降级项</h3>
        <div id="cap-degraded"></div>
      </div>
    </div>

    <div id="auditview" hidden>
      <div class="panelbox">
        <h2>动作 · ACTIONS</h2>
        <p class="hint">来自 exec_audit：每一次能力调用（含被拒）都在这里。被拒的也留痕，这是"越权为零"能被验证的地方。</p>
        <p class="hint" id="av-meta"></p>
        <div id="auditlist"></div>
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
      <div class="panelbox" id="superbox">
        <h2>SUPER · 超级权限</h2>
        <p class="hint">开了它，<span data-agent>鲸鲸</span>就能<b>完全接管这台电脑</b>：改记忆库本体、改人格、删系统文件、关机、装软件、跑任意解释器。
          <b>只有你在这里能开</b> —— 对话里没有这条路，模型也碰不到。</p>
        <p class="hint">两条<b>永远不放开</b>：格式化磁盘（那会把机器弄没）、删 <code>trash/</code> 与 <code>snapshots/</code>（那是回滚的底）。</p>
        <div id="superstate" class="hint">…</div>
        <div id="superon" hidden>
          <label>为什么开（可选，会进审计）</label>
          <input id="superwhy" placeholder="想写就写一句，不写也行" autocomplete="off">
          <div class="acts"><button id="supergo" class="no">开启超级权限</button><span id="supermsg" class="hint"></span></div>
        </div>
        <div id="superoff" hidden>
          <div class="acts"><button id="superclose" class="primary">收回超级权限</button><span id="supermsg2" class="hint"></span></div>
        </div>
      </div>

      <div class="panelbox">
        <h2>AGENT · 她的名字</h2>
        <p class="hint">「鲸鲸」只是<b>预置人格</b>的名字，不是这个项目的名字（项目叫 Pseudo Digital Life Project）。
          你可以自己取一个 —— 面板、引导页、回执里都用它。</p>
        <div class="filerow">
          <input id="agentname" class="searchbox" maxlength="16" placeholder="给它取个名字（≤16 字）" autocomplete="off">
          <button id="agentsave" type="button">保存</button>
          <span id="agentmsg" class="hint"></span>
        </div>
      </div>

      <div class="panelbox">
        <h2>HOST · 命令解释器</h2>
        <p class="hint">她跑<b>脚本文件</b>（<code>.ps1</code> / <code>.sh</code> / <code>.mjs</code> / <code>.py</code>）时用哪个解释器。
          默认用系统自带的 <b>PowerShell 5.1</b>；Git Bash 要你自己给 <code>bash.exe</code> 的路径（安装位置五花八门）。</p>
        <p class="hint">注意：<b>任意命令不走这里</b>（那是 <code>shell.exec</code> 的 argv 直传，不经 shell 包装）。
          原因见 <code>src/host.ts</code> 头注释：一条 <code>-Command</code> 就能绕过所有闸门。</p>
        <div class="filerow">
          <select id="hostshell" class="searchbox"></select>
          <span id="hostnow" class="hint"></span>
        </div>
        <div class="filerow" id="hostbashrow" hidden>
          <input id="hostbash" class="searchbox" placeholder="Git Bash 的 bash.exe 绝对路径，如 C:/Program Files/Git/bin/bash.exe" autocomplete="off">
          <button id="hostsave" type="button">保存路径</button>
        </div>
        <p class="hint" id="hostmsg"></p>
      </div>

      <div class="panelbox">
        <h2>SHELL · 界面</h2>
        <p class="hint">两套界面共用同一份数据。<b>经典面板</b>是三列 + 卷宗；<b>记录本</b>按天翻页、页边带时间戳、
          右边是切口索引。<b>随时能切回来</b>：<code>/classic</code> 永远打开经典面板。</p>
        <div class="filerow">
          <select id="shellmode" class="searchbox">
            <option value="classic">经典面板（三列 / 卷宗）</option>
            <option value="notebook">记录本（按天 / 页边时间戳 / 切口索引）</option>
          </select>
          <a id="shellopen" class="hint" href="/classic" target="_blank" style="text-decoration:underline">打开看看</a>
          <span id="shellmsg" class="hint"></span>
        </div>
      </div>

      <div class="panelbox">
        <h2>SPLASH · 开机片头</h2>
        <p class="hint">每次打开软件先播的一段：黑底白线，先写出项目名，再把本机的真实读数一行行写进去。<b>点一下画面或按 Esc</b> 随时跳过。</p>
        <div class="filerow">
          <select id="splashmode" class="searchbox">
            <option value="full">完整 · 约 7 秒（遥测 / 终端 / 节点矩阵 + READY，数字都是真机实时值）</option>
            <option value="simple">简易 · 约 3.6 秒（只写项目名）</option>
            <option value="off">不播</option>
          </select>
          <span id="splashmsg" class="hint"></span>
        </div>
      </div>

      <div class="panelbox">
        <h2>SETUP · 重新过一遍引导</h2>
        <p class="hint">引导是<b>第一次打开软件时自动弹</b>的（/welcome）。要再看一遍装了什么、或者从头配一次，从这里进。</p>
        <div class="acts"><button type="button" id="gotoWelcome">打开引导页</button>
          <span class="hint" id="welcome-msg"></span></div>
      </div>

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
        <!-- 它现在在干什么：这一行之前完全不存在，用户原话「我根本就不知道它在干什么」 -->
        <p class="hint" id="m-live">…</p>
        <div id="m-nights"></div>
        <div class="two">
          <div><label>共享默认 · route / extract / salience / conflict</label><select id="m-default"></select></div>
          <div><label>闲时整理 · 自传与反思</label><select id="m-night"></select></div>
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
        <p class="hint" id="p-gen"></p>
      </div>

      <div class="panelbox">
        <h2>AVATAR · 头像</h2>
        <p class="hint">只收 png / jpeg / webp（会验文件头，不信声明的类型）；SVG 不收 —— 它能带脚本。</p>
        <div class="avav"><span class="av" id="pv-agent"><svg class="ico" aria-hidden="true"><use href="#whale" /></svg></span>
          <div><div class="hint"><span data-agent>鲸鲸</span></div>
            <div class="acts"><button type="button" id="up-agent">选图片</button><input type="file" id="f-agent" accept="image/png,image/jpeg,image/webp">
              <button type="button" id="rm-agent">恢复默认</button></div></div></div>
        <div class="avav"><span class="av" id="pv-user">U</span>
          <div><div class="hint">我</div>
            <div class="acts"><button type="button" id="up-user">选图片</button><input type="file" id="f-user" accept="image/png,image/jpeg,image/webp">
              <button type="button" id="rm-user">恢复默认</button></div></div></div>
        <span id="av-msg" class="hint"></span>
      </div>

    </div>
  </div></div>

  <div class="ticker" id="ticker"></div>
  <form id="composer"><div class="wrap">
    <button type="button" id="modechip" class="permchip" title="聊天 = 靠记忆（默认）；工作 = 带最近几轮上下文，适合连着干活">聊天</button>
    <textarea id="m" rows="1" placeholder="说点什么…"></textarea>
    <button id="stop" type="button" title="停止生成">■</button>
    <button class="send">▲</button>
  </div></form>
</main>

</main>

<!-- 右栏「卷宗」（结构照 Trianon 的 Dossier：Plan / Changes / Context 三张可折卡） -->
<aside id="folio" aria-label="卷宗">
  <div class="fcap"><b>卷 宗</b><span>DOSSIER</span><button id="folioX" type="button" title="收起卷宗（⌘/Ctrl+J）" aria-label="收起卷宗">»</button></div>

  <div class="dcard" data-card="trace">
    <button class="dtab" type="button"><i>·</i><b>过 程</b><span class="n" id="dc-trace-n"></span></button>
    <div class="din" id="dc-trace">
      <p class="dempty" id="dc-trace-empty">还没有动作。对话时它的思考和工具调用会出现在这里。</p>
      <div id="tracebox"></div>
    </div>
  </div>

  <div class="dcard" data-card="inbox">
    <button class="dtab" type="button"><i>0</i><b>等 你 点 头</b><span class="n" id="dc-inbox-n"></span></button>
    <div class="din" id="dc-inbox">
      <div class="sec" id="pendsec" data-sec="pend" hidden><h3>待确认</h3><div id="pendlist"></div></div>
      <div class="sec" id="propsec" data-sec="prop" hidden><h3><button type="button" data-tog="prop">它想做的 <span class="n" id="propcount"></span></button></h3><div id="proplist"></div></div>
      <div class="sec" id="egrsec" data-sec="egr" hidden><h3><button type="button" data-tog="egr">它想读代码 <span class="n" id="egrcount"></span></button></h3>
        <p class="hint">表达模型在云端时，读源码等于把代码发出去。默认拒；可以只批一次，或批一段时间。</p>
        <div id="egrlist"></div></div>
      <div class="sec" id="rcpsec" data-sec="rcp" hidden><h3><button type="button" data-tog="rcp">它做完的事 <span class="n" id="rcpcount"></span></button></h3>
        <p class="hint">点了「知道了」才算看见了 —— 三天没人看的，对应常驻指令会自动停用。</p>
        <div id="rcplist"></div></div>
      <div class="sec" id="threadsec" data-sec="thread" hidden><h3><button type="button" data-tog="thread">未闭合 <span class="n" id="threadcount"></span></button></h3>
        <p class="hint">它答应过、还没了结的事。办完了点一下；太久没动静的会标「拖了 N 天」。</p>
        <div id="threadlist"></div></div>
      <p class="dempty" id="dc-inbox-empty">没有等你点头的事。</p>
    </div>
  </div>

  <div class="dcard" data-card="plan">
    <button class="dtab" type="button"><i>I</i><b>计 划</b><span class="n" id="dc-plan-n"></span></button>
    <div class="din" id="dc-plan"><p class="dempty">…</p></div>
  </div>

  <div class="dcard" data-card="chg">
    <button class="dtab" type="button"><i>II</i><b>改 动</b><span class="n" id="dc-chg-n"></span></button>
    <div class="din" id="dc-chg"><p class="dempty">…</p></div>
    <div class="din" style="padding-top:0"><div class="dact">
      <button type="button" class="item" data-view="gitview" style="margin:0">看 git 校样</button>
    </div></div>
  </div>

  <div class="dcard" data-card="ctx">
    <button class="dtab" type="button"><i>III</i><b>上 下 文</b><span class="n" id="dc-ctx-n"></span></button>
    <div class="din"><div id="dc-ctx-stats"><p class="dempty">…</p></div>
      <div class="sec" id="surfsec" data-sec="surf" hidden><h3><button type="button" data-tog="surf">抽检 <span class="n" id="surfcount"></span></button></h3>
        <p class="hint">这几根线是它自己连的，最没把握的排前面。判错了就点「不对」，当场断。</p>
        <div id="surflist"></div></div>
    </div>
  </div>
</aside>

<div id="modelpicker" hidden role="dialog" aria-modal="true" aria-label="换模型">
  <div class="permbox">
    <p class="hint">换的是<b>表达模型</b>（回答你用的那个）。本地模型只管记忆整理，不参与对话。</p>
    <label>provider</label>
    <select id="mp-prov"><option value="deepseek">deepseek</option><option value="anthropic">anthropic</option><option value="openai">openai</option></select>
    <label>model</label>
    <input id="mp-model" placeholder="deepseek-flash" autocomplete="off">
    <div class="acts"><button id="mp-save" class="primary">保存</button><button id="mp-close">关闭</button><span id="mp-msg" class="hint"></span></div>
  </div>
</div>

<script>
window.SOURCES_DIR = null;   // 服务端会把它替换成 data/sources 的绝对路径（点“摄入”的人才知道文件该放哪）
const $ = (s) => document.querySelector(s);
const NL2 = String.fromCharCode(10, 10);
// 标签页标题：待确认闪烁时也要闪回这个名字
const TITLE = 'Pseudo Digital Life Project';
// 她叫什么：默认是**预置人格**的名字（鲸鲸），用户可以在设置里改成自己的。
// 项目名（Pseudo Digital Life Project）与她无关 —— exe 的 productName 用的是项目名。
var AGENT = (typeof window !== 'undefined' && window.AGENT_NAME) ? window.AGENT_NAME : '鲸鲸';
function applyAgentName() {
  document.querySelectorAll('[data-agent]').forEach(function (el) { el.textContent = AGENT; });
  document.querySelectorAll('[data-agent-aria]').forEach(function (el) { el.setAttribute('aria-label', AGENT); });
  document.title = TITLE;
}
// 占位符按屏宽给：手机上长提示会换行顶出输入框（截图抓到的）
var mEl = document.getElementById("m");
if (mEl) mEl.placeholder = innerWidth > 560 ? "说点什么…（Enter 发送 · Shift+Enter 换行）" : "说点什么…";
const H = { "x-jj": "1", "content-type": "application/json" };
const WHALE = "<svg class='ico' aria-hidden='true'><use href='#whale' /></svg>";
let view = "chat", TOOLS = [], MEMS = [];
let sideActive = null;   // 侧栏里最后点的那一项（文档/工具/记忆/日期都是多选一）


var chatScroll = 0;   // 切走前记下对话滚到哪了
const VIEWNAME = { chat: "对话 · CHAT", cfg: "设置 · CONFIG", toolview: "工具 · TOOL",
  memview: "记忆 · MEMORY", memlistview: "记忆 · MEMORY", docview: "文档 · DOC", capview: "能力 · CAPABILITIES",
  filesview: "文件 · PROJECT", gitview: "校样 · GIT",
  docsview: "文档 · DOCS", auditview: "动作 · ACTIONS",
  searchview: "搜索 · SEARCH", propview: "它想做的一件事" };
function show(v, opts) {
  // 切走时把滚动位置存下来：隐藏 #chat 会让 #scroll 的 scrollHeight 塌成 0，浏览器会把 scrollTop 归零
  if (view === "chat" && v !== "chat") chatScroll = $("#scroll").scrollTop;
  view = v;
  document.body.dataset.view = v;   // CSS 用它把「回到最新」锁在对话里
  for (const id of ["chat", "cfg", "toolview", "memview", "memlistview", "docview", "docsview", "auditview", "capview", "filesview", "gitview", "searchview", "propview"]) $("#" + id).hidden = id !== v;
  $("#composer").style.display = v === "chat" ? "" : "none";
  // "回到最新"是对话专用的，别的界面不该出现
  if (v !== "chat") $("#jump").classList.remove("on");
  if (v === "chat") {
    requestAnimationFrame(function () {
      const el = $("#scroll");
      // 点「现在」= 回到最新（2026-11-04）。这条必须**先于**位置恢复判：
      // 以前它走的是"恢复离开前的位置"，于是"现在"有时候并不在最新 ——
      // 而且看起来像偶发（取决于上次离开时是不是贴底）。ui:test 红过一次。
      if (opts && opts.latest) { el.scrollTop = el.scrollHeight; chatScroll = 0; return; }
      // 指定了哪一天就滚到那一天（这是唯一决定滚动位置的地方）
      if (opts && opts.day) {
        const target = [...document.querySelectorAll("#chat .day")].find(function (e) {
          return e.textContent.startsWith(opts.day);
        });
        if (target) {
          el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
          return;
        }
      }
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
  // 点了某一天：只亮那一天，别再顺手把「现在」点亮（两个都亮等于没有高亮）
  const dayItem = sideActive && sideActive.isConnected && sideActive.dataset.day ? sideActive : null;
  for (const b of document.querySelectorAll("#side .item")) {
    const on = navOnly(b) && b.dataset.view === v && !(dayItem && b.dataset.view === "chat" && !b.dataset.day);
    b.classList.toggle("on", on);
  }
  if (sideActive && sideActive.isConnected && !navOnly(sideActive) && sideActive.dataset.view === v) {
    sideActive.classList.add("on");
  }
  // 标题条（照 Trianon 的 stage 顶部）：当前在哪一屏，别让人靠猜
  const st = $("#stTitle"); if (st) st.textContent = VIEWNAME[v] || v;
  const sub = $("#stSub"); if (sub) sub.textContent = v === "chat" ? "本地 · 记忆库" : "";
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
  var stTxt = s.state?.text ? " · " + s.state.text : "";
  $("#statetext").textContent = stTxt;
  var ws = $("#wingstate"); if (ws) ws.textContent = s.state?.text ? s.state.text : "…";
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
    // E-6 第二步：energy 的唯一恢复点在闲时整理；它没跑就得说清，否则只能看着数字掉
    var nrc = document.querySelector(".ro-w");
    if (nrc) {
      nrc.title = s.nightlySkipped
        ? "energy 只在闲时整理后恢复 —— 现在夜间未运行（" + String(s.nightlySkipped).slice(11, 19) + " · 缺模型）"
        : "energy：每轮对话 -2%，闲时整理 +25%";
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
  // 2026-11-01：工具卡不再进会话栏（历史里也不进）—— 会话栏只留回答；
  // 想看历史调用去了，走左栏「动作」（exec_audit 是全量账）。
  const tools = "";
  const recall = isUser ? "" : recallHtml(b.cites || [], b.omitted || 0, b.omittedDocs || 0);
  const resend = isUser ? " <span class='hintacts'><button class='resend'>重发</button></span>" : "";
  return "<div class='row " + b.role + "'><div class='av'>" + avHtml(isUser) + "</div><div>" +
    "<div class='meta'>" + (isUser ? "USER · " : "") + clock(b.ts) + resend + "</div>" +
    recall + (isUser ? "" : toolsNote(b)) +
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
  loadProposals(); loadSurfaceReview(); loadThreads(); loadReceipts(); loadStanding(); loadPermission(); loadEgress(); loadCapPage();
  paintLamps();
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
  // 左栏的「动作」只是一行入口 + 计数；列表本体在 openAudit() 里渲染。
  var rows = [], total = 0;
  try { var j = await (await fetch('/api/audit?limit=1')).json(); total = j.total || (j.rows || []).length; } catch (e) { return; }
  var ac = $('#actcount'); if (ac) ac.textContent = total + ' 条';
}
async function openAudit() {
  show("auditview");
  var rows = [], total = 0;
  try { var j2 = await (await fetch("/api/audit?limit=80")).json(); rows = j2.rows || []; total = j2.total || rows.length; } catch (e) { rows = []; }
  var am = $("#av-meta"); if (am) am.textContent = "exec_audit 共 " + total + " 条 · 下面显示最近 " + rows.length + " 条（含被拒绝的）";
  $("#auditlist").innerHTML = (rows || []).map(function (r) {
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
  { id: "search", label: "搜记忆 / 文档…", key: "动作", run: function () { show("memlistview"); memories(); setTimeout(function () { var el = $("#q"); if (el) el.focus(); }, 300); } },
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
// 记忆的两个视图（2026-11-04）：默认「关于你」。
// 起因：active 209 条里 193 条是「进程被杀 N 分钟」，记忆屏打开就是这些，
// 人看不到她到底记住了自己什么。数据不动（D-J），只做视图分流。
var MEMSCOPE = "about";   // about | all | outage
function paintMemScope(sum, count) {
  var el = $("#memscope"); if (!el) return;
  var chip = function (scope, label, n) {
    return "<button type='button' data-scope='" + scope + "' aria-pressed='" + (MEMSCOPE === scope) + "'>" +
      label + "<span class='n'>" + (n == null ? "" : n) + "</span></button>";
  };
  el.innerHTML = chip("about", "关于你" + (sum.about7d ? " +" + sum.about7d : ""), sum.about) +
    chip("all", "全部", sum.total) +
    (sum.outage ? chip("outage", "断片", sum.outage) : "");
  Array.prototype.forEach.call(el.querySelectorAll("button"), function (b) {
    b.onclick = function () { MEMSCOPE = b.dataset.scope; memories(); };
  });
  var mc = $("#memcount"); if (mc) mc.textContent = (count == null ? sum.total : count) + " 条";
}
async function memories(limit) {
  var lim = limit || MEMPAGE;
  var sum = { total: 0, about: 0, outage: 0 };
  try { sum = await (await fetch("/api/memories/summary")).json(); } catch (e) { /* 老服务没有这个接口就算了 */ }
  // 第一次进来才自动选：没有「关于你」的记忆就退回全部（新库/全断片时不至于空屏）
  if (!limit && MEMSCOPE === "about" && !sum.about) MEMSCOPE = "all";
  const rows = await (await fetch("/api/memories?scope=" + MEMSCOPE + "&limit=" + lim)).json();
  MEMS = rows;
  MEMPAGE = lim;
  paintMemScope(sum, MEMSCOPE === "all" ? sum.total : (MEMSCOPE === "about" ? sum.about : sum.outage));
  loadGaps();
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

// ── 「关于你」的缺口（2026-11-04）─────────────────────────────
// 夜里抽不出「她几点睡」这种事实（语料九成是工作日志）。那就直接问，
// 一次问三句，答一句落一条 contract。不弹窗：只在她主动看记忆屏时出现在顶部。
var GAPS = [];
async function loadGaps() {
  var el = $("#gapcard"); if (!el) return;
  var j = {};
  try { j = await (await fetch("/api/profile/gaps")).json(); } catch (e) { return; }
  GAPS = (j && j.gaps) || [];
  // 断片视图里不问（那是"翻旧账"的地方）；「全部」和新库都问 ——
  // 尤其在库里还没有「关于你」的记忆时，这张卡才是这屏唯一有用的东西。
  if (!GAPS.length || MEMSCOPE === "outage") { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = "<div class='gapq'>还有 " + GAPS.length + " 件关于你的事我不知道。答一句我就记下（不想说就跳过）：</div>" +
    "<div class='gapchips'>" + GAPS.map(function (g, i) {
      return "<button type='button' data-gap='" + i + "'>" + escapeHtml(g.question) + "</button>";
    }).join("") + "</div>";
  Array.prototype.forEach.call(el.querySelectorAll("button[data-gap]"), function (b) {
    b.onclick = function () { askGap(GAPS[Number(b.dataset.gap)]); };
  });
}
function askGap(g) {
  if (!g) return;
  var el = $("#gapcard");
  el.innerHTML = "<div class='gapq'>" + escapeHtml(g.question) + "</div>" +
    "<div class='gapchips'><input id='gapinput' class='searchbox' placeholder='写一句就行（Esc 放弃）' autocomplete='off'>" +
    "<button type='button' id='gapsave'>记住</button></div>";
  var inp = $("#gapinput"); if (inp) inp.focus();
  var save = async function () {
    var text = inp ? inp.value.trim() : "";
    if (!text) return;
    var j = {};
    try {
      j = await (await fetch("/api/profile/answer", { method: "POST", headers: H, body: JSON.stringify({ key: g.key, text: text }) })).json();
    } catch (e) { j = {}; }
    if (j && j.ok) pushTicker("记住了：" + g.key);
    else pushTicker("没记上：" + ((j && j.why) || "未知原因"));
    loadGaps(); memories();
  };
  var btn = $("#gapsave"); if (btn) btn.onclick = save;
  if (inp) inp.onkeydown = function (e) { if (e.key === "Enter") save(); if (e.key === "Escape") loadGaps(); };
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
// ── 状态灯：每个入口上一个小点，说清「这页有没有事」──
// 学自 Coopanion 的 rail lamps。之前这些信息只存在于各自页面里，不点进去就看不见。
function setLamp(id, kind) {
  var el = document.getElementById(id);
  if (!el) return;
  el.className = 'lamp' + (kind ? ' on ' + kind : '');
}
async function paintLamps() {
  // 动作：有提议等你点头 / 有工具被拒
  try {
    var pr = await (await fetch('/api/proposals?status=open')).json();
    var n = Array.isArray(pr) ? pr.length : 0;
    setLamp('lamp-act', n ? 'wait' : '');
  } catch (e) { setLamp('lamp-act', ''); }
  // 能力：有降级项（插件连不上 / 索引不全 / 厂商冷却）
  try {
    var cap = await (await fetch('/api/capabilities')).json();
    var deg = (cap && cap.degraded) || [];
    setLamp('lamp-cap', deg.length ? 'bad' : '');
  } catch (e) { setLamp('lamp-cap', 'warn'); }
  // 记忆：有跨层冲突等你判
  try {
    var cf = await (await fetch('/api/surface/review')).json();
    var open = Array.isArray(cf) ? cf.length : 0;
    setLamp('lamp-mem', open ? 'warn' : '');
  } catch (e) { setLamp('lamp-mem', ''); }
  // 设置：本地模型离线 / 没有可用 key
  try {
    var h = await (await fetch('/health')).json();
    var bad = [];
    if (h && h.local && h.local.online === false) bad.push('local');
    if (h && (h.degraded || []).some(function (d) { return d.indexOf('embed-index') === 0; })) bad.push('vec');
    setLamp('lamp-cfg', bad.length ? 'warn' : '');
  } catch (e) { setLamp('lamp-cfg', 'warn'); }
}
document.addEventListener('visibilitychange', function () { if (!document.hidden) paintLamps(); });
setInterval(function () { if (!document.hidden) paintLamps(); }, 20000);

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

// ── 首次配置（H-4）：可暂停、可终止，终止先给预览 ────────
// ── 分代（H-5）：显示当前第几代，并说清"改动只向前生效" ──
// ── 文件面板：只读浏览项目两个根（白名单在服务端 project.read/list）──
var TREE = [], FCUR = "", FSEEN = 40;
async function loadTree(dir) {
  var j;
  try { j = await (await fetch("/api/project/tree?dir=" + encodeURIComponent(dir))).json(); } catch (e) { return; }
  var box = document.getElementById("flist");
  if (!j.ok) { box.innerHTML = '<p class="hint err">' + escapeHtml(j.error || '读不了这个目录') + '</p>'; return; }
  TREE = j.entries || []; FCUR = dir || ""; FSEEN = 40;
  var crumbs = document.getElementById("fcrumbs");
  if (crumbs) {
    crumbs.innerHTML = FCUR ? ("位置：<b>" + escapeHtml(FCUR) + "</b>") : "位置：项目根（jingjing/ 与 docs/）";
  }
  paintTree();
}
function paintTree() {
  var q = (document.getElementById("fq") || {}).value || "";
  q = q.trim().toLowerCase();
  var rows = TREE.filter(function (e) { return !q || e.path.toLowerCase().indexOf(q) >= 0; });
  var box = document.getElementById("flist");
  if (!rows.length) { box.innerHTML = '<p class="hint">没有匹配的文件。</p>'; return; }
  var shown = rows.slice(0, FSEEN);
  var html = shown.map(function (e) {
    var isDir = e.type === "dir";
    return '<button class="item" data-fpath="' + escapeHtml(e.path) + '" data-ftype="' + (isDir ? 'dir' : 'file') + '">' +
      escapeHtml(e.path.replace(FCUR ? FCUR + "/" : "", "")) +
      '<span class="m">' + (isDir ? '目录' : Math.max(1, Math.round((e.bytes || 0) / 1024)) + 'KB') + '</span></button>';
  }).join("");
  if (rows.length > shown.length) {
    html += '<button class="item dimmore" id="fmore">显示更多（' + shown.length + ' / ' + rows.length + '）</button>';
  }
  box.innerHTML = html;
  var more = document.getElementById("fmore");
  if (more) more.onclick = function () { FSEEN += 40; paintTree(); };
}
async function openFile(path) {
  var j;
  try { j = await (await fetch("/api/project/file?path=" + encodeURIComponent(path))).json(); } catch (e) { return; }
  var box = document.getElementById("fview");
  var head = document.getElementById("fpath");
  var pre = document.getElementById("ftext");
  if (!j.ok) {
    box.hidden = false; head.textContent = path; pre.textContent = j.error || "读不了"; return;
  }
  box.hidden = false;
  head.textContent = j.path;
  pre.textContent = j.text || "（空文件）";
  pre.scrollTop = 0;
}
// ── git 校样：只读（status / diff / log）────────────────────────
async function loadGit(what, path) {
  var msg = document.getElementById("gmsg");
  if (msg) msg.textContent = "…";
  var url = "/api/git?what=" + encodeURIComponent(what) + (path ? "&path=" + encodeURIComponent(path) : "");
  var j;
  try { j = await (await fetch(url)).json(); } catch (e) { if (msg) msg.textContent = "网络错误"; return; }
  var pre = document.getElementById("gdiff");
  var lines = document.getElementById("gfiles");
  var head = "";
  if (!j.ok) {
    if (msg) msg.textContent = j.code || "失败";
    pre.textContent = j.output || "";
    lines.innerHTML = "";
    return;
  }
  if (what === "status") {
    // status 的输出第一行是摘要，剩下每行一个文件；把文件行做成可点的（点了看这个文件的 diff）
    var all = String(j.output || "").split(String.fromCharCode(10));
    head = all.shift() || "";
    if (msg) msg.textContent = head;
    lines.innerHTML = all.filter(Boolean).map(function (ln) {
      var p = ln.slice(3).trim();
      return '<button class="item" data-gpath="' + escapeHtml(p) + '"><span class="preview">' +
        escapeHtml(ln.slice(0, 2).trim() || '??') + '  ' + escapeHtml(p) + '</span></button>';
    }).join("");
    pre.textContent = "";
    return;
  }
  lines.innerHTML = "";
  if (msg) msg.textContent = what === "log" ? "最近提交" : "差异";
  pre.textContent = j.output || "（没有内容）";
  pre.scrollTop = 0;
}

// 她的名字：读 /api/config 的 agent.name，保存时写回去并立刻套用到页面
(function () {
  var inp = document.getElementById('agentname');
  var btn = document.getElementById('agentsave');
  if (!inp || !btn) return;
  inp.value = AGENT;
  btn.onclick = async function () {
    var msg = document.getElementById('agentmsg');
    var name = inp.value.trim();
    if (!name) { msg.className = 'hint err'; msg.textContent = '不能是空的'; return; }
    var j = await (await fetch('/api/config', { method: 'PUT', headers: H, body: JSON.stringify({ agent: { name: name } }) })).json();
    if (!j || !j.ok) { msg.className = 'hint err'; msg.textContent = (j && (j.why || j.error)) || '保存失败'; return; }
    AGENT = name;
    applyAgentName();
    msg.className = 'hint ok'; msg.textContent = '已改名叫 ' + name;
  };
})();

// 引导页是首启自动弹的；这里给一个手动入口（排障 / 重来）
(function () {
  var b = document.getElementById('gotoWelcome');
  if (b) b.onclick = function () { location.href = '/welcome'; };
})();

// ── 过程（右栏）：思考与工具调用都在这里，会话栏只留最终回答 ──────
// 对话正文只留最终回答：按步收集，被判为「过程」的那几步整段剔除。

// 用户 2026-11-01：会话栏只有结果；思考和调用工具的行为移到侧边栏。
//
// 2026-11-03 修：右栏 tracebox 每轮开始时清空，于是历史里那句「过程见右栏」指向一片空白 ——
// 用户原话「一轮对话完成后，直接把上一轮的对话进程覆盖了」。
// 现在每轮的过程随消息一起落盘（payload.trace），这里做成**可点开**：点一下回看那一轮怎么想的。
// 把平铺的 trace 分成「步」：一段推理 + 它之后的工具调用与结果 = 一步。
// 判据与 agent 那边一致：think 出现且当前步已经动过手 → 开新的一步。
function groupTrace(tr) {
  var steps = [];
  var cur = { think: '', items: [] };
  (tr || []).forEach(function (x) {
    var k = x.k || 'think';
    if (k === 'think') {
      if (cur.items.length) { steps.push(cur); cur = { think: x.t || '', items: [] }; return; }
      cur.think = (cur.think ? cur.think + String.fromCharCode(10) : '') + String(x.t || '');
      return;
    }
    cur.items.push(x);
  });
  if (cur.think || cur.items.length) steps.push(cur);
  return steps;
}

function traceItemHtml(x) {
  var cls = x.k === 'err' ? 'err' : x.k === 'res' ? 'res' : 'tool';
  var who = x.k === 'tool' ? '工具' : x.k === 'res' ? '结果' : '错误';
  return '<div class="tr ' + cls + '"><span class="who">' + escapeHtml(who) +
    (x.ms != null ? ' · ' + x.ms + 'ms' : '') + '</span>' + escapeHtml(String(x.t || '').slice(0, 800)) + '</div>';
}

function toolsNote(b) {
  const tr = b.trace || [];
  const n = (b.tools || []).length;
  if (!tr.length) return n ? '<div class="hint" data-note>' + n + ' 次工具调用</div>' : '';
  var steps = groupTrace(tr);
  var body = steps.map(function (st, i) {
    var head = '第 ' + (i + 1) + ' 步' + (st.items.length ? ' · ' + st.items.length + ' 次动作' : '');
    return '<details class="trg"><summary>' + escapeHtml(head) + '</summary>' +
      (st.think ? '<div class="tr think"><span class="who">她在想</span>' + escapeHtml(st.think.slice(0, 800)) + '</div>' : '') +
      st.items.map(traceItemHtml).join('') + '</details>';
  }).join('');
  return '<details class="histtrace"><summary class="hint">这一轮的过程（' + steps.length + ' 步' + (n ? ' · ' + n + ' 次工具调用' : '') + '）</summary>' + body + '</details>';
}

var trCur = null;   // 当前这一步的容器
var trNo = 0;       // 第几步

function traceStart() {
  var box = document.getElementById('tracebox');
  if (!box) return;
  box.innerHTML = '';
  trCur = null; trNo = 0;
  // 「还没有动作」这句不要提前藏起来：这一轮如果她没调工具，右栏就应该是这句话，
  // 而不是一片空白（用户原话：「现在过程看不见了」）。真有内容时再藏。
  var empty = document.getElementById('dc-trace-empty');
  if (empty) empty.hidden = false;
  var n = document.getElementById('dc-trace-n');
  if (n) n.textContent = '';
}
/** 保证有一个「当前步」容器；刚开新的一定展开，上一步收起来 */
function traceStep() {
  var box = document.getElementById('tracebox');
  if (!box) return null;
  var empty = document.getElementById('dc-trace-empty');
  if (empty) empty.hidden = true;      // 真有动作了，才把提示收起
  if (trCur) return trCur;
  var prev = box.querySelector('details.trg[open]');
  if (prev) prev.removeAttribute('open');
  trNo += 1;
  var d = document.createElement('details');
  d.className = 'trg';
  d.open = true;
  var sum = document.createElement('summary');
  sum.textContent = '第 ' + trNo + ' 步';
  var body = document.createElement('div');
  d.appendChild(sum); d.appendChild(body);
  box.appendChild(d);
  trCur = { el: d, body: body, sum: sum, acts: 0 };
  return trCur;
}
function traceStepCount() {
  if (!trCur) return;
  trCur.sum.textContent = '第 ' + trNo + ' 步' + (trCur.acts ? ' · ' + trCur.acts + ' 次动作' : '');
}

function traceAdd(kind, who, text) {
  var box = document.getElementById('tracebox');
  if (!box) return;
  // 一段推理，但当前这步已经动过手 → 是下一轮了，开新的一步
  if (kind === 'think' && trCur && trCur.acts > 0) { trCur = null; }
  var st = traceStep();
  if (!st) return;
  var el = document.createElement('div');
  el.className = 'tr ' + kind;
  if (who) { var w = document.createElement('span'); w.className = 'who'; w.textContent = who; el.appendChild(w); }
  el.appendChild(document.createTextNode(String(text == null ? '' : text)));
  st.body.appendChild(el);
  var panel = document.getElementById('dc-trace');
  if (panel) panel.scrollTop = panel.scrollHeight;
  var n = document.getElementById('dc-trace-n');
  if (n) n.textContent = trNo + ' 步';
}
// 工具卡：一次调用两段（调用 + 结果），结果回来时补到同一行
function traceTool(name, args, result, ms) {
  var box = document.getElementById('tracebox');
  if (!box) return null;
  var st = traceStep();
  if (!st) return null;
  st.acts += 1;
  traceStepCount();
  var el = document.createElement('div');
  el.className = 'tr tool';
  var w = document.createElement('span'); w.className = 'who';
  w.textContent = '工具 · ' + name + (ms != null ? ' · ' + ms + 'ms' : '');
  el.appendChild(w);
  el.appendChild(document.createTextNode(String(args || '')));
  st.body.appendChild(el);
  var n = document.getElementById('dc-trace-n');
  if (n) n.textContent = trNo + ' 步';
  if (result != null) traceAdd('res', '结果', String(result).slice(0, 1200));
  return el;
}

// ── 界面壳（ui.shell：classic / notebook，2026-11-05）──
// 两套界面共用同一份数据；这一行只决定「下次打开 / 出哪套」。
// 回退永远可用：/classic 直接开经典面板，不依赖这个配置。
async function loadShell() {
  var sel = document.getElementById('shellmode');
  if (!sel) return;
  var u = {};
  try { u = await (await fetch('/api/ui')).json(); } catch (e) { return; }
  sel.value = u.shell === 'notebook' ? 'notebook' : 'classic';
  var open = document.getElementById('shellopen');
  if (open) open.setAttribute('href', sel.value === 'notebook' ? '/?shell=notebook' : '/classic');
  sel.onchange = async function () {
    var msg = document.getElementById('shellmsg');
    var r = await (await fetch('/api/ui', { method: 'PUT', headers: H,
      body: JSON.stringify({ shell: sel.value }) })).json();
    msg.className = r.ok ? 'hint ok' : 'hint err';
    msg.textContent = r.ok ? '已保存（下次打开生效）' : (r.error || '保存失败');
    if (r.ok && open) open.setAttribute('href', sel.value === 'notebook' ? '/?shell=notebook' : '/classic');
  };
}

// ── 开机片头档位（ui.splash：off / simple / full）──
async function loadSplash() {
  var sel = document.getElementById('splashmode');
  if (!sel) return;
  var u = {};
  try { u = await (await fetch('/api/ui')).json(); } catch (e) { return; }
  sel.value = u.splash || 'full';
  sel.onchange = async function () {
    var msg = document.getElementById('splashmsg');
    var r = await (await fetch('/api/ui', { method: 'PUT', headers: H,
      body: JSON.stringify({ splash: sel.value }) })).json();
    msg.className = r.ok ? 'hint ok' : 'hint err';
    msg.textContent = r.ok ? '已保存（下次打开软件生效）' : (r.error || '保存失败');
  };
}

// ── 命令解释器（host）：默认 PowerShell；Git Bash 让用户自己填路径 ──
async function loadHost() {
  var h;
  try { h = await (await fetch('/api/host')).json(); } catch (e) { return; }
  var sel = document.getElementById('hostshell');
  if (!sel) return;
  var opts = [{ kind: 'auto', label: '自动（推荐：系统自带 PowerShell）' }].concat(h.available || []);
  sel.innerHTML = opts.map(function (o) {
    return '<option value="' + escapeHtml(o.kind) + '"' + (o.kind === h.wanted ? ' selected' : '') + '>' +
      escapeHtml(o.label + (o.path ? ' · ' + o.path : '')) + '</option>';
  }).join('');
  var now = document.getElementById('hostnow');
  if (now) {
    now.textContent = '现在用：' + (h.active.profile || h.active.kind) +
      (h.fellBack ? '（' + (h.reason || '回退了') + '）' : '');
  }
  var row = document.getElementById('hostbashrow');
  var inp = document.getElementById('hostbash');
  if (row) row.hidden = h.wanted !== 'gitbash';
  if (inp && h.gitbashPath) inp.value = h.gitbashPath;
  sel.onchange = async function () {
    var msg = document.getElementById('hostmsg');
    var r = await (await fetch('/api/host', { method: 'PUT', headers: H,
      body: JSON.stringify({ shell: sel.value }) })).json();
    msg.className = r.ok ? 'hint ok' : 'hint err';
    msg.textContent = r.ok ? '已保存' : (r.why || r.error || '保存失败');
    await loadHost();
  };
}
(function () {
  var save = document.getElementById('hostsave');
  if (!save) return;
  save.onclick = async function () {
    var msg = document.getElementById('hostmsg');
    var p = document.getElementById('hostbash').value.trim();
    var r = await (await fetch('/api/host', { method: 'PUT', headers: H,
      body: JSON.stringify({ shell: 'gitbash', gitbashPath: p }) })).json();
    msg.className = r.ok ? 'hint ok' : 'hint err';
    msg.textContent = r.ok ? '已保存' : (r.why || r.error || '保存失败');
    await loadHost();
  };
})();

// ── 换模型（卷宗里那一行的入口）：只改 express 的 provider/model ──
(function () {
  var box = document.getElementById('modelpicker');
  if (!box) return;
  function openPicker() {
    var cfg = { provider: 'deepseek', model: '' };
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (j) {
      var p = document.getElementById('mp-prov'), m = document.getElementById('mp-model');
      if (j && j.provider) p.value = j.provider;
      if (j && j.model) m.value = j.model;
      box.hidden = false;
      m.focus();
    }).catch(function () { box.hidden = false; });
  }
  // 用事件委托：卷宗每 20 秒会重画，按钮会被换掉
  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'modelpick') openPicker();
  });
  document.getElementById('mp-close').onclick = function () { box.hidden = true; };
  document.getElementById('mp-save').onclick = async function () {
    var msg = document.getElementById('mp-msg');
    var provider = document.getElementById('mp-prov').value;
    var model = document.getElementById('mp-model').value.trim();
    if (!model) { msg.className = 'hint err'; msg.textContent = '要填模型名'; return; }
    msg.className = 'hint'; msg.textContent = '保存中…';
    var j = await (await fetch('/api/config', { method: 'PUT', headers: H, body: JSON.stringify({ provider: provider, model: model }) })).json();
    if (!j || !j.ok) { msg.className = 'hint err'; msg.textContent = (j && (j.why || j.error)) || '保存失败'; return; }
    msg.className = 'hint ok'; msg.textContent = '已换成 ' + provider + '/' + model;
    await loadDossier();
    setTimeout(function () { box.hidden = true; }, 600);
  };
})();

// ── 超级权限（设置里唯一的入口）──────────────────────────────
async function loadSuper() {
  var st;
  try { st = await (await fetch('/api/super')).json(); } catch (e) { return; }
  var s1 = document.getElementById('superstate');
  var onBox = document.getElementById('superon'), offBox = document.getElementById('superoff');
  if (!s1) return;
  if (st.enabled) {
    s1.innerHTML = '<b style="color:var(--red)">已开启</b> · ' + escapeHtml(String(st.since || '').slice(0, 16)) +
      ' · 理由：' + escapeHtml(st.because || '（没写）');
    onBox.hidden = true; offBox.hidden = false;
  } else {
    s1.innerHTML = '当前：<b>关闭</b>（记忆核心 / 硬禁名单都照常挡）';
    onBox.hidden = false; offBox.hidden = true;
  }
}
async function superPost(body) {
  var j;
  try { j = await (await fetch('/api/super', { method: 'POST', headers: H, body: JSON.stringify(body) })).json(); }
  catch (e) { return { ok: false, why: '网络错误' }; }
  await loadSuper();
  return j;
}
(function () {
  var go = document.getElementById('supergo');
  if (go) go.onclick = async function () {
    var msg = document.getElementById('supermsg');
    var why = document.getElementById('superwhy').value.trim();
    msg.className = 'hint'; msg.textContent = '开启中…';
    var r = await superPost({ action: 'on', because: why });
    msg.className = r.ok ? 'hint ok' : 'hint err';
    msg.textContent = r.ok ? '已开启 —— 它会记进审计' : (r.why || r.error || '失败');
    if (r.ok) { document.getElementById('superwhy').value = ''; }
  };
  var close = document.getElementById('superclose');
  if (close) close.onclick = async function () {
    var msg = document.getElementById('supermsg2');
    var r = await superPost({ action: 'off' });
    msg.className = r.ok ? 'hint ok' : 'hint err';
    msg.textContent = r.ok ? '已收回' : (r.why || '失败');
  };
})();

// ── 能力屏：插件（MCP）/ 技能 / 原生工具 / 降级项 ────────────────
// 三件事都只读：这里不装、不启、不改配置 —— 装是跑 jingjing mcp add，或往目录里放文件。
function capline(k, v, bad) {
  return '<div class="capline' + (bad ? ' bad' : '') + '">' +
    '<span class="k">' + escapeHtml(k) + '</span>' +
    '<span class="v">' + escapeHtml(v == null ? '' : String(v)) + '</span></div>';
}
async function loadCapPage() {
  var cap = null, sk = null;
  try { cap = await (await fetch('/api/capabilities')).json(); } catch (e) { /* 下面显示空 */ }
  try { sk = await (await fetch('/api/skills')).json(); } catch (e) { /* 同上 */ }

  var cls = (cap && cap.classes) || {};
  var mcpTools = ((cls.tool) || []).filter(function (t) { return t.source === 'mcp'; });
  var byServer = {};
  mcpTools.forEach(function (t) {
    var m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(t.name);
    var server = m ? m[1] : '?';
    (byServer[server] = byServer[server] || []).push(t);
  });
  var errs = ((cap && cap.degraded) || []).filter(function (d) { return d.indexOf('mcp-unavailable') === 0; });
  var html = '';
  Object.keys(byServer).filter(function (k) { return k !== '?'; }).forEach(function (name) {
    html += capline(name, byServer[name].length + ' 个工具 · ok');
  html += '<div class="dact"><button type="button" data-del-mcp="' + escapeHtml(name) + '">删掉</button></div>';
    byServer[name].forEach(function (t) {
      html += '<div class="hint">· ' + escapeHtml(t.name.replace(/^mcp__[^_]+__/, '')) + '（' + escapeHtml(t.tier) + '）</div>';
    });
  });
  errs.forEach(function (d) { html += capline(d.replace('mcp-unavailable:', ''), '连不上', true); });
  // 重连：学 Coopanion 的 World 单独重启 —— 不用重启整个程序
  html = '<div class="dact" style="margin-bottom:6px"><button type="button" id="cap-reconnect">重连插件（不用重启程序）</button><span class="hint" id="cap-reconnect-msg"></span></div>' + html;
  document.getElementById('cap-mcp').innerHTML = html ||
    '<p class="hint">没装插件。插件是 MCP server：写进 data/mcp.json 的 servers 里，重启面板就会出现在这里。</p>';

  var rbtn = document.getElementById('cap-reconnect');
  if (rbtn) rbtn.onclick = async function () {
    var msg = document.getElementById('cap-reconnect-msg');
    rbtn.disabled = true;
    if (msg) msg.textContent = '重连中…';
    try {
      var r = await (await fetch('/api/plugins/reconnect', { method: 'POST', headers: H, body: '{}' })).json();
      if (msg) msg.textContent = r.ok
        ? '已重连：' + (r.servers || []).length + ' 个插件 / ' + (r.tools || []).length + ' 个工具' + ((r.errors || []).length ? '（' + r.errors.join('；') + '）' : '')
        : '失败：' + (r.why || r.error || '');
      if (r.ok) await loadCapPage();
    } catch (e) { if (msg) msg.textContent = '重连失败：' + e.message; }
    finally { rbtn.disabled = false; }
  };

  var list = (sk && sk.skills) || [];
  var dirsEl = document.getElementById('cap-skills-dirs');
  if (dirsEl) {
    dirsEl.textContent = '放这里就会被认到：' + ((sk && sk.dirs) || []).join(' 或 ') + '（和 pi / Claude Code 同一套目录）';
  }
  // 分两组：她自己的（会进简报索引）/ 使用者的开发技能（默认不进简报，折起来）
  var mine = list.filter(function (x) { return x.source !== 'agents'; });
  var devs = list.filter(function (x) { return x.source === 'agents'; });
  var skHtml = '';
  function skillRow(x) {
    return capline(x.id, x.source + ' · ' + Math.max(1, Math.round(x.bytes / 1024)) + 'KB') +
      '<div class="hint">' + escapeHtml(x.description || '（没有描述）') + '</div>';
  }
  if (mine.length) {
    skHtml += '<p class="hint">她自己的（会进简报索引：名字 + 一句描述）</p>';
    skHtml += mine.map(function (x) {
      return skillRow(x) + '<div class="dact"><button type="button" data-del-skill="' + escapeHtml(x.id) + '">删掉</button></div>';
    }).join('');
  }
  if (devs.length) {
    skHtml += '<p class="hint">使用者的开发技能（共 ' + devs.length + ' 个；默认不进简报，要看用 skill_list）' +
      '<button type="button" id="cap-more" class="dimmore" style="margin-left:8px;padding:3px 6px">展开</button></p>';
    skHtml += '<div id="cap-dev" hidden>' + devs.map(skillRow).join('') + '</div>';
  }
  document.getElementById('cap-skills').innerHTML = skHtml ||
    '<p class="hint">还没有技能。一份 SKILL.md 就是一个技能：<b>一句话说明 + 做法</b>。对话时只把名字和那句说明放进简报，正文由它自己 skill_read 取 —— 不占每轮的上下文。</p>';
  var more = document.getElementById('cap-more'), dev = document.getElementById('cap-dev');
  if (more && dev) more.onclick = function () { dev.hidden = !dev.hidden; more.textContent = dev.hidden ? '展开' : '收起'; };

  var cnt = function (k) { return ((cls[k] || []).filter(function (t) { return t.source !== 'mcp'; })).length; };
  document.getElementById('cap-native').innerHTML =
    capline('工具（verbs）', cnt('tool') + ' 个') +
    capline('命令（CLI）', cnt('command') + ' 个') +
    capline('面板能力', cnt('panel') + ' 个') +
    capline('定时模板', cnt('cron') + ' 个');

  var deg = (cap && cap.degraded) || [];
  document.getElementById('cap-degraded').innerHTML = deg.length
    ? deg.map(function (d) { return capline(d, '缺', true); }).join('')
    : '<p class="hint">没有降级项：当前能自述的能力都是真的。</p>';

  var cc = document.getElementById('capcount');
  if (cc) cc.textContent = (mcpTools.length + list.length + cnt('tool')) + ' 项';
}
async function loadGeneration() {
  var g; try { g = await (await fetch("/api/persona")).json(); } catch (e) { return; }
  var el = $("#p-gen");
  if (!el) return;
  if (!g || !g.generation) { el.textContent = ""; return; }
  el.innerHTML = "当前第 <b>" + g.generation.gen + "</b> 代（" + escapeHtml(String(g.generation.createdAt).slice(0, 10)) +
    "）· 改动只影响<b>之后</b>写下的记忆；旧记忆仍按原来的代解释。";
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
// ── 权限档：**已删除**（2026-11-04 用户：「去掉」）──
// 她默认就是 full，档位只会在干活途中把她打断（一次确认 = 一次断句）。
// 保留的两条硬边界不在这里：coreguard（记忆核心）与格式化磁盘/救援目录，
// 见 src/grant.ts / coreguard.ts。loadPermission() 留着是因为启动流程会调它。
// 工作/聊天模式：点一下切换，存进 config（跨重启保留）
var MODE = "chat";
async function loadMode() {
  try { MODE = (await (await fetch("/api/mode")).json()).mode || "chat"; } catch (e) { return; }
  paintMode();
}
function paintMode() {
  var b = document.getElementById("modechip");
  if (!b) return;
  b.textContent = MODE === "work" ? "工作" : "聊天";
  b.className = "permchip" + (MODE === "work" ? " full" : "");
}
async function setMode(m) {
  var r;
  try { r = await (await fetch("/api/mode", { method: "POST", headers: H, body: JSON.stringify({ mode: m }) })).json(); }
  catch (e) { return false; }
  if (r.ok) { MODE = r.mode; paintMode(); return true; }
  return false;
}
var modeBtn = document.getElementById("modechip");
if (modeBtn) modeBtn.onclick = function () { setMode(MODE === "work" ? "chat" : "work"); };

// 斜杠命令：/work、/chat（权限档那层 UI 删了，/permission 也跟着去掉）
async function handleSlash(text) {
  var t = String(text || "").trim();
  if (t === "/work" || t === "/chat") {
    var okw = await setMode(t === "/work" ? "work" : "chat");
    pushTicker(okw ? ("模式：" + (t === "/work" ? "工作（带最近几轮上下文）" : "聊天（靠记忆）")) : "切换失败");
    return true;
  }
  return false;
}

// 权限档这层 UI 删掉了（2026-11-04 用户：「去掉」）。
async function loadPermission() { /* 不再有档位可读：永远 full */ }
async function setPermission() { return false; }
function renderPermOptions() { /* 无档位可选 */ }
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
    b.innerHTML = "// 还没有能说话的模型 —— 本地模型只管整理记忆，不参与对话。点这里配 <button id='go-cfg'>去设置</button>";
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
async function paintLocalLive() {
  var el = document.getElementById('m-live');
  if (!el) return;
  var h = null;
  try { h = await (await fetch('/health')).json(); } catch (e) { el.textContent = '取不到本地模型状态'; return; }
  var L = h && h.local;
  if (!L) { el.textContent = ''; return; }
  var parts = [];
  parts.push(L.online ? '在线' : '离线');
  parts.push(L.running && L.running.length ? '正在跑：' + L.running.join(', ') : '当前没有模型在跑（只在需要时加载）');
  var e = L.embed || {};
  parts.push('本轮进程里 embedding 调了 ' + (e.calls || 0) + ' 次' + (e.texts ? '（' + e.texts + ' 条文本，共 ' + Math.round((e.ms || 0) / 100) / 10 + 's）' : '') + (e.failed ? ' · 失败 ' + e.failed + ' 次' : ''));
  parts.push('白天不参与对话；只在夜里整理记忆与建索引时干活');
  el.textContent = parts.join(' ｜ ');
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
  paintLocalLive();
  paintNightLog();
}

// 最近几晚它干了什么：数据来自 events(kind=night)，每夜一条（成功失败都记）
function bindNightRun() {
  var rb = document.getElementById('night-run');
  if (!rb) return;
  rb.onclick = async function () {
    var m = document.getElementById('night-msg');
    rb.disabled = true;
    if (m) m.textContent = '整理中…（读事件 / 抽取 / 冲突消解，几十秒）';
    try {
      var r = await (await fetch('/api/night/run', { method: 'POST', headers: H, body: '{}' })).json();
      if (m) m.textContent = r.ok ? '整理完了' : ('失败：' + (r.why || r.error || ''));
      await paintNightLog();
    } catch (e) { if (m) m.textContent = '请求失败：' + e.message; }
  };
}

async function paintNightLog() {
  var box = document.getElementById('m-nights');
  if (!box) return;
  var d = null;
  try { d = await (await fetch('/api/nightlog')).json(); } catch (e) { box.textContent = ''; return; }
  var runs = (d && d.runs) || [];
  // 该不该跑 + 现在跑一次：之前闲时整理**从来没有自动触发过**（用户问出来的）
  var due = null;
  try { due = await (await fetch('/api/night/due')).json(); } catch (e) { /* 拿不到就不显示 */ }
  var bar = '';
  if (due) {
    var when = due.lastAt ? String(due.lastAt).slice(5, 16).replace('T', ' ') : null;
    bar = '<div class="dact" style="margin-bottom:6px">' +
      (due.running ? '<span class="hint">正在整理…</span>' : '<button type="button" id="night-run">现在整理一次</button>') +
      '<span class="hint" id="night-msg">' +
      (due.due ? (when ? '该整理了（上次 ' + when + '）' : '从没整理过') : '还不用跑' + (when ? '（上次 ' + when + '）' : '')) +
      '</span></div>';
  }
  if (!runs.length) {
    box.innerHTML = bar + '<p class="hint">还没有闲时整理记录。它会在启动时自动检查（距上次超过 20 小时就后台跑）；也可以点上面的按钮现在跑一次。</p>';
    bindNightRun();
    return;
  }
  box.innerHTML = bar + '<p class="hint">最近几晚（每夜一条，成功失败都记）</p>' + runs.slice(0, 7).map(function (r) {
    var when = String(r.ts || '').slice(5, 16).replace('T', ' ');
    var head = (r.ok ? '✅ ' : '❌ ') + when;
    var parts = [];
    if (r.scanned != null) parts.push('读了 ' + r.scanned + ' 条事件');
    if (r.candidates != null) parts.push('候选 ' + r.candidates);
    if (r.added) parts.push('<b>新增 ' + r.added + '</b>');
    if (r.merged) parts.push('合并 ' + r.merged);
    if (r.superseded) parts.push('取代 ' + r.superseded);
    if (r.contradicted) parts.push('反证 ' + r.contradicted);
    if (r.decayed) parts.push('衰减 ' + r.decayed);
    if (r.rounds) parts.push(r.rounds + ' 轮' + (r.converged ? '·已收敛' : ''));
    if (r.ms != null) parts.push(Math.round(r.ms / 100) / 10 + 's');
    var notes = (r.notes || []).join('；');
    return '<div class="hint" style="margin:1px 0">' + head + ' · ' + (parts.join(' · ') || '无事可做') +
      (notes ? ' <span class="dim2">' + escapeHtml(notes) + '</span>' : '') + '</div>';
  }).join('');
  // 「现在整理一次」：之前闲时整理**从来没有自动触发过**（用户问出来的）
  bindNightRun();
  var rb = document.getElementById('night-run');
  if (rb) rb.onclick = async function () {
    var m = document.getElementById('night-msg');
    rb.disabled = true;
    if (m) m.textContent = '整理中…（读事件 / 抽取 / 冲突消解，几十秒）';
    try {
      var r = await (await fetch('/api/night/run', { method: 'POST', headers: H, body: '{}' })).json();
      if (m) m.textContent = r.ok ? '整理完了' : ('失败：' + (r.why || r.error || ''));
      await paintNightLog();
    } catch (e) { if (m) m.textContent = '请求失败：' + e.message; }
  };
}
$("#m-save").addEventListener("click", async function () {
  const btn = this;
  btn.disabled = true;
  $("#m-msg").textContent = "保存中…";
  try {
    const body = { default: $("#m-default").value, night: $("#m-night").value, embed: $("#m-embed").value };
    const r = await fetch("/api/models", { method: "PUT", headers: H, body: JSON.stringify(body) });
    const j = await r.json();
    $("#m-msg").textContent = j.ok ? "已保存：下次闲时整理与重启面板后生效" : ("失败：" + (j.error || r.status));
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
  // 认任何带 data-view 的 .item：左栏是导航，中栏的列表项（记忆/文档/审计）也走这里。
  // 之前只认 #side 里的 .item，列表搬出左栏之后点不动了（回归过一次）。
  const t = e.target.closest(".item[data-view]");
  if (!t) return;
  const v = t.dataset.view;
  if (t.closest("#side")) {
    sideActive = t;
    for (const b of document.querySelectorAll("#side .item")) b.classList.toggle("on", b === t);
  }
  if (v === "cfg") { show("cfg"); loadSuper(); loadHost(); loadSplash(); loadShell(); loadMode(); loadConfig().then(() => loadPersona($("#p-file").value)); return; }
  if (v === "toolview") { openTool(Number(t.dataset.tool)); return; }
  if (v === "memview") { openMemory(Number(t.dataset.mem)); return; }
  if (v === "docview") { openDoc(t.dataset.doc); return; }
  if (v === "capview") { show("capview"); loadCapPage(); return; }
  if (v === "filesview") { show("filesview"); loadTree(""); return; }
  if (v === "gitview") { show("gitview"); loadGit("status"); return; }
  if (v === "memlistview") { show("memlistview"); memories(); return; }
  if (v === "docsview") { show("docsview"); docs(); return; }
  if (v === "auditview") { openAudit(); return; }
  show("chat", t.dataset.day ? { day: t.dataset.day } : (t.closest("#sesslist") ? { latest: true } : undefined));
});
$("#p-file").onchange = (e) => loadPersona(e.target.value);
// 头像框：改完立刻套上（不等服务端），再把选择存住
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

// ── 卷宗（右栏）：Plan / Changes / Context ───────────────────────────
// 数据来自 /api/dossier（只读）。它不猜、不跑命令：
//   Plan   = 她惦记的事（agenda.json）+ 没闭合的线（memories 里的 thread）
//   Changes= 我们自己的账本 exec_audit 里**真的动过东西**的那几条（写入/执行）
//   Context= 记忆/文档/分块/今天用量 —— 都是系统量，不是装饰数字
var DOSSIER = null;
// 生成代码里禁反斜杠转义（TS 模板字符串会吃掉一层）：JS 字符串只用单引号，HTML 属性只用双引号
function dline(k, v, t) {
  return '<div class="dline"><span class="k">' + escapeHtml(k) + '</span>' +
    '<span class="t" title="' + escapeHtml(t || v) + '">' + escapeHtml(v) + '</span></div>';
}
// 「等你点头」那张卡：五块各自有 loader 在维护 DOM，这里只负责
//   · 数一数有几条（卡片标题上的数字）
//   · 全空时显示「没有等你点头的事」
// 坑（踩过）：回调里改 #dc-inbox-empty 的 hidden，而观察器正盯着 #dc-inbox 的 attributes
// → 自己触发自己，微任务无限循环，整页卡死。所以**值没变就不写**，并且用 rAF 合并。
var inboxRaf = 0;
function paintInbox() {
  var box = document.getElementById('dc-inbox');
  if (!box) return;
  var n = 0;
  ['pendsec', 'propsec', 'egrsec', 'rcpsec', 'threadsec'].forEach(function (id) {
    var sec = document.getElementById(id);
    if (!sec || sec.hidden) return;
    n += sec.querySelectorAll('.pend, .item, .card').length;
  });
  var badge = document.getElementById('dc-inbox-n');
  if (badge) {
    var txt = n ? n + ' 条' : '';
    if (badge.textContent !== txt) badge.textContent = txt;
  }
  var empty = document.getElementById('dc-inbox-empty');
  if (empty) {
    var hide = n > 0;
    if (empty.hidden !== hide) empty.hidden = hide;   // 值不变不写 → 不会自触发
  }
}
function paintInboxSoon() {
  if (inboxRaf) return;
  inboxRaf = requestAnimationFrame(function () { inboxRaf = 0; paintInbox(); });
}
function watchInbox() {
  var box = document.getElementById('dc-inbox');
  if (!box || !window.MutationObserver) return;
  new MutationObserver(paintInboxSoon).observe(box, { childList: true, subtree: true });
  paintInbox();
}
watchInbox();
function renderDossier() {
  var d = DOSSIER; if (!d) return;
  var ag = d.plan.agenda || [], th = d.plan.threads || [];
  var n = ag.length + th.length;
  document.getElementById('dc-plan-n').textContent = n ? n + ' 条' : '';
  var ph = '';
  for (var i = 0; i < ag.length; i++) ph += dline(ag[i].k, ag[i].t, ag[i].from);
  for (var j = 0; j < th.length; j++) {
    ph += dline(th[j].aging ? '拖了 ' + th[j].d + ' 天' : th[j].d + ' 天', th[j].t, '#' + th[j].id);
  }
  document.getElementById('dc-plan').innerHTML = ph || '<p class="dempty">手上没有未了的事。</p>';
  var ch = d.changes || [];
  document.getElementById('dc-chg-n').textContent = ch.length ? ch.length + ' 条' : '';
  var chh = '';
  for (var k2 = 0; k2 < ch.length; k2++) {
    var r = ch[k2], a = r.argv || '';
    try { var o = JSON.parse(a); if (o && o.argv) a = o.argv.join(' '); else if (o && o.path) a = o.path; } catch (e) { /* 不是 JSON 就原样 */ }
    chh += '<div class="dline"><span class="k">' + (r.ok ? '✓' : '✗') + ' ' + escapeHtml(r.verb) +
      '</span><span class="t" title="' + escapeHtml(a) + '">' + escapeHtml(a) + '</span></div>';
  }
  document.getElementById('dc-chg').innerHTML = chh || '<p class="dempty">这一轮还没动过东西。她动手时（含被拒的）都会记在这里。</p>';
  var c = d.context || {};
  document.getElementById('dc-ctx-n').textContent = c.model ? String(c.model).split('/').pop() : '';
  var ctxh = '';
  ctxh += dline('记忆', (c.memories || 0) + ' 条', 'status=active');
  var stages = (c.stages || []).map(function (x) { return x.stage + ' ' + x.c; }).join(' · ');
  if (stages) ctxh += dline('分层', stages, '');
  ctxh += dline('文档', (c.docs || 0) + ' 篇 / ' + (c.chunks || 0) + ' 块', '');
  ctxh += dline('模型', c.model || '未配置', '');
  ctxh += '<div class="dact"><button type="button" id="modelpick">换模型</button></div>';
  ctxh += dline('今天用量', (c.todayTokens || 0) + ' tok · $' + Number(c.todayUsd || 0).toFixed(4), '');
  var pl = c.plugins || {};
  ctxh += dline('能借的手脚', '插件 ' + (pl.servers || 0) + ' · 工具 ' + (c.tools || 0) + ' · 技能 ' + (c.skills || 0), 'MCP / verbs / SKILL.md');
  document.getElementById('dc-ctx-stats').innerHTML = ctxh;
}
async function loadDossier() {
  try {
    DOSSIER = await (await fetch('/api/dossier')).json();
    renderDossier();
  } catch (e) { /* 拿不到就保持原样，不弹错 */ }
}
for (const b of document.querySelectorAll('#folio .dtab')) {
  b.onclick = function () { b.parentElement.classList.toggle('closed'); };
}
var folioTog = document.getElementById('folioTog');
if (folioTog) folioTog.onclick = function () { document.body.classList.toggle('folio-open'); };
var ws = document.getElementById('wspath');
if (ws) ws.textContent = 'data/ · persona/ · workspace/';
loadDossier();
setInterval(loadDossier, 20000);

// ── 边栏收纳：收起来是「收」，不是「删」────────────────────────────
// 状态存在 localStorage：这是**这台机器的视觉偏好**，不该进 data/config.json
// （那是会跟着搬家走的东西；换台机器屏幕宽度不同，不该跟着搬）。
function applyLayout() {
  // 窄屏不套用这两个偏好：那里它们由抽屉管
  var narrow = innerWidth <= 1180;
  var wing = !narrow && localStorage.getItem('jj.wing') === 'off';
  var folio = !narrow && localStorage.getItem('jj.folio') === 'off';
  document.body.classList.toggle('wing-off', wing);
  document.body.classList.toggle('folio-off', folio);
  var h = document.getElementById('wingHandle');
  if (h) h.hidden = !wing;
}
function toggleWing(on) {
  var off = (typeof on === 'boolean') ? !on : !document.body.classList.contains('wing-off');
  localStorage.setItem('jj.wing', off ? 'off' : 'on');
  applyLayout();

}
function toggleFolio(on) {
  var off = (typeof on === 'boolean') ? !on : !document.body.classList.contains('folio-off');
  localStorage.setItem('jj.folio', off ? 'off' : 'on');
  applyLayout();
}
applyLayout();
// 插件与技能：装 / 删（写 data/mcp.json 与 data/skills/<id>/SKILL.md）
async function pluginPost(body) {
  var j;
  try {
    j = await (await fetch('/api/plugins', { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
  } catch (e) { return { ok: false, why: '网络错误' }; }
  if (j.ok) { await loadCapPage(); }
  return j;
}
(function () {
  var add = document.getElementById('mcp-add');
  if (add) add.onclick = async function () {
    var msg = document.getElementById('mcp-msg');
    var name = document.getElementById('mcp-name').value.trim();
    var cmd = document.getElementById('mcp-cmd').value.trim();
    var args = document.getElementById('mcp-args').value.trim();
    if (!name || !cmd) { msg.className = 'hint err'; msg.textContent = '名字和命令都要填'; return; }
    msg.className = 'hint'; msg.textContent = '写入中…';
    var r = await pluginPost({ kind: 'mcp', action: 'add', name: name, command: cmd,
      args: args ? args.split(/\s+/) : [] });
    msg.className = r.ok ? 'hint ok' : 'hint err';
    msg.textContent = r.ok ? (r.note || '已写入') : (r.why || r.error || '失败');
  };
  var skAdd = document.getElementById('sk-add');
  if (skAdd) skAdd.onclick = async function () {
    var msg = document.getElementById('sk-msg');
    var id = document.getElementById('sk-id').value.trim();
    var body = document.getElementById('sk-body').value;
    if (!id || !body.trim()) { msg.className = 'hint err'; msg.textContent = '目录名和内容都要填'; return; }
    msg.className = 'hint'; msg.textContent = '写入中…';
    var r = await pluginPost({ kind: 'skill', action: 'add', name: id, content: body });
    msg.className = r.ok ? 'hint ok' : 'hint err';
    msg.textContent = r.ok ? (r.note || '已写入') : (r.why || r.error || '失败');
    if (r.ok) document.getElementById('sk-body').value = '';
  };
  var capbox = document.getElementById('capview');
  if (capbox) capbox.addEventListener('click', async function (e) {
    var dm = e.target.closest('[data-del-mcp]');
    var ds = e.target.closest('[data-del-skill]');
    if (dm) {
      var name = dm.dataset.delMcp;
      if (!confirm('删掉插件 ' + name + '？（写进 data/mcp.json 的 servers 里那一条）')) return;
      var r1 = await pluginPost({ kind: 'mcp', action: 'remove', name: name });
      var m1 = document.getElementById('mcp-msg');
      m1.className = r1.ok ? 'hint ok' : 'hint err';
      m1.textContent = r1.ok ? (r1.note || '已删') : (r1.why || '失败');
      return;
    }
    if (ds) {
      var sid = ds.dataset.delSkill;
      if (!confirm('删掉技能 ' + sid + '？（整个目录，含 SKILL.md）')) return;
      var r2 = await pluginPost({ kind: 'skill', action: 'remove', name: sid });
      var m2 = document.getElementById('sk-msg');
      m2.className = r2.ok ? 'hint ok' : 'hint err';
      m2.textContent = r2.ok ? (r2.note || '已删') : (r2.why || '失败');
    }
  });
})();

// 文件面板 / git 校样的事件（只读）
(function () {
  var fq = document.getElementById('fq');
  if (fq) fq.oninput = function () { paintTree(); };
  var froot = document.getElementById('froot');
  if (froot) froot.onclick = function () { loadTree(''); };
  var flist = document.getElementById('flist');
  if (flist) flist.onclick = function (e) {
    var b = e.target.closest('[data-fpath]');
    if (!b) return;
    if (b.dataset.ftype === 'dir') loadTree(b.dataset.fpath);
    else openFile(b.dataset.fpath);
  };
  var fclose = document.getElementById('fclose');
  if (fclose) fclose.onclick = function () { document.getElementById('fview').hidden = true; };
  var gs = document.getElementById('gs'), gst = document.getElementById('gst'), gl = document.getElementById('gl');
  if (gs) gs.onclick = function () { loadGit('status'); };
  if (gst) gst.onclick = function () { loadGit('diff'); };
  if (gl) gl.onclick = function () { loadGit('log'); };
  var gfiles = document.getElementById('gfiles');
  if (gfiles) gfiles.onclick = function (e) {
    var b = e.target.closest('[data-gpath]');
    if (b) loadGit('diff', b.dataset.gpath);
  };
})();
var wingHandle = document.getElementById('wingHandle');
if (wingHandle) wingHandle.onclick = function () { toggleWing(true); };
// ── 卷宗的开/关（唯一入口）──────────────────────────────────────
// 两套状态不能混：窄屏是**抽屉**（folio-open，只在内存里），宽屏是**收纳**（folio-off，记 localStorage）。
// 之前 » 在手机上也去写 folio-off，于是抽屉一关，◧ 再也打不开（folio-off 压着 display:none）。
var NARROW = function () { return innerWidth <= 1180; };
function folioIsOpen() {
  return NARROW() ? document.body.classList.contains('folio-open')
                  : !document.body.classList.contains('folio-off');
}
function setFolioOpen(open) {
  if (NARROW()) {
    document.body.classList.toggle('folio-open', open);
    document.body.classList.remove('folio-off');   // 窄屏不认宽屏留下的收纳状态
    return;
  }
  toggleFolio(open);
}
var folioX = document.getElementById('folioX');
if (folioX) folioX.onclick = function () { setFolioOpen(false); };
var folioTog2 = document.getElementById('folioTog');
if (folioTog2) folioTog2.onclick = function () { setFolioOpen(!folioIsOpen()); };
// 左栏的 «：窄屏只是关抽屉，别把「收起」记成偏好
var wingTog2 = document.getElementById('wingTog');
if (wingTog2) wingTog2.onclick = function () {
  if (NARROW()) { document.getElementById('side').classList.remove('open'); return; }
  toggleWing(false);
};
// 窗口跨过 1180：把另一种模式的状态清干净（窄屏拖宽不该带着 folio-open）
addEventListener('resize', function () {
  if (NARROW()) document.body.classList.remove('wing-off', 'folio-off');
  else document.body.classList.remove('folio-open');
  applyLayout();

});
document.addEventListener('keydown', function (e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  var k = (e.key || '').toLowerCase();
  if (k === 'b') { e.preventDefault(); toggleWing(); }
  else if (k === 'j') { e.preventDefault(); toggleFolio(); }
});

$("#composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#m").value.trim(); if (!text) return;
  // 斜杠命令先过一道：/permission 之类的本地动作不该被当成聊天发出去
  if (await handleSlash(text)) { $("#m").value = ""; fitComposer(); return; }
  if (inflight) return;                       // 上一轮还没完就别叠
  $("#m").value = ""; fitComposer();
  traceStart();
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
  // 按步收集：被判为「过程」的那几步整段不进正文（用户：对话界面只呈现最终回答）。
  // 放在这个闭包里，才能直接用 box / acc。
  const turns = {};
  function paintAnswer() {
    const keys = Object.keys(turns).map(Number).sort((a, b) => a - b);
    const out = keys.filter((k) => !turns[k].process).map((k) => turns[k].text).join("");
    acc = out;
    box.innerHTML = escapeHtml(out) + "<span class='cursor'></span>";
  }
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
          // 「这次到底是本地还是云端在说话」：写在气泡的 meta 里，不靠猜
          if (d.responder) {
            var who = d.responder;
            meta.innerHTML = "<span class='who " + (who.kind === "local" ? "local" : "cloud") + "'>" +
              escapeHtml(who.label) + "</span>";
          }
        }
        if (d.type === "unavailable") {
          meta.textContent = "不可用";
          box.innerHTML = "<span class='err'>" + escapeHtml(d.message || "对话不可用") + "</span>";
          continue;
        }
        if (d.type === "memo") {
          // 当场记住的那一条：走底部 ticker，不占对方的话（2026-11-04）
          pushTicker(d.text);
        }
        if (d.type === "notice") {
          // 2026-11-01：思考移到右栏「过程」，会话栏只留最终回答
          traceAdd("think", "想", d.text);
        }
        if (d.type === "delta") {
          // 按步累积：这一轮如果最后被判定为「过程」，整段一起从正文拿掉。
          // 不再靠「文本末尾匹配」撤回 —— 模型多一个空格就撤不掉，正文留半句话。
          var st = d.step == null ? 0 : Number(d.step);
          if (!turns[st]) turns[st] = { text: "", process: false };
          turns[st].text += String(d.text || "");
          acc += d.text;
          box.innerHTML = escapeHtml(acc) + "<span class='cursor'></span>";
        }
        if (d.type === "think") {
          // 这一步是「过程」：它的所有 delta 都不该出现在对话里。
          // 用户 2026-11-03：「这个 think 也放进程里，对话界面只呈现最终回答」。
          var st2 = d.step == null ? 0 : Number(d.step);
          if (turns[st2]) turns[st2].process = true;
          paintAnswer();
          traceAdd("think", "想", String(d.text || ""));
        }
        if (d.type === "tool") {
          meta.textContent = "调用 " + d.name;
          traceTool(d.name, d.args, null, null);
        }
        if (d.type === "tool_result") {
          // 结果补在过程里（不再往会话栏塞工具卡）
          meta.textContent = "调用 " + d.name + " · " + d.ms + "ms";
          traceAdd("res", "结果", String(d.result || "").slice(0, 1200));
        }
        if (d.type === "error") {
          traceAdd("err", "错", d.message);
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
// 两档模式：默认只显示常用入口；「文件 / 工具」收在高级里。
// 学自 Coopanion 的 normal / advanced —— 新手不会一上来面对一屏入口。
(function initAdvanced() {
  var key = 'jj.advanced';
  function apply(on) {
    document.body.classList.toggle('advanced', on);
    var b = document.getElementById('adv-toggle');
    if (b) { b.textContent = on ? '收起高级项' : '显示高级项'; b.setAttribute('aria-pressed', String(on)); }
  }
  var on = false;
  try { on = localStorage.getItem(key) === '1'; } catch (e) { /* 无痕模式 */ }
  apply(on);
  var btn = document.getElementById('adv-toggle');
  if (btn) btn.onclick = function () {
    var now = !document.body.classList.contains('advanced');
    apply(now);
    try { localStorage.setItem(key, now ? '1' : '0'); } catch (e) { /* ignore */ }
  };
})();

// 左栏「闲时整理」：显示上次什么时候、该不该跑；点一下就跑（用户要的显眼入口）
async function loadIdle() {
  var btn = document.getElementById('idle-run'), when = document.getElementById('idle-when');
  if (!btn) return;
  var d = null;
  try { d = await (await fetch('/api/night/due')).json(); } catch (e) { if (when) when.textContent = ''; return; }
  if (d && d.running) { btn.disabled = true; if (when) when.textContent = '整理中…'; return; }
  btn.disabled = false;
  if (when) {
    if (!d || !d.lastAt) when.textContent = '还没跑过';
    else {
      var t = String(d.lastAt);
      // 只说「多久前」，不说绝对时间：绝对时间要看一眼才知道过了多久
      var h = (Date.now() - Date.parse(t)) / 3600000;
      when.textContent = h < 1 ? '刚刚' : (h < 48 ? Math.round(h) + ' 小时前' : Math.round(h / 24) + ' 天前');
    }
  }
}
document.getElementById('idle-run').onclick = async function () {
  var btn = this, when = document.getElementById('idle-when');
  btn.disabled = true;
  if (when) when.textContent = '整理中…';
  try {
    var r = await (await fetch('/api/night/run', { method: 'POST', headers: H, body: '{}' })).json();
    pushTicker(r.ok ? '闲时整理完成' : ('整理失败：' + (r.why || r.error || '')));
  } catch (e) { pushTicker('整理请求失败：' + e.message); }
  await loadIdle();
};
applyAgentName(); loadAvatars(); loadMode(); loadIdle(); applySections(); state(); timeline(); sessions(); tools(); memories(); docs(); audit(); readout(); loadConfig(); pending(); usage(); loadProposals(); loadSurfaceReview(); loadThreads(); loadReceipts(); loadStanding(); loadEgress();
setInterval(() => { state(); pending(); audit(); readout(); loadEgress(); }, 20000);
setInterval(loadIdle, 300000);
</script>
</body></html>`;

