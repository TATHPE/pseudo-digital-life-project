/**
 * 她对你的理解（2026-11-03）。
 *
 * 补的是一个空层：interpret.ts 的 writeInterpretation 机制完整，
 * 但全仓**没有调用方** → 简报 P13 永远是空的。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { listInterpretations } from "../src/interpret.ts";
import { parseInterpretations, refineInterpretations, interpretationPrompt, plausible } from "../src/interpretnight.ts";

const NL = String.fromCharCode(10);

test("解析：只收「一句话 || 依据 id」的行，别的废话一律不要", () => {
  const raw = [
    "好的，我读出来了：",
    "- 她对加班既需要又抗拒 || 12,34",
    "* 她其实很在意被记住 || 34",
    "这句没有依据",
    "太短 || 12",
    "重复的那条 || 34",
  ].join(NL);
  const got = parseInterpretations(raw, 3);
  assert.equal(got.length, 2, "两条有依据的");
  assert.deepEqual(got[0]!.basis, [12, 34]);
  assert.ok(got.every((g) => g.text.length >= 6));
});

test("接上了：模型说什么就落什么，但必须挂在真实记忆上", async () => {
  const home = mkdtempSync(join(tmpdir(), "jj-in-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    const a = remember(db, { text: "她今天加班到十一点", kind: "episode", layer: "narrative", importance: 4 });
    const b = remember(db, { text: "她说老板总在周五改需求", kind: "episode", layer: "narrative", importance: 4 });

    // 假模型：一条挂了真 id，一条挂了不存在的 id
    const extract = async () => [
      "她对加班既依赖又抗拒 || " + a + "," + b,
      "这话没有依据 || 99999",
    ].join(NL);

    const r = await refineInterpretations(db, { complete: extract });
    assert.equal(r.written, 1, "只有挂真 id 的那条能进");
    assert.equal(r.skipped.length, 1, "挂假 id 的被拒（不是静默丢弃）");
    // 挂假 id 的那条被拒（可能先被可解释性检查挡，也可能被 basis 检查挡 —— 都不许静默丢）
    assert.ok(/E_INTERP_BAD_BASIS|E_INTERP_UNGROUNDED/.test(r.skipped.join(' ')), r.skipped.join(' | '));

    const list = listInterpretations(db, 5);
    assert.equal(list.length, 1);
    assert.ok(list[0]!.text.includes("加班"));
  } finally { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test("提示词要把真实 id 摆出来，并要求「读不出来就一条也别写」", () => {
  const p = interpretationPrompt(
    [{ id: 7, text: "她今天加班到十一点" }, { id: 9, text: "她说老板爱改需求" }],
    ["她对工作很上心"],
  );
  assert.ok(p.includes("[7]") && p.includes("[9]"), "编号要给它");
  assert.ok(p.includes("一条也别写"), "宁缺勿滥要写清");
  assert.ok(p.includes("不是复述"), "不许抄原文");
  assert.ok(p.includes("她对工作很上心"), "已有理解要带上，避免重复");
});

test("可解释性：理解里必须有一个实词出现在依据里，否则就是凭空造话题", () => {
  // 实测事故：喂两条技术记忆（posture.ts 的功能 / 探针记忆），
  // 小模型也能推出「她对加班既需要又抗拒」—— basis 只验证 id 存在，管不了这个。
  assert.equal(plausible("她对加班既需要又抗拒", ["详细描述了文件的功能和作用", "探针记忆"]), false, "加班 不在依据里 → 拒");
  assert.equal(plausible("她很在意文件结构", ["详细描述了文件的功能和作用"]), true, "文件/功能 对得上 → 放");
  assert.equal(plausible("她其实很孤独", ["今天加班到十一点"]), false, "只有虚词撑着不算");
});
