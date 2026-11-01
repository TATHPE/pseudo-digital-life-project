import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { loadPolicy } from "../src/policy.ts";
import { loadHooks, fireHooks, HOOK_EVENTS } from "../src/hooks.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-hook-"));

function writeHooks(home: string, hooks: unknown[]): void {
  writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks }), "utf8");
}

test("钩子：只认注册过的事件与模板形状，坏文件当没有", () => {
  const home = H();
  assert.deepEqual(loadHooks(home), []);
  writeFileSync(join(home, "hooks.json"), "{ 半个 json", "utf8");
  assert.deepEqual(loadHooks(home), [], "坏文件不装任何钩子");

  writeHooks(home, [
    { id: "a", event: "after_turn", template: "git.status", because: "每轮看一眼仓库状态" },
    { id: "b", event: "不存在的点", template: "git.status", because: "x" },
    { id: "c", template: "git.status", because: "缺 event" },
    { id: "d", event: "before_night", template: 123, because: "template 不是字符串" },
  ]);
  const hs = loadHooks(home);
  assert.deepEqual(hs.map((h) => h.id), ["a"], "只留下形状正确的");
  assert.deepEqual(HOOK_EVENTS, ["after_turn", "before_night", "after_night"]);
});

test("钩子：触发时走 execute（policy + 审计都照走），且失败不抛", async () => {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  const d = openDb(join(home, "m.db"));
  const policy = await loadPolicy(home);
  const ctx = { home, now: () => new Date("2026-11-01T00:00:00Z"), env: {} };

  writeHooks(home, [
    { id: "ok", event: "after_turn", template: "git.status", because: "看一眼仓库" },
    { id: "off", event: "after_turn", template: "git.status", enabled: false, because: "停用了" },
    { id: "other", event: "after_night", template: "git.status", because: "别的点" },
  ]);

  const r = await fireHooks(home, "after_turn", { db: d.db, policy, ctx });
  assert.deepEqual(r.ran.map((x) => x.id), ["ok"], "停用的与别的事件点都不该跑");
  assert.equal(r.ran[0]!.ok, true);

  // 审计里能看到这条（shell.run 的记录）
  const rows = d.db.prepare("SELECT count(*) c FROM exec_audit WHERE verb='shell.run'").get() as { c: number };
  assert.ok(rows.c >= 1, "钩子也要留痕（实际 " + rows.c + "）");

  // 不存在的模板 → 失败但不抛（钩子不该拖垮调用方）
  writeHooks(home, [{ id: "bad", event: "after_turn", template: "no.such.template", because: "故意坏" }]);
  const r2 = await fireHooks(home, "after_turn", { db: d.db, policy, ctx });
  assert.equal(r2.ran.length, 1);
  assert.equal(r2.ran[0]!.ok, false);
});
