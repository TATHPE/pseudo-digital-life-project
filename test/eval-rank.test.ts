import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NL = String.fromCharCode(10);
const dir = join(process.cwd(), "tools", "fixtures", "hard");
const load = (f: string) => readFileSync(join(dir, f), "utf8").split(NL).filter((l) => l.trim()).map((l) => JSON.parse(l));

test("排序基准自带记忆与用例（tmp/ 会被清，基准不能跟着丢）", () => {
  const mems = load("memories.jsonl");
  const cases = load("cases.jsonl");
  assert.equal(mems.length, 16, "16 条记忆：4 组干扰 + 若干对照");
  assert.equal(cases.length, 12, "10 条该命中 + 2 条该拒答");
  assert.equal(cases.filter((c: any) => c.expectEmpty).length, 2, "拒答 2 条");
  assert.equal(new Set(cases.map((c: any) => c.id)).size, 12, "id 不许重复");

  // 干扰组必须真的在库里（否则这套基准测不到排序）
  const text = mems.map((m: any) => m.text).join("|");
  for (const k of ["栗子味", "巧克力", "深蓝色", "米白色", "季度报告", "花生", "香菜"]) {
    assert.ok(text.includes(k), "干扰项缺了：" + k);
  }
  // 每条用例的关键词必须能在库里找到 —— 否则它永远不可能排对
  for (const c of cases as any[]) {
    for (const e of c.anyOf ?? []) {
      assert.ok(text.includes(e) || text.includes(e.slice(0, 2)), "用例关键词在库里不存在：" + c.id + " → " + e);
    }
  }
});
