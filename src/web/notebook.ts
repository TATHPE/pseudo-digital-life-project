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
 * 约束：零构建、无外部字体/图床、黑底白线、青色只给她的回话。
 * 2026-11-06：界面脚本从模板字符串里抽到 src/web/ui/notebook.js —— 之前它是一整块字符串，
 * tsc 看不见、只能靠切字符串改，改一次带走一片函数（evChips / loadAvatars / thinkAppend 都这么没的）。
 */
import { readFileSync } from "node:fs";

/** 界面脚本（真文件，不是字符串）。测试直接读它，别再去 NOTEBOOK 里 grep。 */
export const NB_JS = readFileSync(new URL("./ui/notebook.js", import.meta.url), "utf8");

export const NOTEBOOK = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>鲸鲸 · 记录本</title>
<style>
:root{
  color-scheme:dark;
  --void:#0b0e0b;--ink:#f2f7f8;--dim:#b9c6c9;--dim2:#7d8b8f;
  --line:rgba(233,240,242,.30);--line-dim:rgba(233,240,242,.10);
  --cyan:#0f7c74;--amber:#8a6d1f;--fade:#8f9799;
  /* 叠加层：深色底上是白雾，浅色底上要反过来，否则一片隐形 */
  --tint1:rgba(233,240,242,.015);--tint2:rgba(233,240,242,.03);--tint3:rgba(233,240,242,.05);
  --ok:#3f7a3a;--warn:#8a6d1f;--err:#a8423a;
  --mono:ui-monospace,"Cascadia Mono",Consolas,monospace;
  --sans:"HarmonyOS Sans SC","PingFang SC","Noto Sans SC","Source Han Sans SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
  /* 版式基准：两套完全一致，按 Hermes 来（2026-11-06） */
  --measure:1120px;  /* 容器宽 */
  --prose:720px;     /* 正文列：约 50 字/行 */
  --rail:248px;   /* 左栏宽度：两套主题一致（2026-11-06 用户要求） */
}
/* ── 主题（2026-11-06）─────────────────────────────────────
   默认 = 记录本（黑白、紧凑、660 正文宽）
   hermes = 借 Hermes-CN-Desktop 的浅色底：纸白 + 墨黑、12.5/1.75、248 侧栏、容器 1120 / 正文 720
   只换变量与版式，结构不动 —— 切换靠 <html data-theme>，不刷新页面。 */
[data-theme="hermes"]{
  color-scheme:light;
  /* 纸白 + 墨黑：Hermes 是浅色底，不是深色底换个灰 */
  --void:#fbfbf9;--ink:#0a0b0c;--dim:#33393c;--dim2:#5a6165;
  --line:rgba(23,25,26,.22);--line-dim:rgba(23,25,26,.09);
  --cyan:#0f7c74;--amber:#8a6d1f;--fade:#6f777a;
  --ok:#3f7a3a;--warn:#8a6d1f;--err:#a8423a;
  --mono:ui-monospace,"Cascadia Mono",Consolas,monospace;
  --sans:"Inter","HarmonyOS Sans SC","PingFang SC","Noto Sans SC",system-ui,sans-serif;
  --lh:1.75;
  /* 浅色底上的叠加层是**墨雾**，不是白雾 */
  --tint1:rgba(23,25,26,.02);--tint2:rgba(23,25,26,.035);--tint3:rgba(23,25,26,.06);
}
/* 版式差异：左栏 248（Hermes 的 sidebar 宽） */
/* 正文别跟着容器一起变宽：容器 1120 / 正文 720 */
[data-theme="hermes"] .nb-greet{font-size:22px;font-weight:600;letter-spacing:-.01em}
[data-theme="hermes"] .nb-sec{letter-spacing:.18em}
[data-theme="hermes"] .nb-e .g .w{letter-spacing:.1em}
/* 浅色下代码块与表格的底要更实一点，不然像没渲染 */
[data-theme="hermes"] .nb-say pre{background:rgba(23,25,26,.04)}
[data-theme="hermes"] .md-table th{background:rgba(23,25,26,.035)}
/* 顶栏与输入区在浅色底上要有一条实线，不然糊在一起 */
[data-theme="hermes"] .nb-top{border-bottom-color:rgba(23,25,26,.14)}
[data-theme="hermes"] .nb-composer{border-top:1px solid rgba(23,25,26,.12)}
/* 滚动条：浅色底上用墨色滑块 */
[data-theme="hermes"] ::-webkit-scrollbar-thumb{background:rgba(23,25,26,.18)}
[data-theme="hermes"] ::-webkit-scrollbar-thumb:hover{background:rgba(23,25,26,.32)}


/* ── 共用语汇（两套主题都用；颜色全部走变量）────────────────
   2026-11-06 用户选 B：一套风格的明暗两版，而不是两套风格。 */
/* 对话页：页边等宽小字、细线分隔、证据条只留边框、代码块浅底 */
.nb-sheet{padding-top:20px}
/* 每条之间就是一条细线，不加间距以外的装饰 */
.nb-e{border-top:1px solid var(--line-dim);padding:18px 0 22px}
.nb-e .g{font-size:9.5px;line-height:1.6;letter-spacing:.06em;color:var(--dim2)}
.nb-e .g .w{font-size:9px;letter-spacing:.18em;text-transform:uppercase}
/* 她的回话：左边一条细线（青），用户那条用墨 */
.nb-say{max-width:var(--prose);border-left:1px solid var(--cyan);padding-left:12px}
.nb-e .b{max-width:var(--prose)}
.nb-e.me .nb-say{border-left-color:var(--line)}
/* 证据条：只有边框的小标签 */
.nb-ev span{border:1px solid var(--line-dim);background:none;
  font-size:9.5px;letter-spacing:.06em;padding:2px 6px}
/* 日期分隔：等宽大写 + 细线 */
.nb-daymark{font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}
/* 代码：一行一行像清单 */
.nb-say pre{background:var(--tint1);border:1px solid var(--line-dim);font-size:11.5px}
.nb-say code{background:var(--tint2);font-size:11.5px}
/* 折叠按钮 */
.nb-more{border-color:var(--line);font-size:10px;letter-spacing:.08em}
/* 输入区：一条底线 + 等宽提示 */
.nb-cin{border-top:1px solid var(--line)}
.nb-cin .h{font-size:9.5px;letter-spacing:.08em;color:var(--dim2)}
.nb-cin .sd{border-color:var(--line);font-size:10.5px}
.nb-cin .sd:hover{background:var(--ink);color:var(--void)}
/* 空状态与提示 */
.nb-empty{font-size:11.5px;color:var(--dim2)}
/* 页边头像：方形，细边 */
.nb-gav{border:1px solid var(--line-dim);opacity:1}
/* 工作台：细线 + 等宽小标签 + 密读数，不加底色 */
.nb-cards{gap:0;border:1px solid var(--line);border-right:0}
.nb-card2{border:0;border-right:1px solid var(--line);padding:14px 16px;background:none}
.nb-card2:hover{background:var(--tint1)}
.nb-card2 .k{font-size:9.5px;letter-spacing:.18em;text-transform:uppercase}
.nb-card2 b{font-size:26px;font-weight:500;letter-spacing:-.02em}
.nb-card2 .m{font-size:10px;letter-spacing:.04em}
/* 中间那排读数：一格一条竖线，像表格 */
.nb-kv{grid-template-columns:88px 1fr;font-size:10.5px;line-height:1.9;
  border-top:1px solid var(--line-dim);border-bottom:1px solid var(--line-dim);padding:8px 0;margin:14px 0}
.nb-kv b{font-size:9.5px;letter-spacing:.16em;text-transform:uppercase}
/* 分区标题：细线在上 */
.nb-sec{border-top:1px solid var(--line-dim);padding-top:10px;margin:26px 0 10px;
  font-size:9.5px;letter-spacing:.22em}
/* 配方卡与按钮：只有细线 */
.nb-recipe{border:1px solid var(--line);background:none;padding:12px 14px}
.nb-recipe:hover{background:var(--tint1);border-color:var(--ink)}
.nb-btn{border-color:var(--line);font-size:10.5px;letter-spacing:.08em}
.nb-btn:hover{background:var(--ink);color:var(--void);border-color:var(--ink)}
/* 活动行：更密、时间戳等宽 */
.nb-actline{border-top:1px solid var(--line-dim)}



*{box-sizing:border-box}
/* hidden 要真的藏住：.nb-tabs 有 display:flex，会盖过 UA 的 [hidden]{display:none} */
[hidden]{display:none !important}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--line-dim);border-radius:0}
::-webkit-scrollbar-thumb:hover{background:var(--dim2)}
html,body{height:100%;margin:0}
body{background:var(--void);color:var(--ink);font:12.5px/1.75 var(--sans);
  text-spacing-trim:trim-start;text-autospace:ideograph-alpha ideograph-numeric;
  line-break:strict;hanging-punctuation:first allow-end last;font-kerning:normal;
  font-variant-east-asian:normal}
.nb{height:100vh;display:grid;grid-template-rows:34px minmax(0,1fr)}
.nb-top{display:flex;align-items:center;gap:16px;padding:0 14px;border-bottom:1px solid var(--line-dim);
  font:11px/1 var(--mono);color:var(--dim);letter-spacing:.04em;white-space:nowrap;overflow:hidden}
.nb-top b{color:var(--ink);font-weight:600}
.nb-top .sp{flex:1}
.nb-crumb{font:10.5px/1 var(--mono);letter-spacing:.12em;color:var(--dim)}
.nb-crumb b{color:var(--ink);font-weight:500;letter-spacing:.12em}
.nb-crumb i{color:var(--dim2);font-style:normal;margin:0 6px}
.nb-dot{width:5px;height:5px;background:var(--cyan);border-radius:50%;display:inline-block;margin-right:7px;vertical-align:1px}
.nb-main{display:grid;grid-template-columns:var(--rail) minmax(0,1fr) auto;min-height:0}

.nb-index{border-right:1px solid var(--line-dim);display:flex;flex-direction:column;min-height:0;padding:14px 0 8px;overflow:auto}
.nb-index h2{font:10px/1 var(--mono);letter-spacing:.18em;color:var(--dim2);margin:0 0 10px 16px;font-weight:400}
.nb-day{display:grid;grid-template-columns:18px 1fr;gap:8px;padding:7px 14px;cursor:pointer;border-left:2px solid transparent}
.nb-day:hover{background:var(--tint2)}
.nb-day.on{border-left-color:var(--ink);background:var(--tint3)}
.nb-day .mk{width:7px;height:7px;border:1px solid var(--line);margin-top:9px}
.nb-day.on .mk{background:var(--ink);border-color:var(--ink)}
.nb-day .d{display:block;font:12px/1.5 var(--sans)}
.nb-day .m{display:block;font:10px/1.6 var(--mono);color:var(--dim2)}
.nb-grow{flex:1;min-height:16px}
.nb-go{display:flex;justify-content:space-between;gap:8px;padding:6px 14px;font:11px/1.9 var(--mono);
  color:var(--dim);cursor:pointer;border-top:1px solid var(--line-dim)}
.nb-go:hover{color:var(--ink)}
.nb-go.cur{color:var(--ink);background:var(--tint3)}
.nb-go .n{color:var(--dim2)}
.nb-go.warn .n{color:var(--amber)}

.nb-page{min-width:0;overflow:auto;padding:0 0 110px;scroll-behavior:auto}
.nb-home{max-width:calc(var(--measure) + 76px);margin:0 auto;padding:26px 24px 8px 8px}
.nb-kicker{font:10px/1 var(--mono);letter-spacing:.22em;color:var(--dim2);margin-bottom:14px}
.nb-greet{font:26px/1.35 var(--sans);font-weight:700;letter-spacing:-.01em;margin:0 0 8px}
.nb-greet em{font-style:italic;font-weight:400;border-bottom:1px solid var(--line)}
.nb-meta{font:10.5px/1.7 var(--mono);color:var(--dim2);letter-spacing:.04em}
.nb-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:18px 0 6px}
.nb-card2{display:block;text-align:left;border:1px solid var(--line-dim);background:var(--tint1);color:var(--ink);padding:11px 12px;cursor:pointer}
.nb-card2:hover{border-color:var(--line);background:var(--tint3)}
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
.nb-pagehd{display:flex;align-items:baseline;gap:12px;padding:18px 22px 10px;max-width:calc(var(--measure) + 76px);margin:0 auto}
.nb-pagehd h1{font:10px/1 var(--mono);letter-spacing:.18em;color:var(--dim2);margin:0;font-weight:400}
.nb-pagehd .sp{flex:1}
/* 视图页（记忆/文档/设置…）与对话列同宽同位置，不再一个 1100 一个 720 */
.nb-wrap{max-width:calc(var(--measure) + 76px);margin:0 auto;padding:0 22px 60px}
.nb-row{display:block;width:100%;text-align:left;border:0;border-top:1px solid var(--line-dim);
  background:none;color:var(--ink);padding:11px 4px;cursor:pointer;font:14px/1.6 var(--sans)}
.nb-row:hover{background:var(--tint2)}
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
.nb-recipe:hover{border-color:var(--line);background:var(--tint3)}
.nb-recipe .n{display:block;font:12.5px/1.4 var(--sans)}
.nb-recipe .d{display:block;font:10px/1.5 var(--mono);color:var(--dim2);margin-top:4px}
.nb-actline{display:flex;gap:10px;align-items:baseline;padding:5px 2px;border-bottom:1px solid var(--line-dim);cursor:pointer;font:12px/1.6 var(--sans)}
.nb-actline:hover{background:var(--tint2)}
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
.nb-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:40}
.nb-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:41;width:min(560px,92vw);max-height:80vh;overflow:auto;background:var(--void);border:1px solid var(--line);padding:16px 18px}
.nb-step{border-left:1px solid var(--line-dim);padding:2px 0 6px 10px;margin:8px 0}
.nb-step .hd{font:9px/1 var(--mono);letter-spacing:.16em;color:var(--dim2);margin-bottom:6px}
.nb-tr{font:11px/1.7 var(--mono);color:var(--ink);margin:4px 0;word-break:break-word}
.nb-tr .w{display:inline-block;min-width:44px;color:var(--dim);margin-right:6px}
.nb-tr.think{color:var(--dim)}
.nb-tr.res{color:var(--dim2)}
.nb-tr.err{color:#e06c6c}
/* 她写的 markdown 表格（榜单、对照表） */
.md-table{border-collapse:collapse;margin:10px 0;font:12px/1.6 var(--mono)}
.md-table th,.md-table td{border:1px solid var(--line-dim);padding:6px 9px;text-align:left;vertical-align:top}
.md-table th{color:var(--dim);font-weight:400;letter-spacing:.06em;background:var(--tint2)}
.md-table tr:hover td{background:var(--tint1)}
/* 聊天 / 工作：点一下切换，当前档亮着 */
.nb-modechip{font:10px/1 var(--mono);letter-spacing:.08em;color:var(--dim);background:none;
  border:1px solid var(--line-dim);padding:4px 8px;cursor:pointer;margin-right:8px}
.nb-modechip:hover{color:var(--ink);border-color:var(--line)}
.nb-modechip.on{color:var(--void);background:var(--ink);border-color:var(--ink)}
/* 回到最新：滚上去了才出现，点一下回到底 */
.nb-latest{position:fixed;right:74px;bottom:96px;z-index:6;font:10px/1 var(--mono);letter-spacing:.08em;
  color:var(--void);background:var(--ink);border:1px solid var(--ink);padding:7px 11px;cursor:pointer}
.nb-latest:hover{opacity:.85}
.nb-latest[hidden]{display:none}
.nb-gav{display:block;width:22px;height:22px;object-fit:cover;margin:0 0 5px auto;border:1px solid var(--line-dim);opacity:.85}
.nb-e.me .g .w{color:var(--amber)}
.nb-e .b{min-width:0}
.nb-say{border-left:2px solid var(--cyan);padding:2px 0 2px 14px}
.nb-e.me .nb-say{border-left-color:var(--amber)}
.nb-say p{margin:0 0 .8em}
.nb-say p:last-child{margin-bottom:0}
.nb-say ul,.nb-say ol{margin:.2em 0 .9em;padding-left:1.15em}
.nb-say li{margin:.3em 0}
.nb-say code{font:12.5px/1.7 var(--mono);background:var(--tint3);padding:1px 5px;border-radius:0}
.nb-say pre{background:var(--tint3);border:1px solid var(--line-dim);padding:10px;overflow:auto;
  font:12px/1.7 var(--mono);margin:.6em 0}
.nb-say h1,.nb-say h2,.nb-say h3{font-size:15px;margin:.9em 0 .4em;letter-spacing:.02em}
.nb-fold{position:relative;max-height:10.8em;overflow:hidden}
.nb-fold:after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--line-dim)}
.nb-fold.open{max-height:none}.nb-fold.open:after{display:none}
.nb-more{margin:8px 0 2px;font:11px/1 var(--mono);color:var(--ink);background:none;border:1px solid var(--line);
  padding:5px 9px;cursor:pointer;
  border-bottom:1px dashed var(--line);padding:0 0 3px;cursor:pointer;letter-spacing:.04em}
.nb-more:hover{color:var(--ink);border-bottom-color:var(--ink)}
.nb-ev{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.nb-ev span{font:10px/1 var(--mono);color:var(--dim);border:1px solid var(--line-dim);
  padding:5px 7px;background:var(--tint1)}
.nb-daymark{display:flex;align-items:center;gap:10px;margin:6px 0 4px;font:10px/1 var(--mono);
  letter-spacing:.14em;color:var(--dim2)}
.nb-daymark:after{content:"";flex:1;height:1px;background:var(--line-dim)}

/* 标本页：她收着的 */
.nb-board{max-width:1240px;margin:0 auto;padding:20px 22px 40px}
.nb-board h1{font:10px/1 var(--mono);letter-spacing:.2em;color:var(--dim2);margin:0 0 14px;font-weight:400}
.nb-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.nb-spec{position:relative;border:1px solid var(--line-dim);padding:13px 13px 38px;min-height:132px;}
.nb-spec:hover{border-color:var(--line);background:var(--tint2)}
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
/* 右栏自己滚：不加 min-height:0，grid 子项会被内容撑高，整页出现滚动条（2026-11-06） */
.nb-tabs{display:flex;border-left:1px solid var(--line-dim);min-height:0;height:100%;overflow:hidden}
.nb-rail{width:52px;display:flex;flex-direction:column;gap:2px;padding-top:12px;overflow:auto}
.nb-tab{font:11px/1 var(--mono);letter-spacing:.1em;color:var(--dim2);padding:11px 0;cursor:pointer;
  text-align:center;border:0;background:none;border-left:2px solid transparent}
.nb-tab:hover{color:var(--dim);background:var(--tint2)}
.nb-tab.on{color:var(--void);background:var(--ink);border-left-color:var(--ink)}
.nb-tab.wait{color:var(--amber)}
.nb-tab.wait.on{color:var(--void);background:var(--amber);border-left-color:var(--amber)}
.nb-tab .c{display:block;margin-top:5px;font-size:9px}
.nb-panel{width:280px;padding:14px 14px 40px;border-left:1px solid var(--line-dim);min-height:0;max-height:100%;overflow-y:auto;overscroll-behavior:contain}
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
.nb-composer{position:fixed;left:var(--rail);right:52px;bottom:0;padding:0 24px 14px;background:var(--void)}
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
.nb-tick{position:fixed;left:var(--rail);right:52px;bottom:64px;padding:0 24px;pointer-events:none}
.nb-tick div{max-width:calc(var(--measure) + 76px);margin:0 auto;font:10px/1.4 var(--mono);color:var(--dim2);
  padding-left:76px;text-align:right}

/* 其余页面：与对话页/工作台同一套语汇（2026-11-06 用户：其他界面也按这个来） */
/* 页头：等宽大写小标签 + 一条细线 */
.nb-pagehd{padding:18px 22px 10px}
.nb-pagehd h1{font-size:9.5px;letter-spacing:.22em;text-transform:uppercase}
/* 列表行：12.5px、细线、悬停只说一点 */
.nb-row{font-size:12.5px;line-height:1.75;padding:10px 4px}
.nb-row:hover{background:var(--tint1)}
.nb-row .m{font-size:9.5px;letter-spacing:.05em;margin-top:2px}
.nb-row .tag{font-size:9px;letter-spacing:.16em;text-transform:uppercase}
/* 搜索框：只留一条底线，像在纸上写 */
.nb-search{max-width:100%;border:0;border-bottom:1px solid var(--line);font-size:12.5px;padding:7px 2px}
.nb-search:focus{border-bottom-color:var(--ink)}
/* 表单：等宽小标签 + 底线输入 */
.nb-fld{grid-template-columns:88px 1fr}
.nb-fld label,.nb-form label{font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim2)}
.nb-form input,.nb-form textarea,.nb-form select{border:0;border-bottom:1px solid var(--line-dim);
  background:none;color:var(--ink);font-size:12.5px;padding:6px 2px}
.nb-form input:focus,.nb-form textarea:focus{border-bottom-color:var(--ink);outline:none}
/* 右栏切口签：选中反色 */
.nb-tab{font-size:9.5px;letter-spacing:.14em}
/* 跳转条 */
.nb-jump{font-size:9.5px;letter-spacing:.12em;border-color:var(--line-dim)}
/* 弹窗：只有细线，没有阴影 */
.nb-modal{border-color:var(--line)}
/* 引用块 / 追踪 / 审计：等宽小字，行高收紧 */
.nb-sub{border-left-width:1px;padding-left:12px;font-size:12.5px}
.nb-audit,.nb-tr{font-size:10.5px;line-height:1.75}
/* 日志行：更密 */
.nb-logrow{font-size:10.5px;padding:5px 2px}
/* 卡片 */
.nb-card{padding:12px 14px}
/* 空状态 */
.nb-empty{font-size:11.5px}
/* 切口签 / 跳转条：分段细线，选中反色（设置页那排太挤，靠这个立住） */
.nb-jumpbar{gap:0;border-bottom:1px solid var(--line)}
.nb-jump{border:1px solid var(--line-dim);border-right:0;padding:7px 9px;color:var(--dim)}
.nb-jump:last-child{border-right:1px solid var(--line-dim)}
.nb-jump.on{background:var(--ink);color:var(--void);border-color:var(--ink)}
.nb-tab{letter-spacing:.16em}

/* 日志行：列宽自适应，长 verb 省略而不是压到下一列 */
.nb-logrow{grid-template-columns:104px minmax(110px,190px) 70px 92px minmax(0,1fr);gap:10px}
.nb-logrow .v{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nb-logrow .d{white-space:nowrap}
/* 拒因单独一行，缩进对齐，不挤在行列里 */
.nb-audit{padding-left:114px;font-size:10px;color:var(--dim2)}
/* 切口签：单行横向滚动，不折行 */
.nb-jumpbar{flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;padding:8px 0 6px}
.nb-jump{flex:0 0 auto;white-space:nowrap}
.nb-jumpbar::-webkit-scrollbar{height:6px}
</style></head>
<body>
<!--BOOT-->
<div class="nb">
  <div class="nb-top">
    <span><i class="nb-dot"></i><b id="nb-line">醒着</b></span>
    <span id="nb-counts"></span>
    <span class="sp"></span>
    <button class="nb-modechip" id="nb-modechip" title="聊天：只靠记忆召回；工作：带上最近几轮 + 更宽的预算">聊天</button>
    <span id="nb-usd">今天 $0.000</span><span id="nb-model">—</span>
    <span id="nb-crumb" class="nb-crumb">记录本</span>
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
      <div class="nb-go" data-v="files">文件</div>
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
        <button class="nb-tab" data-t="4" id="nb-t4">IV<span class="c" id="nb-c4">0</span></button>
      </div>
      <div class="nb-panel" id="nb-panel" hidden></div>
    </aside>
  </div>
</div>

<div class="nb-tick"><div id="nb-tickmsg"></div></div>
<button class="nb-latest" id="nb-latest" hidden>回到最新 ↓</button>
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

</div>

<!-- 界面脚本在 src/web/ui/notebook.js：真文件，能 node --check、能 import 测试；下面这个标签只是加载它 -->
<script src="/ui/notebook.js"></script>
</body></html>`;
