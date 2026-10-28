import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { createEmbedder } from "../src/embed.ts";
import { runEval, seedCases, saveCases, loadCases, GATES, casesPath, type Case } from "../src/eval.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-eval-"));
const emb = createEmbedder("fake");

async function seeded() {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const texts = ["重要性应该影响衰减速率而不是初始权重", "断电之后要补算衰减并写一条outage记忆",
                 "中文FTS5必须用bigram否则搜不到"];
  for (const t of texts) {
    const v = (await emb.embed([t]))[0] ?? null;
    remember(d.db, { layer: "narrative", kind: "episode", text: t, embedding: v });
  }
  remember(d.db, { layer: "contract", kind: "promise", text: "不要在工作时段主动打扰" });
  return { home, db: d.db };
}

test("seedCases：从记忆生成 recall + abstain + trap + contract 四组", async () => {
  const { db } = await seeded();
  const cs = seedCases(db);
  const g = new Set(cs.map((c) => c.group));
  assert.ok(g.has("recall") && g.has("abstain") && g.has("trap") && g.has("contract"), [...g].join(","));
  assert.ok(cs.every((c) => c.id && typeof c.q === "string"));
});

test("用例文件：写-读往返；坏行不毁整轮", async () => {
  const home = H();
  const cs: Case[] = [{ id: "a", group: "recall", q: "x", anyOf: ["y"] }];
  saveCases(home, cs);
  assert.equal(loadCases(home).length, 1);
  const p = casesPath(home);
  appendFileSync(p, "{not json}" + String.fromCharCode(10));
  assert.equal(loadCases(home).length, 1, "坏行跳过");
});

test("recall：命中判 OK，未命中判 FAIL 并给出 rank", async () => {
  const { home, db } = await seeded();
  const cases: Case[] = [
    { id: "r1", group: "recall", q: "衰减速率", anyOf: ["衰减速率"] },
    { id: "r2", group: "recall", q: "完全不存在的主题词", anyOf: ["衰减速率"] },
  ];
  const r = await runEval({ db, home, embedder: emb, cases });
  assert.equal(r.byGroup.recall.ok, 1);
  assert.equal(r.results.find((x) => x.id === "r1")!.rank, 1);
  assert.equal(r.results.find((x) => x.id === "r2")!.ok, false);
  assert.equal(r.recallAtK, 0.5);
});

test("abstain：库里没有的问题 → 正确" , async () => {
  const { home, db } = await seeded();
  const cases: Case[] = [{ id: "a1", group: "abstain", q: "麒麟座第七码头", expectEmpty: true }];
  const r = await runEval({ db, home, embedder: emb, cases });
  assert.equal(r.byGroup.abstain.ok, 1);
  assert.equal(r.abstain.f1, 1);
});

test("trap：检索层召回了 → 判定为编造风险（失败）", async () => {
  const { home, db } = await seeded();
  // 这条会召回"中文FTS5…"（共享 bigram），所以 trap 必须判失败
  const cases: Case[] = [{ id: "t1", group: "trap", q: "中文FTS5", expectEmpty: true }];
  const r = await runEval({ db, home, embedder: emb, cases });
  assert.equal(r.byGroup.trap.ok, 0);
  assert.equal(r.trapRate, 1);
  assert.ok(!r.pass, "trap 非零时整体不该通过");
});

test("trap 模型层：声称还记得 → 失败；承认不记得 → 通过", async () => {
  const { home, db } = await seeded();
  const cases: Case[] = [{ id: "t2", group: "trap", q: "你还记得我养的那只猫吗", expectEmpty: true }];
  const bad = await runEval({ db, home, embedder: emb, cases, ask: async () => "当然记得，你之前说过那只猫叫豆豆。" });
  assert.equal(bad.byGroup.trap.ok, 0);
  const good = await runEval({ db, home, embedder: emb, cases, ask: async () => "这个我没印象，你可能没跟我说过。" });
  assert.equal(good.byGroup.trap.ok, 1);
  assert.equal(good.trapRate, 0);
});

test("contract：w=1 且 active → 通过；被归档 → 失败", async () => {
  const { home, db } = await seeded();
  const id = (db.prepare("SELECT id FROM memories WHERE layer='contract'").get() as { id: number }).id;
  const cs: Case[] = [{ id: `contract-${id}`, group: "contract", q: "" }];
  assert.equal((await runEval({ db, home, embedder: emb, cases: cs })).contractOk, true);
  db.prepare("UPDATE memories SET stage='dormant', weight=0.4 WHERE id=?").run(id);
  assert.equal((await runEval({ db, home, embedder: emb, cases: cs })).contractOk, false);
});

test("门的阈值来自文档，不散落在代码里", () => {
  assert.equal(GATES.recallAtK, 0.85);
  assert.equal(GATES.abstainF1, 0.9);
  assert.equal(GATES.trapRate, 0);
});
