import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEgress, noteEgressRequest, allowOnce, allowFor, revokeEgress, egressStatus, forcedByEnv, _resetEgress } from "../src/egress.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-egr-"));
const ENV = {} as Record<string, string | undefined>;   // 没有 JJ_PROJECT_EGRESS

test("H-7 默认拒：不带路径的批文不等于放行，且拒绝时说得清是哪一条", () => {
  _resetEgress();
  const home = H();
  const r = checkEgress(home, "jingjing/src/recall.ts", { env: ENV });
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.code, "E_NEEDS_EGRESS"); assert.equal(r.path, "jingjing/src/recall.ts"); }
});

test("H-7 只这一次：读一次就消耗掉，第二次又回到拒绝", () => {
  _resetEgress();
  const home = H();
  allowOnce(home, "jingjing/src/recall.ts");
  assert.equal(egressStatus(home, { env: ENV }).once, 1);
  const a = checkEgress(home, "jingjing/src/recall.ts", { env: ENV });
  assert.equal(a.ok, true);
  if (a.ok) assert.equal(a.via, "once");
  const b = checkEgress(home, "jingjing/src/recall.ts", { env: ENV });
  assert.equal(b.ok, false, "一次性额度用完就该拒");
  _resetEgress();
});

test("H-7 时间窗：窗口内都行，到点自动关；收回立刻关", () => {
  _resetEgress();
  const home = H();
  const r = allowFor(home, 60_000, "面板批了");
  assert.ok(r.until);
  assert.equal(checkEgress(home, "jingjing/src/a.ts", { env: ENV }).ok, true);
  assert.equal(egressStatus(home, { env: ENV }).open, true);
  const later = new Date(Date.now() + 120_000);
  assert.equal(checkEgress(home, "jingjing/src/a.ts", { env: ENV, now: later }).ok, false, "过了窗口就拒");
  allowFor(home, 60_000, "再批一次");
  revokeEgress(home);
  assert.equal(egressStatus(home, { env: ENV }).open, false);
  _resetEgress();
});

test("H-7 待批列表：同一个路径只留最新一条，批完就消失", () => {
  _resetEgress();
  const home = H();
  noteEgressRequest(home, "jingjing/src/x.ts", "project.read", new Date(Date.UTC(2026, 9, 31, 10)));
  noteEgressRequest(home, "jingjing/src/x.ts", "project.read", new Date(Date.UTC(2026, 9, 31, 11)));
  noteEgressRequest(home, "docs/01-记忆动力学.md", "project.read", new Date(Date.UTC(2026, 9, 31, 9)));
  const st = egressStatus(home, { env: ENV });
  assert.equal(st.pending.length, 2, "同一路径去重");
  assert.equal(st.pending[0]!.path, "jingjing/src/x.ts", "最新的排前面");
  allowOnce(home, "jingjing/src/x.ts");
  assert.equal(egressStatus(home, { env: ENV }).pending.length, 1, "批过的从待批里消失");
  _resetEgress();
});

test("H-7 无人值守：JJ_PROJECT_EGRESS=1 时全放行，但状态里标成 forced", () => {
  _resetEgress();
  const home = H();
  assert.equal(forcedByEnv({ JJ_PROJECT_EGRESS: "1" }), true);
  assert.equal(checkEgress(home, "jingjing/src/a.ts", { env: { JJ_PROJECT_EGRESS: "1" } }).ok, true);
  assert.equal(egressStatus(home, { env: { JJ_PROJECT_EGRESS: "1" } }).forced, true);
  _resetEgress();
});
