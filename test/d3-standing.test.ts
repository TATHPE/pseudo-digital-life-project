import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addStanding, listStanding, disableStanding, isDue, runDue, parseWhen } from "../src/standing.ts";
import { pushReceipt, listReceipts, markSeen, unseenCount, staleUnseen, ESCALATE_MS } from "../src/notify.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-std-"));
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi, 0);

// ── 回执通道 ─────────────────────────────────────────
test("D-3 回执：送达 ≠ 已读；只有 markSeen 才算人看见了", () => {
  const home = H();
  const r = pushReceipt(home, { kind: "standing", title: "跑完了", body: "输出…", source: "standing:x" });
  assert.equal(unseenCount(home), 1, "刚写进去是未读");
  const seen = markSeen(home, r.id);
  assert.equal(seen?.seen, true);
  assert.ok(seen?.seenAt);
  assert.equal(unseenCount(home), 0);
  assert.equal(listReceipts(home).length, 1, "已读的还在（历史不丢）");
});

test("D-3 回执：超过 3 天没人读 → staleUnseen 能点名", () => {
  const home = H();
  const now = at(2026, 10, 31, 12);
  pushReceipt(home, { kind: "standing", title: "很久没人看", source: "standing:old" }, new Date(now.getTime() - ESCALATE_MS - 60_000));
  pushReceipt(home, { kind: "standing", title: "刚刚" }, now);
  const stale = staleUnseen(home, now);
  assert.equal(stale.length, 1);
  assert.equal(stale[0]!.title, "很久没人看");
});

// ── 常驻指令 ─────────────────────────────────────────
test("D-3 when 解析：daily / workdays / 指定星期；写错的直接拒", () => {
  assert.deepEqual(parseWhen("daily 09:00"), { days: "all", hh: 9, mm: 0 });
  assert.deepEqual(parseWhen("workdays 20:30"), { days: [1, 2, 3, 4, 5], hh: 20, mm: 30 });
  assert.deepEqual(parseWhen("mon,thu 07:05"), { days: [1, 4], hh: 7, mm: 5 });
  assert.equal(parseWhen("every day 9am"), null);
  assert.equal(parseWhen("daily 25:00"), null);
  assert.equal(parseWhen("funday 09:00"), null);
});

test("D-3 建指令的闸：模板必须有、理由够长、**必须指定通知通道**", () => {
  const home = H();
  const base = { id: "log-check", when: "workdays 09:00", template: "node.run_script", because: "日志里出现 E_ 时我想第一时间知道" };

  const noNotify = addStanding(home, { ...base, notify: "" });
  assert.equal(noNotify.ok, false);
  if (!noNotify.ok) assert.equal(noNotify.code, "E_STANDING_NOTIFY");

  const badTpl = addStanding(home, { ...base, template: "rm.everything", notify: "panel" });
  assert.equal(badTpl.ok, false);
  if (!badTpl.ok) assert.equal(badTpl.code, "E_STANDING_TEMPLATE");

  const shortWhy = addStanding(home, { ...base, because: "随便", notify: "panel" });
  assert.equal(shortWhy.ok, false);

  const ok = addStanding(home, { ...base, notify: "panel", ttlDays: 3, maxPerDay: 2 });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.order.enabled, true);
    assert.equal(ok.order.maxPerDay, 2);
    // ttl 夹到 30 天以内
    const days = (Date.parse(ok.order.expiresAt) - Date.parse(ok.order.createdAt)) / 86400_000;
    assert.ok(days <= 30 + 0.01);
  }
});

test("D-3 到点判定：看星期、看时刻、看当天配额", () => {
  const home = H();
  const r = addStanding(home, {
    id: "daily-log", when: "workdays 09:00", template: "node.run_script",
    because: "每个工作日早上看一眼日志", notify: "panel", maxPerDay: 1, ttlDays: 7,
  }, at(2026, 10, 30, 8));                       // 周五建
  assert.equal(r.ok, true);
  const o = listStanding(home)[0]!;

  assert.equal(isDue(o, at(2026, 10, 30, 8, 30)), false, "还没到 9 点");
  assert.equal(isDue(o, at(2026, 10, 30, 9, 0)), true, "周五 9 点，到点");
  assert.equal(isDue(o, at(2026, 10, 31, 9, 0)), false, "周六不是工作日");
  const spent = { ...o, lastDay: "2026-10-30", countToday: 1 };
  assert.equal(isDue(spent, at(2026, 10, 30, 10, 0)), false, "当天配额用完");
  const expired = { ...o, expiresAt: at(2026, 10, 1, 0).toISOString() };
  assert.equal(isDue(expired, at(2026, 10, 30, 9, 0)), false, "过期就不跑");
});

test("D-3 跑一次：写回执、记配额、失败也要有回执", async () => {
  const home = H();
  addStanding(home, {
    id: "one", when: "daily 09:00", template: "node.run_script",
    because: "每天跑一次看看有没有异常", notify: "panel",
  }, at(2026, 10, 30, 8));

  const now = at(2026, 10, 30, 9, 5);
  let calls = 0;
  const report = await runDue({
    home,
    async run() { calls++; return { ok: false, output: "exit=1 boom" }; },
  }, now);

  assert.equal(calls, 1, "只跑一次");
  assert.equal(report.ran.length, 1);
  assert.equal(report.ran[0]!.ok, false);
  const inbox = listReceipts(home, { unseenOnly: true });
  assert.equal(inbox.length, 1, "失败也要留回执");
  assert.match(inbox[0]!.title, /失败/);
  assert.equal(inbox[0]!.source, "standing:one");

  // 配额：同一天再 tick 不跑
  const again = await runDue({ home, async run() { calls++; return { ok: true, output: "" }; } }, at(2026, 10, 30, 10));
  assert.equal(again.ran.length, 0);
  assert.equal(calls, 1);
});

test("D-3 回执没人读 → 自动停用（这条是 D-3 的核心保险）", async () => {
  const home = H();
  addStanding(home, {
    id: "noisy", when: "daily 09:00", template: "node.run_script",
    because: "每天提醒我一件很容易被忽略的事", notify: "panel", ttlDays: 30,
  }, at(2026, 10, 1, 8));

  // 三天前跑过一次，回执没人读
  await runDue({ home, async run() { return { ok: true, output: "done" }; } }, at(2026, 10, 27, 9, 5));
  assert.equal(unseenCount(home), 1);

  const report = await runDue({ home, async run() { return { ok: true, output: "done" }; } }, at(2026, 10, 31, 9, 5));
  assert.equal(report.disabled.length, 1, "应当停用它");
  const o = listStanding(home)[0]!;
  assert.equal(o.enabled, false);
  assert.match(String(o.disabledReason), /回执超过 3 天没人读/);
  assert.equal(report.ran.length, 0, "停用的这一轮不该跑");
});

test("D-3 停用后不再跑；disable 是显式动作、留原因", async () => {
  const home = H();
  addStanding(home, {
    id: "manual-x", when: "daily 09:00", template: "node.run_script",
    because: "手动停用测试要用的一条例行", notify: "panel",
  }, at(2026, 10, 30, 8));
  const o = disableStanding(home, "manual-x", "我不想它再跑了", at(2026, 10, 30, 9));
  assert.equal(o?.enabled, false);
  const report = await runDue({ home, async run() { throw new Error("不该被调用"); } }, at(2026, 10, 31, 9));
  assert.equal(report.ran.length, 0);
});
