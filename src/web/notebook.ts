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
 * 现状：零构建、无外部字体/图床；配色就是 :root 里那几个变量，想换改它们。
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
<title>{{AGENT}} · 记录本</title>
<style>
:root{
  color-scheme:dark;
  --void:#0b0e0b;--ink:#f2f7f8;--dim:#b9c6c9;--dim2:#7d8b8f;
  --line:rgba(233,240,242,.30);--line-dim:rgba(233,240,242,.10);
  --cyan:#0f7c74;--amber:#c9a227;--fade:#8f9799;   /* 深底上琥珀要够亮：8.02:1 */
  /* 叠加层：深色底上是白雾，浅色底上要反过来，否则一片隐形 */
  --tint1:rgba(233,240,242,.015);--tint2:rgba(233,240,242,.03);--tint3:rgba(233,240,242,.05);
  --ok:#3f7a3a;--warn:#8a6d1f;--err:#a8423a;
  /* 危险动作与遮罩：以前散在各处硬写，现在收进 token（2026-11-07 a11y/主题审计 P2） */
  --danger:#7a3b36;--danger-fg:#d08a85;--scrim:rgba(5,7,6,.9);--modal-scrim:rgba(0,0,0,.62);
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
  --danger:#a8423a;--danger-fg:#a8423a;--scrim:rgba(251,251,249,.92);--modal-scrim:rgba(23,25,26,.28);
}
/* 版式差异：左栏 248（Hermes 的 sidebar 宽） */
/* 正文别跟着容器一起变宽：容器 1120 / 正文 720 */
[data-theme="hermes"] .nb-greet{font-size:22px;font-weight:600;letter-spacing:-.01em}
[data-theme="hermes"] .nb-sec{letter-spacing:.18em}
[data-theme="hermes"] .nb-e .g .w{letter-spacing:.1em}
/* 浅色下代码块与表格的底要更实一点，不然像没渲染 */
[data-theme="hermes"] .nb-say pre{background:var(--tint2)}
[data-theme="hermes"] .md-table th{background:var(--tint2)}
/* 顶栏与输入区在浅色底上要有一条实线，不然糊在一起 */
[data-theme="hermes"] .nb-top{border-bottom-color:var(--line-dim)}
[data-theme="hermes"] .nb-composer{border-top:1px solid var(--line-dim)}
/* 滚动条：浅色底上用墨色滑块 */
[data-theme="hermes"] ::-webkit-scrollbar-thumb{background:var(--line-dim)}
[data-theme="hermes"] ::-webkit-scrollbar-thumb:hover{background:var(--dim2)}
/* 选项按钮：一律走共用语汇里的通用三行（高亮卡片），主题级不再单独覆盖，
   避免「深色主题一套、浅色主题另一套」，也不给任何单颗按钮开小灶。 */


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
.nb{height:100vh;display:flex;flex-direction:column}
.nb-top{flex:0 0 34px}
.nb-top{display:flex;align-items:center;gap:16px;padding:0 14px;border-bottom:1px solid var(--line-dim);
  font:11px/1 var(--mono);color:var(--dim);letter-spacing:.04em;white-space:nowrap;overflow:hidden}
.nb-top b{color:var(--ink);font-weight:600}
.nb-top .sp{flex:1}
.nb-crumb{font:10.5px/1 var(--mono);letter-spacing:.12em;color:var(--dim)}
.nb-crumb b{color:var(--ink);font-weight:500;letter-spacing:.12em}
.nb-crumb i{color:var(--dim2);font-style:normal;margin:0 6px}
.nb-dot{width:5px;height:5px;background:var(--cyan);border-radius:50%;display:inline-block;margin-right:7px;vertical-align:1px}
.nb-main{display:grid;grid-template-columns:var(--rail) minmax(0,1fr) auto;min-height:0;flex:1}
/* ===== 外壳（2026-11-14）：ui.shell 以前只存不用，现在真的有第二种形态 =====
   classic = 单栏专注：收起左侧索引与右侧切口签，只留内容；顶栏的「≡」把导航临时叫回来。
   不复活那套已删的旧面板（2026-11-05 的决定），同一套记录本，只是收边。 */
.nb-navtoggle{display:none;align-items:center;justify-content:center;width:26px;height:24px;margin-right:8px;
  background:none;border:1px solid var(--line-dim);border-radius:6px;color:var(--dim);cursor:pointer;
  font:13px/1 var(--sans);padding:0}
.nb-navtoggle:hover{color:var(--ink);border-color:var(--line)}
[data-shell="classic"] .nb-navtoggle{display:inline-flex}
[data-shell="classic"] .nb-index{display:none}
[data-shell="classic"] .nb-tabs{display:none}
[data-shell="classic"] .nb-main{grid-template-columns:minmax(0,1fr)}
[data-shell="classic"] #nb-composer{left:0 !important;right:0 !important}
[data-shell="classic"] .nb-tick{left:0 !important;right:0 !important}
/* 唤回的导航是浮层：不挤内容，点空白或选中一项就收 */
[data-shell="classic"].shell-peek .nb-index{display:flex;position:fixed;left:0;top:0;bottom:0;z-index:40;
  width:var(--rail);background:var(--void);border-right:1px solid var(--line);box-shadow:0 0 40px rgba(0,0,0,.45)}

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
.nb-btn.danger{border-color:var(--danger);color:var(--danger-fg)}
.nb-btn.danger:hover{background:var(--danger);color:var(--ink)}
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
.nb-gapt{font:15px/1.7 var(--sans);color:var(--ink)}
.nb-gapt .m{display:block;font:10px/1.6 var(--mono);color:var(--dim2);margin-top:2px}
.nb-grid2{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:6px}
.nb-recipe{display:block;text-align:left;border:1px solid var(--line-dim);background:none;color:var(--ink);padding:10px 11px;cursor:pointer}
.nb-recipe:hover{border-color:var(--line);background:var(--tint3)}
.nb-recipe .n{display:block;font:12.5px/1.4 var(--sans)}
.nb-recipe .d{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font:9.5px/1.55 var(--mono);color:var(--dim2);margin-top:5px}
.nb-actline{display:flex;gap:10px;align-items:baseline;padding:5px 2px;border-bottom:1px solid var(--line-dim);cursor:pointer;font:12px/1.6 var(--sans)}
.nb-actline:hover{background:var(--tint2)}
.nb-actline .t{font:9.5px/1.6 var(--mono);color:var(--dim2);flex:none;font-variant-numeric:tabular-nums}
.nb-actline .w{font:9px/1.6 var(--mono);color:var(--dim);flex:none}
.nb-actline .x{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nb-pal{position:fixed;inset:0;z-index:50;background:var(--scrim);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}
.nb-pal[hidden]{display:none}
.nb-palbox{width:min(620px,92vw);border:1px solid var(--line);background:var(--void)}
.nb-palin{width:100%;background:none;border:0;border-bottom:1px solid var(--line-dim);color:var(--ink);font:14px/1.6 var(--sans);padding:12px 14px;outline:none}
#nb-palist{max-height:46vh;overflow:auto}
.nb-palrow{display:flex;gap:10px;align-items:baseline;padding:8px 14px;cursor:pointer;border-bottom:1px solid var(--line-dim)}
.nb-palrow.on{background:var(--ink);color:var(--void)}
.nb-palrow .k{font:9px/1 var(--mono);letter-spacing:.12em;color:var(--dim2);flex:none;width:44px}
.nb-palrow.on .k{color:var(--dim)}
.nb-palrow .v{font:12.5px/1.5 var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nb-run{border-top:1px solid var(--line-dim);margin-bottom:6px}
.nb-runrow{display:grid;grid-template-columns:84px 1fr auto;gap:12px;align-items:baseline;padding:9px 2px;border-bottom:1px solid var(--line-dim);font:12.5px/1.6 var(--sans)}
.nb-runrow .k{font:9.5px/1.6 var(--mono);letter-spacing:.12em;color:var(--dim2)}
.nb-runrow .v{color:var(--ink)}
.nb-runrow .m{font:10px/1.6 var(--mono);color:var(--dim2);text-align:right}
.nb-form{display:grid;gap:8px;padding:6px 0 4px}
/* ===== 设置页（2026-11-14 重排）：左侧分类 + 右侧整组铺开 =====
   旧版是 20 个平铺标签，总宽 1407px 而容器只有 1075px —— 末尾 5 项得横向滚动才找得到；
   而且一次只显示一节，同类的几项被拆到不同页。现在按 5 类收拢，同类一次看全。 */
.cf-layout{display:flex;flex-wrap:wrap;align-items:flex-start;gap:26px 30px;max-width:940px}
.cf-nav{flex:0 0 164px;position:sticky;top:6px;display:grid;gap:1px}
.cf-navitem{display:grid;grid-template-columns:1fr auto;grid-template-areas:"n c" "h c";gap:2px 8px;
  text-align:left;background:none;border:0;padding:9px 10px 9px 12px;
  cursor:pointer;color:var(--dim);font:13px/1.3 var(--sans);transition:color .12s,background-color .12s}
/* 选中用和左侧主导航同一套语言：淡底 + 亮字，不额外画边框 */
.cf-navitem:hover{color:var(--ink);background:var(--tint1)}
.cf-navitem.on{color:var(--ink);background:var(--tint3)}
.cf-navname{grid-area:n;letter-spacing:.02em}
.cf-navhint{grid-area:h;font:9px/1.4 var(--mono);letter-spacing:.08em;color:var(--dim2)}
.cf-navn{grid-area:c;align-self:center;font:9px/1 var(--mono);color:var(--dim2)}
.cf-navitem.on .cf-navn{color:var(--dim)}
.cf-body{flex:1 1 420px;min-width:0;max-width:660px}
.cf-ghead{display:flex;align-items:baseline;gap:10px;padding-bottom:7px;border-bottom:1px solid var(--line)}
.cf-ghead h2{margin:0;font:15px/1.3 var(--sans);font-weight:500;color:var(--ink);letter-spacing:.02em}
.cf-ghead .t{font:9.5px/1 var(--mono);letter-spacing:.16em;color:var(--dim2)}
/* 组标题已经说明了这是什么，紧跟着的第一节不再画一条横线分隔 */
.cf-group > .cf-ghead + .nb-sec{margin-top:14px;border-top:0;padding-top:0}
.nb-sec{scroll-margin-top:44px}
/* 版本与更新：SHA-256 / 下载地址都是长串，允许在任意字符处断行，别把整行顶出去 */
#cf-upout .nb-runrow .v{overflow-wrap:anywhere;word-break:break-word}
.nb-opts{display:flex;flex-wrap:wrap;gap:6px}
/* 选项按钮（2026-11-14）：整套统一成「高亮卡片」——非选中态也有实底、可见边框和主色文字，
   不再有哪一颗灰字糊在背景里。颜色全走 --ink / --void，随深浅主题自动翻转；
   所有 .nb-opt（外壳 / 开机片头 / 主题 / 权限 / 音色 / 人格档）同一套规则，不给单颗开小灶。 */
.nb-opt{font:600 11px/1.45 var(--mono);color:var(--void);background:color-mix(in srgb,var(--ink) 72%,var(--void));border:1px solid color-mix(in srgb,var(--ink) 45%,transparent);border-radius:6px;padding:7px 10px;cursor:pointer}
.nb-opt:hover{background:color-mix(in srgb,var(--ink) 88%,var(--void));border-color:color-mix(in srgb,var(--ink) 65%,transparent)}
.nb-opt.on{color:var(--void);background:var(--ink);border-color:var(--ink);font-weight:700;box-shadow:0 0 0 2px color-mix(in srgb,var(--ink) 30%,transparent),inset 0 0 0 1px rgba(255,255,255,.22)}
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
.nb-modal-bg{position:fixed;inset:0;background:var(--modal-scrim);z-index:40}
.nb-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:41;width:min(560px,92vw);max-height:80vh;overflow:auto;background:var(--void);border:1px solid var(--line);padding:16px 18px}
.nb-step{border-left:1px solid var(--line-dim);padding:2px 0 6px 10px;margin:8px 0}
.nb-step .hd{font:9px/1 var(--mono);letter-spacing:.16em;color:var(--dim2);margin-bottom:6px}
.nb-tr{font:11px/1.7 var(--mono);color:var(--ink);margin:4px 0;word-break:break-word}
.nb-tr .w{display:inline-block;min-width:44px;color:var(--dim);margin-right:6px}
.nb-tr.think{color:var(--dim)}
.nb-tr.res{color:var(--dim2)}
.nb-tr.err{color:var(--err)}
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
.nb-note{font:10px/1.6 var(--mono);color:var(--dim2);margin-top:6px;letter-spacing:.04em}
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
.nb-spec .v{font-size:12.5px;line-height:1.75;word-break:break-word}
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
.nb-card .t{font-size:12.5px;line-height:1.75}
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
/* 切口签：分段细线，选中反色 */
.nb-tab{letter-spacing:.16em}

/* 日志行：列宽自适应，长 verb 省略而不是压到下一列 */
.nb-logrow{grid-template-columns:104px minmax(110px,190px) 70px 92px minmax(0,1fr);gap:10px}
.nb-logrow .v{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nb-logrow .d{white-space:nowrap}
/* 拒因单独一行，缩进对齐，不挤在行列里 */
.nb-audit{padding-left:114px;font-size:10px;color:var(--dim2)}
/* 还没配好的横幅：细线一条，不弹窗、不挡操作 */
.nb-cfgbar{display:flex;align-items:center;gap:12px;padding:7px 16px;border-bottom:1px solid var(--line-dim);
  background:var(--tint1);font:10.5px/1.4 var(--mono);letter-spacing:.04em;color:var(--amber)}
.nb-cfgbar .t{flex:1}
.nb-cfgbar .nb-btn{margin:0}

/* 键盘可达性（2026-11-07 a11y 审计 P1）：用 Tab 走界面时要有可见焦点 */
[role="button"]:focus-visible,button:focus-visible,a:focus-visible,textarea:focus-visible,input:focus-visible{
  outline:2px solid var(--ink);outline-offset:-2px}
.nb-day:focus-visible,.nb-tab:focus-visible{outline-offset:0}

/* 浏览器自带表面（2026-11-07 polish）：这些默认值不属于任何设计系统，得自己接管 */
::selection{background:var(--ink);color:var(--void)}
html{caret-color:var(--cyan)}
/* 数字一律等宽对齐：时间戳、计数、花费、步骤号 */
.nb-e .g,.nb-meta,.nb-counts,.nb-top,.nb-kv,.nb-runrow .v,.nb-row .m,.nb-logrow,.nb-audit,.nb-metric b{
  font-variant-numeric:tabular-nums}
/* 链接：偏移一点，别贴着字 */
a{text-underline-offset:2px;text-decoration-thickness:1px}

/* 间距节奏收成 8 的倍数：同一页面里 22/26/18/14 混着用会显脏 */
.nb-sec{margin:24px 0 8px}
.nb-cards{margin:16px 0 8px}
.nb-kv{margin:8px 0 16px}
.nb-pagehd{padding:16px 16px 8px}
.nb-wrap{padding:0 16px 48px}

/* 空状态：一句话 + 一句提示，别只丢一行灰字 */
.nb-empty{line-height:1.7}

/* 按钮的禁用态（做到一半的按钮会临时 disabled，没样式就像坏了） */
.nb-btn:disabled,.nb-opt:disabled{opacity:.45;cursor:default}
/* 输入框的焦点：底色不动，只把底边压深一格 */
input:focus-visible,textarea:focus-visible{outline:none;border-bottom-color:var(--ink)}

/* ── 动效（2026-11-07）─────────────────────────────
   Operate 模式：只做「状态变了」和「东西到了」这两类，不做入场编排。
   签名动作：她的竖线从 0 长起来（1px 线是这套世界的记号）。 */
@keyframes nb-line-grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes nb-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes nb-fade{from{opacity:0}to{opacity:1}}
@keyframes nb-drop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@keyframes nb-blink{0%,49%{opacity:1}50%,100%{opacity:0}}

/* 新落地的一条：抬起 4px 到位（只在刚追加时加 .fresh） */
.nb-e.fresh{animation:nb-rise .18s cubic-bezier(.2,.8,.2,1) both}
/* 她的那条：竖线从顶端长下来 */
.nb-e.fresh .nb-say{transform-origin:top;animation:nb-line-grow .22s cubic-bezier(.2,.8,.2,1) both}
/* 流式正文末尾的方块光标 */
.nb-say .streaming::after{content:"";display:inline-block;width:6px;height:1em;vertical-align:-2px;
  margin-left:3px;background:var(--ink);animation:nb-blink 1.05s steps(1) infinite}
/* 过程追加：只让最新那一行淡进来（整栏重绘时不会重复演） */
.nb-step:last-child{animation:nb-fade .14s ease-out both}
/* 面板切换：内容在换，只做一次短淡入 */
.nb-panel:not([hidden]){animation:nb-fade .12s ease-out both}
/* 横幅从上面掉下来（它是「出现了」这件事本身） */
.nb-cfgbar:not([hidden]){animation:nb-drop .16s ease-out both}
/* 按压：按钮给一点手感，不做位移 */
.nb-btn:active,.nb-opt:active,.cf-navitem:active{transform:translateY(1px)}
.nb-btn,.nb-opt,.cf-navitem,.nb-tab{transition:background-color .12s,color .12s,border-color .12s}
/* 关掉动效：不劫持状态变化，只去掉位移与闪烁 */
@media (prefers-reduced-motion: reduce){
  .nb-e.fresh,.nb-e.fresh .nb-say,.nb-step:last-child,.nb-panel:not([hidden]),.nb-cfgbar:not([hidden]){animation:none}
  .nb-say .streaming::after{animation:none}
  .nb-btn:active,.nb-opt:active,.cf-navitem:active{transform:none}
}
/* 跳转链接：平时看不见，Tab 一进来就出现（2026-11-07 a11y 补） */
.nb-skip{position:absolute;left:8px;top:-40px;z-index:99;padding:6px 10px;background:var(--ink);color:var(--void);
  font:10.5px/1 var(--mono);letter-spacing:.08em;text-decoration:none;transition:top .12s}
.nb-skip:focus{top:8px}
@media (prefers-reduced-motion: reduce){.nb-skip{transition:none}}
/* ===== 陪伴模式（2026-11-13）：鲸鱼娘占主视觉 + 浮动对话；只替换中间对话区，左导航与右卷宗保留 ===== */
/* 背景一套：海洋/房间都写到 .nb-main 上，中间与右栏共享同一张底，不再各自铺一块 */
.nb.companion-on{--cp-bg:radial-gradient(130% 100% at 50% 0%, #2a7fa3 0%, #1c5f86 30%, #123a5c 62%, #0a1626 100%);
  /* 玻璃层：越透明越要够强的背景模糊 + 文字投影，否则压在人/照片上读不清 */
  /* 上浅下深的一道压暗：既透又能压住文字，照片背景也不会糊成一片 */
  --cp-glass:linear-gradient(to bottom, rgba(8,18,30,.26), rgba(8,18,30,.46) 55%, rgba(8,18,30,.62));
  --cp-glass-strong:rgba(10,22,36,.46);--cp-hair:rgba(160,220,245,.17);
  /* 右栏面板是整列高度，顶部常在亮墙上，必须比气泡更实一点才读得清 */
  --cp-glass-panel:linear-gradient(to bottom, rgba(8,18,30,.52), rgba(8,18,30,.64));}
.nb.companion-on[data-bg="room"]{--cp-bg:linear-gradient(180deg, rgba(12,20,32,.12), rgba(12,20,32,.4)), url("/static/pal/bg/room.png") center 32%/cover no-repeat}
.nb.companion-on .nb-main{background:var(--cp-bg)}
.nb.companion-on .nb-index{background:var(--void)}   /* 左导航保持原底色，不然黑字压在深底上 */
#nb-companion{position:absolute;inset:0;display:none;overflow:hidden;background:transparent}
.nb.companion-on #nb-companion{display:block}
.nb.companion-on .nb-page{padding:0;overflow:hidden;position:relative}
.nb.companion-on #nb-log,.nb.companion-on #nb-home,.nb.companion-on #nb-board,.nb.companion-on #nb-view{display:none}
.nb.companion-on .nb-composer{display:none}
/* 右卷宗留着（用户要的 0/I/II/III/IV + 计数）：整列透明浮在背景上，按钮本体是深色玻璃 + 描边，
   不与任何一张具体背景绑定（海洋、房间、以后再加的都一样） */
.nb.companion-on .nb-tabs{border-left:none;padding:16px 12px 14px 0;position:relative;background:transparent}
.nb.companion-on .nb-rail{width:54px;gap:10px;padding-top:0;overflow:visible}
.nb.companion-on .nb-tab{position:relative;border-radius:13px;padding:12px 0;border:1px solid rgba(150,215,240,.22);
  background:rgba(10,24,40,.42);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
  color:#d6ebf7;font:11.5px/1 var(--mono);letter-spacing:.12em;box-shadow:0 4px 16px rgba(0,0,0,.22)}
.nb.companion-on .nb-tab:hover{background:rgba(34,84,112,.6);color:#eef8fc}
.nb.companion-on .nb-tab.on{background:rgba(70,194,212,.24);border-color:rgba(95,224,216,.85);color:#eafcff;
  box-shadow:0 0 18px rgba(95,224,216,.38),inset 0 0 12px rgba(95,224,216,.18)}
.nb.companion-on .nb-tab .c{position:absolute;top:-6px;right:-5px;margin:0;min-width:17px;height:17px;line-height:17px;
  padding:0 4px;border-radius:9px;background:rgba(12,28,46,.92);border:1px solid rgba(150,215,240,.45);
  font-size:9px;letter-spacing:0;color:#cfe9f6}

/* 右栏展开面板（2026-11-13）：与对话卡同一版玻璃 —— 同一道半透明压暗 + 同样的模糊与圆角，
   不再是一条贴着窗口边的裸面板 */
.nb.companion-on .nb-panel{background:var(--cp-glass-panel);
  -webkit-backdrop-filter:blur(20px) saturate(1.06);backdrop-filter:blur(20px) saturate(1.06);
  border:1px solid var(--cp-hair);border-left:none;border-radius:18px;
  margin-left:10px;padding:14px 16px 18px;box-shadow:0 10px 34px rgba(0,0,0,.28);
  scrollbar-width:thin;scrollbar-color:rgba(120,200,235,.42) transparent}
.nb.companion-on .nb-panel::-webkit-scrollbar{width:7px}
.nb.companion-on .nb-panel::-webkit-scrollbar-thumb{background:rgba(120,200,235,.4);border-radius:7px}
.nb.companion-on .nb-panel h3{color:rgba(214,238,249,.95);text-shadow:0 1px 3px rgba(0,6,14,.5)}
.nb.companion-on .nb-panel .nb-card{border-color:rgba(160,220,245,.18);background:rgba(120,200,235,.07)}
.nb.companion-on .nb-panel .nb-card .t{color:#eef7fc}
.nb.companion-on .nb-panel .nb-empty{color:rgba(206,230,242,.8)}
.nb.companion-on .nb-tab.wait.on{color:#0b0e0b}/* 背景层不再自己铺底（底在 .nb-main），只留水下光效 */
.cp-bg{position:absolute;inset:0;z-index:0;overflow:hidden;background:transparent}
.cp-bg::after{content:"";position:absolute;inset:0;background:radial-gradient(80% 60% at 50% 110%, rgba(8,16,30,.55), transparent 60%)}
/* 房间里关掉水下光柱、焦散、气泡与冷光晕（背景本身在 .nb-main 的 --cp-bg 里）；自定义图同待遇 */
.nb.companion-on[data-bg="room"] .cp-rays,.nb.companion-on[data-bg="room"] .cp-caustics,
.nb.companion-on[data-bg="room"] .cp-bubbles,.nb.companion-on[data-bg="room"] .cp-glow,
.nb.companion-on[data-bg="custom"] .cp-rays,.nb.companion-on[data-bg="custom"] .cp-caustics,
.nb.companion-on[data-bg="custom"] .cp-bubbles,.nb.companion-on[data-bg="custom"] .cp-glow{display:none}
.nb.companion-on[data-bg="room"] .cp-canvas,.nb.companion-on[data-bg="custom"] .cp-canvas{filter:drop-shadow(0 14px 26px rgba(0,8,18,.45))}
/* 体积光：从海面斜射下来的明亮光柱（正常叠加保证可见），底部渐隐，缓慢摆动 */
.cp-rays{position:absolute;inset:-18% -10%;transform-origin:50% 0;filter:blur(3px);
  background:linear-gradient(102deg, transparent 39%, rgba(198,244,255,.4) 45%, rgba(198,244,255,.1) 51%, transparent 58%),
    linear-gradient(96deg, transparent 55%, rgba(168,230,250,.32) 61%, transparent 68%),
    linear-gradient(108deg, transparent 23%, rgba(210,248,255,.34) 30%, transparent 38%),
    linear-gradient(90deg, transparent 69%, rgba(176,234,250,.28) 76%, transparent 84%),
    linear-gradient(100deg, transparent 84%, rgba(190,240,255,.24) 90%, transparent 96%);
  -webkit-mask-image:linear-gradient(to bottom, #000 0%, rgba(0,0,0,.6) 58%, transparent 96%);
  mask-image:linear-gradient(to bottom, #000 0%, rgba(0,0,0,.6) 58%, transparent 96%);
  animation:cp-rays 18s ease-in-out infinite alternate}
@keyframes cp-rays{0%{transform:translateX(-3%) skewX(-2deg);opacity:.85}50%{opacity:1}100%{transform:translateX(3%) skewX(2deg);opacity:.9}}
/* 水底焦散光斑：缓慢游动的亮区，增加深海层次 */
.cp-caustics{position:absolute;inset:0;
  background:radial-gradient(58% 40% at 26% 84%, rgba(130,216,240,.2), transparent 62%),
    radial-gradient(50% 34% at 74% 88%, rgba(160,232,248,.16), transparent 62%),
    radial-gradient(42% 30% at 50% 96%, rgba(190,242,255,.14), transparent 60%);
  animation:cp-caustics 12s ease-in-out infinite alternate}
@keyframes cp-caustics{0%{transform:translateX(-2%) scale(1);opacity:.5}100%{transform:translateX(2%) scale(1.07);opacity:.8}}
.nb.companion-on #nb-companion{animation:cp-fade .55s ease-out}
@keyframes cp-fade{from{opacity:0}to{opacity:1}}
.cp-glow{position:absolute;left:50%;top:4%;width:64%;height:54%;transform:translateX(-50%);
  background:radial-gradient(closest-side, rgba(165,236,250,.42), rgba(130,215,240,.13) 55%, transparent 72%);filter:blur(6px);
  animation:cp-breathe 7s ease-in-out infinite}
@keyframes cp-breathe{0%,100%{opacity:.75;transform:translateX(-50%) scale(1)}50%{opacity:1;transform:translateX(-50%) scale(1.05)}}
.cp-bubbles{position:absolute;inset:0}
.cp-bub{position:absolute;bottom:-48px;border-radius:50%;
  background:radial-gradient(circle at 32% 30%, rgba(225,248,255,.55), rgba(160,220,240,.14) 58%, transparent 72%);
  border:1px solid rgba(205,240,255,.2);animation:cp-rise linear infinite}
@keyframes cp-rise{0%{transform:translateY(0) translateX(0);opacity:0}8%{opacity:.75}88%{opacity:.5}100%{transform:translateY(-112vh) translateX(26px);opacity:0}}
/* 人物舞台：WebGL 透明画布叠在背景上；底部留出浮动对话+输入条的位置 */
.cp-stage{position:absolute;inset:0;z-index:1}
.cp-canvas{position:absolute;left:0;right:0;top:0;bottom:186px;width:100%;height:100%;display:block;
  filter:drop-shadow(0 18px 30px rgba(0,10,25,.45))}
@media (prefers-reduced-motion: reduce){.cp-rays,.cp-caustics{animation:none}}
/* 顶部：状态胶囊 + 声音/切换 */
.cp-top{position:absolute;top:0;left:0;right:0;z-index:3;display:flex;align-items:center;justify-content:space-between;padding:16px 20px}
.cp-status{display:flex;align-items:center;gap:9px;height:34px;box-sizing:border-box;
  background:rgba(12,28,46,.55);border:1px solid rgba(150,215,240,.26);
  -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-radius:999px;padding:0 16px;
  font:12px/1 var(--sans);color:#e3f4fb;letter-spacing:.05em;box-shadow:0 4px 18px rgba(0,0,0,.22)}
.cp-dot{width:7px;height:7px;border-radius:50%;background:#5fe0d8;box-shadow:0 0 9px #5fe0d8;animation:cp-pulse 2.4s ease-in-out infinite}
@keyframes cp-pulse{0%,100%{opacity:.55;transform:scale(.9)}50%{opacity:1;transform:scale(1.1)}}
/* 顶栏与面板共用同一套表面：同高度、同描边、同圆角，视觉上是一组控件 */
.cp-topbtns{display:flex;gap:8px}
.cp-icon,.cp-pill,.cp-exit{height:34px;background:rgba(12,28,46,.55);border:1px solid rgba(150,215,240,.26);
  -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  color:#e3f4fb;border-radius:999px;cursor:pointer;font:12px/1 var(--sans);transition:background .16s,border-color .16s,transform .12s}
.cp-icon{width:34px;font-size:14px;display:flex;align-items:center;justify-content:center}
.cp-pill{padding:0 14px;letter-spacing:.05em}
.cp-exit{padding:0 16px;letter-spacing:.06em}
.cp-icon:hover,.cp-pill:hover,.cp-exit:hover{background:rgba(42,98,130,.72);border-color:rgba(160,225,245,.55)}
.cp-icon:active,.cp-pill:active,.cp-exit:active{transform:translateY(1px)}
.cp-icon[aria-pressed="false"]{opacity:.55}
.cp-pill[aria-pressed="true"]{background:rgba(70,194,212,.24);border-color:rgba(95,224,216,.7);color:#eafcff}
/* 纯字幕模式（2026-11-13）：拿掉卡片，文字直接压在人/背景上，靠更重的投影保证可读 */
.nb.companion-on.sub-mode .cp-bubble{background:none;border-color:transparent;
  -webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:none;padding:10px 14px}
.nb.companion-on.sub-mode .cp-tx{color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.95),0 0 18px rgba(0,0,0,.7),0 2px 10px rgba(0,0,0,.55)}
.nb.companion-on.sub-mode .cp-who{background:rgba(0,0,0,.34);border-color:rgba(255,255,255,.14)}
.nb.companion-on.sub-mode .cp-more{background:rgba(8,18,30,.42);border-color:rgba(160,220,245,.18)}
.nb.companion-on.sub-mode .cp-input{background:rgba(8,18,30,.34);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
/* 表情/动作弹层：只有 Live2D 公皮才显示，浮在右上按钮下方 */
.cp-exprpop{position:absolute;top:60px;right:20px;z-index:4;max-width:340px;max-height:46vh;overflow:auto;
  background:rgba(12,28,46,.72);border:1px solid rgba(150,215,240,.28);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  border-radius:18px;padding:12px 14px;box-shadow:0 10px 34px rgba(0,0,0,.34);
  scrollbar-width:thin;scrollbar-color:rgba(120,200,235,.4) transparent}
.cp-exprpop[hidden]{display:none}
.cp-exprsec{font:10px/1 var(--mono);letter-spacing:.16em;color:#9fc6dc;margin:6px 0 8px}
.cp-exprrow{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
.cp-chip{border:1px solid rgba(150,215,240,.22);background:rgba(120,200,235,.08);color:#dceef8;border-radius:999px;
  padding:5px 12px;font:11.5px/1.4 var(--sans);cursor:pointer;transition:background .14s,border-color .14s}
.cp-chip:hover{background:rgba(120,200,235,.2);border-color:rgba(160,225,245,.45)}
.cp-chip:active{transform:translateY(1px)}
/* 镜头/形象调参（2026-11-13 统一）：收起是一枚胶囊，展开是一张面板 ——
   表面、描边、圆角、字体与对话气泡/顶栏完全同一套，不再各写一套玻璃 */
.cp-ctrl{position:absolute;left:20px;top:66px;z-index:4;width:200px;max-height:calc(100% - 150px);overflow-y:auto;overflow-x:hidden;
  background:rgba(12,28,46,.62);border:1px solid rgba(150,215,240,.28);
  -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  border-radius:18px;box-shadow:0 10px 34px rgba(0,0,0,.32);
  scrollbar-width:thin;scrollbar-color:rgba(120,200,235,.45) transparent}
.cp-ctrl:not([open]){width:auto;border-radius:999px;overflow:visible}
.cp-ctrl:not([open]) .cp-ctrlhead{min-height:32px}  /* 32 + 上下各 1px 边框 = 与顶栏按钮同为 34px */
.cp-ctrl::-webkit-scrollbar{width:7px}
.cp-ctrl::-webkit-scrollbar-thumb{background:rgba(120,200,235,.4);border-radius:7px}
.cp-ctrlhead{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;list-style:none;user-select:none;
  padding:8px 16px;min-height:34px;box-sizing:border-box;font:10.5px/1.4 var(--mono);letter-spacing:.14em;color:rgba(176,218,237,.9)}
.cp-ctrlhead::-webkit-details-marker{display:none}
.cp-ctrlhead::after{content:'+';font:13px/1 var(--sans);color:#7fd8e8}
.cp-ctrl[open] .cp-ctrlhead::after{content:'−'}
.cp-ctrlhead:hover{color:#e6f6ff}
.cp-ctrl[open] .cp-ctrlhead{border-bottom:1px solid rgba(150,215,240,.14)}
.cp-ctrlbody{padding:9px 16px 11px}
.cp-grp{font:9.5px/1 var(--mono);letter-spacing:.16em;color:rgba(158,206,228,.8);margin:9px 0 5px}
.cp-grp:first-child{margin-top:0}
.cp-ctl{display:block;margin:0 0 7px}
.cp-ctl span{display:flex;align-items:baseline;justify-content:space-between;gap:8px;
  font:11.5px/1.4 var(--sans);color:rgba(216,238,248,.92);margin-bottom:3px}
.cp-ctl i{font-style:normal;font:10.5px/1 var(--mono);color:#7fd8e8;font-variant-numeric:tabular-nums}
.cp-ctl input[type=range]{width:100%;height:14px;-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer}
.cp-ctl input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:3px;background:rgba(150,215,240,.22)}
.cp-ctl input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;margin-top:-4.5px;
  background:#eafcff;border:2px solid #46c2d4;box-shadow:0 0 8px rgba(70,194,212,.5);transition:transform .12s}
.cp-ctl input[type=range]:hover::-webkit-slider-thumb{transform:scale(1.08)}
.cp-ctl input[type=range]::-moz-range-track{height:3px;border-radius:3px;background:rgba(150,215,240,.22)}
.cp-ctl input[type=range]::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#eafcff;border:2px solid #46c2d4}
.cp-ctlcheck{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 8px}
.cp-ctlcheck span{margin-bottom:0}
/* 开关做成滑动式：原生小方框和整块圆角语言不搭 */
.cp-ctlcheck input[type=checkbox]{-webkit-appearance:none;appearance:none;flex:0 0 auto;width:32px;height:18px;border-radius:999px;
  border:1px solid rgba(150,215,240,.3);background:rgba(10,24,40,.6);position:relative;cursor:pointer;
  transition:background .16s,border-color .16s}
.cp-ctlcheck input[type=checkbox]::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
  background:rgba(220,240,250,.75);transition:transform .16s,background .16s}
.cp-ctlcheck input[type=checkbox]:checked{background:rgba(70,194,212,.35);border-color:rgba(95,224,216,.75)}
.cp-ctlcheck input[type=checkbox]:checked::after{transform:translateX(14px);background:#eafcff}
.cp-ctrlreset{width:100%;margin-top:3px;padding:6px 0;border-radius:999px;border:1px solid rgba(150,215,240,.26);
  background:rgba(120,200,235,.08);color:rgba(214,238,248,.92);font:11px/1 var(--sans);letter-spacing:.04em;cursor:pointer;
  transition:background .14s,border-color .14s}
.cp-ctrlreset:hover{background:rgba(120,200,235,.18);border-color:rgba(160,225,245,.4)}
/* 底部：浮动对话气泡 + 输入条 */
.cp-bottom{position:absolute;left:0;right:0;bottom:0;z-index:3;display:flex;flex-direction:column;align-items:center;gap:13px;padding:0 24px 24px}
.cp-bubble{max-width:580px;width:100%;background:var(--cp-glass);border:1px solid var(--cp-hair);
  -webkit-backdrop-filter:blur(20px) saturate(1.06);backdrop-filter:blur(20px) saturate(1.06);
  border-radius:20px;padding:14px 20px;
  font:15px/1.75 var(--sans);color:#f2f9fd;box-shadow:0 8px 28px rgba(0,0,0,.24);animation:cp-float-in .4s ease}
@keyframes cp-float-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
/* 气泡里放的是**同一条对话**的最近几条（2026-11-13）：进陪伴视图能看见刚才在记录本里说了什么，
   不再是「进去就从空开始」；在陪伴里说的话也会出现在记录本里 */
/* 默认只露最近一轮（你 + 她），更早的收成一行提示；点开才展开，不再一屏都是字 */
.cp-more{display:block;width:fit-content;margin:0 auto 9px;padding:3px 13px;cursor:pointer;
  background:rgba(120,200,235,.06);border:1px solid rgba(160,220,245,.14);border-radius:999px;
  font:10.5px/1.5 var(--mono);letter-spacing:.08em;color:rgba(170,216,236,.85);text-align:center;transition:background .14s,color .14s,border-color .14s}
.cp-more:hover{background:rgba(120,200,235,.18);border-color:rgba(150,215,240,.34);color:#e3f6ff}
.cp-more:hover{color:#cfeeff}
.cp-more[hidden]{display:none}
.cp-log{display:flex;flex-direction:column;gap:12px;max-height:32vh;overflow-y:auto;overscroll-behavior:contain;
  scrollbar-width:thin;scrollbar-color:rgba(120,200,235,.45) transparent;padding-right:2px}
.cp-log::-webkit-scrollbar{width:7px}
.cp-log::-webkit-scrollbar-thumb{background:rgba(120,200,235,.4);border-radius:7px}
/* 上下还有内容时用渐隐提示，而不是让字被硬切一半 */
.cp-log.fade-top{-webkit-mask-image:linear-gradient(to bottom, transparent 0, #000 20px);mask-image:linear-gradient(to bottom, transparent 0, #000 20px)}
.cp-log.fade-bottom{-webkit-mask-image:linear-gradient(to top, transparent 0, #000 20px);mask-image:linear-gradient(to top, transparent 0, #000 20px)}
.cp-log.fade-top.fade-bottom{-webkit-mask-image:linear-gradient(to bottom, transparent 0, #000 20px, #000 calc(100% - 20px), transparent 100%);
  mask-image:linear-gradient(to bottom, transparent 0, #000 20px, #000 calc(100% - 20px), transparent 100%)}
.cp-log.clip{max-height:none;overflow:visible;gap:7px}
.cp-log.clip .cp-line{display:none}
.cp-log.clip .cp-line:nth-last-child(-n+2){display:flex}
.cp-log.clip .cp-line.cp-me .cp-tx{font-size:13px;opacity:.72}
.cp-line{display:flex;gap:8px;align-items:flex-start}
.cp-who{flex:0 0 22px;text-align:center;font:9.5px/1.9 var(--mono);letter-spacing:.06em;color:#8ec8dd;
  border-radius:6px;background:rgba(120,200,235,.1);border:1px solid rgba(150,215,240,.14);margin-top:1px}
.cp-line.cp-me .cp-who{color:rgba(255,217,168,.85);background:rgba(255,200,120,.09);border-color:rgba(255,200,120,.16)}
.cp-tx{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;font:14.5px/1.75 var(--sans);color:#f2f9fd;
  text-shadow:0 1px 3px rgba(0,6,14,.5)}
.cp-line.cp-me .cp-tx{color:#daeaf5}
.cp-line .cp-typing::after{content:"…";animation:cp-dots 1.2s steps(4) infinite}
@keyframes cp-dots{0%{content:""}25%{content:"·"}50%{content:"··"}75%{content:"···"}}
.cp-input{max-width:580px;width:100%;display:flex;align-items:flex-end;gap:10px;background:var(--cp-glass-strong);
  border:1px solid var(--cp-hair);-webkit-backdrop-filter:blur(20px) saturate(1.06);backdrop-filter:blur(20px) saturate(1.06);
  border-radius:999px;padding:8px 8px 8px 22px;
  box-shadow:0 6px 22px rgba(0,0,0,.22);transition:border-color .16s}
.cp-input:focus-within{border-color:rgba(120,225,240,.6)}
.cp-input.busy{border-color:rgba(150,215,240,.2)}
.cp-input textarea:disabled{opacity:.6;cursor:default}
.cp-input textarea{flex:1;min-width:0;background:none;border:none;outline:none;color:#eef7fc;font:14px/1.5 var(--sans);
  resize:none;max-height:104px;overflow-y:auto;padding:7px 0;line-height:1.5}
.cp-input textarea::placeholder{color:rgba(200,228,242,.5)}
.cp-input textarea::-webkit-scrollbar{width:6px}
.cp-input textarea::-webkit-scrollbar-thumb{background:rgba(120,200,235,.35);border-radius:6px}
.cp-send{width:40px;height:40px;border-radius:50%;border:none;background:linear-gradient(135deg,#46c2d4,#2f8fbf);color:#fff;
  font-size:17px;cursor:pointer;flex:0 0 auto;display:flex;align-items:center;justify-content:center;transition:transform .12s,filter .16s;box-shadow:0 4px 14px rgba(47,143,191,.4)}
.cp-send:hover{filter:brightness(1.12)}
.cp-send:active{transform:scale(.93)}
.cp-send:disabled{opacity:.5;cursor:default}
@media (prefers-reduced-motion: reduce){.cp-bub,.cp-glow,.cp-dot{animation:none}.cp-bubble{animation:none}}
/* ===== 设置页 · 陪伴形象与背景卡片（2026-11-13）：点一下就换，缩略图所见即所得 ===== */
.pal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:12px;margin:6px 0 4px}
.pal-card{position:relative;border:1px solid var(--line-dim);border-radius:12px;overflow:hidden;cursor:pointer;
  background:var(--tint1);transition:border-color .15s,transform .12s,box-shadow .15s}
.pal-card:hover{border-color:var(--cyan);transform:translateY(-1px)}
.pal-card:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.pal-card.on{border-color:var(--cyan);box-shadow:0 0 0 1px var(--cyan),0 6px 18px rgba(15,124,116,.18)}
.pal-thumb{display:block;width:100%;height:88px;object-fit:cover;background:var(--tint2)}
.pal-avthumb{object-fit:contain;background:linear-gradient(180deg,#123a5c,#0a1626)}
.pal-noimg{display:flex;align-items:center;justify-content:center;color:#9fc6dc;font:12px/1 var(--mono);letter-spacing:.1em}
.pal-kind{position:absolute;top:64px;right:6px;padding:2px 7px;border-radius:8px;background:rgba(10,24,40,.72);
  border:1px solid rgba(150,215,240,.3);color:#bfe3f5;font:9.5px/1.4 var(--mono);letter-spacing:.06em}
.pal-ocean{background:radial-gradient(130% 100% at 50% 0%, #2a7fa3 0%, #1c5f86 30%, #123a5c 62%, #0a1626 100%)}
.pal-name{display:block;padding:7px 9px;font:11px/1.4 var(--sans);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pal-now{position:absolute;top:6px;left:6px;padding:2px 7px;border-radius:8px;background:var(--cyan);color:#fff;
  font:9.5px/1.4 var(--mono);letter-spacing:.06em}
.pal-del{position:absolute;top:5px;right:5px;width:20px;height:20px;border-radius:50%;background:rgba(10,14,11,.62);
  color:#fff;font:13px/20px var(--sans);text-align:center;cursor:pointer}
.pal-del:hover{background:var(--amber)}
.pal-steps{margin:8px 0 2px;padding:10px 12px;border:1px dashed var(--line-dim);border-radius:10px;
  font:11.5px/1.8 var(--sans);color:var(--dim2)}
</style></head>
<body>
<a class="nb-skip" href="#nb-page">跳到内容</a>
<!--BOOT-->
<div class="nb">
  <div class="nb-cfgbar" id="nb-cfgbar" role="status" aria-live="polite" hidden></div>
  <div class="nb-top">
    <button class="nb-navtoggle" id="nb-navtoggle" title="显示导航（Esc 收起）" aria-label="显示导航">≡</button>
    <span><i class="nb-dot" aria-hidden="true"></i><b id="nb-line">醒着</b></span>
    <span id="nb-counts"></span>
    <span class="sp"></span>
    <button class="nb-modechip" id="nb-companion-toggle" title="陪伴形象 ⇄ 文字记录本">陪伴</button>
    <button class="nb-modechip" id="nb-modechip" title="聊天：只靠记忆召回；工作：带上最近几轮 + 更宽的预算">聊天</button>
    <span id="nb-usd">今天 $0.000</span><span id="nb-model">—</span>
    <span id="nb-crumb" class="nb-crumb">记录本</span>
  </div>

  <div class="nb-main">
    <nav class="nb-index" aria-label="记录与去处">
      <h2>记录</h2>
      <div id="nb-days" role="list" aria-label="按天"></div>
      <h2 style="margin-top:16px">去处</h2>
      <div class="nb-go" data-v="home" role="button" tabindex="0">工作台</div>
      <div class="nb-go" data-v="sess" role="button" tabindex="0">会话<span class="n" id="nb-nsess">…</span></div>
      <div class="nb-go" data-v="mem" role="button" tabindex="0">记忆<span class="n" id="nb-nmem">…</span></div>
      <div class="nb-go" data-v="docs" role="button" tabindex="0">文档<span class="n" id="nb-ndocs">…</span></div>
      <div class="nb-go" data-v="cap" role="button" tabindex="0">能力</div>
      <div class="nb-go" data-v="task" role="button" tabindex="0">任务<span class="n" id="nb-ntask">…</span></div>
<div class="nb-go" data-v="logs" role="button" tabindex="0">日志</div>
      <div class="nb-go" data-v="files" role="button" tabindex="0">文件</div>
      <div class="nb-go" data-v="git" role="button" tabindex="0">校样</div>
      <div class="nb-go" data-v="sys" role="button" tabindex="0">系统</div>
      <div class="nb-go" data-v="cfg" role="button" tabindex="0">设置</div>
      <div class="nb-grow"></div>
      <div class="nb-go" id="nb-board-btn" role="button" tabindex="0">她收着的<span class="n" id="nb-about">…</span></div>
      <div class="nb-go" id="nb-gap" role="button" tabindex="0">还缺<span class="n" id="nb-gapn">…</span></div>
    </nav>

    <main class="nb-page" id="nb-page" tabindex="-1">
      <section id="nb-home"></section>
      <div id="nb-board" hidden></div>
      <div id="nb-view" hidden></div>
      <div id="nb-companion" hidden>
        <div class="cp-bg" aria-hidden="true"><div class="cp-rays"></div><div class="cp-caustics"></div><div class="cp-glow"></div><div class="cp-bubbles" id="cp-bubbles"></div></div>
        <div class="cp-stage" id="cp-stage"></div>
        <div class="cp-top">
          <div class="cp-status"><i class="cp-dot"></i><span id="cp-state">鲸鱼娘 · 在发呆</span></div>
          <div class="cp-topbtns">
            <button class="cp-pill" id="cp-bg" title="背景：在设置里配好的列表里循环">海洋</button>
            <button class="cp-pill" id="cp-sub" aria-pressed="false" title="对话框：玻璃卡片 ⇄ 纯字幕">字幕</button>
            <button class="cp-pill" id="cp-expr" title="表情 / 动作（仅 Live2D 公皮）" hidden>表情</button>
            <button class="cp-icon" id="cp-sound" title="声音开关" aria-pressed="true">🔊</button>
            <button class="cp-exit" id="cp-exit" title="切回文字记录本">记录本</button>
          </div>
        </div>
        <div class="cp-exprpop" id="cp-exprpop" hidden></div>
        <details class="cp-ctrl" id="cp-ctrl" aria-label="镜头与形象调参">
          <summary class="cp-ctrlhead">镜头 · 形象</summary>
          <div class="cp-ctrlbody">
            <div class="cp-grp">镜头</div>
            <label class="cp-ctl"><span>取景松紧<i id="tv-frac"></i></span><input type="range" data-tune="frac" min="0.3" max="0.9" step="0.01"></label>
            <label class="cp-ctl"><span>缩放<i id="tv-zoom"></i></span><input type="range" data-tune="zoom" min="0.6" max="1.8" step="0.01"></label>
            <label class="cp-ctl"><span>垂直位置<i id="tv-offY"></i></span><input type="range" data-tune="offY" min="-240" max="240" step="2"></label>
            <label class="cp-ctl"><span>水平位置<i id="tv-offX"></i></span><input type="range" data-tune="offX" min="-240" max="240" step="2"></label>
            <div class="cp-grp">表现</div>
            <label class="cp-ctl"><span>视线跟随<i id="tv-gaze"></i></span><input type="range" data-tune="gaze" min="0" max="2" step="0.05"></label>
            <label class="cp-ctl"><span>口型幅度<i id="tv-mouth"></i></span><input type="range" data-tune="mouth" min="0" max="2" step="0.05"></label>
            <label class="cp-ctl"><span>呼吸幅度<i id="tv-breath"></i></span><input type="range" data-tune="breath" min="0" max="2" step="0.05"></label>
            <div class="cp-grp">画面</div>
            <label class="cp-ctl cp-ctlcheck" title="关掉模型自带的加载方块 / 鼻影伪影，mesh 与 Live2D 公皮都适用"><span>伪影修复<i id="tv-noseFix"></i></span><input type="checkbox" data-tune="noseFix"></label>
            <button class="cp-ctrlreset" id="cp-ctrl-reset">重置为默认</button>
          </div>
        </details>
        <div class="cp-bottom">
          <div class="cp-bubble" id="cp-bubble">
            <button class="cp-more" id="cp-more" type="button" hidden>↑ 之前</button>
            <div class="cp-log" id="cp-log" aria-live="polite"></div>
          </div>
          <div class="cp-input" id="cp-input-box">
            <textarea id="cp-say" rows="1" placeholder="和鲸鱼娘说点什么  ·  Enter 发送，Shift+Enter 换行" autocomplete="off"></textarea>
            <button class="cp-send" id="cp-send" title="发送">↑</button>
          </div>
        </div>
      </div>
      <div class="nb-sheet" id="nb-log"></div>
    </main>

    <aside class="nb-tabs" id="nb-tabs" aria-label="卷宗">
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

<div class="nb-tick" role="status" aria-live="polite"><div id="nb-tickmsg"></div></div>
<button class="nb-latest" id="nb-latest" hidden>回到最新 ↓</button>
<div class="nb-pal" id="nb-pal" role="dialog" aria-modal="true" aria-label="调色板" hidden>
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
