import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { addItem, openItems, closeItem, refreshFromFacts, agendaForBrief, AGENDA_CAP } from "../src/agenda.ts";
import { writeInterpretation, listInterpretations, interpretationsForBrief } from "../src/interpret.ts";
import { buildBrief } from "../src/brief.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-agenda-"));

// ── H-a 她自己的惦记 ────────────────────────────────
test("H-a 惦记：没有出处的「惦记」一律拒（不许编）", () => {
  const home = H();
  const r = addItem(home, { text: "总觉得还有件事没做", why: "直觉", from: "" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "E_AGENDA_NO_SOURCE");
});

test("H-a 惦记：同一出处不重复、有上限、能了结", () => {
  const home = H();
  assert.equal(addItem(home, { text: "提醒买蛋糕", why: "答应了", from: "mem:1" }).ok, true);
  const dup = addItem(home, { text: "提醒买蛋糕", why: "答应了", from: "mem:1" });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.code, "E_AGENDA_DUP");

  for (let i = 2; i <= AGENDA_CAP; i++) addItem(home, { text: `第 ${i} 件`, why: "攒满", from: `mem:${i}` });
  const full = addItem(home, { text: "再惦记一件", why: "超了", from: "mem:99" });
  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.code, "E_AGENDA_FULL");

  const open = openItems(home);
  assert.equal(open.length, AGENDA_CAP);
  const closed = closeItem(home, open[0]!.id, "办完了");
  assert.ok(closed?.closedAt);
  assert.equal(openItems(home).length, AGENDA_CAP - 1, "了结后不再占位");
  assert.equal(addItem(home, { text: "新的一件", why: "空了", from: "mem:100" }).ok, true);
});

test("H-a 惦记：从事实里刷新（未闭合承诺 / 拖 7 天 / 待人判的矛盾），且带来源", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const now = new Date(Date.UTC(2026, 9, 31, 12));
  const old = new Date(Date.UTC(2026, 9, 20, 12));   // 11 天前
  remember(d.db, { layer: "contract", kind: "promise", text: "下周三提醒买蛋糕", now: old });
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "她说喜欢下雨", now });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "今天下了很大的雨", now });
  d.db.prepare("INSERT INTO memory_links(src_id,dst_id,rel,weight,why,created_at) VALUES(?,?,?,?,?,?)")
    .run(a, b, "contradicts", 0.6, "极性相反", now.toISOString());

  const r = refreshFromFacts(d.db, home, now);
  assert.ok(r.added >= 2, "至少：承诺 + 矛盾：" + JSON.stringify(r));
  const items = openItems(home);
  assert.ok(items.every((x) => x.from.startsWith("mem:") || x.from.startsWith("link:")), "每条都要有出处");
  assert.ok(items.some((x) => x.why.includes("答应过")));
  assert.ok(items.some((x) => x.from.startsWith("link:")), "矛盾要进惦记（等人判）");
});

test("H-a 惦记：进简报（最多 2 条，带原因），空的时候不占位", () => {
  const home = H();
  addItem(home, { text: "提醒买蛋糕", why: "答应了", from: "mem:1" });
  addItem(home, { text: "问她周报交了没", why: "每周三", from: "mem:2" });
  addItem(home, { text: "第三件", why: "超两条", from: "mem:3" });
  const lines = agendaForBrief(home, 2);
  assert.equal(lines.length, 2, "简报里最多 2 条，别把上下文撑爆");
  assert.match(lines[0]!, /提醒买蛋糕/);
  assert.match(lines[0]!, /我惦记着/);

  const brief = buildBrief({
    persona: { core: "x", boundaries: "y", evidenceOrder: "z", toolSchemas: "", toolDirectory: "" } as never,
    contracts: [], recalled: [], now: new Date(), user: "在吗",
    agenda: lines, interpretations: [],
  } as never);
  assert.match(brief.text, /【我惦记的】/);
  assert.match(brief.text, /提醒买蛋糕/);
});

// ── H-b 记忆的意义层 ────────────────────────────────
test("H-b 意义层：没证据的「理解」写不进去", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const noBasis = writeInterpretation(d.db, { text: "她其实很孤独", basis: [] });
  assert.equal(noBasis.ok, false);
  if (!noBasis.ok) assert.equal(noBasis.code, "E_INTERP_NO_BASIS");

  const badBasis = writeInterpretation(d.db, { text: "她其实很孤独", basis: [999] });
  assert.equal(badBasis.ok, false);
  if (!badBasis.ok) assert.equal(badBasis.code, "E_INTERP_BAD_BASIS");
});

test("H-b 意义层：复述原文不算解释", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const mid = remember(d.db, { layer: "narrative", kind: "episode", text: "她今天加班到十一点" });
  const r = writeInterpretation(d.db, { text: "她今天加班到十一点", basis: [mid] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "E_INTERP_RESTATE");
});

test("H-b 意义层：带证据写入 → 有 derived_from 边；同话题新解释取代旧解释（旧条归档不删）", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const m1 = remember(d.db, { layer: "narrative", kind: "episode", text: "她今天加班到十一点" });
  const m2 = remember(d.db, { layer: "narrative", kind: "episode", text: "她说最近项目很赶" });

  const a = writeInterpretation(d.db, { text: "她在用加班换掌控感", subject: "工作压力", basis: [m1, m2] });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  const links = d.db.prepare("SELECT dst_id FROM memory_links WHERE src_id=? AND rel='derived_from'").all(a.id) as Array<{ dst_id: number }>;
  assert.equal(links.length, 2, "两条证据都要连上");

  const list = listInterpretations(d.db);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0]!.basis.sort(), [m1, m2].sort());

  const b = writeInterpretation(d.db, { text: "她加班更多是怕被换掉，不是掌控感", subject: "工作压力", basis: [m1] });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.equal(b.replaced, a.id, "同话题：新的取代旧的");
  const old = d.db.prepare("SELECT status, superseded_by FROM memories WHERE id=?").get(a.id) as { status: string; superseded_by: number };
  assert.equal(old.status, "archived");
  assert.equal(Number(old.superseded_by), b.id);
  assert.equal(listInterpretations(d.db).length, 1, "active 只剩新的");
});

test("H-b 意义层：进简报时带依据 id（可查）", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const m = remember(d.db, { layer: "narrative", kind: "episode", text: "她说喜欢下雨天" });
  writeInterpretation(d.db, { text: "她对天气的偏爱和情绪有关", basis: [m] });
  const lines = interpretationsForBrief(d.db, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(`#${m}`));

  const brief = buildBrief({
    persona: { core: "x", boundaries: "y", evidenceOrder: "z", toolSchemas: "", toolDirectory: "" } as never,
    contracts: [], recalled: [], now: new Date(), user: "在吗",
    agenda: [], interpretations: lines,
  } as never);
  assert.match(brief.text, /【我怎么理解你】/);
});
