import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember, getRow } from "../src/store.ts";
import { createEmbedder } from "../src/embed.ts";
import { w0FromImportance, DECAY_PARAMS_VERSION } from "../src/decay.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-e2-"));
const emb = createEmbedder("fake");

test("E-2 w0 由 importance 推导：终于有方差；契约层仍为 1；1↔5 有界", () => {
  assert.equal(w0FromImportance(3, "narrative"), 0.59, "默认 3 → 0.59（接近旧的 0.55，不把旧库相对位置打乱）");
  assert.equal(w0FromImportance(1, "narrative"), 0.35);
  assert.equal(w0FromImportance(5, "narrative"), 0.83);
  assert.equal(w0FromImportance(3, "contract"), 1, "契约层永远是 1，不进公式");
  // 越界要夹住，不许“重要度 99”变成无限权重
  assert.equal(w0FromImportance(99, "narrative"), 0.83);
  assert.equal(w0FromImportance(-5, "narrative"), 0.35);
  assert.equal(DECAY_PARAMS_VERSION, 2, "改了行为必须 bump");
});

test("E-2 写库时真的用上了：importance 3/5 两条 w0 不同", async () => {
  const d = openDb(join(H(), "m.db"));
  const v = (await emb.embed(["x"]))[0]!;
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "普通的一条", importance: 3, embedding: v });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "很重要的一条", importance: 5, embedding: v });
  const ra = getRow(d.db, a)!, rb = getRow(d.db, b)!;
  assert.equal(ra.w0, 0.59);
  assert.equal(rb.w0, 0.83);
  assert.ok(rb.weight > ra.weight, "起点权重应该有差别（以前两条都是 0.55）");
});

test("E-2 显式传 w0 仍然优先（不让推导覆盖调用方的决定）", async () => {
  const d = openDb(join(H(), "m.db"));
  const v = (await emb.embed(["x"]))[0]!;
  const id = remember(d.db, { layer: "narrative", kind: "episode", text: "手动权重", importance: 5, w0: 0.2, embedding: v });
  assert.equal(getRow(d.db, id)!.w0, 0.2);
});

test("E-3 scored_by 写进库：人 / 规则 / 工具各有署名", async () => {
  const d = openDb(join(H(), "m.db"));
  const v = (await emb.embed(["x"]))[0]!;
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "人写的", scoredBy: "human:cli", embedding: v });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "抽取的", scoredBy: "extract:qwen2.5:7b", embedding: v });
  const c = remember(d.db, { layer: "narrative", kind: "episode", text: "默认的", embedding: v });
  const sb = (id: number) => (d.db.prepare("SELECT scored_by FROM memories WHERE id=?").get(id) as { scored_by: string }).scored_by;
  assert.equal(sb(a), "human:cli");
  assert.equal(sb(b), "extract:qwen2.5:7b");
  assert.equal(sb(c), "system", "没写明也要有个署名，不许留空");
});

// ── E-5：模型只能改元数据 ─────────────────────────────────────
test("E-5 模型不能改正文：updateMemoryText 只接受 human:*", async () => {
  const { updateMemoryText, patchMemoryMeta } = await import("../src/store.ts");
  const d = openDb(join(H(), "m.db"));
  const v = (await emb.embed(["x"]))[0]!;
  const id = remember(d.db, { layer: "narrative", kind: "episode", text: "原来的正文", embedding: v });

  assert.throws(() => updateMemoryText(d.db, id, "模型改写的历史", "extract:qwen2.5:7b"), /E_METADATA_ONLY/);
  assert.throws(() => updateMemoryText(d.db, id, "工具改写", "tool:memory.remember"), /E_METADATA_ONLY/);
  // 人改可以，且留 pre-image
  const r = updateMemoryText(d.db, id, "我改过的正文", "human:panel", new Date("2026-10-30T12:00:00Z"));
  assert.deepEqual(r, { ok: true, changed: true });
  const ev = d.db.prepare("SELECT kind,actor,payload FROM events WHERE kind='memory_text_changed'").get() as
    { kind: string; actor: string; payload: string };
  assert.equal(ev.actor, "human:panel");
  const payload = JSON.parse(ev.payload) as { before: string; after: string; by: string };
  assert.notEqual(payload.before, payload.after, "pre-image 要能看出变过");
  assert.equal((payload as unknown as { before_text: string }).before_text, "原来的正文", "pre-image 要能拿回旧正文（否则恢复不了）");
  assert.equal((d.db.prepare("SELECT text FROM memories WHERE id=?").get(id) as { text: string }).text, "我改过的正文");

  // 元数据白名单：模型可以改 stage/weight，不许改 text/bigram
  const ok = patchMemoryMeta(d.db, id, { stage: "fading", weight: 0.3 }, "extract:qwen2.5:7b");
  assert.deepEqual(ok.applied.sort(), ["stage", "weight"]);
  assert.throws(() => patchMemoryMeta(d.db, id, { text: "偷偷改" }, "extract:qwen2.5:7b"), /E_METADATA_ONLY/);
  assert.throws(() => patchMemoryMeta(d.db, id, { text_bigram: "x" }, "tool:memory.remember"), /E_METADATA_ONLY/);
});

test("E-5 夜间整备不会改已有记忆的正文", async () => {
  const { runNightly } = await import("../src/nightly.ts");
  const { appendEvent, newEventId } = await import("../src/journal.ts");
  const home = H();
  const inbox = join(home, "inbox");
  const d = openDb(join(home, "m.db"));
  const v = (await emb.embed(["老的一条"]))[0]!;
  const id = remember(d.db, { layer: "narrative", kind: "episode", text: "老的一条记忆", embedding: v, sensitivity: "shareable" });
  appendEvent(inbox, {
    v: 1, id: newEventId(), ts: new Date(Date.UTC(2026, 9, 30, 21)).toISOString(),
    kind: "utterance", actor: "user", payload: { text: "老的一条记忆今天又提到了" },
  });
  await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: async () => '[{"kind":"episode","layer":"narrative","text":"新的一条","salience":0.5}]',
    now: new Date(Date.UTC(2026, 9, 30, 23)),
  });
  assert.equal((d.db.prepare("SELECT text FROM memories WHERE id=?").get(id) as { text: string }).text, "老的一条记忆");
});
