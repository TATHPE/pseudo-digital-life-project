import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief } from "../src/brief.ts";

/**
 * L0（稳定前缀）必须**字节级不变**。
 *
 * 为什么要有这条：前缀缓存是按**字节**命中的。改一个标点、加一个空格，
 * 整段缓存就全掉 —— 钱和时间都在烧，而且没有任何症状。
 * 所以这里把一段固定的 persona 的 prefixHash **钉死**：
 * 谁改了 L0（core / boundaries / evidence / tools），这条测试就会红。
 *
 * 改 L0 是允许的（那是产品决策），但必须：
 *   ① 故意改这个常量，并在 commit message 里写"这次会让前缀缓存全掉"
 *   ② 不是顺手改的
 */
const PINNED_PREFIX_HASH = "fc9720b384d70e80";   // 由第一次跑测试时打印出来的真值填进来

const FIXED_PERSONA = {
  core: "我是鲸鲸。",
  boundaries: "不替你确认。",
  evidenceOrder: "原话优先。",
  toolSchemas: "fs.read",
  toolDirectory: "data/",
};

function briefOnce() {
  return buildBrief({
    persona: FIXED_PERSONA as never,
    contracts: [],
    recalled: [],
    now: new Date(Date.UTC(2026, 9, 31, 3, 0, 0)),
    state: { energy: 1, closeness: 0.5 },
    user: "在吗",
  });
}

test("L0 前缀：同样的输入 → 同样的 prefixHash（幂等）", () => {
  const a = briefOnce();
  const b = briefOnce();
  assert.equal(a.prefixHash, b.prefixHash, "同一份 persona 两次构造必须一致");
  assert.equal(a.text, b.text, "整段文本也要一致");
});

test("L0 前缀：字节级不变（改了 L0 这条就红）", () => {
  const a = briefOnce();
  // 首次运行会打印真值；把下面的常量改成"故意的"那一次才允许变
  assert.equal(
    a.prefixHash,
    PINNED_PREFIX_HASH,
    "L0 变了 —— 如果是有意的，请更新 PINNED_PREFIX_HASH 并在 commit 里写清「前缀缓存会全掉」；实测 hash=" + a.prefixHash,
  );
});

test("L0 前缀：动一个标点就换 hash（证明这条断言真的敏感）", () => {
  const base = briefOnce();
  const tweaked = buildBrief({
    persona: { ...FIXED_PERSONA, core: "我是鲸鲸。" + " " } as never,
    contracts: [], recalled: [], now: new Date(Date.UTC(2026, 9, 31, 3, 0, 0)),
    state: { energy: 1, closeness: 0.5 }, user: "在吗",
  });
  assert.notEqual(tweaked.prefixHash, base.prefixHash, "多一个空格就该换 hash —— 缓存是按字节命中的");
});

test("L0 前缀：易变内容（时间/召回/用户输入）不进 L0 的 hash", () => {
  const a = briefOnce();
  const b = buildBrief({
    persona: FIXED_PERSONA as never,
    contracts: ["别叫我助手"], recalled: [], now: new Date(Date.UTC(2026, 9, 31, 9, 30, 0)),
    state: { energy: 0.4, closeness: 0.9 }, user: "今天好累",
  });
  assert.equal(b.prefixHash, a.prefixHash, "L0 必须是「与此刻无关」的那一段");
});
