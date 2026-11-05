/**
 * 第二条壳：工作记录本（2026-11-05）
 *
 * 为什么是**第二条**而不是改 page.ts：用户要保留旧面板、随时能退回去。
 *   /            经典面板（page.ts，一行没动）
 *   /notebook    记录本（这个文件）
 * 两套都走同一份数据、同一批 /api；回退 = 换个 URL，不改代码。
 *
 * 结构来自三个方向的原型，但只有一个是骨架：
 *   · 骨架 = 工作记录本：按天的目录 / 页边时间戳 / 长回复折叠 / 证据条
 *   · 借一块 = 标本柜的「她收着的」页：一张纸一件事，褪色可见，「要你点头」钉在第一张
 *   · 借一块 = 手册的醋酸片：过程是盖在正文上的半透明页，掀起来才看
 *
 * 约束不变：零构建、单文件内联、无外部字体/图床、黑底白线、青色只给她的回话。
 */
export const NOTEBOOK = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>鲸鲸 · 记录本</title>
<style>
:root{
  color-scheme:dark;
  --void:#0b0e0b;--ink:#e9f0f2;--dim:#9fb0b3;--dim2:#66757a;
  --line:rgba(233,240,242,.30);--line-dim:rgba(233,240,242,.10);
  --cyan:#0f97a4;--amber:#c9a227;--fade:#8a9698;
  --ok:#8db580;--warn:#c9a227;--err:#c4554d;
  --mono:ui-monospace,"Cascadia Mono",Consolas,monospace;
  --sans:"HarmonyOS Sans SC","PingFang SC","Noto Sans SC","Source Han Sans SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
  --measure:660px;
}
*{box-sizing:border-box}
/* hidden 要真的藏住：.nb-tabs 有 display:flex，会盖过 UA 的 [hidden]{display:none} */
[hidden]{display:none !important}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--line-dim);border-radius:0}
::-webkit-scrollbar-thumb:hover{background:var(--dim2)}
html,body{height:100%;margin:0}
body{background:var(--void);color:var(--ink);font:15px/1.85 var(--sans);
  text-spacing-trim:trim-start;text-autospace:ideograph-alpha ideograph-numeric;
  line-break:strict;hanging-punctuation:first allow-end last;font-kerning:normal;
  font-variant-east-asian:normal}
.nb{height:100vh;display:grid;grid-template-rows:34px minmax(0,1fr)}
.nb-top{display:flex;align-items:center;gap:16px;padding:0 14px;border-bottom:1px solid var(--line-dim);
  font:11px/1 var(--mono);color:var(--dim);letter-spacing:.04em;white-space:nowrap;overflow:hidden}
.nb-top b{color:var(--ink);font-weight:600}
.nb-top .sp{flex:1}
.nb-dot{width:5px;height:5px;background:var(--cyan);border-radius:50%;display:inline-block;margin-right:7px;vertical-align:1px}
.nb-main{display:grid;grid-template-columns:196px minmax(0,1fr) auto;min-height:0}

.nb-index{border-right:1px solid var(--line-dim);display:flex;flex-direction:column;min-height:0;padding:14px 0 8px;overflow:auto}
.nb-index h2{font:10px/1 var(--mono);letter-spacing:.18em;color:var(--dim2);margin:0 0 10px 16px;font-weight:400}
.nb-day{display:grid;grid-template-columns:18px 1fr;gap:8px;padding:7px 14px;cursor:pointer;border-left:2px solid transparent}
.nb-day:hover{background:rgba(233,240,242,.03)}
.nb-day.on{border-left-color:var(--ink);background:rgba(233,240,242,.04)}
.nb-day .mk{width:7px;height:7px;border:1px solid var(--line);margin-top:9px}
.nb-day.on .mk{background:var(--ink);border-color:var(--ink)}
.nb-day .d{display:block;font:12px/1.5 var(--sans)}
.nb-day .m{display:block;font:10px/1.6 var(--mono);color:var(--dim2)}
.nb-grow{flex:1;min-height:16px}
.nb-go{display:flex;justify-content:space-between;gap:8px;padding:6px 14px;font:11px/1.9 var(--mono);
  color:var(--dim);cursor:pointer;border-top:1px solid var(--line-dim)}
.nb-go:hover{color:var(--ink)}
.nb-go.cur{color:var(--ink);background:rgba(233,240,242,.04)}
.nb-go .n{color:var(--dim2)}
.nb-go.warn .n{color:var(--amber)}

.nb-page{min-width:0;overflow:auto;padding:0 0 110px;scroll-behavior:auto}
.nb-home{max-width:calc(var(--measure) + 76px);margin:0 auto;padding:26px 24px 8px 8px}
.nb-kicker{font:10px/1 var(--mono);letter-spacing:.22em;color:var(--dim2);margin-bottom:14px}
.nb-greet{font:26px/1.35 var(--sans);font-weight:700;letter-spacing:-.01em;margin:0 0 8px}
.nb-greet em{font-style:italic;font-weight:400;border-bottom:1px solid var(--line)}
.nb-meta{font:10.5px/1.7 var(--mono);color:var(--dim2);letter-spacing:.04em}
.nb-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:18px 0 6px}
.nb-card2{display:block;text-align:left;border:1px solid var(--line-dim);background:rgba(233,240,242,.015);color:var(--ink);padding:11px 12px;cursor:pointer}
.nb-card2:hover{border-color:var(--line);background:rgba(233,240,242,.04)}
.nb-card2 .k{display:block;font:9px/1 var(--mono);letter-spacing:.16em;color:var(--dim2);margin-bottom:9px}
.nb-card2 b{display:block;font:22px/1 var(--sans);font-weight:700}
.nb-card2 .m{display:block;font:9.5px/1.6 var(--mono);color:var(--dim2);margin-top:6px}
.nb-card2.wait{border-color:var(--amber)}
.nb-card2.wait .k,.nb-card2.wait b{color:var(--amber)}
.nb-health{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;margin:10px 0 20px;border:1px solid var(--line-dim);background:var(--line-dim)}
.nb-hc{background:var(--void);padding:8px 9px;min-width:0}
.nb-hc .k{font:8.5px/1 var(--mono);letter-spacing:.14em;color:var(--dim2)}
.nb-hc .v{font:11px/1.5 var(--mono);color:var(--dim);margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nb-hc.bad .v{color:var(--amber)}
.nb-sec{display:flex;align-items:baseline;gap:10px;margin:22px 0 6px;font:9.5px/1 var(--mono);letter-spacing:.2em;color:var(--dim2)}
.nb-sec:after{content:"";flex:1;height:1px;background:var(--line-dim)}
.nb-pagehd{display:flex;align-items:baseline;gap:12px;padding:18px 22px 10px;max-width:1100px;margin:0 auto}
.nb-pagehd h1{font:10px/1 var(--mono);letter-spacing:.18em;color:var(--dim2);margin:0;font-weight:400}
.nb-pagehd .sp{flex:1}
.nb-wrap{max-width:1100px;margin:0 auto;padding:0 22px 60px}
.nb-row{display:block;width:100%;text-align:left;border:0;border-top:1px solid var(--line-dim);
  background:none;color:var(--ink);padding:11px 4px;cursor:pointer;font:14px/1.6 var(--sans)}
.nb-row:hover{background:rgba(233,240,242,.03)}
.nb-row .m{display:block;font:10px/1.7 var(--mono);color:var(--dim2);margin-top:3px}
.nb-row .tag{font:9px/1 var(--mono);letter-spacing:.1em;color:var(--dim2);margin-right:8px}
.nb-kv{display:grid;grid-template-columns:96px 1fr;gap:6px 12px;font:11px/1.8 var(--mono);color:var(--dim);margin:10px 0}
.nb-kv b{color:var(--dim2);font-weight:400}
.nb-pre{white-space:pre-wrap;word-break:break-word;font:11.5px/1.7 var(--mono);color:var(--dim);
  border:1px solid var(--line-dim);padding:12px;margin:10px 0;max-height:52vh;overflow:auto}
.nb-btn{font:10px/1 var(--mono);letter-spacing:.08em;color:var(--ink);background:none;
  border:1px solid var(--line);padding:7px 10px;cursor:pointer;margin:2px 6px 2px 0}
.nb-btn:hover{background:var(--ink);color:var(--void)}
.nb-btn.danger{border-color:#7a3b36;color:#d08a85}
.nb-btn.danger:hover{background:#7a3b36;color:var(--ink)}
.nb-search{width:100%;max-width:420px;background:none;border:1px solid var(--line-dim);color:var(--ink);
  font:13px/1.6 var(--sans);padding:8px 10px;outline:none;margin:0 0 8px}
.nb-search:focus{border-color:var(--line)}
.nb-logrow{display:grid;grid-template-columns:118px 140px 64px 120px 1fr;gap:8px;align-items:baseline;padding:6px 2px;
  border-bottom:1px solid var(--line-dim);font:11px/1.6 var(--mono);color:var(--dim)}
.nb-logrow .t{color:var(--dim2)}
.nb-logrow .v{color:var(--ink)}
.nb-logrow .d.ok{color:var(--dim)}
.nb-logrow .d.bad{color:var(--amber)}
.nb-logrow .x{color:var(--dim2);white-space:nowrap}
.nb-logrow .a{color:var(--dim2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nb-turn{border-top:1px solid var(--line-dim);padding:12px 2px}
.nb-audit{font:11px/1.7 var(--mono);color:var(--dim);margin-top:6px}
.nb-appr{border-top:1px solid var(--line-dim);padding:12px 2px}
.nb-gapq{border-top:1px solid var(--line-dim);padding:12px 2px}
.nb-gapt{font:14px/1.7 var(--sans);color:var(--ink)}
.nb-gapt .m{display:block;font:10px/1.6 var(--mono);color:var(--dim2);margin-top:2px}
.nb-grid2{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:6px}
.nb-recipe{display:block;text-align:left;border:1px solid var(--line-dim);background:none;color:var(--ink);padding:10px 11px;cursor:pointer}
.nb-recipe:hover{border-color:var(--line);background:rgba(233,240,242,.04)}
.nb-recipe .n{display:block;font:12.5px/1.4 var(--sans)}
.nb-recipe .d{display:block;font:10px/1.5 var(--mono);color:var(--dim2);margin-top:4px}
.nb-actline{display:flex;gap:10px;align-items:baseline;padding:5px 2px;border-bottom:1px solid var(--line-dim);cursor:pointer;font:12px/1.6 var(--sans)}
.nb-actline:hover{background:rgba(233,240,242,.03)}
.nb-actline .t{font:10px/1.6 var(--mono);color:var(--dim2);flex:none}
.nb-actline .w{font:9px/1.6 var(--mono);color:var(--dim);flex:none}
.nb-actline .x{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nb-pal{position:fixed;inset:0;z-index:50;background:rgba(5,7,6,.9);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}
.nb-pal[hidden]{display:none}
.nb-palbox{width:min(620px,92vw);border:1px solid var(--line);background:var(--void)}
.nb-palin{width:100%;background:none;border:0;border-bottom:1px solid var(--line-dim);color:var(--ink);font:14px/1.6 var(--sans);padding:12px 14px;outline:none}
#nb-palist{max-height:46vh;overflow:auto}
.nb-palrow{display:flex;gap:10px;align-items:baseline;padding:8px 14px;cursor:pointer;border-bottom:1px solid var(--line-dim)}
.nb-palrow.on{background:var(--ink);color:var(--void)}
.nb-palrow .k{font:9px/1 var(--mono);letter-spacing:.12em;color:var(--dim2);flex:none;width:44px}
.nb-palrow.on .k{color:rgba(11,14,11,.6)}
.nb-palrow .v{font:12.5px/1.5 var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nb-run{border-top:1px solid var(--line-dim);margin-bottom:6px}
.nb-runrow{display:grid;grid-template-columns:84px 1fr auto;gap:12px;align-items:baseline;padding:9px 2px;border-bottom:1px solid var(--line-dim);font:12.5px/1.6 var(--sans)}
.nb-runrow .k{font:9.5px/1.6 var(--mono);letter-spacing:.12em;color:var(--dim2)}
.nb-runrow .v{color:var(--ink)}
.nb-runrow .m{font:10px/1.6 var(--mono);color:var(--dim2);text-align:right}
.nb-form-wrap{max-width:640px}
.nb-form{display:grid;gap:8px;padding:6px 0 4px}
.nb-jumpbar{position:sticky;top:0;z-index:3;display:flex;flex-wrap:wrap;gap:4px;padding:8px 0;
  background:var(--void);border-bottom:1px solid var(--line-dim);margin-bottom:10px}
.nb-jump{font:10px/1 var(--mono);letter-spacing:.06em;color:var(--dim);background:none;
  border:1px solid var(--line-dim);padding:6px 8px;cursor:pointer}
.nb-jump:hover{color:var(--ink);border-color:var(--line)}
.nb-jump.on{color:var(--void);background:var(--ink);border-color:var(--ink)}
.nb-sec{scroll-margin-top:44px}
.nb-opts{display:flex;flex-wrap:wrap;gap:6px}
.nb-opt{font:11px/1 var(--mono);color:var(--dim);background:none;border:1px solid var(--line-dim);padding:7px 9px;cursor:pointer}
.nb-opt:hover{border-color:var(--line);color:var(--ink)}
.nb-opt.on{color:var(--void);background:var(--ink);border-color:var(--ink)}
.nb-av{width:26px;height:26px;object-fit:cover;border:1px solid var(--line-dim);image-rendering:auto}
label.nb-btn{display:inline-flex;align-items:center;cursor:pointer}
.nb-fld{display:grid;grid-template-columns:76px 1fr;gap:10px;align-items:center}
.nb-fld span{font:9.5px/1 var(--mono);letter-spacing:.12em;color:var(--dim2)}
.nb-fld .nb-search{margin:0}
.nb-actrow{display:flex;align-items:center;gap:8px;margin-top:4px}
.nb-sub{font:13px/1.9 var(--sans);color:var(--ink);border-left:2px solid var(--cyan);padding-left:12px;margin:8px 0}
.nb-sheet{max-width:calc(var(--measure) + 76px);margin:0 auto;padding:24px 24px 0 8px}
.nb-e{display:grid;grid-template-columns:64px 1fr;gap:0 12px;position:relative;padding:16px 0 20px;border-top:1px solid var(--line-dim)}
.nb-e:first-child{border-top:0}
.nb-e .g{text-align:right;font:10px/1.7 var(--mono);color:var(--dim2);padding-top:5px}
.nb-e .g .w{display:block;color:var(--dim);letter-spacing:.06em}
.nb-gav{display:block;width:22px;height:22px;object-fit:cover;margin:0 0 5px auto;border:1px solid var(--line-dim);opacity:.85}
.nb-e.me .g .w{color:var(--amber)}
.nb-e .b{min-width:0}
.nb-say{border-left:2px solid var(--cyan);padding:2px 0 2px 14px}
.nb-e.me .nb-say{border-left-color:var(--amber)}
.nb-say p{margin:0 0 .8em}
.nb-say p:last-child{margin-bottom:0}
.nb-say ul,.nb-say ol{margin:.2em 0 .9em;padding-left:1.15em}
.nb-say li{margin:.3em 0}
.nb-say code{font:12.5px/1.7 var(--mono);background:rgba(233,240,242,.06);padding:1px 5px;border-radius:0}
.nb-say pre{background:rgba(233,240,242,.05);border:1px solid var(--line-dim);padding:10px;overflow:auto;
  font:12px/1.7 var(--mono);margin:.6em 0}
.nb-say h1,.nb-say h2,.nb-say h3{font-size:15px;margin:.9em 0 .4em;letter-spacing:.02em}
.nb-fold{position:relative;max-height:10.8em;overflow:hidden}
.nb-fold:after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--line-dim)}
.nb-fold.open{max-height:none}.nb-fold.open:after{display:none}
.nb-more{margin-top:6px;font:11px/1 var(--mono);color:var(--dim);background:none;border:0;
  border-bottom:1px dashed var(--line);padding:0 0 3px;cursor:pointer;letter-spacing:.04em}
.nb-more:hover{color:var(--ink);border-bottom-color:var(--ink)}
.nb-ev{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.nb-ev span{font:10px/1 var(--mono);color:var(--dim);border:1px solid var(--line-dim);
  padding:5px 7px;background:rgba(233,240,242,.02)}
.nb-daymark{display:flex;align-items:center;gap:10px;margin:6px 0 4px;font:10px/1 var(--mono);
  letter-spacing:.14em;color:var(--dim2)}
.nb-daymark:after{content:"";flex:1;height:1px;background:var(--line-dim)}

/* 标本页：她收着的 */
.nb-board{max-width:1240px;margin:0 auto;padding:20px 22px 40px}
.nb-board h1{font:10px/1 var(--mono);letter-spacing:.2em;color:var(--dim2);margin:0 0 14px;font-weight:400}
.nb-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.nb-spec{position:relative;border:1px solid var(--line-dim);padding:13px 13px 38px;min-height:132px;}
.nb-spec:hover{border-color:var(--line);background:rgba(233,240,242,.03)}
.nb-spec .k{font:9px/1 var(--mono);letter-spacing:.16em;color:var(--dim2);margin-bottom:8px}
.nb-spec .v{font-size:14px;line-height:1.7;word-break:break-word}
.nb-spec .lab{position:absolute;left:13px;right:13px;bottom:9px;display:flex;justify-content:space-between;
  gap:8px;font:9px/1.4 var(--mono);color:var(--dim2);border-top:1px solid var(--line-dim);padding-top:6px}
.nb-spec.fade .v{color:var(--fade)}
.nb-spec.wait{border-color:var(--amber)}
.nb-spec.wait .k{color:var(--amber)}
.nb-spec.wait .act{display:flex;gap:6px;margin-top:6px}
.nb-spec.wait .act button{font:10px/1 var(--mono);background:none;color:var(--ink);border:1px solid var(--line);
  padding:6px 8px;cursor:pointer}
.nb-spec.wait .act button:hover{background:var(--ink);color:var(--void)}

/* 切口索引 */
.nb-tabs{display:flex;border-left:1px solid var(--line-dim)}
.nb-rail{width:52px;display:flex;flex-direction:column;gap:2px;padding-top:12px}
.nb-tab{font:11px/1 var(--mono);letter-spacing:.1em;color:var(--dim2);padding:11px 0;cursor:pointer;
  text-align:center;border:0;background:none;border-left:2px solid transparent}
.nb-tab:hover{color:var(--dim);background:rgba(233,240,242,.03)}
.nb-tab.on{color:var(--void);background:var(--ink);border-left-color:var(--ink)}
.nb-tab.wait{color:var(--amber)}
.nb-tab.wait.on{color:var(--void);background:var(--amber);border-left-color:var(--amber)}
.nb-tab .c{display:block;margin-top:5px;font-size:9px}
.nb-panel{width:280px;padding:14px 14px 40px;overflow:auto;border-left:1px solid var(--line-dim)}
.nb-panel[hidden]{display:none}
.nb-panel h3{font:10px/1 var(--mono);letter-spacing:.16em;color:var(--dim2);margin:0 0 12px;font-weight:400}
.nb-card{border:1px solid var(--line-dim);padding:10px 11px;margin-bottom:9px}
.nb-card .t{font-size:13px;line-height:1.6}
.nb-card .s{font:10px/1.6 var(--mono);color:var(--dim2);margin-top:5px}
.nb-card button{font:10px/1 var(--mono);background:none;color:var(--ink);border:1px solid var(--line);
  padding:6px 8px;margin-top:8px;cursor:pointer}
.nb-card button:hover{background:var(--ink);color:var(--void)}
.nb-au{font:10.5px/1.9 var(--mono);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nb-au i{font-style:normal;color:var(--dim2)}
.nb-empty{font:11px/1.8 var(--mono);color:var(--dim2)}

/* 输入 */
.nb-composer{position:fixed;left:196px;right:52px;bottom:0;padding:0 24px 14px;background:var(--void)}
.nb-cin{max-width:calc(var(--measure) + 76px);margin:0 auto;border-top:1px solid var(--line);
  padding:9px 24px 0 76px;display:flex;align-items:flex-end;gap:10px}
.nb-cin .cr{color:var(--cyan);font:12px/1 var(--mono);padding-bottom:7px}
.nb-cin textarea{flex:1;min-height:24px;max-height:160px;resize:none;background:none;border:0;
  color:var(--ink);font:15px/1.7 var(--sans);outline:none;padding:3px 0}
.nb-cin textarea::placeholder{color:var(--dim2)}
.nb-cin .h{font:10px/1 var(--mono);color:var(--dim2);padding-bottom:8px;white-space:nowrap}
.nb-cin .sd{font:10px/1 var(--mono);letter-spacing:.1em;color:var(--ink);background:none;
  border:1px solid var(--line);padding:7px 10px;cursor:pointer;margin-bottom:3px}
.nb-cin .sd:hover{background:var(--ink);color:var(--void)}
.nb-tick{position:fixed;left:196px;right:52px;bottom:64px;padding:0 24px;pointer-events:none}
.nb-tick div{max-width:calc(var(--measure) + 76px);margin:0 auto;font:10px/1.4 var(--mono);color:var(--dim2);
  padding-left:76px;text-align:right}

/* 醋酸片：过程盖在正文上 */
.nb-leaf{position:fixed;right:64px;bottom:78px;width:360px;max-height:56vh;overflow:auto;z-index:5;
  background:rgba(14,18,17,.96);
  backdrop-filter:blur(4px);border:1px solid rgba(233,240,242,.22);
  padding:18px 12px 12px}
.nb-leaf[hidden]{display:none}
.nb-leaf .holes{position:absolute;left:8px;top:8px;display:flex;gap:5px}
.nb-leaf .holes i{width:4px;height:4px;border:1px solid rgba(233,240,242,.35);border-radius:50%}
.nb-leaf h4{font:9px/1 var(--mono);letter-spacing:.16em;color:var(--dim);margin:0 0 9px;font-weight:400}
.nb-leaf .ln{font:11px/1.8 var(--mono);color:var(--ink);word-break:break-word}
.nb-leaf .ln b{color:var(--dim2);font-weight:400}
.nb-leaf .x{position:absolute;right:6px;top:6px;font:9px/1 var(--mono);color:var(--dim);background:none;
  border:1px solid var(--line-dim);padding:4px 6px;cursor:pointer}
</style></head>
<body>
<!--BOOT-->
<div class="nb">
  <div class="nb-top">
    <span><i class="nb-dot"></i><b id="nb-line">醒着</b></span>
    <span id="nb-counts"></span>
    <span class="sp"></span>
    <span id="nb-usd">今天 $0.000</span><span id="nb-model">—</span>
    <span id="nb-shell">记录本</span>
  </div>

  <div class="nb-main">
    <nav class="nb-index">
      <h2>记录</h2>
      <div id="nb-days"></div>
      <h2 style="margin-top:16px">去处</h2>
      <div class="nb-go" data-v="home">工作台</div>
      <div class="nb-go" data-v="sess">会话<span class="n" id="nb-nsess">…</span></div>
      <div class="nb-go" data-v="mem">记忆<span class="n" id="nb-nmem">…</span></div>
      <div class="nb-go" data-v="docs">文档<span class="n" id="nb-ndocs">…</span></div>
      <div class="nb-go" data-v="cap">能力</div>
      <div class="nb-go" data-v="logs">日志</div>
      <div class="nb-go" data-v="git">校样</div>
      <div class="nb-go" data-v="cfg">设置</div>
      <div class="nb-grow"></div>
      <div class="nb-go" id="nb-board-btn">她收着的<span class="n" id="nb-about">…</span></div>
      <div class="nb-go" id="nb-gap">还缺<span class="n" id="nb-gapn">…</span></div>
    </nav>

    <main class="nb-page" id="nb-page">
      <section id="nb-home"></section>
      <div id="nb-board" hidden></div>
      <div id="nb-view" hidden></div>
      <div class="nb-sheet" id="nb-log"></div>
    </main>

    <aside class="nb-tabs" id="nb-tabs">
      <div class="nb-rail">
        <button class="nb-tab" data-t="0" id="nb-t0">0<span class="c" id="nb-c0">0</span></button>
        <button class="nb-tab" data-t="1" id="nb-t1">I<span class="c" id="nb-c1">0</span></button>
        <button class="nb-tab" data-t="2" id="nb-t2">II<span class="c" id="nb-c2">0</span></button>
        <button class="nb-tab" data-t="3" id="nb-t3">III<span class="c" id="nb-c3">0</span></button>
      </div>
      <div class="nb-panel" id="nb-panel" hidden></div>
    </aside>
  </div>
</div>

<div class="nb-tick"><div id="nb-tickmsg"></div></div>
<div class="nb-pal" id="nb-pal" hidden>
  <div class="nb-palbox">
    <input id="nb-palq" class="nb-palin" placeholder="搜会话 / 记忆 / 文档 / 页面　⌘K 或 Ctrl+K 打开，Esc 关掉" autocomplete="off">
    <div id="nb-palist"></div>
  </div>
</div>
<div class="nb-composer" id="nb-composer">
  <div class="nb-cin">
    <span class="cr">›</span>
    <textarea id="nb-say" rows="1" placeholder="说点什么"></textarea>
    <span class="h">Enter 发送 · Shift+Enter 换行</span>
    <button class="sd" id="nb-stop" hidden>停止</button>
    <button class="sd" id="nb-send">发送</button>
  </div>
</div>
<div class="nb-leaf" id="nb-leaf" hidden>
  <div class="holes"><i></i><i></i></div>
  <button class="x" id="nb-leafx">×</button>
  <h4>过程 · 掀起来的这一页</h4>
  <div id="nb-leaflines"></div>
</div>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var H = { 'content-type':'application/json', 'x-jj':'1' };
  var TL = [], BOARD = false, CUR = 0, TAB = -1, BUSY = false, AV = {}, AC = null;

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  function tick(msg){
    $('nb-tickmsg').textContent = msg || '';
    if (!msg) return;
    setTimeout(function(){ if ($('nb-tickmsg').textContent === msg) $('nb-tickmsg').textContent = ''; }, 5000);
  }
  function hhmm(ts){
    try {
      var d = new Date(ts);
      var p = function(n){ return String(n).padStart(2,'0'); };
      return p(d.getHours()) + ':' + p(d.getMinutes());
    } catch(e){ return ''; }
  }

  // ── 顶栏与左栏 ────────────────────────────────
  function loadState(){
    fetch('/api/state').then(function(r){ return r.json(); }).then(function(j){
      if (j && j.line) $('nb-line').textContent = j.line;
    }).catch(function(){});
    fetch('/api/memories/summary').then(function(r){ return r.json(); }).then(function(j){
      $('nb-about').textContent = j.about == null ? '…' : j.about;
      var nm = $('nb-nmem'); if (nm) nm.textContent = j.total == null ? '…' : j.total;
      fetch('/api/sessions?limit=50').then(function(r){ return r.json(); }).then(function(x){
        var ns = $('nb-nsess'); if (ns) ns.textContent = String(((x && x.sessions) || []).length);
      }).catch(function(){});
      fetch('/api/docs').then(function(r){ return r.json(); }).then(function(rows){
        var nd = $('nb-ndocs');
        if (nd) nd.textContent = Array.isArray(rows) ? rows.length : '…';
      }).catch(function(){});
      $('nb-counts').textContent = '关于你 ' + (j.about||0) + ' 条' +
        (j.about7d ? ' · 本周 +' + j.about7d : '') + ' · 断片 ' + (j.outage||0);
    }).catch(function(){});
    fetch('/api/profile/gaps').then(function(r){ return r.json(); }).then(function(j){
      var g = (j && j.gaps) || [];
      $('nb-gapn').textContent = g.length ? (g.length + ' 件') : '齐了';
      $('nb-gap').className = 'nb-go' + (g.length ? ' warn' : '');
    }).catch(function(){});
  }

  function loadTimeline(){
    return fetch('/api/timeline').then(function(r){ return r.json(); }).then(function(blocks){
      TL = blocks || [];
      renderDays();
      renderLog();
    }).catch(function(){});
  }

  function renderDays(){
    var days = TL.filter(function(b){ return b.type === 'day'; });
    var html = '';
    var today = new Date();
    var p = function(n){ return String(n).padStart(2,'0'); };
    var todayLabel = today.getFullYear() + '-' + p(today.getMonth()+1) + '-' + p(today.getDate());
    html += '<div class="nb-day on" data-jump="' + todayLabel + '"><span class="mk"></span>' +
      '<span><span class="d">今天</span><span class="m">' + hhmm(today.toISOString()) + '</span></span></div>';
    days.slice(-8).reverse().forEach(function(d){
      var gap = d.gapMs ? ('距上次 ' + Math.round(d.gapMs/3600000) + ' 小时') : '';
      html += '<div class="nb-day" data-jump="' + esc(d.label) + '">' +
        '<span class="mk"></span><span><span class="d">' + esc(d.label) + '</span>' +
        '<span class="m">' + esc(gap) + '</span></span></div>';
    });
    $('nb-days').innerHTML = html;
    Array.prototype.forEach.call($('nb-days').querySelectorAll('.nb-day'), function(el){
      el.onclick = function(){
        Board(false);
        go('chat');
        Array.prototype.forEach.call($('nb-days').querySelectorAll('.nb-day'), function(x){ x.classList.remove('on'); });
        el.classList.add('on');
        var lab = el.getAttribute('data-jump');
        var marks = $('nb-log').querySelectorAll('.nb-daymark');
        for (var i = 0; i < marks.length; i++) {
          if ((marks[i].textContent || '').indexOf(lab) >= 0) { marks[i].scrollIntoView({ block:'start' }); return; }
        }
        $('nb-page').scrollTop = 0;
      };
    });
  }

  function evChips(b){
    var out = [];
    var tn = (b.tools || []).length;
    if (tn) out.push('工具 ' + tn + ' 次');
    if (b.cites && b.cites.length) out.push('引用 ' + b.cites.length + ' 条');
    if (b.omitted) out.push(b.omitted + ' 条本地记忆未发送');
    return out;
  }

  function loadAvatars(){
    fetch('/api/avatars').then(function(r){ return r.json(); }).then(function(j){
      AV = j || {};
      if (TL.length && $('nb-log')) renderLog();
    }).catch(function(){});
  }
  function renderLog(){
    var html = '', n = 0;
    TL.forEach(function(b){
      if (b.type === 'day') { html += '<div class="nb-daymark">' + esc(b.label) + '</div>'; return; }
      if (b.type !== 'msg') return;
      n++;
      var mine = b.role === 'user';
      var body = b.html || esc(b.text).split(String.fromCharCode(10)).join('<br>');
      var long = String(b.text || '').length > 420;
      var id = 'f' + (CUR++);
      html += '<article class="nb-e ' + (mine ? 'me' : 'her') + '">' +
        '<div class="g">' +
        (function(){
          var av = mine ? AV.user : AV.agent;
          return av && av.url ? '<img class="nb-gav" src="' + esc(av.url) + '" alt="">' : '';
        })() +
        hhmm(b.ts) + '<span class="w">' + (mine ? '你' : '她') + '</span></div>' +
        '<div class="b"><div class="nb-say"><div class="' + (long ? 'nb-fold' : '') + '" id="' + id + '">' +
        body + '</div></div>' +
        (evChips(b).length ? '<div class="nb-ev">' + evChips(b).map(function(t){ return '<span>' + esc(t) + '</span>'; }).join('') + '</div>' : '') +
        '</div></article>';
      if (long) {
        var holder = document.createElement('div');
        holder.innerHTML = html; html = '';
        var fold = holder.querySelector('#' + id);
        var btn = document.createElement('button');
        btn.className = 'nb-more';
        btn.textContent = '展开全文 · 还有 ' + Math.max(1, Math.round((String(b.text).length - 300) / 60)) + ' 行';
        btn.onclick = function(){ fold.classList.add('open'); btn.remove(); };
        fold.parentNode.parentNode.appendChild(btn);
        html = holder.innerHTML;
      }
    });
    $('nb-log').innerHTML = html;
    if (!n) $('nb-log').innerHTML = '<div class="nb-empty">还没有任何记录。说一句试试。</div>';
    // 折叠按钮（innerHTML 之后重新绑）
    Array.prototype.forEach.call($('nb-log').querySelectorAll('.nb-more'), function(btn){
      btn.onclick = function(){
        var prev = btn.previousElementSibling;
        var fold = prev ? prev.querySelector('.nb-fold') : null;
        if (fold) fold.classList.add('open');
        btn.remove();
      };
    });
    requestAnimationFrame(function(){
      $('nb-page').scrollTop = AT_BOTTOM ? $('nb-page').scrollHeight : 0;
    });
  }

  // ── 她收着的（标本页）─────────────────────────
  function Board(on){
    BOARD = !!on;
    $('nb-board').hidden = !on;
    $('nb-log').hidden = !!on;
    showHome(!on);
    $('nb-board-btn').className = 'nb-go' + (on ? ' cur' : '');
    if (on) loadBoard();
  }
  function loadBoard(){
    var el = $('nb-board');
    el.innerHTML = '<div class="nb-board"><h1>她收着的 · 关于你</h1><div class="nb-grid" id="nb-grid">' +
      '<div class="nb-empty">读取中…</div></div></div>';
    Promise.all([
      fetch('/api/proposals?status=open').then(function(r){ return r.json(); }).catch(function(){ return []; }),
      fetch('/api/memories?scope=about&limit=18').then(function(r){ return r.json(); }).catch(function(){ return []; }),
    ]).then(function(res){
      var props = Array.isArray(res[0]) ? res[0] : [];
      var mems = Array.isArray(res[1]) ? res[1] : [];
      var html = '';
      props.slice(0, 3).forEach(function(p){
        html += '<div class="nb-spec wait"><div class="k">要你点头</div>' +
          '<div class="v">' + esc(p.title || p.text || '') + '</div>' +
          '<div class="act"><button data-ok="' + esc(p.id) + '">同意</button>' +
          '<button data-no="' + esc(p.id) + '">不用</button></div>' +
          '<div class="lab"><span>她提的 · ' + esc(String(p.createdAt || '').slice(5,16).replace('T',' ')) + '</span><span>等你</span></div></div>';
      });
      var KIND = { boundary:'边界', promise:'承诺', fact_hard:'事实', fact:'事实',
        preference_hard:'偏好', preference_soft:'偏好', episode:'经历', thought:'想法',
        reading:'读来的', anchor:'锚点', contract:'契约', gist:'梗概' };
      mems.forEach(function(m){
        var w = Number(m.weight || 0);
        var fade = w < 0.35 ? ' fade' : '';
        html += '<div class="nb-spec' + fade + '"><div class="k">' + esc(KIND[m.kind] || m.kind || '记忆') + '</div>' +
          '<div class="v">' + esc(m.text) + '</div>' +
          '<div class="lab"><span>#' + esc(m.id) + '</span>' +
          '<span>' + (w >= 0.999 ? '契约 · 不衰减' : '鲜度 ' + w.toFixed(2)) + '</span></div></div>';
      });
      if (!props.length) html = '<div class="nb-empty" style="grid-column:1/-1;border:1px dashed var(--line-dim);padding:10px">' +
        '现在没有等你点头的事。</div>' + html;
      if (!mems.length && !props.length) html += '<div class="nb-empty" style="grid-column:1/-1">' +
        '还没有关于你的事。对她说一句「记住：…」。</div>';
      $('nb-grid').innerHTML = html;
      Array.prototype.forEach.call($('nb-grid').querySelectorAll('button[data-ok], button[data-no]'), function(b){
        b.onclick = function(){
          var ok = b.hasAttribute('data-ok');
          var id = ok ? b.getAttribute('data-ok') : b.getAttribute('data-no');
          fetch('/api/proposals/' + encodeURIComponent(id), {
            method:'POST', headers:H, body: JSON.stringify({ action: ok ? 'accept' : 'reject' })
          }).then(function(){ tick(ok ? '已同意' : '已拒绝'); loadBoard(); loadState(); }).catch(function(){});
        };
      });
    });
  }
  $('nb-board-btn').onclick = function(){ Board(!BOARD); if (!BOARD) renderLog(); };
  var gapBtn = $('nb-gap');
  if (gapBtn) gapBtn.onclick = function(){ go('gap'); };

  // ── 切口索引 ──────────────────────────────────
  function loadTabs(){
    fetch('/api/dossier').then(function(r){ return r.json(); }).then(function(d){
      var plan = (d.plan && (d.plan.agenda.length + d.plan.threads.length)) || 0;
      var chg = (d.changes || []).length;
      var ctx = d.context || {};
      $('nb-c1').textContent = plan;
      $('nb-c2').textContent = chg;
      $('nb-c3').textContent = ctx.memories == null ? '…' : ctx.memories;
      $('nb-model').textContent = ctx.model || '—';
      if (ctx.todayUsd != null) $('nb-usd').textContent = '今天 $' + Number(ctx.todayUsd).toFixed(3);
      window.__dossier = d;
    }).catch(function(){});
    fetch('/api/proposals?status=open').then(function(r){ return r.json(); }).then(function(j){
      var n = Array.isArray(j) ? j.length : 0;
      $('nb-c0').textContent = n;
      $('nb-t0').className = 'nb-tab' + (n ? ' wait' : '') + (TAB === 0 ? ' on' : '');
    }).catch(function(){});
  }

  function paintTab(i){
    Array.prototype.forEach.call(document.querySelectorAll('.nb-tab'), function(b){
      b.className = 'nb-tab' + (Number(b.getAttribute('data-t')) === 0 && Number($('nb-c0').textContent) > 0 ? ' wait' : '') +
        (Number(b.getAttribute('data-t')) === i ? ' on' : '');
    });
  }

  function showTab(i){
    var panel = $('nb-panel');
    if (TAB === i) { TAB = -1; panel.hidden = true; paintTab(-1); return; }
    TAB = i; panel.hidden = false; paintTab(i);
    var d = window.__dossier || {};
    if (i === 0) {
      panel.innerHTML = '<h3>等你点头</h3><div class="nb-empty">读取中…</div>';
      fetch('/api/proposals?status=open').then(function(r){ return r.json(); }).then(function(j){
        var rows = Array.isArray(j) ? j : [];
        panel.innerHTML = '<h3>等你点头 · ' + rows.length + '</h3>' + (rows.length ? rows.map(function(p){
          return '<div class="nb-card"><div class="t">' + esc(p.title || '') + '</div>' +
            '<div class="s">' + esc((p.why || '').slice(0, 60)) + '</div></div>';
        }).join('') : '<div class="nb-empty">没有等你点头的事。</div>');
      }).catch(function(){});
      return;
    }
    if (i === 1) {
      var ag = (d.plan && d.plan.agenda) || [], th = (d.plan && d.plan.threads) || [];
      panel.innerHTML = '<h3>计划 · ' + (ag.length + th.length) + '</h3>' + (ag.concat(th).length ?
        ag.map(function(x){ return '<div class="nb-card"><div class="t">' + esc(x.t) + '</div><div class="s">来自 ' + esc(x.from||'') + '</div></div>'; }).join('') +
        th.map(function(x){ return '<div class="nb-card"><div class="t">' + esc(x.t) + '</div><div class="s">' + esc(String(x.d||0)) + ' 天' + (x.aging?' · 变旧':'') + '</div></div>'; }).join('')
        : '<div class="nb-empty">手上没有未了的事。</div>');
      return;
    }
    if (i === 2) {
      var ch = d.changes || [];
      panel.innerHTML = '<h3>改动 · ' + ch.length + '</h3>' + (ch.length ? ch.map(function(c){
        return '<div class="nb-au"><i>' + esc(String(c.ts||'').slice(11,16)) + '</i> ' + esc(c.verb) + ' · ' + esc(String(c.argv||'').slice(0,48)) + '</div>';
      }).join('') : '<div class="nb-empty">这一轮还没动过东西。</div>');
      return;
    }
    var ctx = d.context || {};
    panel.innerHTML = '<h3>上下文</h3>' +
      '<div class="nb-au">记忆 ' + esc(ctx.memories) + ' · 文档 ' + esc(ctx.docs) + ' 篇 / ' + esc(ctx.chunks) + ' 块</div>' +
      '<div class="nb-au">工具 ' + esc(ctx.tools) + ' · 技能 ' + esc(ctx.skills) + '</div>' +
      '<div class="nb-au">模型 ' + esc(ctx.model || '—') + '</div>' +
      '<div class="nb-au">今天 ' + esc(ctx.todayTokens) + ' tok · $' + esc(Number(ctx.todayUsd||0).toFixed(3)) + '</div>';
  }
  Array.prototype.forEach.call(document.querySelectorAll('.nb-tab'), function(b){
    b.onclick = function(){ showTab(Number(b.getAttribute('data-t'))); };
  });

  // ── 醋酸片（过程）─────────────────────────────
  var LEAF = [];
  function leafAdd(kind, text){
    LEAF.push({ k: kind, t: String(text || '').slice(0, 400) });
    if (LEAF.length > 40) LEAF.shift();
    paintLeaf();
  }
  function paintLeaf(){
    if (!LEAF.length) { $('nb-leaf').hidden = true; return; }
    $('nb-leaf').hidden = false;
    $('nb-leaflines').innerHTML = LEAF.map(function(x){
      return '<div class="ln"><b>' + esc(x.k) + '</b> ' + esc(x.t) + '</div>';
    }).join('');
    $('nb-leaf').scrollTop = $('nb-leaf').scrollHeight;
  }
  $('nb-leafx').onclick = function(){ LEAF = []; paintLeaf(); };

  // ── 发一句话 ──────────────────────────────────
  function send(){
    if (BUSY) return;
    var ta = $('nb-say');
    var text = (ta.value || '').trim();
    if (!text) return;
    BUSY = true; AT_BOTTOM = true; ta.value = ''; ta.style.height = '24px';
    AC = new AbortController();
    var stopBtn = $('nb-stop'); if (stopBtn) stopBtn.hidden = false;
    LEAF = []; paintLeaf();

    var mine = document.createElement('article');
    mine.className = 'nb-e me';
    mine.innerHTML = '<div class="g">' + hhmm(new Date().toISOString()) + '<span class="w">你</span></div>' +
      '<div class="b"><div class="nb-say"><div>' + esc(text) + '</div></div></div>';
    $('nb-log').appendChild(mine);

    var her = document.createElement('article');
    her.className = 'nb-e her';
    her.innerHTML = '<div class="g">' + hhmm(new Date().toISOString()) + '<span class="w">她</span></div>' +
      '<div class="b"><div class="nb-say"><div id="nb-live"></div></div></div>';
    $('nb-log').appendChild(her);
    $('nb-page').scrollTop = $('nb-page').scrollHeight;

    fetch('/api/say', { method:'POST', headers:H, body: JSON.stringify({ text: text }), signal: AC ? AC.signal : undefined }).then(function(res){
      if (!res.ok || !res.body) throw new Error('E_HTTP');
      var rd = res.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump(){
        return rd.read().then(function(r){
          if (r.done) return;
          buf += dec.decode(r.value, { stream:true });
          var parts = buf.split(String.fromCharCode(10,10));
          buf = parts.pop();
          parts.forEach(function(frame){
            var line = frame.trim();
            if (line.indexOf('data: ') !== 0) return;
            var ev;
            try { ev = JSON.parse(line.slice(6)); } catch(e){ return; }
            if (ev.type === 'delta') {
              var live = $('nb-live'); if (live) live.textContent += ev.text;
              $('nb-page').scrollTop = $('nb-page').scrollHeight;
            } else if (ev.type === 'think') {
              leafAdd('想', ev.text);
            } else if (ev.type === 'tool') {
              leafAdd('用', ev.name + ' ' + String(ev.args || '').slice(0, 80));
            } else if (ev.type === 'notice' || ev.type === 'memo') {
              tick(ev.text);
            } else if (ev.type === 'error') {
              tick(ev.message);
            }
          });
          return pump();
        });
      }
      return pump();
    }).then(function(){
      BUSY = false; AC = null;
      var sb = $('nb-stop'); if (sb) sb.hidden = true;
      go('chat');
      return loadTimeline().then(function(){
        loadState(); loadTabs();
        requestAnimationFrame(function(){ $('nb-page').scrollTop = $('nb-page').scrollHeight; });
      });
    }).catch(function(){
      BUSY = false; AC = null;
      var sb2 = $('nb-stop'); if (sb2) sb2.hidden = true;
      var live = $('nb-live'); if (live) live.textContent = '（这一轮没接上，看右上角状态）';
      tick('发送失败');
    });
  }
  $('nb-send').onclick = send;
  var stopEl = $('nb-stop');
  if (stopEl) stopEl.onclick = function(){
    if (AC) { try { AC.abort(); } catch (e) {} }
    BUSY = false;
    stopEl.hidden = true;
    tick('已停止这一轮');
  };
  $('nb-say').addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('nb-say').addEventListener('input', function(){
    this.style.height = 'auto'; this.style.height = Math.min(160, this.scrollHeight) + 'px';
  });

  // ── 工作台（编号分节 + 三张状态卡 + 健康格）────────────
  var USD = String.fromCharCode(36);
  function showHome(on){ var h = $('nb-home'); if (h) h.hidden = !on; }
  function loadHome(){
    var el = $('nb-home');
    if (!el) return;
    Promise.all([
      fetch('/api/state').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/memories/summary').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/proposals?status=open').then(function(r){ return r.json(); }).catch(function(){ return []; }),
      fetch('/api/dossier').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/health').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/usage').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/night/due').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/egress').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/skills').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/activity?limit=8').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
    ]).then(function(res){
      var st = res[0] || {}, sum = res[1] || {}, props = Array.isArray(res[2]) ? res[2] : [];
      var dors = res[3] || {}, health = res[4] || {};
      var use = res[5] || {}, night = res[6] || {}, eg = res[7] || {};
      var sk = res[8] || {}, act = res[9] || {};
      var ctx = dors.context || {};
      var deg = health.degraded || [];
      var d = new Date();
      var wd = ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()];
      var p2 = function(n){ return String(n).padStart(2, '0'); };
      var date = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
      var h0 = d.getHours();
      var hello = h0 < 6 ? '凌晨好' : h0 < 12 ? '早上好' : h0 < 18 ? '下午好' : '晚上好';
      var about = sum.about == null ? '…' : sum.about;
      var hc = function(k, v, bad){
        return '<div class="nb-hc' + (bad ? ' bad' : '') + '"><div class="k">' + k +
          '</div><div class="v">' + esc(v) + '</div></div>';
      };
      el.innerHTML = '<div class="nb-home">' +
        '<div class="nb-kicker">№ 001 · 工作台</div>' +
        '<h1 class="nb-greet">' + hello + '。<em>她记得 ' + esc(String(about)) + ' 件关于你的事。</em></h1>' +
        '<div class="nb-meta">' + date + ' · ' + wd + ' · ' + esc(String(st.line || '醒着')) +
          ' · 今天 ' + USD + Number(ctx.todayUsd || 0).toFixed(3) + '</div>' +
        '<div class="nb-cards">' +
          '<button class="nb-card2' + (props.length ? ' wait' : '') + '" data-home="wait"><span class="k">待你处理</span><b>' +
            props.length + '</b><span class="m">批准 / 拒绝</span></button>' +
          '<button class="nb-card2" data-home="board"><span class="k">她记得</span><b>' + esc(String(about)) +
            '</b><span class="m">关于你 · 本周 +' + Number(sum.about7d || 0) + '</span></button>' +
          '<button class="nb-card2" data-home="cfg"><span class="k">状态</span><b>' +
            (deg.length ? '有 ' + deg.length + ' 项' : '正常') + '</b><span class="m">' +
            (deg.length ? esc(deg.slice(0, 2).join(' · ')) : 'degraded 0') + '</span></button>' +
        '</div>' +
        '<div class="nb-health">' +
          hc('模型', ctx.model || '—') +
          hc('记忆', String(ctx.memories == null ? '…' : ctx.memories)) +
          hc('文档', String(ctx.docs == null ? '…' : ctx.docs) + '/' + String(ctx.chunks == null ? '…' : ctx.chunks)) +
          hc('工具', String(ctx.tools == null ? '…' : ctx.tools)) +
          hc('技能', String(ctx.skills == null ? '…' : ctx.skills)) +
          hc('断片', String(sum.outage == null ? '…' : sum.outage), Number(sum.outage || 0) > 0) +
        '</div>' +
        '<div class="nb-sec">§ 02 进行中</div>' +
        '<div class="nb-run">' +
          '<div class="nb-runrow"><span class="k">正在跑</span><span class="v">' +
            (night.running ? '夜里那次整理正在跑' : '没有在跑的后台任务') + '</span>' +
            '<span class="m">' + (night.lastAt ? '上次整理 ' + esc(String(night.lastAt).slice(5, 16).replace('T', ' ')) : '还没整理过') + '</span></div>' +
          '<div class="nb-runrow"><span class="k">已花</span><span class="v">' + USD +
            Number(use.todayUsd || 0).toFixed(3) + '</span><span class="m">今天 ' + Number(use.calls || 0) +
            ' 次调用 · ' + Number(use.inTokens || 0) + '/' + Number(use.outTokens || 0) + ' tok</span></div>' +
          '<div class="nb-runrow"><span class="k">等批准</span><span class="v">' +
            (props.length + (Array.isArray(eg.pending) ? eg.pending.length : Number(eg.pending || 0) || 0)) +
            '</span><span class="m">' + props.length + ' 个提议' +
            ((Array.isArray(eg.pending) && eg.pending.length) ? ' · ' + eg.pending.length + ' 个外发' : '') + '</span></div>' +
        '</div>' +
        '<div class="nb-actrow" style="margin:10px 0 2px">' +
        '<button class="nb-btn" id="nb-night">现在整理一次</button>' +
        '<span class="nb-empty" id="nb-nightmsg">夜里那次整理；手动跑一次不写游标也行</span></div>' +
        '<div class="nb-sec">§ 03 配方</div>' +
        ((sk.skills || []).length ? '<div class="nb-grid2">' + (sk.skills || []).slice(0, 6).map(function(x){
          return '<button class="nb-recipe" data-skill="' + esc(x.id) + '">' +
            '<span class="n">' + esc(x.name || x.id) + '</span>' +
            '<span class="d">' + esc(String(x.description || '').slice(0, 60)) + '</span></button>';
        }).join('') + '</div>' : '<div class="nb-empty">还没有技能。把 SKILL.md 放进 data/skills 就会出现在这里。</div>') +
        '<div class="nb-sec">§ 04 活动</div>' +
        ((act.items || []).length ? (act.items || []).map(function(x){
          var mine = x.role === 'user';
          return '<div class="nb-actline"' + (x.session ? ' data-sess="' + esc(x.session) + '"' : '') + '>' +
            '<span class="t">' + esc(String(x.ts || '').slice(5, 16).replace('T', ' ')) + '</span>' +
            '<span class="w">' + (mine ? '你' : '她') + '</span>' +
            '<span class="x">' + esc(String(x.text || '').slice(0, 60)) + '</span></div>';
        }).join('') : '<div class="nb-empty">还没有动静。</div>') +
        '<div class="nb-actrow" style="margin-top:18px">' +
        '<button class="nb-btn" id="nb-gochat">进入记录 · 继续说话</button></div>' +
        '</div>';
      var nb = $('nb-night');
      if (nb) nb.onclick = function(){
        var msg = $('nb-nightmsg');
        nb.disabled = true;
        if (msg) msg.textContent = '整理中…（本地模型，可能要几十秒）';
        fetch('/api/night/run', { method: 'POST', headers: H, body: '{}' })
          .then(function(r){ return r.json(); }).then(function(j){
            if (msg) msg.textContent = j.ok ? '整理完了（退出码 ' + j.code + '）' : ('没整理成：' + (j.why || j.error || j.code || '?'));
            nb.disabled = false;
            loadHome(); loadState();
          }).catch(function(){
            if (msg) msg.textContent = '没整理成（请求失败）';
            nb.disabled = false;
          });
      };
      var gc = $('nb-gochat');
      if (gc) gc.onclick = function(){ go('chat'); };
      Array.prototype.forEach.call(el.querySelectorAll('[data-skill]'), function(b){
        b.onclick = function(){
          go('chat');
          var ta = $('nb-say');
          if (ta) { ta.value = '/' + b.getAttribute('data-skill') + ' '; ta.focus(); }
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll('[data-sess]'), function(b){
        b.onclick = function(){ sessDetail(b.getAttribute('data-sess')); };
      });
      Array.prototype.forEach.call(el.querySelectorAll('[data-home]'), function(b){
        b.onclick = function(){
          var w = b.getAttribute('data-home');
          if (w === 'wait') go('approvals');
          else if (w === 'board') Board(true);
          else if (w === 'cfg') go('cfg');
          else showTab(0);
        };
      });
    }).catch(function(){});
  }
  // ── 还缺：她还没弄明白的六件事（答完就写成契约，不会衰减）──────
  function gapView(){
    var el = $('nb-view');
    el.innerHTML = head('还缺', '<button class="nb-btn" id="nb-gback">← 回记录</button>') +
      wrap('<div id="nb-gaps"><div class="nb-empty">读取中…</div></div>');
    var back = $('nb-gback'); if (back) back.onclick = function(){ go('chat'); };
    fetch('/api/profile/gaps').then(function(r){ return r.json(); }).then(function(j){
      var gaps = (j && j.gaps) || [];
      var done = Number((j && j.answered) || 0), total = Number((j && j.total) || gaps.length);
      var box = $('nb-gaps');
      if (!gaps.length) {
        box.innerHTML = '<div class="nb-empty">六道题都答完了（' + done + ' / ' + total + '）。</div>';
        return;
      }
      box.innerHTML = '<div class="nb-empty">已答 ' + done + ' / ' + total + '。答完的会直接写成契约（不衰减）。</div>' +
        gaps.map(function(g, i){
          var id = 'gapin-' + i;
          return '<div class="nb-gapq">' +
            '<div class="nb-gapt">' + esc(g.question) +
            '<span class="m">' + esc(g.why || '') + '</span></div>' +
            '<div class="nb-actrow"><input class="nb-search" id="' + id + '" placeholder="写一句就行" data-k="' + esc(g.key) + '">' +
            '<button class="nb-btn" data-save="' + id + '">记住</button></div></div>';
        }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-save]'), function(b){
        b.onclick = function(){
          var inp = $(b.getAttribute('data-save'));
          if (!inp || !inp.value.trim()) return;
          fetch('/api/profile/answer', { method: 'POST', headers: H,
            body: JSON.stringify({ key: inp.getAttribute('data-k'), text: inp.value.trim() }) })
            .then(function(r){ return r.json(); }).then(function(r){
              if (r.ok) { tick('记下了'); gapView(); loadState(); }
              else tick(r.why || r.error || '没记上');
            });
        };
      });
    }).catch(function(){
      var box = $('nb-gaps'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
    });
  }

  // ── 待你处理：提议 + 代码外发（2026-11-05）──────────────────
  function approvalsView(){
    var el = $('nb-view');
    el.innerHTML = head('待你处理') + wrap('<div id="nb-appr"><div class="nb-empty">读取中…</div></div>');
    function paint(){
      fetch('/api/approvals').then(function(r){ return r.json(); }).then(function(j){
        var items = (j && j.items) || [];
        var box = $('nb-appr');
        if (!items.length) { box.innerHTML = '<div class="nb-empty">没有等你点头的事。</div>'; return; }
        box.innerHTML = items.map(function(x, i){
          var isP = x.kind === 'proposal';
          return '<div class="nb-appr">' +
            '<div class="nb-gapt">' + esc(x.title || '') + '<span class="m">' + esc(x.kind) + ' · ' + esc(String(x.at || '').slice(0, 16).replace('T', ' ')) + '</span></div>' +
            (x.detail ? '<div class="nb-empty">' + esc(x.detail) + '</div>' : '') +
            '<div class="nb-actrow">' +
            (isP
              ? '<button class="nb-btn" data-ok="' + i + '">同意</button><button class="nb-btn" data-no="' + i + '">不用</button>'
              : '<button class="nb-btn" data-ok="' + i + '">允许一次</button>') +
            '</div></div>';
        }).join('') +
        '<div class="nb-actrow" style="margin-top:14px"><button class="nb-btn" id="nb-egoff">收回全部外发授权</button></div>';
        Array.prototype.forEach.call(box.querySelectorAll('[data-ok]'), function(b){
          b.onclick = function(){
            var it = items[Number(b.getAttribute('data-ok'))];
            if (!it) return;
            var req = it.kind === 'proposal'
              ? fetch(it.route, { method: 'POST', headers: H, body: JSON.stringify({ action: 'accept', reason: '我同意，你来做' }) })
              : fetch('/api/egress', { method: 'POST', headers: H, body: JSON.stringify({ action: 'once', path: String(it.id).replace('egress:', '') }) });
            req.then(function(){ tick('已同意'); paint(); loadState(); });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-no]'), function(b){
          b.onclick = function(){
            var it = items[Number(b.getAttribute('data-no'))];
            if (!it) return;
            fetch(it.route, { method: 'POST', headers: H, body: JSON.stringify({ action: 'reject', reason: '不做' }) })
              .then(function(){ tick('已拒绝'); paint(); loadState(); });
          };
        });
        var off = $('nb-egoff');
        if (off) off.onclick = function(){
          fetch('/api/egress', { method: 'POST', headers: H, body: JSON.stringify({ action: 'revoke' }) })
            .then(function(){ tick('外发授权已收回'); paint(); loadState(); });
        };
      }).catch(function(){
        var box = $('nb-appr'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
      });
    }
    paint();
  }

  // ── 日志：执行层审计（2026-11-05）────────────────────────────
  function logsView(){
    var el = $('nb-view');
    el.innerHTML = head('日志', '<input class="nb-search" id="nb-logq" placeholder="过滤 verb / 参数 / 决定" style="max-width:260px;margin:0">') +
      wrap('<div id="nb-logs"><div class="nb-empty">读取中…</div></div>');
    function paint(q){
      fetch('/api/logs?limit=200' + (q ? '&q=' + encodeURIComponent(q) : '')).then(function(r){ return r.json(); }).then(function(j){
        var items = (j && j.items) || [];
        var box = $('nb-logs');
        if (!items.length) { box.innerHTML = '<div class="nb-empty">还没有执行记录。' + (q ? '（过滤条件下）' : '') + '</div>'; return; }
        box.innerHTML = items.map(function(x){
          var ok = x.decision === 'allow' || x.decision === 'allowed';
          return '<div class="nb-logrow" data-i="' + esc(JSON.stringify(x).slice(0, 0)) + '">' +
            '<span class="t">' + esc(String(x.ts || '').slice(5, 19).replace('T', ' ')) + '</span>' +
            '<span class="v">' + esc(x.verb) + '</span>' +
            '<span class="d ' + (ok ? 'ok' : 'bad') + '">' + esc(x.decision || '') + '</span>' +
            '<span class="x">' + (x.exit == null ? '' : 'exit ' + x.exit) + (x.ms == null ? '' : ' · ' + x.ms + 'ms') + '</span>' +
            '<span class="a">' + esc(String(x.argv || '').slice(0, 70)) + '</span>' +
            '</div>' +
            (x.why ? '<div class="nb-audit">拒因：' + esc(x.why) + '</div>' : '');
        }).join('');
      }).catch(function(){
        var box = $('nb-logs'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
      });
    }
    var q = $('nb-logq');
    if (q) q.onkeydown = function(e){ if (e.key === 'Enter') paint(q.value.trim()); };
    paint('');
  }

  // ── 会话：一次可指认的对话（2026-11-05）────────────────────────
  function sessView(){
    var el = $('nb-view');
    el.innerHTML = head('会话') + wrap('<div id="nb-sess"><div class="nb-empty">读取中…</div></div>');
    fetch('/api/sessions').then(function(r){ return r.json(); }).then(function(j){
      var rows = (j && j.sessions) || [];
      var box = $('nb-sess');
      if (!rows.length) { box.innerHTML = '<div class="nb-empty">还没有会话。去「记录」说一句就有第一次了。</div>'; return; }
      box.innerHTML = rows.map(function(x){
        var t = String(x.title || '（没起标题）');
        return '<button class="nb-row" data-sess="' + esc(x.id) + '">' + esc(t) +
          '<span class="m">' + esc(String(x.updated_at).slice(5, 16).replace('T', ' ')) +
          ' · ' + Number(x.msgs || 0) + ' 条 · ' + esc(x.status) + '</span></button>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-sess]'), function(b){
        b.onclick = function(){ sessDetail(b.getAttribute('data-sess')); };
      });
    }).catch(function(){
      var box = $('nb-sess'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
    });
  }

  function sessDetail(id){
    var el = $('nb-view');
    el.innerHTML = head('会话', '<button class="nb-btn" id="nb-sback">← 回会话</button>') +
      wrap('<div id="nb-sdetail"><div class="nb-empty">读取中…</div></div>');
    var back = $('nb-sback'); if (back) back.onclick = function(){ sessView(); };
    fetch('/api/sessions/' + encodeURIComponent(id)).then(function(r){ return r.json(); }).then(function(j){
      var msgs = (j && j.messages) || [];
      var tools = (j && j.tools) || [];
      var meta = (j && j.session) || {};
      // 文件：工具参数里像路径的那些；终端：跑过命令的工具
      var files = tools.filter(function(t){ return /(^|[\\/])[\w.-]+\.(ts|js|mjs|json|md|html|css|py|ps1|sh)$/.test(String(t.args || '')); });
      var terms = tools.filter(function(t){ return /shell|run|exec|bash|pwsh/i.test(String(t.name || '')); });
      var tab = function(k, label, n){
        return '<button class="nb-jump' + (k === 'msgs' ? ' on' : '') + '" data-tab="' + k + '">' + label +
          (n == null ? '' : ' ' + n) + '</button>';
      };
      var head2 = '<div class="nb-kv"><b>开始</b><span>' + esc(String(meta.created_at || '').slice(0, 16).replace('T', ' ')) + '</span>' +
        '<b>状态</b><span>' + esc(meta.status || '—') + '</span>' +
        '<b>条数</b><span>' + Number(meta.msgs || 0) + '</span></div>';
      var acts = '<div class="nb-actrow" style="margin:6px 0 10px">' +
        '<button class="nb-btn" id="nb-branch">从这里分叉</button>' +
        '<button class="nb-btn" id="nb-undo">撤回最后一轮</button></div>';
      var tabs = '<div class="nb-jumpbar" style="position:static;border-top:0;border-bottom:1px solid var(--line-dim)">' +
        tab('msgs', '记录', msgs.length) + tab('turns', '轮次', null) + tab('files', '文件', files.length) + tab('term', '终端', terms.length) + '</div>';
      var bodyMsgs = msgs.length ? msgs.map(function(m){
        var mine = m.role === 'user';
        return '<div class="nb-e ' + (mine ? 'me' : 'her') + '" style="border-top:1px solid var(--line-dim)">' +
          '<div class="g">' + esc(String(m.ts || '').slice(11, 16)) +
          '<span class="w">' + (mine ? '你' : '她') + '</span></div>' +
          '<div class="b"><div class="nb-say"><div>' + esc(String(m.text || '').slice(0, 1200)) + '</div></div></div></div>';
      }).join('') : '<div class="nb-empty">这次会话没有留下消息。</div>';
      var bodyFiles = files.length ? files.map(function(t){
        return '<div class="nb-runrow"><span class="k">' + esc(String(t.name || '')) + '</span>' +
          '<span class="v">' + esc(String(t.args || '').slice(0, 160)) + '</span><span></span></div>';
      }).join('') : '<div class="nb-empty">这次会话没碰过文件。</div>';
      var bodyTerm = terms.length ? terms.map(function(t){
        return '<div class="nb-pre">$ ' + esc(String(t.args || '').slice(0, 300)) +
          String.fromCharCode(10) + esc(String(t.result || '').slice(0, 800)) + '</div>';
      }).join('') : '<div class="nb-empty">这次会话没跑过命令。</div>';
      var bodyTurns = '<div id="nb-turns"><div class="nb-empty">读取中…</div></div>';
      $('nb-sdetail').innerHTML = head2 + acts + tabs +
        '<div id="nb-stab-msgs">' + bodyMsgs + '</div>' +
        '<div id="nb-stab-turns" hidden>' + bodyTurns + '</div>' +
        '<div id="nb-stab-files" hidden>' + bodyFiles + '</div>' +
        '<div id="nb-stab-term" hidden>' + bodyTerm + '</div>';
      var br = $('nb-branch');
      if (br) br.onclick = function(){ fetch('/api/sessions/' + encodeURIComponent(id) + '/branch', { method: 'POST', headers: H, body: '{}' }).then(function(){ tick('已分叉'); sessView(); }); };
      var un = $('nb-undo');
      if (un) un.onclick = function(){ fetch('/api/sessions/' + encodeURIComponent(id) + '/undo', { method: 'POST', headers: H, body: '{}' }).then(function(){ tick('已撤回最后一轮'); sessDetail(id); }); };
      // 轮次：一问一答一行，按钮各自独立
      fetch('/api/sessions/' + encodeURIComponent(id) + '/turns').then(function(r){ return r.json(); }).then(function(tj){
        var turns = (tj && tj.turns) || [];
        var box = $('nb-turns');
        if (!box) return;
        box.innerHTML = turns.length ? turns.map(function(t, i){
          return '<div class="nb-turn">' +
            '<div class="nb-gapt">' + (i + 1) + '. ' + esc(String(t.user || '').slice(0, 80)) +
            '<span class="m">' + esc(String(t.userTs || '').slice(11, 16)) +
            (t.agentTs ? ' · 答 ' + esc(String(t.agentTs).slice(11, 16)) : ' · 没答') +
            (t.tools ? ' · ' + t.tools + ' 个工具' : '') + '</span></div>' +
            (t.agent ? '<div class="nb-sub">' + esc(String(t.agent).slice(0, 220)) + '</div>' : '') +
            '<div class="nb-actrow">' +
            '<button class="nb-btn" data-tundo="' + esc(t.id) + '">撤回这一轮</button>' +
            '<button class="nb-btn" data-tretry="' + esc(t.id) + '">重问</button>' +
            '<button class="nb-btn" data-tsteer="' + esc(t.id) + '">引导重答</button>' +
            '<button class="nb-btn" data-taudit="' + esc(t.id) + '">这一轮的审计</button>' +
            '</div><div class="nb-audit" id="aud-' + esc(t.id) + '"></div></div>';
        }).join('') : '<div class="nb-empty">还没有轮次。</div>';
        Array.prototype.forEach.call(box.querySelectorAll('[data-tundo]'), function(b){
          b.onclick = function(){
            var tid = b.getAttribute('data-tundo');
            fetch('/api/sessions/' + encodeURIComponent(id) + '/turns/' + tid + '/undo', { method: 'POST', headers: H, body: '{}' })
              .then(function(){ tick('已撤回这一轮'); sessDetail(id); });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-tretry]'), function(b){
          b.onclick = function(){
            var tid = b.getAttribute('data-tretry');
            fetch('/api/sessions/' + encodeURIComponent(id) + '/turns/' + tid + '/retry', { method: 'POST', headers: H, body: '{}' })
              .then(function(r){ return r.json(); }).then(function(j){
                go('chat');
                var ta = $('nb-say');
                if (ta && j.text) { ta.value = j.text; ta.focus(); tick('原话已填回输入框，回车重问'); }
              });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-tsteer]'), function(b){
          b.onclick = function(){
            var tid = b.getAttribute('data-tsteer');
            var note = window.prompt('要她怎么重答？（比如：短一点 / 说具体数字 / 别用列表）');
            if (!note) return;
            b.textContent = '重答中…';
            fetch('/api/sessions/' + encodeURIComponent(id) + '/turns/' + tid + '/steer', { method: 'POST', headers: H, body: JSON.stringify({ note: note }) })
              .then(function(r){ return r.json(); }).then(function(j){
                if (j.ok) { tick('已重答'); sessDetail(id); } else { tick(j.why || j.error || '没答成'); b.textContent = '引导重答'; }
              }).catch(function(){ tick('没答成'); b.textContent = '引导重答'; });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-taudit]'), function(b){
          b.onclick = function(){
            var tid = b.getAttribute('data-taudit');
            var out = document.getElementById('aud-' + tid);
            if (!out) return;
            out.textContent = '读取中…';
            fetch('/api/sessions/' + encodeURIComponent(id) + '/turns/' + tid + '/audit', { method: 'POST', headers: H, body: '{}' })
              .then(function(r){ return r.json(); }).then(function(j){
                var rows = (j && j.audit) || [];
                out.innerHTML = rows.length ? rows.map(function(a){
                  return '<div class="nb-au">' + esc(String(a.ts || '').slice(11, 19)) + ' ' + esc(a.verb) +
                    ' · ' + esc(a.decision) + (a.exit == null ? '' : ' · exit ' + a.exit) + '</div>';
                }).join('') : '<div class="nb-empty">这一轮没有经过执行层的动作。</div>';
              }).catch(function(){ out.textContent = '读取失败'; });
          };
        });
      }).catch(function(){ var box = $('nb-turns'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>'; });
      Array.prototype.forEach.call($('nb-sdetail').querySelectorAll('[data-tab]'), function(b){
        b.onclick = function(){
          var k = b.getAttribute('data-tab');
          Array.prototype.forEach.call($('nb-sdetail').querySelectorAll('[data-tab]'), function(x){ x.className = 'nb-jump'; });
          b.className = 'nb-jump on';
          ['msgs', 'turns', 'files', 'term'].forEach(function(t){
            var e = $('nb-stab-' + t); if (e) e.hidden = t !== k;
          });
        };
      });
    }).catch(function(){
      var box = $('nb-sdetail'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
    });
  }

  // ── 去处：记忆 / 文档 / 能力 / 校样 / 设置 ──────────────────
  var KIND = { boundary:'边界', promise:'承诺', fact_hard:'事实', fact:'事实',
    preference_hard:'偏好', preference_soft:'偏好', episode:'经历', thought:'想法',
    reading:'读来的', anchor:'锚点', contract:'契约', gist:'梗概' };
  var VIEW = 'home', AT_BOTTOM = false;
  function head(title, extra){
    return '<div class="nb-pagehd"><h1>' + esc(title) + '</h1><span class="sp"></span>' +
      (extra || '') + '</div>';
  }
  function wrap(html){ return '<div class="nb-wrap">' + html + '</div>'; }
  function go(v){
    VIEW = v;
    Array.prototype.forEach.call(document.querySelectorAll('.nb-go[data-v]'), function(x){
      x.className = 'nb-go' + (x.getAttribute('data-v') === v ? ' cur' : '');
    });
    var home = v === 'home';
    var chat = v === 'chat';
    // 三块面一次只露一块：工作台 / 记录（对话） / 其余（记忆/文档/设置…）
    showHome(home);
    $('nb-log').hidden = !chat;
    $('nb-board').hidden = true;
    $('nb-view').hidden = home || chat;
    var cb = $('nb-composer'); if (cb) cb.hidden = !chat;
    // 记录页是纯文字：右栏那四个切口是工作台的东西，不该跟着对话流杵在旁边
    var tb = $('nb-tabs'); if (tb) tb.hidden = home || chat;
    // 右栏撤掉时，输入区要跟着铺到右边，不然留一条 52px 的空白
    var railGone = home || chat;
    var cbx = $('nb-composer'); if (cbx) cbx.style.right = railGone ? '0px' : '52px';
    var tk = document.querySelector('.nb-tick'); if (tk) tk.style.right = railGone ? '0px' : '52px';
    $('nb-board-btn').className = 'nb-go';
    var el = $('nb-view');
    if (home) { $('nb-page').scrollTop = 0; return; }
    if (chat) { AT_BOTTOM = true; $('nb-page').scrollTop = $('nb-page').scrollHeight; return; }
    if (v === 'mem') memView('');
    else if (v === 'docs') docsView();
    else if (v === 'cap') capView();
    else if (v === 'logs') logsView();
    else if (v === 'git') gitView();
    else if (v === 'cfg') cfgView();
    else if (v === 'gap') gapView();
    else if (v === 'sess') sessView();
    else if (v === 'approvals') approvalsView();
    else el.innerHTML = head('？') + wrap('<div class="nb-empty">没有这一页。</div>');
  }
  Array.prototype.forEach.call(document.querySelectorAll('.nb-go[data-v]'), function(b){
    b.onclick = function(){ go(b.getAttribute('data-v')); };
  });

  function memView(q){
    var el = $('nb-view');
    el.innerHTML = head('记忆 · ' + (q ? '搜「' + esc(q) + '」' : '全部')) +
      wrap('<input class="nb-search" id="nb-mq" placeholder="搜记忆（回车）" value="' + esc(q || '') + '">' +
        '<div id="nb-mlist"><div class="nb-empty">读取中…</div></div>');
    var box = $('nb-mq');
    if (box) {
      box.onkeydown = function(e){ if (e.key === 'Enter') memView(box.value.trim()); };
      box.focus();
    }
    var url = q ? '/api/memories?q=' + encodeURIComponent(q) : '/api/memories?limit=80';
    fetch(url).then(function(r){ return r.json(); }).then(function(rows){
      if (!Array.isArray(rows)) rows = [];
      var list = $('nb-mlist');
      list.innerHTML = rows.length ? rows.map(function(m){
        return '<button class="nb-row" data-mem="' + m.id + '">' +
          '<span class="tag">' + esc(KIND[m.kind] || m.kind || '') + '</span>' +
          esc(String(m.text).slice(0, 110)) +
          '<span class="m">#' + m.id + ' · ' + esc(m.stage) + ' · ' + Number(m.weight).toFixed(2) + '</span></button>';
      }).join('') : '<div class="nb-empty">没有匹配的记忆。</div>';
      Array.prototype.forEach.call(list.querySelectorAll('[data-mem]'), function(b){
        b.onclick = function(){ memDetail(Number(b.getAttribute('data-mem'))); };
      });
    }).catch(function(){
      var list = $('nb-mlist');
      if (list) list.innerHTML = '<div class="nb-empty">读取失败。</div>';
    });
  }

  function memDetail(id){
    var el = $('nb-view');
    el.innerHTML = head('记忆 #' + id, '<button class="nb-btn" id="nb-mback">← 回列表</button>') +
      wrap('<div class="nb-empty">读取中…</div>');
    var back = $('nb-mback'); if (back) back.onclick = function(){ memView(''); };
    fetch('/api/memories/' + id).then(function(r){ return r.json(); }).then(function(j){
      var m = (j && j.memory) || j || {};
      var kv = [
        ['种类', (KIND[m.kind] || m.kind || '') + ' / ' + (m.layer === 'contract' ? '契约层（不衰减）' : '叙事层')],
        ['状态', esc(m.stage) + ' · 权重 ' + Number(m.weight || 0).toFixed(2) + ' · w0 ' + Number(m.w0 || 0).toFixed(2)],
        ['来源', esc(m.scored_by || '?') + ' / ' + esc(m.source_kind || '?') + ' · ' + (m.sensitivity === 'shareable' ? '可出网' : '仅本地')],
        ['采集', esc(String(m.created_at || '').slice(0, 16).replace('T', ' '))],
        ['编号', '#' + esc(m.id)]
      ].map(function(x){ return '<b>' + x[0] + '</b><span>' + x[1] + '</span>'; }).join('');
      var html = '<div class="nb-sub" id="nb-mtext">' + esc(m.text || '') + '</div>' +
        '<div class="nb-form" id="nb-medit" hidden>' +
        '<textarea id="nb-mtextarea" class="nb-search" style="min-height:70px;width:100%">' + esc(m.text || '') + '</textarea>' +
        '<div class="nb-actrow"><button class="nb-btn" id="nb-msave">保存</button>' +
        '<button class="nb-btn" id="nb-mcancel">取消</button>' +
        '<span class="nb-empty">改动会留一条事件（human:panel）</span></div></div>' +
        (m.quote ? '<div class="nb-kv"><b>原话</b><span>' + esc(m.quote) + '</span></div>' : '') +
        '<div class="nb-kv">' + kv + '</div>' +
        '<div><button class="nb-btn" id="nb-meditbtn">编辑正文</button>' +
        '<button class="nb-btn" id="nb-msens">改成' + (m.sensitivity === 'shareable' ? '仅本地' : '可出网') + '</button>' +
        '<button class="nb-btn danger" id="nb-mforget">忘掉它</button>' +
        '<button class="nb-btn" id="nb-mback2">← 回列表</button></div>';
      el.innerHTML = head('记忆 #' + id, '<button class="nb-btn" id="nb-mback3">← 回列表</button>') + wrap(html);
      var b1 = $('nb-mback3'), b2 = $('nb-mback2'), b3 = $('nb-mforget');
      if (b1) b1.onclick = function(){ memView(''); };
      if (b2) b2.onclick = function(){ memView(''); };
      var eb = $('nb-meditbtn'), ed = $('nb-medit'), cancel = $('nb-mcancel'), save = $('nb-msave');
      if (eb && ed) eb.onclick = function(){ ed.hidden = !ed.hidden; if (!ed.hidden) { var t = $('nb-mtextarea'); if (t) t.focus(); } };
      if (cancel && ed) cancel.onclick = function(){ ed.hidden = true; };
      if (save) save.onclick = function(){
        var t = $('nb-mtextarea'); if (!t) return;
        fetch('/api/memories/' + id, { method: 'PUT', headers: H, body: JSON.stringify({ text: t.value.trim() }) })
          .then(function(r){ return r.json(); }).then(function(j){
            if (j.ok === false) { tick(j.error || '没保存成'); return; }
            tick('已改'); memDetail(id);
          });
      };
      var sens = $('nb-msens');
      if (sens) sens.onclick = function(){
        var next = m.sensitivity === 'shareable' ? 'local_only' : 'shareable';
        fetch('/api/memories/' + id, { method: 'PUT', headers: H, body: JSON.stringify({ sensitivity: next }) })
          .then(function(){ tick('敏感度：' + (next === 'shareable' ? '可出网' : '仅本地')); memDetail(id); });
      };
      if (b3) b3.onclick = function(){
        fetch('/api/memories/' + id + '/forget', { method: 'POST', headers: H, body: '{}' })
          .then(function(){ tick('已忘掉 #' + id); memForgotten(id); })
          .catch(function(){ tick('忘不掉，看状态'); });
      };
    }).catch(function(){
      el.innerHTML = head('记忆 #' + id) + wrap('<div class="nb-empty">读取失败。</div>');
    });
  }

  // 忘掉之后的落点：给一次撤销（调 /api/memories/:id/restore）
  function memForgotten(id){
    var el = $('nb-view');
    el.innerHTML = head('记忆 #' + id, '<button class="nb-btn" id="nb-fback">← 回列表</button>') +
      wrap('<div class="nb-empty">已忘掉这条。它被标成 deleted（不是物理删除），随时可以撤回来。</div>' +
      '<div class="nb-actrow"><button class="nb-btn" id="nb-fundo">撤销，恢复这条</button>' +
      '<button class="nb-btn" id="nb-fback2">← 回列表</button></div>');
    var b1 = $('nb-fback'), b2 = $('nb-fback2'), b3 = $('nb-fundo');
    if (b1) b1.onclick = function(){ memView(''); };
    if (b2) b2.onclick = function(){ memView(''); };
    if (b3) b3.onclick = function(){
      fetch('/api/memories/' + id + '/restore', { method: 'POST', headers: H, body: '{}' })
        .then(function(r){ return r.json(); }).then(function(j){
          if (j.ok === false) { tick(j.error || '没恢复成'); return; }
          tick('已恢复 #' + id); memDetail(id);
        });
    };
  }

  function docsView(){
    var el = $('nb-view');
    el.innerHTML = head('文档') + wrap('<div id="nb-docs"><div class="nb-empty">读取中…</div></div>');
    fetch('/api/docs').then(function(r){ return r.json(); }).then(function(rows){
      if (!Array.isArray(rows)) rows = [];
      var box = $('nb-docs');
      box.innerHTML = '<div class="nb-actrow" style="margin-bottom:10px">' +
        '<button class="nb-btn" id="nb-updoc">上传一份</button>' +
        '<span class="nb-empty">.md / .txt 直接吃；PDF 要 Python + markitdown</span>' +
        '<input type="file" id="nb-upfile" accept=".md,.txt,.pdf,.markdown" style="display:none"></div>' +
        (rows.length ? rows.map(function(d){
        return '<button class="nb-row" data-doc="' + esc(d.id) + '">' + esc(d.title || d.id) +
          '<span class="m">' + esc(String(d.n_chunks || 0)) + ' 块 · ' +
          (d.sensitivity === 'shareable' ? '可出网' : '仅本地') + '</span></button>';
      }).join('') : '<div class="nb-empty">还没有摄入任何文档。</div>');
      var up = $('nb-updoc'), upf = $('nb-upfile');
      if (up && upf) up.onclick = function(){ upf.click(); };
      if (upf) upf.onchange = function(){
        var f = upf.files && upf.files[0];
        if (!f) return;
        tick('上传 ' + f.name + '…');
        fetch('/api/ingest/upload?name=' + encodeURIComponent(f.name), {
          method: 'POST', headers: { 'x-jj': '1', 'content-type': 'application/octet-stream' }, body: f,
        }).then(function(r){ return r.json(); }).then(function(j){
          if (!j.ok) { tick(j.error || '上传失败'); return; }
          tick('写进 sources/ 了，开始摄入…');
          return fetch('/api/ingest', { method: 'POST', headers: H, body: JSON.stringify({ path: j.path }) })
            .then(function(r){ return r.json(); }).then(function(r){
              tick(r.ok ? ('已摄入 ' + f.name) : ('摄入失败：' + (r.error || r.why || '?')));
              docsView();
            });
        }).catch(function(){ tick('上传失败'); });
      };
      Array.prototype.forEach.call(box.querySelectorAll('[data-doc]'), function(b){
        b.onclick = function(){ docDetail(b.getAttribute('data-doc')); };
      });
    }).catch(function(){
      var box = $('nb-docs'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
    });
  }

  function docDetail(id){
    var el = $('nb-view');
    el.innerHTML = head('文档', '<button class="nb-btn" id="nb-dback">← 回文档</button>') +
      wrap('<div class="nb-empty">读取中…</div>');
    var b = $('nb-dback'); if (b) b.onclick = function(){ docsView(); };
    fetch('/api/docs/' + encodeURIComponent(id)).then(function(r){ return r.json(); }).then(function(j){
      var doc = (j && j.doc) || {};
      var chunks = (j && j.chunks) || [];
      var html = '<div class="nb-kv"><b>标题</b><span>' + esc(doc.title || id) + '</span>' +
        '<b>块数</b><span>' + esc(String(doc.n_chunks || chunks.length)) + '</span></div>' +
        chunks.slice(0, 12).map(function(c){
          return '<div class="nb-row" style="cursor:default"><span class="tag">#' + esc(c.ord) + '</span>' +
            esc(String(c.heading_path || '')) + '<span class="m">' + esc(String(c.text || '').slice(0, 160)) + '</span></div>';
        }).join('') +
        '<div style="margin-top:12px"><button class="nb-btn danger" id="nb-dforget">忘掉这篇</button></div>';
      el.innerHTML = head('文档', '<button class="nb-btn" id="nb-dback2">← 回文档</button>') + wrap(html);
      var b2 = $('nb-dback2'), f = $('nb-dforget');
      if (b2) b2.onclick = function(){ docsView(); };
      if (f) f.onclick = function(){
        fetch('/api/docs/' + encodeURIComponent(id) + '/forget', { method: 'POST', headers: H, body: '{}' })
          .then(function(){ tick('已忘掉这篇文档'); docsView(); });
      };
    }).catch(function(){
      el.innerHTML = head('文档') + wrap('<div class="nb-empty">读取失败。</div>');
    });
  }

  function capView(){
    var el = $('nb-view');
    el.innerHTML = head('能力') + wrap('<div id="nb-cap"><div class="nb-empty">读取中…</div></div>');
    fetch('/api/capabilities').then(function(r){ return r.json(); }).then(function(j){
      var tools = ((j.classes && j.classes.tool) || []);
      var deg = j.degraded || [];
      var html = '<div class="nb-kv"><b>工具</b><span>' + tools.length + ' 项</span>' +
        '<b>降级</b><span>' + (deg.length ? esc(deg.join(' · ')) : '没有') + '</span></div>' +
        tools.slice(0, 40).map(function(t){
          return '<div class="nb-row" style="cursor:default"><span class="tag">' + esc(t.tier) + '</span>' +
            esc(t.name) + '<span class="m">' + esc(String(t.note || '').slice(0, 120)) + '</span></div>';
        }).join('');
      var box = $('nb-cap'); if (box) box.innerHTML = html;
    }).catch(function(){});
  }

  function gitView(){
    var el = $('nb-view');
    function paint(what){
      el.innerHTML = head('校样 · ' + what,
        '<button class="nb-btn" data-g="status">status</button>' +
        '<button class="nb-btn" data-g="diff">diff</button>' +
        '<button class="nb-btn" data-g="log">log</button>') +
        wrap('<div class="nb-pre" id="nb-git">读取中…</div>');
      Array.prototype.forEach.call(el.querySelectorAll('[data-g]'), function(b){
        b.onclick = function(){ paint(b.getAttribute('data-g')); };
      });
      fetch('/api/git?what=' + what).then(function(r){ return r.json(); }).then(function(j){
        var box = $('nb-git');
        if (box) box.textContent = (j && j.ok ? '' : '（读不到：' + ((j && j.code) || '?') + '）') + String((j && j.output) || '');
      }).catch(function(){});
    }
    paint('status');
  }

  function cfgView(){
    var el = $('nb-view');
    el.innerHTML = head('设置') + wrap('<div id="nb-cfg"><div class="nb-empty">读取中…</div></div>');
    var chosen = {};
    var SECS = [];
    function sec(t, inner){
      SECS.push(t);
      var i = SECS.length;
      // 一次只显示一节：设置页有近两千像素高，靠滚动真的会看不见（用户连问两次）
      return '<div class="nb-secwrap" data-i="' + i + '"' + (i === 1 ? '' : ' hidden') + '>' +
        '<div class="nb-sec" id="cf-sec-' + i + '">' + t + '</div>' + inner + '</div>';
    }
    function field(label, id, val, ph){
      return '<label class="nb-fld"><span>' + label + '</span>' +
        '<input id="' + id + '" class="nb-search" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '"></label>';
    }
    // 原生 <select> 的弹层由系统画，暗色主题下仍然是白底灰字（用户截图就是这个）。
    // 所以这里一律用自己画的一排按钮，配色可控。
    function optRow(k, opts, cur, label){
      var hit = opts.filter(function(x){ return cur && String(x).indexOf(cur) === 0; })[0] || opts[0] || '';
      chosen[k] = chosen[k] || hit;
      return '<div class="nb-fld"><span>' + label + '</span><div class="nb-opts" data-k="' + k + '">' +
        opts.map(function(x){
          return '<button class="nb-opt' + (x === chosen[k] ? ' on' : '') + '" data-v="' + esc(x) + '">' + esc(x) + '</button>';
        }).join('') + '</div></div>';
    }
    Promise.all([
      fetch('/api/config').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/ui').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/models').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/mode').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/host').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/standing').then(function(r){ return r.json(); }).catch(function(){ return []; }),
      fetch('/api/grants').then(function(r){ return r.json(); }).catch(function(){ return []; }),
      fetch('/api/egress').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/health').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/persona').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/avatars').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/bridge').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/deploy').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
    ]).then(function(res){
      var c = res[0] || {}, ui = res[1] || {}, m = res[2] || {}, mode = (res[3] || {}).mode || 'chat';
      var host = res[4] || {}, sd = Array.isArray(res[5]) ? res[5] : [];
      var grants = Array.isArray(res[6]) ? res[6] : [];
      var eg = res[7] || {}, health = res[8] || {}, persona = res[9] || {};
      var av = res[10] || {}, br = res[11] || {}, dep = res[12] || {};
      var locals = m.installed || [];
      var roleModel = function(n){
        var hit = (m.roles || []).filter(function(x){ return x.role === n; })[0];
        return hit ? String(hit.model) : '';
      };
      var curEmbed = roleModel('embed'), curChat = roleModel('route') || roleModel('default');
      var deg = health.degraded || [];
      var gen = persona.generation || {};
      var html = '';
      html += sec('接口 · 云端',
        '<div class="nb-form">' +
        field('provider', 'cf-prov', c.provider || '', 'deepseek') +
        field('model', 'cf-model', c.model || '', 'deepseek-flash') +
        field('baseUrl', 'cf-base', c.baseUrl || '', '留空用默认') +
        field('key', 'cf-key', '', c.hasKey ? '已有（' + (c.keyFingerprint || '') + '），留空不改' : '粘贴 key') +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-save">保存</button>' +
        '<button class="nb-btn" id="cf-test">测试连接</button>' +
        '<button class="nb-btn danger" id="cf-clear">清除 key</button>' +
        '<span class="nb-empty" id="cf-msg"></span></div></div>');
      html += sec('本地模型',
        '<div class="nb-form">' +
        (locals.length ? optRow('embed', locals, curEmbed, 'embed') + optRow('chat', locals, curChat, 'chat')
          : '<div class="nb-empty">没有已拉模型</div>') +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-msave">保存模型</button>' +
        '<span class="nb-empty">端点 ' + esc(m.endpoint || '—') + ' · ' + (m.online ? '在线' : '离线') +
        ' · 索引 ' + esc((m.index && m.index.current) || '—') + '</span></div></div>');
      html += sec('人格',
        '<div class="nb-form">' + field('名字', 'cf-name', (c.agent && c.agent.name) || '', '她叫什么') +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-nsave">保存名字</button>' +
        '<span class="nb-empty">第 ' + esc(String(gen.index == null ? '—' : gen.index)) + ' 代</span></div>' +
        '<div class="nb-opts" id="cf-pfiles">' +
        (persona.editable || ['core']).map(function(f, i){
          return '<button class="nb-opt' + (i === 0 ? ' on' : '') + '" data-pfile="' + esc(f) + '">' + esc(f) + '</button>';
        }).join('') + '</div>' +
        '<textarea id="cf-ptext" class="nb-search" style="min-height:150px;width:100%;font-family:var(--mono);font-size:12px;line-height:1.7"></textarea>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-psave">保存这块</button>' +
        '<span class="nb-empty" id="cf-pmsg">改动只向前生效，会开新的一代</span></div></div>');
      html += sec('头像',
        '<div class="nb-form">' +
        '<div class="nb-fld"><span>她</span><div class="nb-actrow">' +
        (av.agent ? '<img class="nb-av" src="' + esc(av.agent.url) + '" alt="">' : '<span class="nb-empty">默认图标</span>') +
        '<button class="nb-btn" data-pick="agent">换一张</button>' +
        '<button class="nb-btn danger" data-delav="agent">删除</button>' +
        '<input type="file" data-av="agent" accept="image/png,image/jpeg,image/webp" style="display:none"></div></div>' +
        '<div class="nb-fld"><span>你</span><div class="nb-actrow">' +
        (av.user ? '<img class="nb-av" src="' + esc(av.user.url) + '" alt="">' : '<span class="nb-empty">默认图标</span>') +
        '<button class="nb-btn" data-pick="user">换一张</button>' +
        '<button class="nb-btn danger" data-delav="user">删除</button>' +
        '<input type="file" data-av="user" accept="image/png,image/jpeg,image/webp" style="display:none"></div></div>' +
        '<div class="nb-empty">png / jpeg / webp，≤512KB</div></div>');
      html += sec('主机 · 命令解释器',
        '<div class="nb-form">' + optRow('shell', ['auto', 'powershell', 'pwsh', 'gitbash'], host.wanted || 'auto', '用哪个') +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-hsave">保存</button>' +
        '<span class="nb-empty">当前 ' + esc((host.active && host.active.label) || '—') + '</span></div></div>');
      html += sec('常驻指令', sd.length ? sd.map(function(x){
        return '<div class="nb-runrow"><span class="k">' + esc(x.when || '') + '</span>' +
          '<span class="v">' + esc(x.because || x.id) + '</span>' +
          '<button class="nb-btn" data-off="' + esc(x.id) + '">停用</button></div>';
      }).join('') : '<div class="nb-empty">没有常驻指令。</div>');
      html += sec('限制',
        '<div class="nb-runrow"><span class="k">档位</span><span class="v">全开（full）</span>' +
        '<span class="m">限制全部撤掉，等软件能用了再谈</span></div>' +
        '<div class="nb-runrow"><span class="k">授权窗口</span><span class="v">' + grants.length + ' 个</span>' +
        '<span class="m">启动自动开，不会逐次问你</span></div>' +
        '<div class="nb-runrow"><span class="k">代码外发</span><span class="v">开</span>' +
        '<span class="m">每次仍写审计</span></div>' +
        '<div class="nb-runrow"><span class="k">超级权限</span><span class="v">关</span>' +
        '<span class="m">只影响「改记忆库本体/人格」这一档</span></div>');
      html += sec('诊断',
        '<div class="nb-actrow"><button class="nb-btn" id="cf-doc">跑一遍体检</button>' +
        '<span class="nb-empty">按项看，红的会列出来</span></div>' +
        '<div id="cf-docout"></div>');
      html += sec('导出 / 导入',
        '<div class="nb-actrow"><button class="nb-btn" id="cf-exp">导出一份快照</button>' +
        '<span class="nb-empty" id="cf-expmsg">不带 secrets/tokens/snapshots</span></div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-ver">校验一个导出目录</button>' +
        '<button class="nb-btn" id="cf-imp">看导入命令</button></div>' +
        '<div class="nb-empty" id="cf-impout"></div>');
      html += sec('开机片头',
        '<div class="nb-form">' +
        '<div class="nb-opts" id="cf-splash">' +
        ['full','simple','off'].map(function(x){
          var label = x === 'full' ? '完整（约 7 秒）' : x === 'simple' ? '简易（约 3.6 秒）' : '不播';
          return '<button class="nb-opt' + (ui.splash === x ? ' on' : '') + '" data-splash="' + x + '">' + label + '</button>';
        }).join('') + '</div>' +
        '<div class="nb-actrow"><span class="nb-empty">点一下就是新的档位，下次打开生效</span></div></div>');
      html += sec('QQ 接入（OneBot 11）',
        '<div class="nb-form">' +
        '<div class="nb-kv"><b>桥</b><span id="cf-bstate">读取中…</span></div>' +
        field('WebSocket', 'cf-bws', '', 'ws://127.0.0.1:3001') +
        field('她的 QQ 号', 'cf-bid', '', '填 selfId，用来过滤自己发的、判断有没有 @') +
        field('Token', 'cf-btoken', '', 'NapCat 里设了才填') +
        '<div class="nb-opts" id="cf-bmode">' +
        [['private','只回私聊'],['group','只回群里 @'],['all','两者都回']].map(function(x){
          return '<button class="nb-opt" data-bmode="' + x[0] + '">' + x[1] + '</button>';
        }).join('') + '</div>' +
        field('群白名单', 'cf-bgroups', '', '用逗号分隔群号；空 = 一个群都不回') +
        field('群里前缀', 'cf-bprefix', '', '不 @ 时用这个开头，如：鲸鲸，') +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-bsave">保存</button>' +
        '<button class="nb-btn" id="cf-bon">开启</button>' +
        '<button class="nb-btn danger" id="cf-boff">关闭</button>' +
        '<span class="nb-empty" id="cf-bmsg">保存即生效；软件下次启动会自动接着跑</span></div>' +
        '<div class="nb-empty">先装 NapCat 并在它的 WebUI 里开一个 WebSocket 服务器（默认 127.0.0.1:3001），' +
        '再回来填这里。开启后，私聊她就能收到消息；群里要 @ 她（或在白名单里配群号）。</div></div>');
      html += sec('引导',
        '<div class="nb-actrow"><a class="nb-btn" href="/welcome">重新过一遍引导</a>' +
        '<span class="nb-empty">首页那八步：装 Ollama / 拉模型 / 试运行</span></div>');
      html += sec('部署状态',
        '<div class="nb-kv">' +
        '<b>版本</b><span>' + esc(dep.version || '—') + '</span>' +
        '<b>模式</b><span>' + esc(dep.mode || '—') + '</span></div>' +
        '<div class="nb-kv">' +
        '<b>Node</b><span>' + esc(dep.node || '—') + '</span>' +
        '<b>已运行</b><span>' + esc(String(Math.round((dep.uptimeS || 0) / 60))) + ' 分钟</span>' +
        '<b>数据库</b><span>' + esc((Number(dep.dbBytes || 0) / 1048576).toFixed(1)) + ' MB</span>' +
        '<b>目录</b><span>' + esc(dep.home || '—') + '</span>' +
        '<b>降级</b><span>' + (deg.length ? esc(deg.join(' · ')) : '没有') + '</span></div>');
      var box = $('nb-cfg');
      var jump = '<div class="nb-jumpbar">' + SECS.map(function(t, i){
        return '<button class="nb-jump' + (i === 0 ? ' on' : '') + '" data-i="' + (i + 1) + '">' + esc(t) + '</button>';
      }).join('') + '</div>';
      if (box) box.innerHTML = jump + '<div class="nb-form-wrap">' + html + '</div>';
      Array.prototype.forEach.call(box.querySelectorAll('.nb-jump'), function(b){
        b.onclick = function(){
          var want = b.getAttribute('data-i');
          Array.prototype.forEach.call(box.querySelectorAll('.nb-jump'), function(x){ x.className = 'nb-jump'; });
          b.className = 'nb-jump on';
          Array.prototype.forEach.call(box.querySelectorAll('.nb-secwrap'), function(w){
            w.hidden = w.getAttribute('data-i') !== want;
          });
          var pg = document.getElementById('nb-page'); if (pg) pg.scrollTop = 0;
        };
      });
      function msg(t, ok){ var e = $('cf-msg'); if (e) { e.textContent = t; e.className = 'hint ' + (ok ? 'ok' : 'err'); } }
      function on(id, fn){ var b = $(id); if (b) b.onclick = fn; }
      Array.prototype.forEach.call(box.querySelectorAll('.nb-opts'), function(g){
        g.onclick = function(e){
          var b = e.target;
          if (!b || b.className.indexOf('nb-opt') < 0) return;
          chosen[g.getAttribute('data-k')] = b.getAttribute('data-v');
          Array.prototype.forEach.call(g.children, function(x){ x.className = 'nb-opt' + (x === b ? ' on' : ''); });
        };
      });
      on('cf-save', function(){
        var b = { provider: $('cf-prov').value.trim(), model: $('cf-model').value.trim() };
        if ($('cf-base').value.trim()) b.baseUrl = $('cf-base').value.trim();
        if ($('cf-key').value.trim()) b.key = $('cf-key').value.trim();
        fetch('/api/config', { method: 'PUT', headers: H, body: JSON.stringify(b) })
          .then(function(r){ return r.json(); }).then(function(j){ msg(j.ok ? '已保存' : (j.error || '失败'), !!j.ok); });
      });
      on('cf-test', function(){
        msg('测试中…', true);
        fetch('/api/test-cloud', { method: 'POST', headers: H, body: '{}' })
          .then(function(r){ return r.json(); }).then(function(j){
            msg(j.ok ? ('通了 · ' + j.ms + 'ms') : (j.error || j.hint || '不通'), !!j.ok);
          });
      });
      on('cf-msave', function(){
        var b = {};
        if (chosen.embed) b.embed = chosen.embed;
        if (chosen.chat) b.default = chosen.chat;
        fetch('/api/models', { method: 'PUT', headers: H, body: JSON.stringify(b) })
          .then(function(r){ return r.json(); }).then(function(j){ msg(j.ok ? '模型已保存' : (j.error || '失败'), !!j.ok); });
      });
      on('cf-nsave', function(){
        fetch('/api/config', { method: 'PUT', headers: H, body: JSON.stringify({ agent: { name: $('cf-name').value.trim() } }) })
          .then(function(r){ return r.json(); }).then(function(j){ msg(j.ok ? '名字已保存' : (j.error || '失败'), !!j.ok); });
      });
      // ── QQ 接入（OneBot 11）──
      (function(){
        var cfgB = (br && br.config) || {};
        var st = (br && br.state) || {};
        var setv = function(id, v){ var e = $(id); if (e && v != null) e.value = v; };
        setv('cf-bws', cfgB.ws || 'ws://127.0.0.1:3001');
        setv('cf-bid', cfgB.selfId || '');
        setv('cf-btoken', cfgB.accessToken || '');
        setv('cf-bgroups', (cfgB.allowGroups || []).join(','));
        setv('cf-bprefix', cfgB.prefix || '');
        var curMode = cfgB.mode || 'private';
        function paintMode(){
          Array.prototype.forEach.call(box.querySelectorAll('[data-bmode]'), function(x){
            x.className = 'nb-opt' + (x.getAttribute('data-bmode') === curMode ? ' on' : '');
          });
        }
        paintMode();
        Array.prototype.forEach.call(box.querySelectorAll('[data-bmode]'), function(b){
          b.onclick = function(){ curMode = b.getAttribute('data-bmode'); paintMode(); };
        });
        var stEl = $('cf-bstate');
        if (stEl) stEl.textContent = !cfgB.enabled ? '没开' : (st.connected ? '已连上' : (st.running ? '在跑，但没连上' : '开了，但要重启软件才会起'));
        function save(on){
          var body = {
            enabled: on === undefined ? Boolean(cfgB.enabled) : !!on,
            ws: $('cf-bws') ? $('cf-bws').value.trim() : '',
            selfId: $('cf-bid') ? $('cf-bid').value.trim() : '',
            accessToken: $('cf-btoken') ? $('cf-btoken').value.trim() : '',
            mode: curMode,
            allowGroups: ($('cf-bgroups') ? $('cf-bgroups').value : '').split(',').map(function(x){ return x.trim(); }).filter(Boolean),
            prefix: $('cf-bprefix') ? $('cf-bprefix').value.trim() : '',
          };
          fetch('/api/bridge', { method: 'PUT', headers: H, body: JSON.stringify(body) })
            .then(function(r){ return r.json(); }).then(function(j){
              var m = $('cf-bmsg');
              if (m) m.textContent = j.ok ? ('已保存' + (j.state ? ('·桥：' + (j.state.connected ? '已连上' : j.state.running ? '在跑，没连上' : '没起')) : '')) : (j.why || j.error || '没保存成');
              if (j.ok) setTimeout(cfgView, 600);
            });
        }
        on('cf-bsave', function(){ save(); });
        on('cf-bon', function(){ save(true); });
        on('cf-boff', function(){ save(false); });
      })();
      // ── 人格六块：点哪个填哪个，保存只存当前这块 ──
      var pFiles = persona.files || {};
      var pCur = (persona.editable && persona.editable[0]) || 'core';
      function paintPersona(){
        var t = $('cf-ptext');
        if (t) t.value = String(pFiles[pCur] || '');
        Array.prototype.forEach.call(box.querySelectorAll('[data-pfile]'), function(x){
          x.className = 'nb-opt' + (x.getAttribute('data-pfile') === pCur ? ' on' : '');
        });
      }
      Array.prototype.forEach.call(box.querySelectorAll('[data-pfile]'), function(b){
        b.onclick = function(){ pCur = b.getAttribute('data-pfile'); paintPersona(); };
      });
      paintPersona();
      on('cf-psave', function(){
        var t = $('cf-ptext'); if (!t) return;
        fetch('/api/persona', { method: 'PUT', headers: H,
          body: JSON.stringify({ file: pCur, content: t.value, because: '面板里改的' }) })
          .then(function(r){ return r.json(); }).then(function(j){
            var msg = $('cf-pmsg');
            if (msg) msg.textContent = j.ok === false ? (j.error || '没保存成') : ('已保存 ' + pCur);
          });
      });

      // ── 清除云端 key（key:null 才是清除；空字符串是「没传」）──
      on('cf-clear', function(){
        if (!window.confirm('清除云端 key？清完就只能用本地模型，直到重新填。')) return;
        fetch('/api/config', { method: 'PUT', headers: H, body: JSON.stringify({ key: null }) })
          .then(function(r){ return r.json(); }).then(function(j){
            msg(j.ok ? 'key 已清除' : (j.error || '没清成'), !!j.ok);
            cfgView();
          });
      });

      // ── 删头像 ──
      Array.prototype.forEach.call(box.querySelectorAll('[data-delav]'), function(b){
        b.onclick = function(){
          var role = b.getAttribute('data-delav');
          if (!window.confirm('删掉这个头像？')) return;
          fetch('/api/avatar?role=' + role, { method: 'DELETE', headers: H })
            .then(function(r){ return r.json(); }).then(function(j){
            tick(j.ok ? '已删除头像' : (j.error || '没删成'));
            cfgView();
          });
        };
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-splash]'), function(b){
        b.onclick = function(){
          var v = b.getAttribute('data-splash');
          fetch('/api/ui', { method: 'PUT', headers: H, body: JSON.stringify({ splash: v }) })
            .then(function(r){ return r.json(); }).then(function(j){
              if (!j.ok) { tick(j.error || '没保存成'); return; }
              Array.prototype.forEach.call(box.querySelectorAll('[data-splash]'), function(x){ x.className = 'nb-opt'; });
              b.className = 'nb-opt on';
              tick('片头：' + (v === 'off' ? '不播' : v) + '（下次打开生效）');
            });
        };
      });
      on('cf-hsave', function(){
        fetch('/api/host', { method: 'PUT', headers: H, body: JSON.stringify({ shell: chosen.shell }) })
          .then(function(r){ return r.json(); }).then(function(j){ msg(j.ok ? '解释器已保存' : (j.error || '失败'), !!j.ok); });
      });
      // 「换一张」按钮 → 触发隐藏的 file input（WebView 里 label 包 input 有时不弹框）
      Array.prototype.forEach.call(box.querySelectorAll('[data-pick]'), function(b){
        b.onclick = function(){
          var inp = box.querySelector('input[data-av="' + b.getAttribute('data-pick') + '"]');
          if (inp) inp.click();
        };
      });
      Array.prototype.forEach.call(box.querySelectorAll('input[data-av]'), function(inp){
        inp.onchange = function(){
          var f = inp.files && inp.files[0]; if (!f) return;
          var rd = new FileReader();
          rd.onload = function(){
            fetch('/api/avatar', { method: 'POST', headers: H, body: JSON.stringify({ role: inp.getAttribute('data-av'), dataUrl: rd.result }) })
              .then(function(r){ return r.json(); }).then(function(j){ tick(j.ok ? '头像已换' : (j.error || '换不了')); cfgView(); });
          };
          rd.readAsDataURL(f);
        };
      });
      on('cf-doc', function(){
        var out = $('cf-docout'); if (out) out.innerHTML = '<div class="nb-empty">在跑…</div>';
        fetch('/api/doctor').then(function(r){ return r.json(); }).then(function(j){
          var rows = (j && j.checks) || [];
          out.innerHTML = rows.map(function(x){
            return '<div class="nb-runrow"><span class="k">' + (x.ok ? '✅' : '❌') + ' ' + esc(x.name) + '</span>' +
              '<span class="v">' + esc(String(x.detail || '').slice(0, 80)) + '</span><span></span></div>';
          }).join('') || '<div class="nb-empty">没有检查项</div>';
        });
      });
      on('cf-exp', function(){
        var out = $('cf-expmsg'); if (out) out.textContent = '导出中…';
        fetch('/api/export', { method: 'POST', headers: H, body: '{}' })
          .then(function(r){ return r.json(); }).then(function(j){
            if (out) out.textContent = j.ok ? ('已导出 ' + j.files + ' 个文件 / ' + (j.bytes / 1048576).toFixed(1) + ' MB → ' + j.outDir) : (j.error || '失败');
          });
      });
      on('cf-ver', function(){
        var out = $('cf-impout'); if (out) out.textContent = '给一个导出目录（绝对路径）';
        var d = window.prompt('导出目录的绝对路径');
        if (!d) return;
        fetch('/api/export/verify?dir=' + encodeURIComponent(d))
          .then(function(r){ return r.json(); }).then(function(j){
            if (out) out.textContent = j.ok ? ('校验通过 · ' + j.files + ' 个文件') : ('有问题：' + (j.problems || []).join('；'));
          });
      });
      on('cf-imp', function(){
        var out = $('cf-impout');
        if (out) out.textContent = 'node src/cli/jingjing.ts import <导出目录>　（导入会换掉整个 home，面板里不做）';
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-off]'), function(b){
        b.onclick = function(){
          fetch('/api/standing/' + encodeURIComponent(b.getAttribute('data-off')) + '/disable', { method: 'POST', headers: H, body: '{}' })
            .then(function(){ tick('已停用'); cfgView(); });
        };
      });
    });
  }

  // ── ⌘K 命令面板（2026-11-05）：会话 / 记忆 / 文档 / 页面 一起搜 ──
  var PAL = [], PALI = 0, PAL_TIMER = 0;
  var PAGES = [
    { k: '页面', v: '工作台', go: 'home' },
    { k: '页面', v: '记录（对话）', go: 'chat' },
    { k: '页面', v: '会话', go: 'sess' },
    { k: '页面', v: '待你处理', go: 'approvals' },
    { k: '页面', v: '记忆', go: 'mem' },
    { k: '页面', v: '文档', go: 'docs' },
    { k: '页面', v: '能力', go: 'cap' },
    { k: '页面', v: '校样', go: 'git' },
    { k: '页面', v: '设置', go: 'cfg' },
    { k: '页面', v: '还缺', go: 'gap' },
  ];
  function palPaint(){
    var box = $('nb-palist');
    if (!box) return;
    box.innerHTML = PAL.length ? PAL.map(function(x, i){
      return '<div class="nb-palrow' + (i === PALI ? ' on' : '') + '" data-i="' + i + '">' +
        '<span class="k">' + esc(x.k) + '</span><span class="v">' + esc(x.v) + '</span></div>';
    }).join('') : '<div class="nb-palrow"><span class="k">—</span><span class="v">没有匹配</span></div>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-i]'), function(b){
      b.onclick = function(){ palPick(Number(b.getAttribute('data-i'))); };
    });
  }
  function palPick(i){
    var it = PAL[i];
    if (!it) return;
    palClose();
    if (it.go) { go(it.go); return; }
    if (it.sess) { go('sess'); sessDetail(it.sess); return; }
    if (it.mem) { go('mem'); memDetail(it.mem); return; }
  }
  function palOpen(){
    var p = $('nb-pal'); if (!p) return;
    p.hidden = false; PAL = PAGES.slice(); PALI = 0; palPaint();
    var q = $('nb-palq'); if (q) { q.value = ''; q.focus(); }
  }
  function palClose(){ var p = $('nb-pal'); if (p) p.hidden = true; }
  function palSearch(q){
    if (!q) { PAL = PAGES.slice(); PALI = 0; palPaint(); return; }
    var lower = q.toLowerCase();
    var local = PAGES.filter(function(x){ return x.v.toLowerCase().indexOf(lower) >= 0; });
    fetch('/api/sessions?limit=50').then(function(r){ return r.json(); }).then(function(j){
      var ss = ((j && j.sessions) || []).filter(function(x){ return String(x.title || '').toLowerCase().indexOf(lower) >= 0; })
        .slice(0, 5).map(function(x){ return { k: '会话', v: x.title || x.id, sess: x.id }; });
      PAL = local.concat(ss); PALI = 0; palPaint();
    }).catch(function(){ PAL = local; PALI = 0; palPaint(); });
    fetch('/api/search?q=' + encodeURIComponent(q)).then(function(r){ return r.json(); }).then(function(j){
      var ms = ((j && j.mem) || []).slice(0, 5).map(function(m){ return { k: '记忆', v: String(m.text || '').slice(0, 60), mem: m.id }; });
      var ds = ((j && j.docs) || []).slice(0, 4).map(function(d){ return { k: '文档', v: String(d.text || '').slice(0, 60) }; });
      PAL = PAL.concat(ms, ds); palPaint();
    }).catch(function(){});
  }
  document.addEventListener('keydown', function(e){
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); palOpen(); return; }
    var p = $('nb-pal');
    if (!p || p.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); palClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); PALI = Math.min(PAL.length - 1, PALI + 1); palPaint(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); PALI = Math.max(0, PALI - 1); palPaint(); return; }
    if (e.key === 'Enter') { e.preventDefault(); palPick(PALI); return; }
  });
  var palQ = $('nb-palq');
  if (palQ) palQ.addEventListener('input', function(){
    clearTimeout(PAL_TIMER);
    var v = palQ.value.trim();
    PAL_TIMER = setTimeout(function(){ palSearch(v); }, 180);
  });
  var palBg = $('nb-pal');
  if (palBg) palBg.addEventListener('click', function(e){ if (e.target === palBg) palClose(); });

  // ── 启动 ─────────────────────────────────────
  loadState(); loadTimeline(); loadTabs(); loadHome(); loadAvatars();
  // 深链接：?view=home|chat|board|mem|docs|cap|git|gap|cfg（截图、书签、排障都靠它）
  (function(){
    var m = /[?&]view=([a-z]+)/.exec(location.search || '');
    var v = m ? m[1] : '';
    if (v === 'board') { go('home'); setTimeout(function(){ Board(true); }, 120); return; }
    if (v === 'chat') { go('chat'); return; }
    if (['mem','docs','cap','git','cfg','gap','sess','approvals','logs'].indexOf(v) >= 0) { setTimeout(function(){ go(v); }, 120); return; }
    go('home');
    if (location.search.indexOf("pal=1") >= 0) setTimeout(palOpen, 200);
  })();
  setInterval(function(){ loadState(); loadTabs(); }, 20000);
})();
</script>
</body></html>`;
