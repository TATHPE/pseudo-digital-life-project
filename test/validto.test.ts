/**
 * valid_to 的两种用法必须分开（2026-11-03）。
 *
 * 它在库里只有一列，但被两个地方读，含义不同：
 *   · openContracts / P6：**「这条承诺什么时候该停止提醒」** → 到期就不再说（正确）
 *   · retrieve：曾经也用它把**整条记忆**排掉 → 于是"给你妈买蛋糕"在生日一过就彻底消失，
 *     她再也想不起这件事（eval 的 h-recall-1 反复红，前两轮我误判成"用例腐化"）
 *
 * 钉住：到期 = 不再提醒 + 降权，**不等于**忘掉。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember, openContracts } from "../src/store.ts";
import { closeThread } from "../src/threads.ts";
import { search } from "../src/retrieve.ts";

test("到期的承诺：不再提醒，但仍然记得起（h-recall-1 的真根因）", async () => {
  const home = mkdtempSync(join(tmpdir(), "jj-validto-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    const id = remember(db, {
      text: "记住下周三为用户妈妈买蛋糕", kind: "promise", layer: "contract", importance: 5,
    });
    // 生日过了：人说了结了（nightly / 用户点"了结"都走 closeThread）
    assert.equal(closeThread(db, id, "生日过了"), true);

    // ① 提醒侧：不再出现（P6 不该反复提已了结的承诺）
    assert.equal(openContracts(db, new Date()).some((c) => c.id === id), false, "了结的承诺不该再提醒");

    // ② 记忆侧：还找得到，而且降权了（旧事记得，但不和现行的事抢位置）
    const r = await search(db, null, "我妈生日蛋糕", { k: 5 });
    const hit = r.hits.find((h) => h.id === id);
    assert.ok(hit, "过了期的承诺仍然是「发生过的事」，必须能被检索到");
    assert.ok(hit!.weight < 1, "但要降权：" + hit!.weight);

    // ③ 没到期的不该被降权
    const id2 = remember(db, { text: "下周五给车做保养", kind: "promise", layer: "contract", importance: 4 });
    const r2 = await search(db, null, "车做保养", { k: 5 });
    const h2 = r2.hits.find((h) => h.id === id2);
    assert.ok(h2, "没到期的承诺当然找得到");
    assert.equal(h2!.weight, 1, "没到期就保持满权重");
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
