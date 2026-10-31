import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToolResult } from "../src/mcp.ts";

test("P-A 纯文本：原样返回，不加噪音", () => {
  assert.equal(renderToolResult({ content: [{ type: "text", text: "第一行" }, { type: "text", text: "第二行" }] }),
    "第一行" + String.fromCharCode(10) + "第二行");
  assert.equal(renderToolResult({ content: [] }), "");
});

test("P-A 只有图片：必须报 E_UNSUPPORTED_CONTENT，不能返回空串", () => {
  const out = renderToolResult({ content: [{ type: "image", mimeType: "image/png" }] });
  assert.match(out, /E_UNSUPPORTED_CONTENT/);
  assert.match(out, /image/);
  assert.notEqual(out, "", "空串会被模型当成本工具没东西可说 —— 这正是不许的");
});

test("P-A 混合内容：文本照给，但明说省略了几个什么部件", () => {
  const out = renderToolResult({ content: [
    { type: "text", text: "封面在这里" },
    { type: "image" }, { type: "image" },
  ] });
  assert.ok(out.startsWith("封面在这里"));
  assert.match(out, /2 个 image/);
});

test("P-A 错误响应：保留 E_TOOL 前缀，且带上缺内容的说明", () => {
  const onlyImg = renderToolResult({ content: [{ type: "image" }], isError: true });
  assert.match(onlyImg, /^E_TOOL: E_UNSUPPORTED_CONTENT/);
  const mixed = renderToolResult({ content: [{ type: "text", text: "失败了" }, { type: "image" }], isError: true });
  assert.match(mixed, /^E_TOOL: 失败了/);
});
