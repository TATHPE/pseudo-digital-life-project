import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { weight, KIND_PARAMS, NIGHTLY_KINDS, isReadingKind } from "../src/decay.ts";
import { buildBrief } from "../src/brief.ts";
import { verbs } from "../src/verbs.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-read-"));

test("读来的：kind=reading 有独立衰减档，且在 NIGHTLY_KINDS 之外", () => {
  assert.ok(KIND_PARAMS["reading"], "reading 必须有参数档");
  assert.ok(!(NIGHTLY_KINDS as readonly string[]).includes("reading"),
    "夜间抽取只看对话（经历），不该从聊天里造出「读来的」");
  assert.equal(isReadingKind("reading"), true);
  assert.equal(isReadingKind("episode"), false);
});

test("读来的比一次性经历耐久：同一时刻，reading 的权重高于 episode", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const t0 = new Date(Date.UTC(2026, 0, 1));
  const later = new Date(Date.UTC(2026, 6, 1));       // 半年后
  const ep = remember(d.db, { layer: "narrative", kind: "episode", text: "今天下雨了", importance: 3, now: t0 });
  const rd = remember(d.db, { layer: "narrative", kind: "reading", text: "书里说：雨是云的重力", importance: 3, now: t0 });
  const rowOf = (id: number) => d.db.prepare("SELECT kind,w0,last_decay_at,layer FROM memories WHERE id=?").get(id) as
    { kind: string; w0: number; last_decay_at: string; layer: string };
  const e = rowOf(ep), r = rowOf(rd);
  const mk = (x: typeof e) => ({ layer: "narrative" as const, kind: x.kind, w0: x.w0, recallCount: 0, lastDecayAt: new Date(x.last_decay_at) });
  const we = weight(mk(e), later);
  const wr = weight(mk(r), later);
  assert.ok(wr > we, `读来的应当更耐久：reading ${wr.toFixed(3)} vs episode ${we.toFixed(3)}`);
});

test("读来的进不了契约层（她没答应过，只是看到过）", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  assert.throws(
    () => remember(d.db, { layer: "contract", kind: "reading", text: "书里说：要早睡" }),
    /E_READING_CONTRACT/,
    "读来的放进永不衰减的契约层 = 把书里的话当成她的承诺",
  );
  // 叙事层可以
  const id = remember(d.db, { layer: "narrative", kind: "reading", text: "书里说：要早睡" });
  assert.ok(id > 0);
});

test("简报里「读来」独立成标签，不和经历混在一起", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const now = new Date(Date.UTC(2026, 9, 31, 12));
  const rd = remember(d.db, { layer: "narrative", kind: "reading", text: "书里说：雨是云的重力", now });
  const ep = remember(d.db, { layer: "narrative", kind: "episode", text: "今天下了很大的雨", now });
  const line = (id: number, text: string, kind: string) => ({
    id, layer: "narrative" as const, kind, stage: "active" as const, weight: 0.6,
    text, sensitivity: "shareable" as const, source: "memory" as const,
  });
  const brief = buildBrief({
    persona: { core: "x", boundaries: "y", evidenceOrder: "z", toolSchemas: "", toolDirectory: "" } as never,
    contracts: [], recalled: [line(rd, "书里说：雨是云的重力", "reading"), line(ep, "今天下了很大的雨", "episode")] as never,
    now, user: "下雨了吗",
  });
  assert.match(brief.text, /读来/, "要有「读来」标签");
  assert.match(brief.text, /叙事/, "经历仍然是「叙事」");
});

test("工具：from=reading 会写成 narrative/reading/local_only，并记来源", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const v = verbs.find((x) => x.name === "memory.remember")!;
  const out = await v.run({ text: "书里说：雨是云的重力", from: "reading", source: "某本书 p.42" },
    { home, now: () => new Date(), db: d.db } as never);
  assert.match(String(out), /读来的/);
  const row = d.db.prepare("SELECT layer,kind,sensitivity,source_kind,source_ref,scored_by FROM memories ORDER BY id DESC LIMIT 1")
    .get() as { layer: string; kind: string; sensitivity: string; source_kind: string; source_ref: string; scored_by: string };
  assert.equal(row.layer, "narrative");
  assert.equal(row.kind, "reading");
  assert.equal(row.sensitivity, "local_only", "书里原文默认不外发");
  assert.equal(row.source_kind, "doc");
  assert.equal(row.source_ref, "某本书 p.42");
  assert.match(row.scored_by, /reading/);
});
