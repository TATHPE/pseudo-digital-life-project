import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { GAPS, openGaps, answered, answerGap, gapSourceRef } from "../src/profile.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-profile-"));

test("一开始有缺口，只暴露 3 条（问多了像表单）", () => {
  const d = openDb(join(H(), "m.db"));
  const g = openGaps(d.db, 3);
  assert.equal(g.length, 3);
  assert.equal(g[0]!.key, GAPS[0]!.key);
});

test("答一句就落一条 contract；同一题不再问，也不许覆盖", () => {
  const d = openDb(join(H(), "m.db"));
  const r = answerGap(d.db, "忌口", "我对花生过敏", new Date("2026-11-04T10:00:00Z"));
  assert.equal(r.ok, true);
  assert.equal(answered(d.db, "忌口"), true);
  assert.ok(!openGaps(d.db, 99).some((g) => g.key === "忌口"), "答过的题不该再出现");

  const row = d.db.prepare("SELECT text,layer,kind,subject,source_ref,scored_by,sensitivity FROM memories").get() as any;
  assert.equal(row.text, "我对花生过敏");
  assert.equal(row.layer, "contract", "长期有效的事要进契约层（不衰减）");
  assert.equal(row.kind, "fact_hard");
  assert.equal(row.subject, "忌口");
  assert.equal(row.source_ref, gapSourceRef("忌口"));
  assert.equal(row.scored_by, "human:profile");
  assert.equal(row.sensitivity, "shareable");

  const again = answerGap(d.db, "忌口", "其实我不过敏了");
  assert.equal(again.ok, false);
  assert.equal((again as any).code, "E_ALREADY");
  assert.equal((d.db.prepare("SELECT count(*) c FROM memories").get() as any).c, 1, "不许悄悄覆盖");
});

test("空答案与不存在的题都拒绝", () => {
  const d = openDb(join(H(), "m.db"));
  assert.equal((answerGap(d.db, "称呼", "  ") as any).code, "E_EMPTY");
  assert.equal((answerGap(d.db, "血型", "O") as any).code, "E_UNKNOWN_GAP");
  assert.equal((d.db.prepare("SELECT count(*) c FROM memories").get() as any).c, 0);
});

test("夜里抽出来的（subject 对上）也算答过，别再问第二遍", () => {
  const d = openDb(join(H(), "m.db"));
  d.db.prepare(`INSERT INTO memories(layer,kind,text,text_bigram,subject,last_decay_at,created_at,updated_at)
    VALUES('contract','fact_hard','住在杭州','住 在','所在地','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`).run();
  assert.equal(answered(d.db, "所在地"), true);
  assert.ok(!openGaps(d.db, 99).some((g) => g.key === "所在地"));
});

test("什么时候问：一天最多一次（否则她会每轮查户口）", async () => {
  const { nextAsk, markAsked } = await import("../src/profile.ts");
  const d = openDb(join(H(), "m.db"));
  const t0 = new Date("2026-11-04T10:00:00Z");
  const first = nextAsk(d.db, t0);
  assert.ok(first, "有缺口、也没问过 → 该问");
  markAsked(d.db, t0);

  assert.equal(nextAsk(d.db, new Date("2026-11-04T23:00:00Z")), null, "13 小时后不该再问");
  const later = nextAsk(d.db, new Date("2026-11-05T11:00:00Z"));
  assert.equal(later?.key, first!.key, "过了 24 小时可以再问同一题");
});
