import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { loadPolicy } from "../src/policy.ts";
import { execute } from "../src/execute.ts";
import {
  scanSkills, readSkill, splitFrontmatter, guessDescription, skillsIndexText, indexableSkills,
  MAX_DESC_CHARS, MAX_READ_CHARS,
} from "../src/skills.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-skill-"));
// 指到一个不存在的目录：把真实的 ~/.agents/skills 挡在外面（否则本机 68 个开发技能会混进来）
const NO_AGENTS = { AGENTS_HOME: join(tmpdir(), "jj-no-agents-here") };

function putSkill(home: string, id: string, body: string): string {
  const dir = join(home, "skills", id);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "SKILL.md");
  writeFileSync(f, body, "utf8");
  return f;
}

test("技能：扫目录、读 frontmatter（含 > 块标量）", () => {
  const home = H();
  putSkill(home, "deploy", [
    "---",
    "name: 上线跑一遍",
    "description: >",
    "  把改动跑一次测试再重启。",
    "  出问题先回滚。",
    "---",
    "",
    "# 步骤",
    "",
    "1. npm test",
  ].join(String.fromCharCode(10)));
  const all = scanSkills(home, { env: NO_AGENTS });
  assert.equal(all.length, 1);
  assert.equal(all[0]!.id, "deploy");
  assert.equal(all[0]!.name, "上线跑一遍");
  assert.match(all[0]!.description, /把改动跑一次测试再重启。 出问题先回滚。/, "块标量要拼成一句，而不是一个 >");
  assert.equal(all[0]!.source, "home");
  assert.equal(all[0]!.parsed, true);
});

test("技能：没写 frontmatter 也能用，描述是猜的", () => {
  const home = H();
  putSkill(home, "note", ["# 写周报", "", "先列数字，再讲一句原因。"].join(String.fromCharCode(10)));
  const all = scanSkills(home, { env: NO_AGENTS });
  assert.equal(all[0]!.description, "先列数字，再讲一句原因。");
  assert.equal(all[0]!.parsed, false);
  assert.equal(guessDescription(""), "");
  assert.ok(guessDescription("x".repeat(400)).length <= MAX_DESC_CHARS);
});

test("技能：同名只取第一个（home 优先于 agents）", () => {
  const home = H();
  const agents = H();
  putSkill(home, "x", "# 我的版本");
  mkdirSync(join(agents, "skills", "x"), { recursive: true });
  writeFileSync(join(agents, "skills", "x", "SKILL.md"), "# 全局版本", "utf8");
  const all = scanSkills(home, { env: { AGENTS_HOME: agents } });
  assert.equal(all.length, 1);
  assert.equal(all[0]!.source, "home");
});

test("技能：readSkill 不拼路径，越界名字直接拒", () => {
  const home = H();
  putSkill(home, "deploy", "# 步骤" + String.fromCharCode(10) + "先跑测试");
  const ok = readSkill(home, "deploy", { env: NO_AGENTS });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.match(ok.text, /先跑测试/);
  for (const bad of ["", "../etc/passwd", "..\\windows\\system32", "nope"]) {
    const r = readSkill(home, bad, { env: NO_AGENTS });
    assert.equal(r.ok, false, bad + " 该被拒");
    if (!r.ok) assert.match(r.code, /E_SKILL_NAME|E_NO_SKILL/);
  }
});

test("技能：正文超长会截断，并说明截断了", () => {
  const home = H();
  putSkill(home, "big", "# 大文件" + String.fromCharCode(10) + "y".repeat(MAX_READ_CHARS + 500));
  const r = readSkill(home, "big", { env: NO_AGENTS });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.truncated, true);
    assert.equal(r.text.length, MAX_READ_CHARS);
  }
});

test("技能索引：只放她自己的；~/.agents 里的开发技能默认不进简报", () => {
  const home = H();
  putSkill(home, "mine", "# 我自己的");
  const agents = H();
  mkdirSync(join(agents, "skills", "code-review"), { recursive: true });
  writeFileSync(join(agents, "skills", "code-review", "SKILL.md"), "# 代码审查", "utf8");
  const all = scanSkills(home, { env: { AGENTS_HOME: agents } });
  assert.equal(all.length, 2);
  const idx = indexableSkills(all, {});
  assert.deepEqual(idx.map((s) => s.id), ["mine"]);
  assert.deepEqual(indexableSkills(all, { JJ_SKILLS_INDEX_AGENTS: "1" }).length, 2);
  const text = skillsIndexText(idx);
  assert.match(text, /mine/);
  assert.match(text, /skill_read/, "要告诉模型正文怎么取");
  assert.equal(skillsIndexText([]), "", "没有技能就不占位");
});

test("技能：走同一条闸门（skill.list / skill.read 进审计）", async () => {
  const home = H();
  putSkill(home, "deploy", "# 步骤" + String.fromCharCode(10) + "先跑测试");
  const d = openDb(join(home, "m.db"));
  const policy = await loadPolicy(home);
  const ctx = { home, now: () => new Date("2026-11-01T00:00:00Z"), env: NO_AGENTS };

  const list = await execute({ db: d.db, policy, ctx }, "skill.list", {});
  assert.equal(list.ok, true, list.output);
  assert.match(list.output, /deploy/);

  const read = await execute({ db: d.db, policy, ctx }, "skill.read", { name: "deploy" });
  assert.equal(read.ok, true, read.output);
  assert.match(read.output, /先跑测试/);

  const miss = await execute({ db: d.db, policy, ctx }, "skill.read", { name: "../../secret" });
  assert.equal(miss.ok, false);
  assert.match(miss.output, /E_NO_SKILL|E_SKILL_NAME/);

  const audited = d.db.prepare("SELECT count(*) c FROM exec_audit WHERE verb LIKE 'skill.%'").get() as { c: number };
  assert.ok(audited.c >= 3, "两次成功 + 一次被拒，都要留痕（实际 " + audited.c + "）");
});

test("技能：frontmatter 解析的边角（引号 / 缺结束符）", () => {
  const a = splitFrontmatter(["---", 'name: "带引号"', "---", "正文"].join(String.fromCharCode(10)));
  assert.equal(a.meta.name, "带引号");
  const b = splitFrontmatter(["---", "name: x"].join(String.fromCharCode(10)));
  assert.equal(b.meta.name, undefined, "没有结束符就当没有 frontmatter");
});
