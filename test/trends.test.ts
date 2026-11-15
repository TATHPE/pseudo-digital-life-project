/**
 * 记忆趋势（阶段 5）的单测。
 *
 * 这个文件重点不是「能不能算出数」，而是锁住三条**诚实性**约束：
 *  ① 切日必须按本地时区（UTC 16:30 属于本地次日）
 *  ② 没有记忆的日期必须补 0（否则折线会把中间的空档连成一条假上升）
 *  ③ 断片默认排除，但被排除的条数要如实报出来
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { memoryTrend } from "../src/trends.ts";

function withDb(fn: (db: ReturnType<typeof openDb>["db"]) => void): void {
  const home = mkdtempSync(join(tmpdir(), "jj-trend-"));
  const o = openDb(join(home, "m.db"));
  try {
    fn(o.db);
  } finally {
    // Windows 上不 close 就删目录会 EBUSY（文件还被 SQLite 占着）
    o.db.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/** 直接改 created_at：remember() 只接受 now，但趋势要按「指定的历史时刻」验时区 */
function setCreated(db: ReturnType<typeof openDb>["db"], id: number, iso: string): void {
  db.prepare("UPDATE memories SET created_at=? WHERE id=?").run(iso, id);
}

test("切日按本地时区：UTC 16:30 必须算本地次日，不能算前一天", () => {
  withDb((db) => {
    const now = new Date(2026, 10, 15, 12, 0, 0); // 本地 11-15 12:00
    const r = remember(db, { layer: "narrative", kind: "fact", text: "本地次日凌晨写的一条", now });
    // UTC 11-14 16:30 = 本地（UTC+8）11-15 00:30
    setCreated(db, r, "2026-11-14T16:30:00.000Z");

    const t = memoryTrend(db, { days: 5, now });
    const day15 = t.daily.find((d) => d.date === "2026-11-15");
    const day14 = t.daily.find((d) => d.date === "2026-11-14");
    assert.equal(day15?.created, 1, "UTC 16:30 属于本地 11-15，不是 11-14");
    assert.equal(day14?.created, 0, "11-14 不该被算进这条");
  });
});

test("逐日补零：中间没有记忆的日期必须出现且为 0", () => {
  withDb((db) => {
    const now = new Date(2026, 10, 15, 12, 0, 0);
    const a = remember(db, { layer: "narrative", kind: "fact", text: "第一天", now });
    const b = remember(db, { layer: "narrative", kind: "fact", text: "第五天", now });
    setCreated(db, a, "2026-11-11T02:00:00.000Z");
    setCreated(db, b, "2026-11-15T02:00:00.000Z");

    const t = memoryTrend(db, { days: 5, now });
    assert.equal(t.daily.length, 5, "5 天窗口就给 5 个点，缺的日子用 0 补");
    assert.deepEqual(
      t.daily.map((d) => d.date),
      ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"],
    );
    assert.deepEqual(t.daily.map((d) => d.created), [1, 0, 0, 0, 1]);
    // 累计是「还在的总数」，中间空档不能让它回退
    assert.deepEqual(t.daily.map((d) => d.cumulative), [1, 1, 1, 1, 2]);
  });
});

test("断片默认排除，但必须如实报出被排除了多少", () => {
  withDb((db) => {
    const now = new Date(2026, 10, 15, 12, 0, 0);
    const real = remember(db, { layer: "narrative", kind: "fact", text: "她说想养猫", now });
    const out = remember(db, { layer: "narrative", kind: "episode", text: "进程被杀 12 分钟", now });
    setCreated(db, real, "2026-11-14T02:00:00.000Z");
    setCreated(db, out, "2026-11-14T03:00:00.000Z");

    const off = memoryTrend(db, { days: 3, now });
    assert.equal(off.summary.createdInWindow, 1, "默认不计断片");
    assert.equal(off.summary.outageInWindow, 1, "被排除的断片必须报出来，不能静默丢掉");
    assert.ok(off.notes.some((n) => n.includes("断片")), "口径要写在 notes 里，界面原样展示");

    const on = memoryTrend(db, { days: 3, now, includeOutage: true });
    assert.equal(on.summary.createdInWindow, 2, "显式要求时断片要计入");
  });
});

test("累计曲线起点 = 窗口之前就有的条数", () => {
  withDb((db) => {
    const now = new Date(2026, 10, 15, 12, 0, 0);
    const old = remember(db, { layer: "narrative", kind: "fact", text: "很久以前", now });
    const recent = remember(db, { layer: "narrative", kind: "fact", text: "昨天", now });
    setCreated(db, old, "2026-09-01T02:00:00.000Z");
    setCreated(db, recent, "2026-11-14T02:00:00.000Z");

    const t = memoryTrend(db, { days: 7, now });
    assert.equal(t.summary.beforeWindow, 1, "窗口前已有 1 条");
    assert.equal(t.daily[0]?.cumulative, 1, "曲线从既有存量起步，不是从 0");
    assert.equal(t.daily[t.daily.length - 1]?.cumulative, 2, "最后一天等于当前 active 总数");
  });
});

test("被忘掉的不画进曲线，但要单独报数", () => {
  withDb((db) => {
    const now = new Date(2026, 10, 15, 12, 0, 0);
    const keep = remember(db, { layer: "narrative", kind: "fact", text: "留着", now });
    const gone = remember(db, { layer: "narrative", kind: "fact", text: "忘了", now });
    setCreated(db, keep, "2026-11-13T02:00:00.000Z");
    setCreated(db, gone, "2026-11-13T03:00:00.000Z");
    db.prepare("UPDATE memories SET status='deleted' WHERE id=?").run(gone);

    const t = memoryTrend(db, { days: 4, now });
    assert.equal(t.daily.find((d) => d.date === "2026-11-13")?.created, 1, "忘掉的不算新增");
    assert.equal(t.summary.deletedInWindow, 1, "但必须报出「有 1 条加了又被忘」");
    assert.ok(t.notes.some((n) => n.includes("忘")), "这条口径也要让用户看得到");
  });
});

test("衰减曲线：横轴是记忆年龄，保留率 = weight / w0", () => {
  withDb((db) => {
    const now = new Date(2026, 10, 15, 12, 0, 0);
    // 今天刚记：w0=1，权重没掉
    const fresh = remember(db, { layer: "narrative", kind: "fact", text: "今天的", importance: 5, now });
    // 40 天前记的：w0=1，掉到 0.4
    const old = remember(db, { layer: "narrative", kind: "fact", text: "很久前的", importance: 5, now });
    setCreated(db, old, "2026-10-06T02:00:00.000Z");
    // w0 由 importance 推导，不是常数 —— 不显式钉住就会算出 1.205 这种「>1」的保留率。
    // 顺便说明：keep 可以 >1（被召回加强过），这里**不 clamp**，clamp 等于抹掉真实情况。
    db.prepare("UPDATE memories SET w0=1, weight=0.4 WHERE id=?").run(old);
    db.prepare("UPDATE memories SET w0=1, weight=1 WHERE id=?").run(fresh);

    const t = memoryTrend(db, { days: 30, now });
    const b0 = t.decay.find((b) => b.label === "今天");
    const b30 = t.decay.find((b) => b.label === "30 天以上");
    assert.equal(b0?.n, 1);
    assert.equal(b0?.keep, 1, "刚记的保留率应该是 1");
    assert.equal(b30?.n, 1);
    assert.equal(b30?.keep, 0.4, "40 天前的掉到 0.4");
    // 分桶必须按年龄单调覆盖，不能有记忆落在桶外
    assert.equal(t.decay.reduce((s, b) => s + b.n, 0), 2, "每条 active 记忆都要落进某个桶");
  });
});

test("days 夹在 1–180，非法值不炸", () => {
  withDb((db) => {
    const now = new Date(2026, 10, 15, 12, 0, 0);
    assert.equal(memoryTrend(db, { days: 0, now }).days, 1);
    assert.equal(memoryTrend(db, { days: 999, now }).days, 180);
    assert.equal(memoryTrend(db, { days: Number.NaN, now }).daily.length >= 1, true);
  });
});

test("空库也能返回结构完整的空曲线（界面不用特判 null）", () => {
  withDb((db) => {
    const now = new Date(2026, 10, 15, 12, 0, 0);
    const t = memoryTrend(db, { days: 30, now });
    assert.equal(t.daily.length, 30);
    assert.ok(t.daily.every((d) => d.created === 0 && d.cumulative === 0));
    assert.equal(t.summary.activeNow, 0);
    assert.equal(t.decay.length, 6, "六个年龄桶恒定存在，空库只是 n=0");
    assert.deepEqual(t.byKind, []);
    assert.ok(t.notes.length >= 3, "口径说明不能因为空库就消失");
  });
});
