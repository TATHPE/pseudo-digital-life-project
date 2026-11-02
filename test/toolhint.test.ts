/**
 * 工具调用 → 人话（2026-11-03，学自 Coopanion 的 pet-status）
 *
 * 之前右栏和历史里是参数原文：`{"q":"记忆","k":3}`、`{"argv":["node","-e","..."]}`。
 * 既难读，又可能把路径、正文、密钥带上屏。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolHuman, toolResultHuman, shorten } from "../src/toolhint.ts";

test("说人话：读文件 / 搜记忆 / 跑命令，只报文件名与程序名", () => {
  assert.equal(toolHuman("fs.read", { path: "D:/LLM/jingjing/data/persona/core.md" }), "读 core.md");
  assert.match(toolHuman("memory.search", { q: "我能读多少记忆", k: 3 }), /在记忆里搜/);
  // argv 只报第一个词：后面可能带路径/正文
  assert.equal(toolHuman("shell.exec", { argv: ["node", "-e", "console.log(1)"] }), "跑命令 node");
  assert.equal(toolHuman("git.status", {}), "看 git 状态");
});

test("敏感参数一个字都不上屏：正文 / 笔记 / 密钥", () => {
  const cases: Array<[string, unknown]> = [
    ["fs.write", { path: "workspace/x.txt", text: "我的银行卡密码是 123456" }],
    ["memory.remember", { text: "用户说了私密的事", kind: "episode" }],
    ["unknown.tool", { apiKey: "sk-abcdef123456", token: "abc", password: "p@ss" }],
  ];
  for (const [name, args] of cases) {
    const s = toolHuman(name, args);
    for (const secret of ["123456", "私密", "sk-abcdef", "p@ss"]) {
      assert.ok(!s.includes(secret), name + " 的结果泄露了：" + s);
    }
  }
});

test("细节截断：CJK 20 字，其他 40 字（与参照物同一口径）", () => {
  assert.equal([...shorten("一二三四五六七八九十一二三四五六七八九十多出来")].length, 21, "20 字 + 省略号");
  const long = "a".repeat(100);
  assert.equal(shorten(long).length, 41, "40 字 + 省略号");
});

test("结果摘要只留第一行、去掉控制字符", () => {
  assert.equal(toolResultHuman("exit=0 328ms\n第二行不该出现"), "exit=0 328ms");
  assert.equal(toolResultHuman("a\u0000b"), "a b");
});
