import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, esc } from "../src/md.ts";

test("转义：HTML 不会被当成标签", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});
test("代码块优先于行内规则（不解析块内 **）", () => {
  const html = renderMarkdown("```ts\nconst a = **b**;\n```");
  assert.match(html, /<pre class="code" data-lang="ts">/);
  assert.ok(!html.includes("<b>b</b>"));
});
test("标题 / 列表 / 行内代码 / 粗体", () => {
  const html = renderMarkdown("# 标题\n\n- 一\n- 二\n\n这是 `code` 和 **粗**。");
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<ul>\s*<li>一<\/li>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<b>粗<\/b>/);
});
test("链接只允许 http(s)", () => {
  assert.ok(!renderMarkdown("[x](javascript:alert(1))").includes("href"));
  assert.match(renderMarkdown("[a](https://a.b)"), /href="https:\/\/a\.b"/);
});
test("未闭合代码块也能渲染（模型常截断）", () => {
  const html = renderMarkdown("```py\nprint(1)");
  assert.match(html, /<pre/);
  assert.ok(html.includes("print(1)"));
});
test("esc 处理四个符号", () => {
  assert.equal(esc('&<>"'), "&amp;&lt;&gt;&quot;");
});

test("表格：她写的榜单要变成 <table>，不是一排竖线（2026-11-05）", async () => {
  const { renderMarkdown } = await import("../src/md.ts");
  const md = ["| 仓库 | star | 它是什么 |", "|---|---|---|", "| a/b | 30.5k | 记忆中枢 |", "| c/d | 4.1k | RAG |"].join(String.fromCharCode(10));
  const html = renderMarkdown(md);
  assert.ok(html.includes("<table class=\"md-table\">"), "要出表格");
  assert.ok(html.includes("<th>仓库</th>"), "表头要转");
  assert.ok(html.includes("<td>a/b</td>"), "单元格要转");
  assert.ok(!html.includes("|---|"), "分隔行不能漏出来");
});

test("表格外的东西不受影响", async () => {
  const { renderMarkdown } = await import("../src/md.ts");
  const html = renderMarkdown(["前言", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "后记"].join(String.fromCharCode(10)));
  assert.ok(html.includes("<p>前言</p>"), "前面的段落还在");
  assert.ok(html.includes("<p>后记</p>"), "后面的段落还在");
});
