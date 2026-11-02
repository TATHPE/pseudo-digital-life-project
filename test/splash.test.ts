/**
 * 完整档片头（2026-11-03）：**在 dsh-550c-boot 的 550C 骨架上改出来的**那一份。
 *
 * 用户的质问是「你为什么不能在别人的基础上对应着改」。所以这份测试盯的不是"像不像"，
 * 而是三件必须成立的事：
 *   ① 数据是真的（`window.JJ_BOOT` 注入，拿不到的显示 —，绝不编）
 *   ② 语言是我们的（没有残留的琥珀/红，也没有无人机/基站术语）
 *   ③ 接上了（面板里 full 档真的是 iframe 加载 /splash，播完/跳过会自己撤掉）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSplash } from "../src/web/splash.ts";
import { PAGE } from "../src/web/page.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const tpl = readFileSync(join(process.cwd(), "src/web/splash.body.html"), "utf8");

test("数据注入：只放有值的字段，拿不到的不写（宁可显示 —，也不显示 undefined）", () => {
  const html = renderSplash({ schema: "11", memories: 158, tools: 27 } as never);
  const m = html.match(/window\.JJ_BOOT=(\{.*?\});<\/script>/);
  assert.ok(m, "要注入 JJ_BOOT");
  const data = JSON.parse(m![1]!);
  assert.equal(data.schema, "11");
  assert.equal(data.memories, 158);
  assert.equal("docs" in data, false, "没传的字段不该出现");
  assert.equal("model" in data, false);
});

test("注入要转义 <：字符串里出现 </script> 会把整页截断", () => {
  const html = renderSplash({ degraded: "</script><b>x" } as never);
  const injected = html.slice(html.indexOf("window.JJ_BOOT="), html.indexOf(";</script>", html.indexOf("window.JJ_BOOT=")));
  assert.ok(!injected.includes("</script"), "注入块里不许有裸的 </script>");
  assert.ok(injected.includes("u003c"), "< 要转成 \\u003c");
});

test("数据层是动态生成的：静态 HTML 里不许写死读数", () => {
  // 原来的静态遥测整块被换成空容器，读数由 __jjTele() 从 JJ_BOOT 生成
  assert.ok(tpl.includes('<div class="w-body" id="teleBody"></div>'), "遥测容器要是空的");
  assert.ok(tpl.includes("function __jjTele()"), "要有生成函数");
  assert.ok(tpl.includes("B.memories") && tpl.includes("B.tools"), "读数取自注入的数据");
  // 原来的假读数不许回来
  for (const fake of ["n78 / n79", "0x5A3F", "PCI 207", "4172"]) {
    assert.ok(!tpl.includes(fake), "不许残留原版的假读数：" + fake);
  }
});

test("只剩黑白：琥珀与红一个都不许留（青色仍只给她回话的气泡）", () => {
  for (const bad of ["#e8a020", "#ffc043", "#e05030", "#ff7050", "#d8c090"]) {
    assert.ok(!tpl.toLowerCase().includes(bad), "不该再有暖色：" + bad);
  }
  assert.ok(tpl.includes("#e9f0f2") || tpl.includes("--amber:#e9f0f2"), "主色是我们的白");
});

test("语言是我们的：无人机/基站那套术语清掉了，工具数换成真实的", () => {
  // 结构可以留（那正是"炫"的来源），但名词得是我们的话
  assert.ok(tpl.includes("PSEUDO DIGITAL LIFE PROJECT"), "顶栏是项目名");
  assert.ok(tpl.includes("NODE_COUNT = (window.JJ_BOOT && window.JJ_BOOT.tools)"), "节点数 = 工具数");
  assert.ok(tpl.includes("TELEMETRY / 本机"), "遥测栏是我们的说法");
  for (const w of ["MOTORS WILL BE DISARMED", "UAV", "BS-07", "无人机", "基站", "DISARM", "550C"]) {
    assert.ok(!tpl.includes(w), "军事/无人机语境清干净了：" + w);
  }
});

test("接上了：full 档是 iframe 加载 /splash，播完/跳过会撤掉", () => {
  // iframe 是在 server 渲染 <!--BOOT--> 时插的（page.ts 只留占位）
  const server = readFileSync(join(process.cwd(), "src/web/server.ts"), "utf8");
  assert.ok(PAGE.includes("<!--BOOT-->"), "页面留占位");
  assert.ok(server.includes("src=\"/splash\""), "面板要知道去加载哪");
  assert.ok(server.includes("jjboot-done"), "页内桥要通知父页面");
  assert.ok(tpl.includes("jjboot-done"), "片头那份自己也要发这条消息");
  assert.ok(tpl.includes("Escape"), "要能跳过");
});

test("字标不是画出来的字形：原版那三个 path（就是「550C」）必须彻底消失", () => {
  // 这一条是被用户"启动动画里还有 550C"逼出来的：
  // 它的字标是 SVG path 画的字形，grep 字符串永远搜不到 —— 只有看画面才发现。
  assert.ok(!tpl.includes('viewBox="0 0 800 230"'), "原版字标 SVG 要整段删掉");
  for (const id of ["five1", "five2", "red0", 'id="cee"']) {
    assert.ok(!tpl.includes(id), "字形分组不许残留：" + id);
  }
  assert.ok(tpl.includes('id="logo" class="jj-logo"'), "换成文本字标");
  for (const w of ["PSEUDO", "DIGITAL", "LIFE", "PROJECT"]) {
    assert.ok(tpl.includes('<span class="ln">' + w + "</span>"), "四个词都在：" + w);
  }
  // 一行横排（用户 2026-11-03：「开头文字为什么不横向显示在一条线上」）
  assert.ok(tpl.includes("flex-direction:row") && tpl.includes("white-space:nowrap"), "必须是一行横排，不换行");
  assert.ok(tpl.includes("width:92vw") && tpl.includes("max-width:1320px"), "按容器收宽度，保证一行放得下");
  assert.ok(tpl.includes("clip-path 1.2s"), "整行从左扫出");
  // 节律保留：250ms 起；总长仍按 4 段算（与原版一致）
  assert.ok(tpl.includes("logo.classList.add('on')"), "整行扫出");
  assert.ok(tpl.includes("250 + lines.length * 300"), "节拍与原版一致");
  assert.ok(tpl.includes("setTimeout(() => bootText.classList.add('show'), 2400)"), "小字仍在 2.4s");
});
