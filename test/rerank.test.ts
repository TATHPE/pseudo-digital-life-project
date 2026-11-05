import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePick, shouldRerank } from "../src/rerank.ts";

test("重排：模型输出怎么抠编号（抠不出就退回基线）", () => {
  assert.equal(parsePick("2", 5), 1, "1-based → 0-based");
  assert.equal(parsePick(" 3。", 5), 2);
  assert.equal(parsePick("NONE", 5), "NONE");
  assert.equal(parsePick("none", 5), "NONE", "大小写都要认");
  assert.equal(parsePick("编号是 4", 5), 3);
  assert.equal(parsePick("9", 3), null, "超出候选数算看不懂");
  assert.equal(parsePick("我不知道", 5), null, "没有数字 = 看不懂");
});

test("重排：只在模糊或全空时跑（auto）", () => {
  const hit = (i: number, s: number) => ({ id: i, text: "x" + i, score: s });
  assert.equal(shouldRerank("off", [hit(1, 0.9), hit(2, 0.8)]), false, "off 一律不跑");
  assert.equal(shouldRerank("auto", []), true, "全空要问一句「真的没有吗」");
  assert.equal(shouldRerank("auto", [hit(1, 0.9)]), false, "只有一条没什么可排");
  assert.equal(shouldRerank("auto", [hit(1, 0.90), hit(2, 0.89)]), true, "贴得近 = 模糊");
  assert.equal(shouldRerank("auto", [hit(1, 0.90), hit(2, 0.50)]), false, "差得远就别花钱");
  assert.equal(shouldRerank("always", [hit(1, 0.99), hit(2, 0.1)]), true, "always 不看差距");
});
