/**
 * 三段侵蚀（学 whale-card 的 render_predicate）。
 *
 * 我们的记忆原来只有「在」和「不在」：权重掉到底就归档，干净但不像人。
 * 人忘事是渐进的：先忘细节，再忘发生了什么，最后只留个影子 ——
 * 而且**被侵蚀过的记忆永远知道自己被侵蚀过**（不能假装是原话）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { erodeStage1, erodeStage2, nextErosion, tickErosion, renderEroded, ERODE_W } from "../src/erosion.ts";

test("第一段：抹掉细节（时间/数字/路径），骨架还在，并明说细节忘了", () => {
  const s = erodeStage1("10-30 18:43 进程被杀 35 分钟，日志在 D:\LLM\jingjing\data\logs 里");
  assert.ok(!s.includes("18:43"), "时间要没：" + s);
  assert.ok(!s.includes("35 分钟"), "时长要没：" + s);
  assert.ok(!s.includes("D:\LLM"), "路径要没：" + s);
  assert.ok(s.includes("进程被杀"), "主干要留：" + s);
  assert.ok(s.includes("细节记不清了"), "要承认自己是残缺的");
});

test("第二段：只剩影子", () => {
  const s = erodeStage2("进程被杀 35 分钟，其间无经历");
  assert.ok(s.length <= 16, "只剩开头一点：" + s);
  assert.ok(s.includes("记不清"), "要明说记不清");
});

test("推进一格：0→1→2→到头（第三次该归档）", () => {
  assert.equal(nextErosion("吃过烧烤", 0)!.stage, 1);
  assert.equal(nextErosion("吃过烧烤（细节记不清了）", 1)!.stage, 2);
  assert.equal(nextErosion("吃…（做过什么，记不清了）", 2), null);
});

test("跑一轮：低权重才侵蚀，被想起过很多次的不动，契约层不动，到头就归档", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-ero-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    const weak = remember(db, { text: "10-30 18:43 在 D:\tmp 吃过烧烤 30 分钟", kind: "episode", layer: "narrative", importance: 1 });
    const strong = remember(db, { text: "她喜欢安静", kind: "preference_soft", layer: "narrative", importance: 5 });
    const contract = remember(db, { text: "不要叫我助手", kind: "promise", layer: "contract", importance: 5 });

    // 把 weak 压到门槛以下；strong 保持高权重；contract 也压下来（但它不该被侵蚀）
    db.prepare("UPDATE memories SET weight=? WHERE id=?").run(ERODE_W / 2, weak);
    db.prepare("UPDATE memories SET weight=? WHERE id=?").run(ERODE_W / 2, contract);
    // 被想起过很多次的弱记忆：不该动
    const recalled = remember(db, { text: "这条被想起过五次", kind: "episode", layer: "narrative", importance: 1 });
    db.prepare("UPDATE memories SET weight=?, recall_count=9 WHERE id=?").run(ERODE_W / 2, recalled);

    const r = tickErosion(db, new Date(), { random: () => 0 });        // random 0 → 必定触发
    assert.equal(r.eroded, 1, "只有那条真的弱、又没被想起的");

    const row = db.prepare("SELECT text,erase_stage FROM memories WHERE id=?").get(weak) as { text: string; erase_stage: number };
    assert.equal(row.erase_stage, 1);
    // 原文必须保留（正文只有人能改）；模糊版是**渲染出来的**
    assert.ok(row.text.includes("吃过烧烤"), "原文还在：" + row.text);
    assert.ok(renderEroded(row.text, row.erase_stage).includes("细节记不清了"), "展示时要模糊");

    const srow = db.prepare("SELECT erase_stage FROM memories WHERE id=?").get(strong) as { erase_stage: number };
    assert.equal(srow.erase_stage, 0, "权重高的不动");
    const crow = db.prepare("SELECT erase_stage FROM memories WHERE id=?").get(contract) as { erase_stage: number };
    assert.equal(crow.erase_stage, 0, "契约层不参与侵蚀");
    const rrow = db.prepare("SELECT erase_stage FROM memories WHERE id=?").get(recalled) as { erase_stage: number };
    assert.equal(rrow.erase_stage, 0, "被反复想起的不侵蚀");

    // 连着再推两次：第二次到 stage 2，第三次归档
    tickErosion(db, new Date(), { random: () => 0 });
    tickErosion(db, new Date(), { random: () => 0 });
    const fin = db.prepare("SELECT status,erase_stage FROM memories WHERE id=?").get(weak) as { status: string; erase_stage: number };
    assert.equal(fin.erase_stage, 2);
    assert.equal(fin.status, "archived", "侵蚀到头是归档，不是硬删");

    // 台账：每一步都有记录
    const n = (db.prepare("SELECT count(*) c FROM events WHERE kind IN ('memory_eroded','memory_erased')").get() as { c: number }).c;
    assert.ok(n >= 3, "侵蚀与归档都要留痕：" + n);
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
