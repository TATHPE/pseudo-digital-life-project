import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { bumpGenerationIfChanged, currentGeneration, generationLog, migrateToCurrentGen, personaFingerprint, generationOf } from "../src/generation.ts";
import { PERSONA_FILES } from "../src/persona.ts";

const H = () => {
  const h = mkdtempSync(join(tmpdir(), "jj-gen-"));
  mkdirSync(join(h, "persona"), { recursive: true });
  for (const f of PERSONA_FILES) writeFileSync(join(h, "persona", f + ".md"), `${f} v1`, "utf8");
  return h;
};

test("H-5 分代：人格没变不换代，变了才换代（重复保存不产生新代）", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const a = bumpGenerationIfChanged(d.db, home, "初始人格");
  assert.equal(a.bumped, true);
  assert.equal(a.generation.gen, 1);

  const b = bumpGenerationIfChanged(d.db, home, "重复保存");
  assert.equal(b.bumped, false, "指纹相同 → 不换代");
  assert.equal(b.generation.gen, 1);

  writeFileSync(join(home, "persona", "core.md"), "core v2", "utf8");
  const c = bumpGenerationIfChanged(d.db, home, "把语气收一点");
  assert.equal(c.bumped, true);
  assert.equal(c.generation.gen, 2);
  assert.equal(generationLog(d.db).length, 2);
});

test("H-5 记忆带着出生代：换人格不动旧记忆", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  bumpGenerationIfChanged(d.db, home, "初始人格");
  const oldId = remember(d.db, { layer: "narrative", kind: "episode", text: "第一代时她说了这句话" });

  writeFileSync(join(home, "persona", "core.md"), "core v2", "utf8");
  bumpGenerationIfChanged(d.db, home, "改成第二代");
  const newId = remember(d.db, { layer: "narrative", kind: "episode", text: "第二代时她说的话" });

  const g = (id: number) => Number((d.db.prepare("SELECT created_under_gen AS g FROM memories WHERE id=?").get(id) as { g: number }).g);
  assert.equal(g(oldId), 1, "旧记忆仍属于第 1 代");
  assert.equal(g(newId), 2, "新记忆属于第 2 代");
  // 旧记忆的解释没有被改写：它出生时的那个人格指纹还在日志里
  const gen1 = generationOf(d.db, 1)!;
  assert.equal(gen1.gen, 1);
  assert.ok(gen1.because.includes("初始"),
    "「她当时为什么那样想」必须还能答出来（旧代的理由还在）");
});

test("H-5 追溯是例外：没理由不许迁，带理由才迁且留事件", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  bumpGenerationIfChanged(d.db, home, "初始人格");
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "老记忆一" });
  writeFileSync(join(home, "persona", "core.md"), "core v2", "utf8");
  bumpGenerationIfChanged(d.db, home, "第二代");

  assert.throws(() => migrateToCurrentGen(d.db, home, { reason: "短" }), /E_GEN_REASON/);
  const r = migrateToCurrentGen(d.db, home, { reason: "旧记忆里的语气设定要按新人格重新解释" });
  assert.equal(r.moved, 1);
  assert.equal(r.gen, 2);
  const row = d.db.prepare("SELECT created_under_gen AS g FROM memories WHERE id=?").get(a) as { g: number };
  assert.equal(row.g, 2);
  const ev = d.db.prepare("SELECT count(*) c FROM events WHERE kind='persona_gen_migrate'").get() as { c: number };
  assert.equal(ev.c, 1, "追溯要在事件里署名");
});

test("H-5 指纹：动一个人格文件就换指纹；没封存过时 currentGeneration 是第 0 代", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const fp1 = personaFingerprint(home);
  assert.equal(currentGeneration(d.db, home).gen, 0, "没封存过就是第 0 代");
  writeFileSync(join(home, "persona", "voice.md"), "voice v2", "utf8");
  assert.notEqual(personaFingerprint(home), fp1);
});
