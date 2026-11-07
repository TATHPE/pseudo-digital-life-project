/**
 * 自我更新三件套（docs/runtime/18 §4.3）：草稿区 → 冒烟 → A/B 槽 → 失败回滚 + 冻结。
 *
 * 只做 ③ 技能：④ 核心代码永不自改（可复现性），② 参数已由 decayparams 的白名单管住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { scanSkills } from "../src/skills.ts";
import { proposeSkill, listDrafts, smokeDraft, promoteDraft, revertSkill, frozenUntil, recentVersions } from "../src/selfupdate.ts";

const SKILL = [
  "---",
  "name: weekly-recap",
  "description: 每周日把这一周的记忆收成三条",
  "---",
  "",
  "1. 调 memory.search 找这一周的线索",
  "2. 只留三件，按重要性排",
].join(String.fromCharCode(10));

test("草稿不等于生效：写进 _drafts，扫描器看不见它", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-su-"));
  try {
    const r = proposeSkill(home, { id: "weekly-recap", content: SKILL, because: "连续三周被问「上周做了什么」" });
    assert.equal(r.ok, true);

    assert.equal(listDrafts(home).length, 1, "草稿列表有它");
    assert.equal(scanSkills(home).some((s) => s.id === "weekly-recap"), false, "生效技能里没有它（草稿不算数）");
  } finally { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test("没有理由的技能不许存在（docs/runtime/18 §4.4）", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-su2-"));
  try {
    const r = proposeSkill(home, { id: "x", content: SKILL, because: "随便" });
    assert.equal(r.ok, false);
    assert.equal((r as { code?: string }).code, "E_NEED_WHY");
  } finally { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test("冒烟：缺 description / 带密钥 / 与已有技能重名，都要挡住", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-su3-"));
  try {
    proposeSkill(home, { id: "no-desc", content: "---" + String.fromCharCode(10) + "name: x" + String.fromCharCode(10) + "---" + String.fromCharCode(10) + "body", because: "试试缺描述的情况" });
    assert.equal(smokeDraft(home, "no-desc").ok, false, "缺 description 要挡");

    proposeSkill(home, { id: "leaky", content: SKILL.replace("只留三件", "key: sk-abcdefabcdefabcdef1234"), because: "试试带密钥的情况" });
    assert.equal(smokeDraft(home, "leaky").ok, false, "带密钥要挡");

    proposeSkill(home, { id: "good", content: SKILL, because: "正常的一份草稿" });
    assert.equal(smokeDraft(home, "good").ok, true);
  } finally { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test("A/B 槽：promote 让旧版本进 .prev，revert 能换回来，并且每次都留 versions 记录", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-su4-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    // 第一版
    proposeSkill(home, { id: "daily", content: SKILL.replace("每周日", "每天"), because: "第一版：每天都收一次" });
    assert.equal(promoteDraft(home, db, "daily").ok, true);
    assert.equal(scanSkills(home).filter((s) => s.id === "daily").length, 1, "生效了");
    assert.equal(existsSync(join(home, "skills", "daily.prev")), false, "第一版没有 .prev");

    // 第二版：旧版让位
    proposeSkill(home, { id: "daily", content: SKILL.replace("每周日", "每周一"), because: "第二版：改到周一" });
    const p2 = promoteDraft(home, db, "daily");
    assert.equal(p2.ok, true);
    assert.equal(existsSync(join(home, "skills", "daily.prev")), true, "旧版进了 .prev");
    assert.ok(readFileSync(join(home, "skills", "daily", "SKILL.md"), "utf8").includes("每周一"), "新版生效");

    // 回滚
    const rv = revertSkill(home, db, "daily", "新版冒烟没问题但观察不好");
    assert.equal(rv.ok, true);
    assert.ok(readFileSync(join(home, "skills", "daily", "SKILL.md"), "utf8").includes("每天"), "换回旧版");

    // versions：三次操作三条记录，且每条都有回滚方式
    const vs = recentVersions(home, 10);
    assert.equal(vs.length, 3, "promote ×2 + revert ×1");
    assert.ok(vs.every((v) => v.text.includes("回滚：")), "每条都写回滚方式");
    assert.ok(vs.some((v) => v.text.includes("每天")), "记录里有她当时的理由");
  } finally { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test("连续两次冒烟失败 → 冻结 24 小时（没有冻结就会每轮重试）", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-su5-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    proposeSkill(home, { id: "broken", content: "---" + String.fromCharCode(10) + "name: broken" + String.fromCharCode(10) + "---" + String.fromCharCode(10), because: "故意做个坏的（缺 description）" });

    const a = promoteDraft(home, db, "broken");
    assert.equal(a.ok, false);
    assert.equal(a.code, "E_SMOKE", "第一次只是冒烟失败");
    assert.equal(frozenUntil(db), null, "还没冻结");

    const b = promoteDraft(home, db, "broken");
    assert.equal(b.ok, false);
    assert.equal(b.code, "E_FROZEN", "第二次触发冻结");
    assert.ok(frozenUntil(db), "冻结生效");

    const c = promoteDraft(home, db, "broken");
    assert.equal(c.code, "E_FROZEN", "冻结期内一律拒绝");
  } finally { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
});
