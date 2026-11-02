/**
 * 开机片头（2026-11-01）。
 *
 * 参照 `dsh-550c-boot`（MIT）的 550C 开机动画，**两档**：
 *   simple 约 3.4s：logo 描边写出 → 填充 → 一行项目名 → 淡出
 *   full   约 9s  ：在 simple 之上多一段「覆写全流程」—— 网格线擦出、逐条读数、最后的 READY
 *
 * 完整档里那 47 行读数，参照物是**编的**（虚构的 PCI/TAC/Cell ID）；我们换成**真实数字**：
 * 记忆条数 / 文档与分块 / 模型 / 能力类目 / 端口与令牌。项目铁律是「读数只显示系统量」，
 * 片头也不例外 —— 拿不到数据就**整段跳过**，不编。
 *
 * 三条从参照物学来的手法：
 *   1. **首帧就盖住**：遮罩在 HTML/CSS 里，不等 JS
 *   2. **写出 → 填充 → 呼吸**，三个相位不重叠
 *   3. **点一下 / Esc 随时跳过**
 * 一条它没有、我们必须有的：`prefers-reduced-motion`（不描边不呼吸，直接给成品）。
 *
 * 本文件用数组 join 拼串（不是模板字符串），**不用反斜杠转义、不写反引号、不写 ${**（AGENTS.md §3）。
 */

/** 鲸尾路径：和面板 #whale symbol 是同一个 d（test/boot.test.ts 比对，防漂移） */
export const WHALE_D = "M453.004 35.117c-65.314 46.61-189.755 41.018-213.559 125.426C184.41 101.41 98.625 83.031 21.771 63.209c6.532 139.103 71.38 147.437 192.44 194.547c23.71 25.786 29.786 49.93 19.254 82.705c46.403 5.1 71.504 15.468 106.754 27.742c-.708-71.67-25.14-108.928-75.518-175.035c11.058 4.233 44.979 37.02 56.578 58.607c109.419-42.421 147.64-112.074 131.725-216.658M180.178 353.9c-60.89-.24-114.034 19.49-158.426 74.221c167.075-48.84 292.003-13.21 471.893 7.895c-118.936-38.752-224.474-81.763-313.467-82.116m98.043 77.844c-99.28.255-206.34 18.738-256.866 63.139c168.002-26.61 356.801-28.408 470.8-4.967c1.102-35.337-101.418-58.46-213.934-58.172";

export type BootMode = "simple" | "full";

const NL = String.fromCharCode(10);

const CSS_COMMON = [
  "  /* ── 开机片头（boot.ts）：黑底 + 白线 + 白字，青色仍然只给她回话的气泡 ── */",
  "  #jjboot{position:fixed;inset:0;z-index:9999;background:#050706;display:flex;",
  "          flex-direction:column;align-items:center;justify-content:center;gap:22px;",
  "          transition:opacity .58s cubic-bezier(.16,1,.3,1);}",
  "  #jjboot.done{opacity:0;pointer-events:none;}",
  "  #jjboot::after{content:'';position:absolute;inset:0;pointer-events:none;",
  "                 background:repeating-linear-gradient(to bottom,rgba(233,240,242,.022) 0,rgba(233,240,242,.022) 1px,transparent 1px,transparent 4px);}",
  "  #jjboot svg{width:min(260px,38vw);height:auto;overflow:visible;}",
  "  #jjboot .jjb-p{fill:none;stroke:#e9f0f2;stroke-width:16;stroke-linecap:round;stroke-linejoin:round;",
  "                 stroke-dasharray:1;stroke-dashoffset:1;",
  "                 animation:jjbDraw 1.5s cubic-bezier(.16,1,.3,1) .12s forwards,",
  "                           jjbFill .5s ease 1.52s forwards,",
  "                           jjbGlow 2.6s ease-in-out 2.1s infinite;}",
  "  @keyframes jjbDraw{to{stroke-dashoffset:0;}}",
  "  @keyframes jjbFill{to{fill:#e9f0f2;}}",
  "  @keyframes jjbGlow{0%,100%{filter:drop-shadow(0 0 6px rgba(233,240,242,.30));}",
  "                          50%{filter:drop-shadow(0 0 16px rgba(233,240,242,.72));}}",
  "  #jjboot .jjb-t{font:10px/1 var(--mono,ui-monospace,Consolas,monospace);letter-spacing:.42em;",
  "                 color:rgba(233,240,242,.42);padding-left:.42em;opacity:0;",
  "                 animation:jjbIn .7s ease 1.75s forwards;white-space:nowrap;}",
  "  #jjboot .jjb-cur{display:inline-block;width:6px;height:11px;background:#e9f0f2;margin-left:10px;",
  "                   vertical-align:-1px;opacity:0;animation:jjbIn .2s 2.35s forwards,jjbBlink 1s steps(1) 2.55s infinite;}",
  "  @keyframes jjbIn{to{opacity:1;}}",
  "  @keyframes jjbBlink{0%,49%{opacity:1;}50%,100%{opacity:0;}}",
  "  @media (prefers-reduced-motion: reduce){",
  "    #jjboot .jjb-p{animation:none;stroke:none;fill:#e9f0f2;}",
  "    #jjboot .jjb-t,#jjboot .jjb-cur{animation:none;opacity:1;}",
  "    #jjboot .jjb-cur{animation:jjbBlink 1s steps(1) infinite;}",
  "    #jjboot .jjb-grid{animation:none;clip-path:none;opacity:1;}",
  "    #jjboot .jjb-lines .l{animation:none;opacity:1;transform:none;}",
  "  }",
].join(NL);

/** 完整档多出来的那层：网格 + 读数区 + READY */
const CSS_FULL = [
  "  /* 完整档：底板网格从中间向两侧擦出（参照物是 l-board 的 clip-path 手法） */",
  "  #jjboot .jjb-grid{position:absolute;inset:0;pointer-events:none;",
  "    background:repeating-linear-gradient(90deg,rgba(233,240,242,.05) 0 1px,transparent 1px 64px),",
  "               repeating-linear-gradient(0deg,rgba(233,240,242,.04) 0 1px,transparent 1px 64px);",
  "    clip-path:inset(0 50% 0 50%);animation:jjbBoard .9s cubic-bezier(.16,1,.3,1) 1.1s forwards;opacity:0;}",
  "  @keyframes jjbBoard{0%{clip-path:inset(0 50% 0 50%);opacity:0;}",
  "                      20%{opacity:1;}100%{clip-path:inset(0 0 0 0);opacity:1;}}",
  "  #jjboot .jjb-lines{width:min(520px,78vw);display:flex;flex-direction:column;gap:5px;",
  "    font:11px/1.5 var(--mono,ui-monospace,Consolas,monospace);color:rgba(233,240,242,.62);}",
  "  #jjboot .jjb-lines .l{display:flex;gap:10px;opacity:0;transform:translateY(3px);",
  "    animation:jjbLine .34s ease forwards;}",
  "  #jjboot .jjb-lines .l .k{color:rgba(233,240,242,.38);letter-spacing:.14em;flex:0 0 112px;}",
  "  #jjboot .jjb-lines .l .v{color:rgba(233,240,242,.86);font-weight:700;letter-spacing:.02em;}",
  "  @keyframes jjbLine{to{opacity:1;transform:none;}}",
  "  #jjboot .jjb-ready{margin-top:4px;font:11px/1 var(--mono,ui-monospace,Consolas,monospace);",
  "    letter-spacing:.5em;color:#e9f0f2;opacity:0;animation:jjbIn .3s ease forwards;}",
].join(NL);

function simpleBody(): string[] {
  return [
    "  <svg viewBox=\"0 0 512 512\" aria-hidden=\"true\"><path class=\"jjb-p\" pathLength=\"1\" d=\"" + WHALE_D + "\"/></svg>",
    "  <div class=\"jjb-t\">PSEUDO DIGITAL LIFE PROJECT<span class=\"jjb-cur\"></span></div>",
  ];
}

function fullBody(): string[] {
  return [
    "  <div class=\"jjb-grid\"></div>",
    "  <svg viewBox=\"0 0 512 512\" aria-hidden=\"true\"><path class=\"jjb-p\" pathLength=\"1\" d=\"" + WHALE_D + "\"/></svg>",
    "  <div class=\"jjb-t\">PSEUDO DIGITAL LIFE PROJECT<span class=\"jjb-cur\"></span></div>",
    "  <div class=\"jjb-lines\" id=\"jjbLines\"></div>",
  ];
}

/**
 * 完整档的读数：**全部来自真实接口**。
 * 顺序照「她工作的顺序」：库 → 记忆 → 文档 → 模型 → 能力 → 她的名字 → 端口。
 * 任何一项拿不到就跳过那一行；整批失败就一个字都不显示（不编）。
 */
const JS_FULL = [
  "  var box=document.getElementById('jjbLines');",
  "  var rows=[];",
  "  function row(k,v){rows.push([k,v]);}",
  "  Promise.all([",
  "    fetch('/api/dossier').then(function(r){return r.json();}).catch(function(){return null;}),",
  "    fetch('/health').then(function(r){return r.json();}).catch(function(){return null;})",
  "  ]).then(function(res){",
  "    var d=res[0],h=res[1];",
  "    if(h&&h.schema)row('MEMORY CORE','schema v'+h.schema);",
  "    if(d&&d.context){",
  "      var c=d.context;",
  "      if(c.memories)row('MEMORIES',c.memories+' \\u6761');",
  "      if(c.docs)row('DOCUMENTS',c.docs+' \\u7bc7 / '+(c.chunks||0)+' \\u5757');",
  "      if(c.model)row('EXPRESS',String(c.model));",
  "      if(c.tools)row('CAPABILITIES',c.tools+' tools');",
  "    }",
  "    if(window.AGENT_NAME)row('HER NAME',window.AGENT_NAME);",
  "    if(location.port)row('SIDECAR','127.0.0.1:'+location.port);",
  "    if(h&&h.degraded&&h.degraded.length)row('DEGRADED',h.degraded.join(' \\u00b7 '));",
  "    var i=0;",
  "    (function next(){",
  "      if(i>=rows.length){",
  "        box.insertAdjacentHTML('beforeend','<div class=\"jjb-ready\">READY</div>');",
  "        return;",
  "      }",
  "      var r=rows[i++];",
  "      var el=document.createElement('div');",
  "      el.className='l';",
  "      el.innerHTML='<span class=\"k\"></span><span class=\"v\"></span>';",
  "      el.querySelector('.k').textContent=r[0];",
  "      el.querySelector('.v').textContent=r[1];",
  "      box.appendChild(el);",
  "      setTimeout(next,300);",
  "    })();",
  "  });",
].join(NL);

function bootJs(mode: BootMode): string {
  const ms = mode === "full" ? 9000 : 3400;
  const slowMs = mode === "full" ? 2200 : 1800;
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
    mode === "full" ? JS_FULL : "  void 0;",
    "})();</script>",
  ].join(NL);
}

/** 片头本体。mode 由渲染方决定（首次启动给 full，之后给 simple） */
export function bootOverlay(mode: BootMode = "simple"): string {
  const full = mode === "full";
  return [
    "<style>" + CSS_COMMON + (full ? NL + CSS_FULL : "") + "</style>",
    "<div id=\"jjboot\" role=\"presentation\" aria-hidden=\"true\">",
    ...(full ? fullBody() : simpleBody()),
    "</div>",
    bootJs(mode),
  ].join(NL);
}
