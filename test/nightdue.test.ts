/**
 * 夜间整备的自动触发（2026-11-03）。
 *
 * 用户问「这个夜间整理从来没启动过吗」——查下来是真的：events 里只有手动那一次，
 * CLI 只有 `jingjing night`，standing/cron/壳/面板都没有触发点。
 * 「她会自己整理记忆」一直是空头承诺。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { dueInfo, kickNightIfDue, nightRunning } from "../src/nightdue.ts";

const writeNight = (db: ReturnType<typeof openDb>["db"], ts: string) =>
  db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,'night','system','nightly','{}',1)").run(ts);

test("从没整理过 → 该跑；刚跑过 → 不该跑；超过 20 小时 → 又该跑", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-nd-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    const now = new Date("2026-11-03T09:00:00Z");

    assert.equal(dueInfo(db, now).due, true, "没记录就该跑");
    assert.match(String(dueInfo(db, now).why), /从没整理过/);

    writeNight(db, "2026-11-03T08:00:00Z");
    assert.equal(dueInfo(db, now).due, false, "1 小时前跑过，不该跑");

    writeNight(db, "2026-11-02T08:00:00Z");   // 注意：max(ts) 仍是 08:00 那条更新的
    assert.equal(dueInfo(db, now).due, false);

    const db2home = mkdtempSync(join(tmpdir(), "jj-nd2-"));
    const d2 = openDb(join(db2home, "memory.db")).db;
    writeNight(d2, "2026-11-01T09:00:00Z");
    assert.equal(dueInfo(d2, now).due, true, "两天前跑过，该跑");
    try { rmSync(db2home, { recursive: true, force: true }); } catch { /* sqlite 句柄没释放 */ }
  } finally { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test("pending 不许假报（2026-11-09）：events 里塞再多事件也恒为 0，交给调用方按 inbox 判断", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-nd-pending-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    const now = new Date("2026-11-03T09:00:00Z");
    assert.equal(dueInfo(db, now).pending, 0, "以前硬编码 1，是对面板假报一条待整理");
    writeNight(db, "2026-11-03T08:00:00Z");
    db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES('2026-11-03T07:00:00Z','utterance','user','x','{}',1)").run();
    db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES('2026-11-03T07:10:00Z','agent_reply','agent','x','{}',1)").run();
    assert.equal(dueInfo(db, now).pending, 0, "查不到 inbox 就不许编数字");
  } finally { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test("kick：到期才起，且在跑的时候不会起第二个（同一批事件被抽两遍就完了）", async () => {
  const home = mkdtempSync(join(tmpdir(), "jj-nd3-"));
  try {
    const { db } = openDb(join(home, "memory.db"));
    const logs: string[] = [];
    let calls = 0;
    const runner = () => new Promise<number>((res) => setTimeout(() => { calls++; res(0); }, 60));

    const a = kickNightIfDue(db, runner, new Date(), { log: (s) => logs.push(s) });
    assert.equal(a.started, true, "从没跑过 → 起");
    assert.equal(nightRunning(), true, "标记在跑");

    const b = kickNightIfDue(db, runner, new Date(), { log: (s) => logs.push(s) });
    assert.equal(b.started, false, "在跑的时候不许起第二个");
    assert.match(String(b.why), /已经在跑/);

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(calls, 1, "只跑了一次");
    assert.equal(nightRunning(), false, "跑完释放");
  } finally { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test("三条提前 return 都要留痕：缺模型 / 没有新事件 / 抽取失败", () => {
  // 之前只有「抽取失败」写记录，另外两条静默 return ——
  // 于是「点了按钮、跑了、但什么都没发生」在历史里查不到（用户以为功能没启动）。
  const src = readFileSync(join(process.cwd(), "src/nightly.ts"), "utf8");
  const n = (src.match(/recordNight\(deps\.db, report, now/g) ?? []).length;
  assert.equal(n, 4, "四处都要记：缺模型 / 没有新事件 / 抽取失败 / 正常结束，实得 " + n);
});
