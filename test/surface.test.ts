import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember, reinforce } from "../src/store.ts";
import { createEmbedder } from "../src/embed.ts";
import { search, expandByLinks } from "../src/retrieve.ts";
import { decideSurface, pickSurface, noteSurfaced, usedToday, SURFACE_LIMITS } from "../src/surface.ts";
import { linkIfNew, pickQuote } from "../src/nightly.ts";
import { indexState } from "../src/embedindex.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-j-"));
const emb = createEmbedder("fake");
const now = new Date("2026-10-30T12:00:00Z");

// ── J-1 再巩固 ──────────────────────────────────────────────
test("J-1 reinforce：被注入之后 recall_count/w0 真的涨，external 不涨", async () => {
  const d = openDb(join(H(), "m.db"));
  const v = (await emb.embed(["x"]))[0]!;
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "我喜欢乌龙茶", embedding: v });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "文档抄来的话", embedding: v, taint: "external" });
  const before = d.db.prepare("SELECT recall_count,w0 FROM memories WHERE id=?").get(a) as { recall_count: number; w0: number };
  assert.equal(before.recall_count, 0, "初始必须是 0（否则测不出有没有接上）");

  const n = reinforce(d.db, [a, b], now);
  assert.equal(n, 1, "只有 trusted 那条会被加固");
  const after = d.db.prepare("SELECT recall_count,w0 FROM memories WHERE id=?").get(a) as { recall_count: number; w0: number };
  assert.equal(after.recall_count, 1);
  assert.ok(after.w0 > before.w0, "w0 要渐近上升");
  const ext = d.db.prepare("SELECT recall_count FROM memories WHERE id=?").get(b) as { recall_count: number };
  assert.equal(ext.recall_count, 0, "external 不许因为被想起而变重（D-1）");
});

// ── J-1 关系一跳 ────────────────────────────────────────────
test("J-1 沿关系一跳：有 why 的有效边才带得动；作废的边不带", async () => {
  const d = openDb(join(H(), "m.db"));
  const v = (await emb.embed(["杭州出差"]))[0]!;
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "三月要去杭州出差", embedding: v, sensitivity: "shareable" });
  // 邻居刻意不用同样的词：否则 FTS 自己就命中了，"沿边扩"这件事测不出来
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "那次谈话让我很累", embedding: v, sensitivity: "shareable" });
  linkIfNew(d.db, a, b, "related", 1, "同一段经历", now);

  const r = await search(d.db, emb, "杭州出差");
  assert.ok(r.hits.length >= 1);
  const near = expandByLinks(d.db, r.hits, { k: 2, now });
  assert.equal(near.length, 1, "应该沿边带出邻居");
  assert.equal(near[0]!.id, b);
  assert.equal(near[0]!.viaLink?.why, "同一段经历", "必须能说出为什么连");

  // 作废（写止期）之后就不该再带
  d.db.prepare("UPDATE memory_links SET valid_to=? WHERE src_id=?").run(now.toISOString(), a);
  assert.equal(expandByLinks(d.db, r.hits, { k: 2, now }).length, 0, "止期到了就不走这条边");
});

test("J-1 没有 why 的边不参与召回（说不清的关系不该存在）", async () => {
  const d = openDb(join(H(), "m.db"));
  const v = (await emb.embed(["x"]))[0]!;
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "甲记忆关于杭州", embedding: v });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "乙记忆关于杭州", embedding: v });
  d.db.prepare("INSERT INTO memory_links(src_id,dst_id,rel,weight,created_at) VALUES(?,?,?,?,?)").run(a, b, "related", 1, now.toISOString());
  const r = await search(d.db, emb, "杭州");
  assert.equal(expandByLinks(d.db, r.hits, { k: 2, now }).length, 0);
});

// ── J-2 原话 ────────────────────────────────────────────────
test("J-2 pickQuote：从真实对话里逐字取原话，取不到就 null", async () => {
  const ev = (text: string) => ({ v: 1, id: "e" + text.length, ts: now.toISOString(), kind: "utterance", actor: "user", payload: { text } });
  const events = [ev("我奶奶生日为什么不提醒了"), ev("今天吃了米饭"), ev("我喜欢乌龙茶")];
  const q = pickQuote(events as never, "提醒奶奶生日");
  assert.equal(q, "我奶奶生日为什么不提醒了", "要挑最像的那句原话");
  assert.equal(pickQuote(events as never, "量子引力与暗物质"), null, "对不上就 null，不许硬凑");
});

// ── J-3 关系带 why + 黑名单 ────────────────────────────────
test("J-3 linkIfNew：why 截到 20 字；拆过的线永不自动接回", async () => {
  const d = openDb(join(H(), "m.db"));
  const v = (await emb.embed(["x"]))[0]!;
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "甲", embedding: v });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "乙", embedding: v });
  linkIfNew(d.db, a, b, "related", 1, "这是一个很长很长的理由超过二十个字了应该被截断", now);
  const row = d.db.prepare("SELECT why FROM memory_links WHERE src_id=?").get(a) as { why: string };
  assert.ok([...row.why].length <= 20, "why 必须 ≤20 字");

  d.db.prepare("INSERT INTO meta(key,value) VALUES('links_blocked',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`${a}:${b}:related`);
  assert.equal(linkIfNew(d.db, a, b, "related", 1, "再来一次", now), false, "黑名单里的线不许重建");
});

// ── J-4 浮现时机 ───────────────────────────────────────────
test("J-4 时机：人回来了 / 换话题 / 隔夜首句 / 情绪线索；其余不浮", () => {
  const base = { text: "继续吧", prevText: "继续吧", firstOfDay: false };
  const d1 = decideSurface({ ...base, now, lastMsgAt: new Date(now.getTime() - 11 * 60 * 1000) }, 0);
  assert.deepEqual([d1.ok, d1.trigger], [true, "人回来了"]);

  const d2 = decideSurface({ ...base, now, lastMsgAt: new Date(now.getTime() - 60 * 1000), prevText: "我们在聊数据库索引", text: "今天天气不错" }, 0);
  assert.deepEqual([d2.ok, d2.trigger], [true, "换了话题"]);

  const d3 = decideSurface({ ...base, now, lastMsgAt: new Date(now.getTime() - 60 * 1000), firstOfDay: true }, 0);
  assert.deepEqual([d3.ok, d3.trigger], [true, "隔夜第一句"]);

  const d4 = decideSurface({ ...base, now, lastMsgAt: new Date(now.getTime() - 60 * 1000), prevText: "今天有点累", text: "今天有点撑不住" }, 0);
  assert.deepEqual([d4.ok, d4.trigger], [true, "对方不太对劲"]);

  const d5 = decideSurface({ ...base, now, lastMsgAt: new Date(now.getTime() - 60 * 1000) }, 0);
  assert.equal(d5.ok, false, "普通连续对话不该浮");
});

test("J-4 每天 ≤2 条：第 3 次直接被挡", () => {
  const d = decideSurface({ now, lastMsgAt: new Date(now.getTime() - 20 * 60 * 1000), prevText: "", text: "在吗", firstOfDay: false }, SURFACE_LIMITS.perDay);
  assert.equal(d.ok, false);
  assert.match(d.reason, /上限/);
});

test("J-4 只挑『沉着但有线』的条目，且同一根线 7 天内不重复", async () => {
  const d = openDb(join(H(), "m.db"));
  const v = (await emb.embed(["x"]))[0]!;
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "旧的约定", embedding: v });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "那次谈话", embedding: v });
  d.db.prepare("UPDATE memories SET stage='dormant', weight=0.1 WHERE id IN (?,?)").run(a, b);
  assert.equal(pickSurface(d.db, now), null, "没有线的沉底条目不该自己浮");

  linkIfNew(d.db, a, b, "related", 1, "同一段经历", now);
  const p1 = pickSurface(d.db, now);
  assert.ok(p1, "有线就该能被挑出来");
  noteSurfaced(d.db, now, p1!);
  assert.equal(usedToday(d.db, now), 1);
  assert.equal(pickSurface(d.db, now), null, "同一根线 7 天内不重复");
});

// ── C-2 顺带：空库不算 stale ───────────────────────────────
test("C-2 空库 stale=false（补回回归）", () => {
  const d = openDb(join(H(), "m.db"));
  assert.equal(indexState(d.db, "ollama:bge-m3").stale, false);
});
