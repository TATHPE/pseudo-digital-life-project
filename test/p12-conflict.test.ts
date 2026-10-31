import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { appendEvent, newEventId } from "../src/journal.ts";
import { runNightly, bigramSim } from "../src/nightly.ts";
import { remember } from "../src/store.ts";
import { l2norm } from "../src/embed.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-p12-"));

/** 受控 embedder：同一组里的文本返回同一向量（模拟"语义上是一回事"） */
function groupedEmb(groups: string[][]) {
  const dim = 512;
  const vecOf = (text: string) => {
    const g = groups.findIndex((grp) => grp.some((x) => text.includes(x)));
    const v = new Float32Array(dim);
    if (g >= 0) v.fill(1 / Math.sqrt(dim));      // 同组 → 完全相同（cos = 1）
    else v.fill(0);
    if (g < 0) v[0] = 1;                          // 其他 → 正交
    return l2norm(v);
  };
  return { name: "grouped", dim, async embed(texts: string[]) { return texts.map(vecOf); } };
}

function seedInbox(home: string, lines: string[]) {
  const inbox = join(home, "inbox");
  lines.forEach((text, i) => appendEvent(inbox, {
    v: 1, id: newEventId(), ts: new Date(Date.UTC(2026, 9, 29, 21, i)).toISOString(),
    kind: i % 2 === 0 ? "utterance" : "agent_reply", actor: i % 2 === 0 ? "user" : "agent",
    payload: { text },
  }));
  return inbox;
}

const reply = (arr: unknown) => async () => JSON.stringify(arr);

test("P1-2 bigramSim：同一件事高分，同一话题低分", () => {
  const same = bigramSim("下周三生日，提前买蛋糕", "下周三生日提醒买蛋糕");
  const other = bigramSim("下周三生日提前买蛋糕", "生日那天我们吵架了");
  assert.ok(same > 0.35, `同一件事应 > 0.35，实际 ${same.toFixed(2)}`);
  assert.ok(other < 0.2, `不同的事应 < 0.2，实际 ${other.toFixed(2)}`);
  assert.ok(same > other);
});

test("P1-2 跨层重复（新的是强层）：contract 覆盖掉旧的 narrative 版本", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const emb = groupedEmb([["生日", "买蛋糕"]]);
  const now = new Date(Date.UTC(2026, 9, 29, 22));

  // 旧：弱层（narrative）
  const oldId = remember(d.db, {
    layer: "narrative", kind: "promise", subject: "生日",
    text: "下周三生日，提前买蛋糕", importance: 3, salience: 0.8,
    sensitivity: "shareable", sourceKind: "extract", sourceRef: "旧版本",
    embedding: (await emb.embed(["下周三生日，提前买蛋糕"]))[0]!, now,
  });
  d.db.prepare("UPDATE memories SET normalized_key=? WHERE id=?").run("narrative|生日", oldId);

  const inbox = seedInbox(home, ["我妈下周三生日，记得提醒我提前买蛋糕", "好，我记着了。"]);
  const report = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: reply([{ kind: "promise", layer: "contract", subject: "生日", text: "下周三生日提醒买蛋糕", salience: 0.9, reason: "承诺" }]),
    now: new Date(Date.UTC(2026, 9, 30, 3)),
  });

  const active = d.db.prepare("SELECT id,layer,status FROM memories WHERE status='active'").all() as Array<{ id: number; layer: string }>;
  assert.equal(active.length, 1, "同一件事只该留一条 active");
  assert.equal(active[0]!.layer, "contract", "留下的是强层");
  const old = d.db.prepare("SELECT status,superseded_by FROM memories WHERE id=?").get(oldId) as { status: string; superseded_by: number };
  assert.equal(old.status, "archived", "旧的弱层版本被归档");
  assert.equal(Number(old.superseded_by), active[0]!.id, "并且指回新条");
  assert.ok(report.notes.some((n) => n.includes("MERGE↑")), "要留痕");
});

test("P1-2 跨层重复（新的是弱层）：不插入，只抬旧条 confidence", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const emb = groupedEmb([["生日", "买蛋糕"]]);

  const keeperId = remember(d.db, {
    layer: "contract", kind: "promise", subject: "生日",
    text: "下周三生日提醒买蛋糕", importance: 5, salience: 0.9,
    sensitivity: "shareable", sourceKind: "extract", sourceRef: "已有",
    embedding: (await emb.embed(["下周三生日提醒买蛋糕"]))[0]!,
    now: new Date(Date.UTC(2026, 9, 29, 22)),
  });
  d.db.prepare("UPDATE memories SET normalized_key=? WHERE id=?").run("contract|生日", keeperId);
  const before = (d.db.prepare("SELECT confidence FROM memories WHERE id=?").get(keeperId) as { confidence: number }).confidence;

  const inbox = seedInbox(home, ["我妈下周三生日，记得提醒我提前买蛋糕", "好，我记着了。"]);
  const report = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    // 模型这次把它判成了叙事层（现实中就是这样抽错的）
    extract: reply([{ kind: "episode", layer: "narrative", subject: "生日提醒", text: "下周三生日，提前买蛋糕", salience: 0.6, reason: "聊天" }]),
    now: new Date(Date.UTC(2026, 9, 30, 3)),
  });

  const active = d.db.prepare("SELECT id,layer FROM memories WHERE status='active'").all() as Array<{ id: number; layer: string }>;
  assert.equal(active.length, 1, "弱层版本不该新增一条");
  assert.equal(active[0]!.layer, "contract");
  assert.equal(report.merged, 1, "report.merged 要计数");
  assert.equal(report.added, 0);
  const after = (d.db.prepare("SELECT confidence FROM memories WHERE id=?").get(keeperId) as { confidence: number }).confidence;
  assert.ok(after > before, "见到一次就抬一点信心");
  assert.ok(report.notes.some((n) => n.includes("MERGE<")), "弱层被吞掉要留痕：" + report.notes.join(" | "));
});

test("P1-2 反例：同一话题但是两件事 → 不许合并", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  // 两个文本向量相同（模拟同一个话题被向量压得很近），但字面差得远
  const emb = groupedEmb([["生日"]]);

  const oldId = remember(d.db, {
    layer: "contract", kind: "promise", subject: "生日",
    text: "下周三生日，提前买蛋糕", importance: 5, salience: 0.9,
    sensitivity: "shareable", sourceKind: "extract", sourceRef: "旧",
    embedding: (await emb.embed(["下周三生日，提前买蛋糕"]))[0]!,
    now: new Date(Date.UTC(2026, 9, 29, 22)),
  });
  d.db.prepare("UPDATE memories SET normalized_key=? WHERE id=?").run("contract|生日", oldId);

  const inbox = seedInbox(home, ["生日那天我们大吵一架，我不太想提", "嗯，先不说了。"]);
  const report = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: reply([{ kind: "episode", layer: "narrative", subject: "生日吵架", text: "生日那天吵架了", salience: 0.7, reason: "经历" }]),
    now: new Date(Date.UTC(2026, 9, 30, 3)),
  });

  const active = d.db.prepare("SELECT count(*) c FROM memories WHERE status='active'").get() as { c: number };
  assert.equal(active.c, 2, "两件事必须都留着");
  assert.equal(report.merged, 0, "不该被合并");
});

test("P1-2 同层但 subject 漂移（\"生日\" vs \"生日提醒\"）→ 也算同一件事", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const emb = groupedEmb([["生日", "买蛋糕"]]);

  const keeperId = remember(d.db, {
    layer: "narrative", kind: "promise", subject: "生日",
    text: "下周三生日，提前买蛋糕", importance: 3, salience: 0.8,
    sensitivity: "shareable", sourceKind: "extract", sourceRef: "已有",
    embedding: (await emb.embed(["下周三生日，提前买蛋糕"]))[0]!,
    now: new Date(Date.UTC(2026, 9, 29, 22)),
  });
  d.db.prepare("UPDATE memories SET normalized_key=? WHERE id=?").run("narrative|生日", keeperId);
  const before = (d.db.prepare("SELECT confidence FROM memories WHERE id=?").get(keeperId) as { confidence: number }).confidence;

  const inbox = seedInbox(home, ["我妈下周三生日，记得提醒我提前买蛋糕", "好，记着了。"]);
  const report = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: reply([{ kind: "promise", layer: "narrative", subject: "生日提醒", text: "下周三生日提醒买蛋糕", salience: 0.7, reason: "聊天" }]),
    now: new Date(Date.UTC(2026, 9, 30, 3)),
  });

  const active = d.db.prepare("SELECT id FROM memories WHERE status='active'").all() as Array<{ id: number }>;
  assert.equal(active.length, 1, "subject 漂移不该变成两条");
  assert.equal(report.merged, 1);
  assert.ok(report.notes.some((n) => n.includes("MERGE=")), "同层用 = 号留痕");
  const after = (d.db.prepare("SELECT confidence FROM memories WHERE id=?").get(keeperId) as { confidence: number }).confidence;
  assert.ok(after > before);
});
