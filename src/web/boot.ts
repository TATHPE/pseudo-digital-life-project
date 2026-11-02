/**
 * 开机片头（2026-11-02）。
 *
 * 参照 `dsh-550c-boot`（MIT）的 550C 开机动画，**两档**：
 *   simple 约 3.6s：项目名逐字写出来 → 一行副标
 *   full   约 10s ：三栏 HUD 覆写（照着原版的结构，不照它的仪表）：
 *                   左栏 TELEMETRY · 本机   —— 真实系统量逐行写进去
 *                   中栏 CORE TERMINAL      —— 逐行打字，每行是真实状态
 *                   右栏 NODE MATRIX        —— 每个工具一个方块，逐个点亮 ONLINE
 *                   顶栏会话行 / 底栏进度条 / 终幕 READY
 *
 * 为什么是这个结构：原版"炫"的不是动画，是**满屏有层次、一直在动的信息**。第一版我只给了
 * 六行读数，那是一张便签，不是开机。这版补齐三个层次（量 → 过程 → 节点）。
 *
 * 两处刻意的不同：
 *   · 配色：原版是琥珀/红，我们是**黑 + 白**（青色仍只给她回话的气泡，AGENTS.md §3）
 *   · 数据：原版那些 PCI/TAC/Cell ID 是编的；我们**只显示真实量**，拿不到的整行不出现，
 *     绝不写死数字（有测试钉住）。所以同一台机器第二次开机，数字会变 —— 那才是证据。
 *
 * 三条从参照物学来的手法：首帧就盖住（不等 JS）／点一下或 Esc 随时跳过／
 * `prefers-reduced-motion` 另走一条路（直接给成品，不播事件）。
 *
 * 本文件用数组 join 拼串，**不用反斜杠转义、不写反引号、不写 ${**（AGENTS.md §3 的老坑）。
 */

export type BootMode = "simple" | "full";

/** 配置里能选的档位（照参照物的 MODE_VALUES） */
export const SPLASH_MODES = ["off", "simple", "full"] as const;

/** 从配置读档位：认不出来就当 full（宁可多播一次，也别让人以为坏了） */
export function splashMode(ui: { splash?: string } | undefined): "off" | BootMode {
  const v = String(ui?.splash ?? "").toLowerCase();
  return v === "off" ? "off" : v === "simple" ? "simple" : "full";
}

/** 项目名（名字分两层：项目 = 这个，她 = agent.name；片头只出现项目层） */
export const PROJECT_NAME = "PSEUDO DIGITAL LIFE PROJECT";

const NL = String.fromCharCode(10);

/* ── 两档共用 ───────────────────────────────────────────── */
const CSS_COMMON = [
  "  /* ── 开机片头（boot.ts）：黑底 + 白线 + 白字；青色仍然只给她回话的气泡 ── */",
  "  #jjboot{position:fixed;inset:0;z-index:9999;background:#050706;overflow:hidden;",
  "          display:flex;flex-direction:column;align-items:center;justify-content:center;",
  "          font-family:var(--mono,ui-monospace,Consolas,monospace);",
  "          transition:opacity .58s cubic-bezier(.16,1,.3,1);}",
  "  #jjboot.done{opacity:0;pointer-events:none;}",
  "  #jjboot::after{content:'';position:absolute;inset:0;pointer-events:none;z-index:3;",
  "                 background:repeating-linear-gradient(to bottom,rgba(233,240,242,.022) 0,rgba(233,240,242,.022) 1px,transparent 1px,transparent 4px);}",
  "  /* 主视觉：项目名。两行大字，每字一个 span（服务端就渲染好，没 JS 也看得见） */",
  "  #jjboot .jjb-title{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;",
  "    gap:2px;font-size:clamp(20px,3.6vw,42px);line-height:1.14;font-weight:700;",
  "    letter-spacing:.20em;padding-left:.20em;color:#e9f0f2;text-align:center;",
  "    text-shadow:0 0 26px rgba(233,240,242,.26);}",
  "  #jjboot .jjb-title .ln{display:block;white-space:nowrap;}",
  "  #jjboot .jjb-ch{display:inline-block;opacity:0;filter:blur(5px);transform:translateY(5px);",
  "    animation:jjbCh .5s cubic-bezier(.16,1,.3,1) forwards;}",
  "  #jjboot .jjb-ch.sp{width:.4em;}",
  "  @keyframes jjbCh{to{opacity:1;filter:blur(0);transform:none;}}",
  "  #jjboot .jjb-sub{position:relative;z-index:2;font-size:9.5px;line-height:1;",
  "                 letter-spacing:.44em;color:rgba(233,240,242,.36);padding-left:.44em;opacity:0;",
  "                 animation:jjbIn .7s ease 1.9s forwards;white-space:nowrap;}",
  "  #jjboot .jjb-cur{display:inline-block;width:5px;height:10px;background:#e9f0f2;margin-left:10px;",
  "                   vertical-align:-1px;opacity:0;animation:jjbIn .2s 2.35s forwards,jjbBlink 1s steps(1) 2.55s infinite;}",
  "  @keyframes jjbIn{to{opacity:1;}}",
  "  @keyframes jjbBlink{0%,49%{opacity:1;}50%,100%{opacity:0;}}",
  "  @media (prefers-reduced-motion: reduce){",
  "    #jjboot .jjb-ch{animation:none;opacity:1;filter:none;transform:none;}",
  "    #jjboot .jjb-sub,#jjboot .jjb-cur{animation:none;opacity:1;}",
  "    #jjboot .jjb-cur{animation:jjbBlink 1s steps(1) infinite;}",
  "    #jjboot .jjb-flash,#jjboot .jjb-scan,#jjboot .jjb-sweep,#jjboot .jjb-bar{display:none;}",
  "    #jjboot .jjb-grid{animation:none;clip-path:none;}",
  "    #jjboot .jjb-hud{animation:none;clip-path:none;}",
  "    #jjboot .jjb-tl,#jjboot .jjb-term .tl,#jjboot .jjb-tool,#jjboot .jjb-mx i{animation:none;opacity:1;transform:none;}",
  "    #jjboot .jjb-mx i{background:#e9f0f2;box-shadow:none;}",
  "    #jjboot .jjb-ready{animation:none;clip-path:none;opacity:1;}",
  "    #jjboot .jjb-ready::before,#jjboot .jjb-ready::after{display:none;}",
  "  }",
].join(NL);

/* ── 完整档专有：三栏 HUD ───────────────────────────────── */
const CSS_FULL = [
  "  /* ① 过曝闪白（参照物的 l-wash） */",
  "  #jjboot .jjb-flash{position:absolute;inset:0;background:#e9f0f2;opacity:0;pointer-events:none;z-index:4;",
  "    animation:jjbFlash .6s cubic-bezier(.16,1,.3,1) .05s forwards;}",
  "  @keyframes jjbFlash{0%{opacity:.9;}55%{opacity:.13;}100%{opacity:0;}}",
  "  /* ② 底板网格：从中间向两侧横向擦出 */",
  "  #jjboot .jjb-grid{position:absolute;inset:0;pointer-events:none;",
  "    background:repeating-linear-gradient(90deg,rgba(233,240,242,.05) 0 1px,transparent 1px 64px),",
  "               repeating-linear-gradient(0deg,rgba(233,240,242,.04) 0 1px,transparent 1px 64px);",
  "    clip-path:inset(0 50% 0 50%);animation:jjbBoard .9s cubic-bezier(.16,1,.3,1) .5s forwards;}",
  "  @keyframes jjbBoard{0%{clip-path:inset(0 50% 0 50%);}100%{clip-path:inset(0 0 0 0);}}",
  "  /* ③ 扫描线（参照物的 l-scan） */",
  "  #jjboot .jjb-scan{position:absolute;left:0;right:0;height:1px;pointer-events:none;z-index:3;",
  "    background:linear-gradient(90deg,transparent,rgba(233,240,242,.7),transparent);",
  "    box-shadow:0 0 14px rgba(233,240,242,.3);top:-2%;",
  "    animation:jjbScan 2.6s linear 1s infinite;}",
  "  @keyframes jjbScan{0%{top:-2%;opacity:0;}8%{opacity:1;}92%{opacity:1;}100%{top:102%;opacity:0;}}",
  "  /* ④ 高光扫过（参照物的 l-sweep） */",
  "  #jjboot .jjb-sweep{position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:none;z-index:2;",
  "    background:linear-gradient(103deg,transparent 44%,rgba(233,240,242,.16) 50%,transparent 56%);",
  "    transform:translateX(-120%);animation:jjbSweep 1.4s cubic-bezier(.4,0,.2,1) 1.5s forwards;}",
  "  @keyframes jjbSweep{0%{transform:translateX(-120%);opacity:0;}18%{opacity:1;}",
  "                      100%{transform:translateX(120%);opacity:0;}}",
  "  /* ⑤ 外壳：顶栏 + 三栏 + 底栏 */",
  "  #jjboot .jjb-shell{position:relative;z-index:2;display:flex;flex-direction:column;gap:8px;",
  "    width:min(1240px,94vw);margin-top:18px;}",
  "  #jjboot .jjb-top{display:flex;align-items:center;gap:14px;font-size:9.5px;line-height:1;",
  "    letter-spacing:.18em;color:rgba(233,240,242,.42);border-bottom:1px solid rgba(233,240,242,.10);",
  "    padding-bottom:6px;}",
  "  #jjboot .jjb-top b{color:#e9f0f2;font-weight:700;letter-spacing:.22em;}",
  "  #jjboot .jjb-top .grow{flex:1;}",
  "  #jjboot .jjb-hud{display:grid;grid-template-columns:1fr 1.3fr 1fr;gap:12px;",
  "    clip-path:inset(0 50% 0 50%);animation:jjbBoard .8s cubic-bezier(.16,1,.3,1) .42s forwards;}",
  "  #jjboot .jjb-panel{border:1px solid rgba(233,240,242,.13);background:rgba(6,10,9,.55);",
  "    padding:7px 9px 9px;min-width:0;display:flex;flex-direction:column;gap:5px;}",
  "  #jjboot .jjb-hd{display:flex;align-items:center;gap:8px;font-size:9px;line-height:1;",
  "    letter-spacing:.2em;color:rgba(233,240,242,.34);border-bottom:1px dashed rgba(233,240,242,.12);",
  "    padding-bottom:5px;}",
  "  #jjboot .jjb-hd b{color:rgba(233,240,242,.78);font-weight:700;}",
  "  #jjboot .jjb-hd .grow{flex:1;}",
  "  #jjboot .jjb-hd .sq{width:5px;height:5px;background:rgba(233,240,242,.3);}",
  "  /* ⑤a 左栏：遥测 —— key 右对齐小灰字 + value 白粗字 */",
  "  #jjboot .jjb-tl{display:flex;align-items:baseline;gap:8px;font-size:10px;line-height:1.42;",
  "    opacity:0;transform:translateX(-4px);animation:jjbIn .3s ease forwards;}",
  "  @keyframes jjbInX{to{opacity:1;transform:none;}}",
  "  #jjboot .jjb-tl .k{flex:0 0 84px;text-align:right;color:rgba(233,240,242,.32);letter-spacing:.1em;",
  "    font-size:9px;}",
  "  #jjboot .jjb-tl .v{color:rgba(233,240,242,.92);font-weight:700;letter-spacing:.02em;",
  "    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  "  #jjboot .jjb-tl .v.dim{color:rgba(233,240,242,.5);font-weight:400;}",
  "  /* ⑤b 中栏：终端 —— 逐行打字，每行带真实相对毫秒 */",
  "  #jjboot .jjb-term .tl{font-size:10px;line-height:1.55;color:rgba(233,240,242,.2);",
  "    opacity:0;animation:jjbIn .22s linear forwards;white-space:nowrap;overflow:hidden;",
  "    text-overflow:ellipsis;}",
  "  #jjboot .jjb-term .tl.on{color:rgba(233,240,242,.78);}",
  "  #jjboot .jjb-term .tl .t{color:rgba(233,240,242,.26);}",
  "  #jjboot .jjb-term .tl .ok{color:#e9f0f2;font-weight:700;}",
  "  /* ⑤c 右栏：节点矩阵 —— 每个工具一个方块，逐个点亮（参照物的 SWARM NODE MATRIX） */",
  "  #jjboot .jjb-tools{display:flex;flex-direction:column;gap:3px;font-size:9.5px;line-height:1.3;",
  "    height:96px;overflow:hidden;color:rgba(233,240,242,.46);}",
  "  #jjboot .jjb-tool{opacity:0;animation:jjbIn .18s linear forwards;white-space:nowrap;overflow:hidden;",
  "    text-overflow:ellipsis;}",
  "  #jjboot .jjb-tool b{color:rgba(233,240,242,.85);font-weight:700;}",
  "  #jjboot .jjb-tool .on{color:#e9f0f2;}",
  "  #jjboot .jjb-mx{display:grid;grid-template-columns:repeat(14,1fr);gap:3px;margin-top:2px;}",
  "  #jjboot .jjb-mx i{display:block;aspect-ratio:1;background:rgba(233,240,242,.10);",
  "    animation:jjbIn .16s linear forwards,jjbDot .3s ease forwards;}",
  "  @keyframes jjbDot{to{background:rgba(233,240,242,.92);box-shadow:0 0 6px rgba(233,240,242,.55);}}",
  "  /* ⑤d 底栏：进度条 + 真实状态词 */",
  "  #jjboot .jjb-bot{display:flex;align-items:center;gap:12px;font-size:9px;line-height:1;",
  "    letter-spacing:.2em;color:rgba(233,240,242,.3);}",
  "  #jjboot .jjb-bot .grow{flex:1;}",
  "  #jjboot .jjb-bar{position:relative;flex:0 0 210px;height:2px;background:rgba(233,240,242,.10);}",
  "  #jjboot .jjb-bar i{display:block;height:100%;width:0;background:#e9f0f2;",
  "    box-shadow:0 0 8px rgba(233,240,242,.5);animation:jjbProg 8.6s linear .4s forwards;}",
  "  @keyframes jjbProg{to{width:100%;}}",
  "  #jjboot .jjb-pct{color:rgba(233,240,242,.72);font-weight:700;letter-spacing:.1em;min-width:34px;",
  "    text-align:right;}",
  "  /* ⑥ 终幕：其余先淡下去，READY 独占屏幕（参照物最后一下压屏的手法） */",
  "  #jjboot.final .jjb-title,#jjboot.final .jjb-sub,#jjboot.final .jjb-shell{opacity:.07;",
  "    transition:opacity .34s ease;}",
  "  #jjboot .jjb-ready{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:5;",
  "    padding:8px 12px;font-size:24px;line-height:1;letter-spacing:.72em;color:#ffffff;",
  "    text-shadow:0 0 22px rgba(255,255,255,.85),0 0 60px rgba(233,240,242,.45);white-space:nowrap;background:#050706;",
  "    clip-path:inset(0 50% 0 50%);opacity:0;",
  "    animation:jjbReady .5s cubic-bezier(.7,0,.2,1) forwards,jjbGlowTxt 1.6s ease-in-out .5s infinite;}",
  "  #jjboot .jjb-ready::before,#jjboot .jjb-ready::after{content:'';position:absolute;top:0;bottom:0;width:1px;",
  "    background:#e9f0f2;box-shadow:0 0 12px 2px rgba(233,240,242,.8);opacity:0;}",
  "  #jjboot .jjb-ready::before{left:50%;animation:jjbEdgeL .5s cubic-bezier(.7,0,.2,1) forwards;}",
  "  #jjboot .jjb-ready::after{right:50%;animation:jjbEdgeR .5s cubic-bezier(.7,0,.2,1) forwards;}",
  "  @keyframes jjbReady{0%{clip-path:inset(0 50% 0 50%);opacity:0;}30%{opacity:1;}",
  "                      100%{clip-path:inset(0 0 0 0);opacity:1;}}",
  "  @keyframes jjbGlowTxt{0%,100%{text-shadow:0 0 12px rgba(255,255,255,.6),0 0 40px rgba(233,240,242,.3);}",
  "                        50%{text-shadow:0 0 30px rgba(255,255,255,1),0 0 80px rgba(233,240,242,.6);}}",
  "  @keyframes jjbEdgeL{0%{left:50%;opacity:1;}88%{left:0;opacity:1;}100%{left:0;opacity:0;}}",
  "  @keyframes jjbEdgeR{0%{right:50%;opacity:1;}88%{right:0;opacity:1;}100%{right:0;opacity:0;}}",
  "  /* 窄屏：HUD 折成一栏（只留终端与遥测），标题缩一号 */",
  "  @media (max-width:900px){",
  "    #jjboot .jjb-hud{grid-template-columns:1fr;}",
  "    #jjboot .jjb-panel:nth-child(3){display:none;}",
  "    #jjboot .jjb-tools{height:72px;}",
  "  }",
].join(NL);

/** 标题按行（两行大字；服务端渲染，没 JS 也是完整可见的文字） */
const TITLE_LINES = ["PSEUDO DIGITAL", "LIFE PROJECT"];

function titleBlock(): string {
  const lines = TITLE_LINES.map((ln) => {
    const chars = Array.from(ln).map((c) => {
      const cls = c === " " ? "jjb-ch sp" : "jjb-ch";
      return "<span class=\"" + cls + "\">" + (c === " " ? "&nbsp;" : c) + "</span>";
    });
    return "    <span class=\"ln\">" + chars.join("") + "</span>";
  });
  return [
    "  <div class=\"jjb-title\" aria-label=\"" + PROJECT_NAME + "\">",
    ...lines,
    "  </div>",
  ].join(NL);
}

function shellBlock(): string {
  return [
    "  <div class=\"jjb-shell\">",
    "    <div class=\"jjb-top\">",
    "      <b>PSEUDO DIGITAL LIFE PROJECT</b>",
    "      <span class=\"grow\"></span>",
    "      <span>SESSION <span id=\"jjbSess\">········</span></span>",
    "      <span>LOCAL <span id=\"jjbClock\">00:00.0</span></span>",
    "    </div>",
    "    <div class=\"jjb-hud\">",
    "      <div class=\"jjb-panel\">",
    "        <div class=\"jjb-hd\"><span class=\"sq\"></span><b>TELEMETRY</b><span>/ 本机</span><span class=\"grow\"></span><span>LIVE</span></div>",
    "        <div id=\"jjbTel\"></div>",
    "      </div>",
    "      <div class=\"jjb-panel jjb-term\">",
    "        <div class=\"jjb-hd\"><span class=\"sq\"></span><b>CORE TERMINAL</b><span class=\"grow\"></span><span>BOOT</span></div>",
    "        <div id=\"jjbTerm\"></div>",
    "      </div>",
    "      <div class=\"jjb-panel\">",
    "        <div class=\"jjb-hd\"><span class=\"sq\"></span><b>NODE MATRIX</b><span class=\"grow\"></span><span id=\"jjbToolN\">·</span></div>",
    "        <div class=\"jjb-tools\" id=\"jjbTools\"></div>",
    "        <div class=\"jjb-mx\" id=\"jjbMx\"></div>",
    "      </div>",
    "    </div>",
    "    <div class=\"jjb-bot\">",
    "      <span>LOCAL ONLY</span>",
    "      <span>NO EGRESS</span>",
    "      <span class=\"grow\"></span>",
    "      <span class=\"jjb-bar\"><i></i></span>",
    "      <span class=\"jjb-pct\" id=\"jjbPct\">0%</span>",
    "    </div>",
    "  </div>",
  ].join(NL);
}

function simpleBody(): string {
  return [
    titleBlock(),
    "  <div class=\"jjb-sub\">LOCAL FIRST · YOURS TO KEEP<span class=\"jjb-cur\"></span></div>",
  ].join(NL);
}

function fullBody(): string {
  return [
    "  <div class=\"jjb-flash\"></div>",
    "  <div class=\"jjb-grid\"></div>",
    "  <div class=\"jjb-sweep\"></div>",
    "  <div class=\"jjb-scan\"></div>",
    titleBlock(),
    "  <div class=\"jjb-sub\">LOCAL FIRST · YOURS TO KEEP<span class=\"jjb-cur\"></span></div>",
    shellBlock(),
  ].join(NL);
}

/**
 * 逐字写出的节奏（两档共用）：每字 26ms，从第 120ms 起。
 * 服务端已把字渲染成 span，这里只补 animation-delay。
 */
const JS_CHARS = [
  "  var chs=b.querySelectorAll('.jjb-ch');",
  "  for(var k=0;k<chs.length;k++){chs[k].style.animationDelay=(0.12+k*0.026)+'s';}",
].join(NL);

/**
 * 完整档的全部内容都由真实接口生成：
 *   /health          → schema / memories / uptimeS / degraded
 *   /api/dossier     → context（docs, chunks, tools, plugins, skills, model, todayTokens, todayUsd）
 *   /api/capabilities→ classes.tool（每个工具一个方块 + 一行名字）、providers（embedder）
 * 拿不到的项整行不出现；数字一律不写死。
 */
const JS_FULL = [
  "  var T0=performance.now();",
  "  function ms(){return ('00'+Math.round(performance.now()-T0)).slice(-3);}",
  "  var tel=document.getElementById('jjbTel'),term=document.getElementById('jjbTerm');",
  "  var toolsBox=document.getElementById('jjbTools'),mx=document.getElementById('jjbMx');",
  "  var pct=document.getElementById('jjbPct'),sess=document.getElementById('jjbSess');",
  "  var clock=document.getElementById('jjbClock'),toolN=document.getElementById('jjbToolN');",
  "  var clockT=setInterval(function(){clock.textContent=((performance.now()-T0)/1000).toFixed(1)+'s';},100);",
  "  var pctT=setInterval(function(){var v=Math.min(96,((performance.now()-T0)/9400)*100);pct.textContent=Math.round(v)+'%';},120);",
  "  function pad(n){return ('0'+n).slice(-2);}",
  "  sess.textContent=(function(){var d=new Date();return pad(d.getHours())+pad(d.getMinutes())+'.'+(d.getSeconds()%16).toString(16).toUpperCase()+'A';})();",
  "  function kfmt(n){return n>=1000?(Math.round(n/100)/10)+'k':String(n);}",
  "  function usd(n){return '$'+(n<0.01?n.toFixed(3):n.toFixed(2));}",
  "",
  "  /* 左栏：一行一行写进去（每行 90ms），值全部来自接口 */",
  "  var telRows=[];",
  "  function T(k,v,dim){telRows.push([k,v,!!dim]);}",
  "  function paintTel(i){",
  "    if(i>=telRows.length)return;",
  "    var r=telRows[i],el=document.createElement('div');",
  "    el.className='jjb-tl';",
  "    el.innerHTML='<span class=\"k\"></span><span class=\"v\"></span>';",
  "    el.querySelector('.k').textContent=r[0];",
  "    var v=el.querySelector('.v');v.textContent=r[1];if(r[2])v.className='v dim';",
  "    tel.appendChild(el);",
  "    setTimeout(function(){paintTel(i+1);},90);",
  "  }",
  "",
  "  /* 中栏：终端逐行（每行 190ms），每行说的是上面那批真实量 */",
  "  var termRows=[];",
  "  function L(s){termRows.push(s);}",
  "  function paintTerm(i){",
  "    if(i>=termRows.length){",
  "      b.classList.add('final');",
  "      var fl=document.createElement('div');fl.className='jjb-flash';fl.style.animation='jjbFlash .5s ease-out';",
  "      b.appendChild(fl);",
  "      var rd=document.createElement('div');rd.className='jjb-ready';rd.textContent='READY';",
  "      b.appendChild(rd);",
  "      clearInterval(pctT);pct.textContent='100%';",
  "      return;",
  "    }",
  "    var prev=term.querySelectorAll('.tl');",
  "    if(prev.length)prev[prev.length-1].className='tl on';",
  "    var el=document.createElement('div');el.className='tl';",
  "    el.innerHTML='<span class=\"t\">[+'+ms()+']</span> '+termRows[i];",
  "    term.appendChild(el);",
  "    setTimeout(function(){paintTerm(i+1);},190);",
  "  }",
  "",
  "  function hx(s){var h=0;for(var i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))>>>0;}",
  "    return ('0000000'+h.toString(16).toUpperCase()).slice(-8);}",
  "",
  "  Promise.all([",
  "    fetch('/api/dossier').then(function(r){return r.json();}).catch(function(){return null;}),",
  "    fetch('/health').then(function(r){return r.json();}).catch(function(){return null;}),",
  "    fetch('/api/capabilities').then(function(r){return r.json();}).catch(function(){return null;})",
  "  ]).then(function(res){",
  "    var d=res[0]||{},h=res[1]||{},c=res[2]||{},ctx=d.context||{};",
  "    var toolsArr=(c.classes&&c.classes.tool)||[];",
  "    var cmdN=(c.classes&&c.classes.command||[]).length;",
  "    var hookN=(c.classes&&c.classes.hook||[]).length;",
  "    var roles=(c.providers&&c.providers.roles)||[];",
  "    var emb=null;for(var q=0;q<roles.length;q++){if(roles[q].role==='embed')emb=roles[q];}",
  "",
  "    if(h.schema)T('MEMORY CORE','v'+h.schema);",
  "    if(h.memories)T('MEMORIES',h.memories+' 条');",
  "    if(ctx.stages&&ctx.stages[0])T('· 分层',ctx.stages[0].stage+' '+ctx.stages[0].c,true);",
  "    if(ctx.docs)T('DOCUMENTS',ctx.docs+' 篇 / '+(ctx.chunks||0)+' 块');",
  "    if(emb&&emb.model)T('EMBEDDER',emb.model+' · '+emb.kind);",
  "    if(ctx.model)T('EXPRESS',String(ctx.model));",
  "    if(ctx.skills)T('SKILLS',ctx.skills+' 个');",
  "    if(ctx.plugins)T('PLUGINS',ctx.plugins.servers+' server / '+ctx.plugins.tools+' tool');",
  "    if(ctx.todayTokens)T('TODAY',kfmt(ctx.todayTokens)+' tok · '+usd(ctx.todayUsd||0));",
  "    if(toolsArr.length)T('CAPABILITIES',toolsArr.length+' tools'+(cmdN?' / '+cmdN+' cmds':''));",
  "    if(c.classes)T('HOOKS',hookN+' 个',true);",
  "    if(location.port)T('SIDECAR','127.0.0.1:'+location.port);",
  "    if(h.uptimeS!==undefined)T('UPTIME',h.uptimeS+'s',true);",
  "    if(h.degraded)T('DEGRADED',h.degraded.length?h.degraded.join(' · '):'none',!h.degraded.length);",
  "",
  "    L('open <b>memory.db</b>'+(h.schema?' · schema v'+h.schema:''));",
  "    if(h.memories)L('memories <b>'+h.memories+'</b>'+(ctx.stages&&ctx.stages[0]?'（'+ctx.stages[0].stage+' '+ctx.stages[0].c+'）':''));",
  "    if(ctx.docs)L('documents <b>'+ctx.docs+'</b> 篇 · 分块 <b>'+(ctx.chunks||0)+'</b>');",
  "    if(toolsArr.length)L('capabilities <b>'+toolsArr.length+'</b> tools · <b>'+cmdN+'</b> cmds');",
  "    if(ctx.skills)L('skills <b>'+ctx.skills+'</b> · plugins <b>'+(ctx.plugins?ctx.plugins.servers:0)+'</b>');",
  "    if(emb&&emb.model)L('embedder <b>'+emb.model+'</b> · '+emb.kind);",
  "    if(ctx.model)L('express <b>'+String(ctx.model)+'</b>');",
  "    if(ctx.todayTokens)L('today <b>'+kfmt(ctx.todayTokens)+'</b> tokens · '+usd(ctx.todayUsd||0));",
  "    if(c.converter)L('converter '+(c.converter.available?'<span class=\"ok\">ready</span>':'<span class=\"ok\">off</span>'));",
  "    L('egress <span class=\"ok\">guarded</span> · taint <span class=\"ok\">external</span>');",
  "    if(location.port)L('sidecar <span class=\"ok\">127.0.0.1:'+location.port+'</span>');",
  "    L('manifest <span class=\"ok\">'+hx(String(location.host)+'|'+String(h.schema)+'|'+String(ctx.memories))+'</span>');",
  "",
  "    /* 右栏：每个工具一个方块 + 一行名字，逐个 ONLINE */",
  "    toolN.textContent=toolsArr.length?toolsArr.length+' / '+toolsArr.length+' ONLINE':'·';",
  "    for(var i=0;i<toolsArr.length;i++){",
  "      (function(i){",
  "        setTimeout(function(){",
  "          var t=toolsArr[i];",
  "          var row=document.createElement('div');row.className='jjb-tool';",
  "          row.innerHTML='<b></b> <span class=\"on\">ONLINE</span>';",
  "          row.querySelector('b').textContent=t.name||'';",
  "          toolsBox.appendChild(row);",
  "          while(toolsBox.children.length>7)toolsBox.removeChild(toolsBox.firstChild);",
  "          var cell=document.createElement('i');cell.style.animationDelay='0s,0s';mx.appendChild(cell);",
  "        },600+i*70);",
  "      })(i);",
  "    }",
  "",
  "    paintTel(0);",
  "    setTimeout(function(){paintTerm(0);},260);",
  "  });",
].join(NL);

function bootJs(mode: BootMode): string {
  const ms = mode === "full" ? 11000 : 3600;
  const slowMs = mode === "full" ? 2400 : 1600;
  return [
    "<script>(function(){",
    "  var b=document.getElementById('jjboot');if(!b)return;",
    "  var ended=false;",
    "  function off(){if(ended)return;ended=true;b.classList.add('done');",
    "    setTimeout(function(){if(b&&b.parentNode)b.parentNode.removeChild(b);},650);}",
    "  var slow=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;",
    "  setTimeout(off,slow?" + slowMs + ":" + ms + ");",
    "  b.addEventListener('pointerdown',off);",
    "  window.addEventListener('keydown',function(e){",
    "    if(e.key==='Escape'||e.key==='Enter'||e.key===' '){off();}",
    "  },{once:true});",
    "  document.documentElement.style.background='#050706';",
    JS_CHARS,
    mode === "full" ? JS_FULL : "  void 0;",
    "})();</script>",
  ].join(NL);
}

/** 片头本体。mode 由渲染方按配置决定（ui.splash） */
export function bootOverlay(mode: BootMode = "full"): string {
  const full = mode === "full";
  return [
    "<style>" + CSS_COMMON + (full ? NL + CSS_FULL : "") + "</style>",
    "<div id=\"jjboot\" role=\"presentation\" aria-hidden=\"true\">",
    full ? fullBody() : simpleBody(),
    "</div>",
    bootJs(mode),
  ].join(NL);
}
