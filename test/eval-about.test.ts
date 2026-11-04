import { test } from "node:test";
import assert from "node:assert/strict";
import { ABOUT_CASES } from "../tools/eval-about.ts";

test("关于你：用例集本身的形状（一个能悄悄改的基准就不是基准）", () => {
  const ids = ABOUT_CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "id 不许重复");

  const recall = ABOUT_CASES.filter((c) => c.expect.length > 0);
  const abstain = ABOUT_CASES.filter((c) => c.expect.length === 0);
  assert.equal(recall.length, 12, "该命中的 12 条");
  assert.equal(abstain.length, 6, "该拒答的 6 条");

  for (const c of ABOUT_CASES) {
    assert.ok(c.q.trim().length >= 3, "问题不能是空的：" + c.id);
    if (c.expect.length) assert.ok(c.expect.every((e) => e.trim().length >= 1), "关键词不能空：" + c.id);
  }

  // 该拒答的那几题，必须是库里**真的没有**的维度（忌口/过敏/作息/所在地/工作/宠物）
  const keys = abstain.map((c) => c.id).join(",");
  for (const k of ["none-1", "none-2", "none-3", "none-4", "none-5", "none-6"]) {
    assert.ok(keys.includes(k), "缺了拒答用例：" + k);
  }
});
