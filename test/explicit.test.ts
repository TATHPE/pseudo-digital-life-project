import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { captureExplicit, writeExplicit } from "../src/explicit.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-explicit-"));

test("记住：明确说「记住 X」就当场记，前缀剥掉、内容留原话", () => {
  const [e] = captureExplicit("记住：我对花生过敏");
  assert.ok(e, "该认出来");
  assert.equal(e!.text, "我对花生过敏");
  assert.equal(e!.kind, "fact_hard");
  assert.equal(e!.layer, "contract");
});

test("边界：以后别 / 今后不要 —— 不用「记住」两个字也算请求", () => {
  const [e] = captureExplicit("以后别在早上给我发消息");
  assert.ok(e);
  assert.equal(e!.kind, "boundary");
  assert.equal(e!.layer, "contract");
  assert.match(e!.text, /以后别在早上给我发消息/);
});

test("偏好与日期", () => {
  const like = captureExplicit("我很喜欢吃辣的")[0];
  assert.equal(like?.kind, "preference_hard");
  assert.equal(like?.layer, "narrative");
  const bday = captureExplicit("我的生日是三月十二号")[0];
  assert.equal(bday?.kind, "fact_hard");
});

test("不该误记：普通陈述、问句、系统操作都不算", () => {
  for (const s of [
    "在吗",
    "跑一下 npm test",
    "今天天气不错",
    "你记得我上次说的那个吗",
    "把 page.ts 里的按钮删掉",
    "以后别用这个 API",        // 说的是代码，不是她的人
    "以后别把端口写死",
    "1",
  ]) {
    assert.deepEqual(captureExplicit(s), [], "不该记：" + s);
  }
});

test("落库：同样的话说两遍只留一条；quote 留原话", () => {
  const d = openDb(join(H(), "m.db"));
  const [e] = captureExplicit("记住：我对花生过敏");
  const a = writeExplicit(d.db, e!, "记住：我对花生过敏", new Date("2026-11-04T10:00:00Z"));
  const b = writeExplicit(d.db, e!, "记住：我对花生过敏", new Date("2026-11-04T10:01:00Z"));
  assert.ok(a && a > 0, "第一次要写进去");
  assert.equal(b, null, "第二次同样的话不该再写一条");
  const row = d.db.prepare("SELECT text,quote,layer,kind,scored_by,source_kind FROM memories WHERE id=?").get(a!) as any;
  assert.equal(row.text, "我对花生过敏");
  assert.equal(row.quote, "记住：我对花生过敏", "原话要留下");
  assert.equal(row.scored_by, "rule:explicit");
  assert.equal(row.source_kind, "user");
  assert.equal((d.db.prepare("SELECT count(*) c FROM memories").get() as any).c, 1);
});
