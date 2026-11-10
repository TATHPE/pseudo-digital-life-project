/**
 * J-3b：关系边的「为什么连」必须是可核对的判据，不是模型转述。
 *
 * 回归点有三处，缺一不可：
 *  ① 库里存得下（原来 links.ts 写死 slice(0,20)，写进去就已经被砍掉）
 *  ② 人看的抽检卡读得到全文（surface.ts 原来也截 20）
 *  ③ 简报 P10 只留 20 字，所以数字必须排在最前面
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { appendEvent, newEventId } from "../src/journal.ts";
import { remember } from "../src/store.ts";
import { createEmbedder, type Embedder } from "../src/embed.ts";
import { linkIfNew, WHY_MAX, WHY_BRIEF } from "../src/links.ts";
import { runNightly, relationWhy } from "../src/nightly.ts";
import { writeInterpretation } from "../src/interpret.ts";
import { pickSurface } from "../src/surface.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-relwhy-"));
const emb = createEmbedder("fake");
const NOW = new Date("2026-10-28T23:00:00Z");
const reply = (arr: unknown) => async () => "```json\n" + JSON.stringify(arr) + "\n```";

function seed(home: string, lines: string[], hour = 21) {
  const inbox = join(home, "inbox");
  lines.forEach((text, i) => appendEvent(inbox, {
    v: 1, id: newEventId(), ts: new Date(Date.UTC(2026, 9, 28, hour, i)).toISOString(),
    kind: i % 2 === 0 ? "utterance" : "agent_reply", actor: i % 2 === 0 ? "user" : "agent",
    payload: { text },
  }));
  return inbox;
}

/** 可控余弦的假向量：旧文本放 e1，新文本放 (c, √(1-c²))，两者余弦恰为 c。
 *  维度保持 512，否则 vec0 虚表会拒收（写入失败虽不抛，但探针会失真）。 */
function controlled(spec: Record<string, number>): Embedder {
  return {
    name: "fake-controlled", dim: 512,
    async embed(texts: string[]) {
      return texts.map((t) => {
        const c = Math.max(-1, Math.min(1, spec[t] ?? 0.3));
        const v = new Float32Array(512);
        v[0] = c;
        v[1] = Math.sqrt(Math.max(0, 1 - c * c));
        return v;
      });
    },
  };
}

const linksOf = (db: ReturnType<typeof openDb>["db"]) =>
  db.prepare("SELECT rel, why FROM memory_links").all() as Array<{ rel: string; why: string }>;

test("relationWhy：数字在前、有规则、不超上限；P10 截 20 字后仍读得到 cos 和字面", () => {
  const why = relationWhy(0.93, 0.42, "同槽 contract≥0.85");
  assert.match(why, /^cos 0\.93 \/ 字面 0\.42 · /);
  assert.match(why, /同槽 contract≥0\.85/);
  assert.ok(why.length <= WHY_MAX);
  const brief = why.slice(0, WHY_BRIEF);
  assert.match(brief, /cos 0\.93 \/ 字面 0\.42/, "P10 只留开头，数字必须活着");
});

test("linkIfNew：60 字判据不再被砍成 20 字，且冲突时刷新 why", () => {
  const d = openDb(join(H(), "m.db"));
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "甲" });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "乙" });
  const full = relationWhy(0.94, 0.61, "跨层同件事(P1-2 ≥0.35 / 0.92)");
  assert.ok(full.length > WHY_BRIEF, "这条判据本来就比 20 字长，才测得出截断");

  linkIfNew(d.db, a, b, "related", 0.8, "旧理由", NOW);
  linkIfNew(d.db, a, b, "related", 1, full, NOW);
  const row = d.db.prepare("SELECT why, weight FROM memory_links").get() as { why: string; weight: number };
  assert.equal(row.why, full, "冲突时 why 必须跟着新证据刷新");
  assert.equal(row.weight, 1);
});

test("nightly：supersedes 不再写「同一件事的新说法」，改带 cos/字面 + 触发规则", async () => {
  const home = H();
  const inbox = seed(home, ["我住在杭州"]);
  const d = openDb(join(home, "m.db"));
  await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb, now: new Date("2026-10-28T22:00:00Z"),
    extract: reply([{ kind: "fact_hard", layer: "contract", subject: "居住地", text: "住在杭州", salience: 0.9, reason: "硬事实转述" }]),
  });
  seed(home, ["我搬到上海了"], 22);
  await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb, now: NOW,
    extract: reply([{ kind: "fact_hard", layer: "contract", subject: "居住地", text: "住在上海", salience: 0.9, reason: "模型给的理由" }]),
    fuzzyThreshold: 0.0,
  });
  const l = linksOf(d.db).find((x) => x.rel === "supersedes");
  assert.ok(l, "应该建一根 supersedes 边");
  assert.match(l.why, /^cos \d\.\d{2} \/ 字面 \d\.\d{2} · 同槽 cos≥0/);
  assert.ok(!l.why.includes("同一件事的新说法"), "不许再写空话");
  assert.ok(!l.why.includes("模型给的理由"), "不许抄模型 reason");
});

test("nightly：refine 的 derived_from 带 cos/字面，不再截模型 reason 的 20 字", async () => {
  const old = "她说下周三要交季度报告";
  const fresh = "她说下下周三要交季度报告";
  const home = H();
  const inbox = seed(home, [old]);
  const d = openDb(join(home, "m.db"));
  const e = controlled({ [old]: 1, [fresh]: 0.8 });
  await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: e, now: new Date("2026-10-28T22:00:00Z"),
    extract: reply([{ kind: "episode", layer: "narrative", subject: "季度报告", text: old, salience: 0.5, reason: "第一版的理由" }]),
  });
  seed(home, [fresh], 22);
  const r = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: e, now: NOW,
    extract: reply([{ kind: "episode", layer: "narrative", subject: "季度报告", text: fresh, salience: 0.5, reason: "第二版的理由" }]),
  });
  assert.equal(r.refined, 1, JSON.stringify(r));
  const l = linksOf(d.db).find((x) => x.rel === "derived_from");
  assert.ok(l, "应该建一根 derived_from 边");
  assert.match(l.why, /^cos 0\.80 \/ 字面 \d\.\d{2} · 同话题 cos≥0\.75/);
  assert.ok(!l.why.includes("第二版的理由"), "模型 reason 不是判据");
});

test("interpret：边上写的是可回查的证据 id 与旧解 id，不是「解释的证据」空话", () => {
  const d = openDb(join(H(), "m.db"));
  const m1 = remember(d.db, { layer: "narrative", kind: "episode", text: "她今天加班到十一点" });
  const m2 = remember(d.db, { layer: "narrative", kind: "episode", text: "她说最近项目很赶" });
  const a = writeInterpretation(d.db, { text: "她在用加班换掌控感", subject: "工作压力", basis: [m1, m2] });
  assert.equal(a.ok, true);
  if (!a.ok) return;

  const derived = linksOf(d.db).filter((x) => x.rel === "derived_from");
  assert.equal(derived.length, 2);
  for (const x of derived) {
    assert.match(x.why, /证据 #\d+、#\d+/, "判据要能按 id 回查");
    assert.ok(!x.why.includes("解释的证据"));
  }

  const b = writeInterpretation(d.db, { text: "她加班更多是怕被换掉", subject: "工作压力", basis: [m1] });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const sup = linksOf(d.db).find((x) => x.rel === "supersedes");
  assert.ok(sup);
  assert.match(sup.why, /同 subject「工作压力」取代 #\d+ · 证据 #\d+/);
  assert.ok(sup.why.length <= WHY_MAX);
});

test("surface：人看的抽检卡读得到整条判据（不再被截成 20 字）", () => {
  const d = openDb(join(H(), "m.db"));
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "旧的约定" });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "那次谈话" });
  d.db.prepare("UPDATE memories SET stage='dormant', weight=0.1 WHERE id IN (?,?)").run(a, b);
  const why = relationWhy(0.91, 0.55, "同槽 cos≥0.92");
  linkIfNew(d.db, a, b, "related", 1, why, NOW);
  const p = pickSurface(d.db, NOW);
  assert.ok(p);
  assert.equal(p.why, why, "抽检卡要全文，否则人没法判断这根线该不该有");
  assert.ok(p.why.length > WHY_BRIEF);
});
