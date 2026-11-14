import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRollbackDrill } from "../tools/rollback-e2e.ts";

function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "jj-rollback-e2e-test-"));
  try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("回滚演练核心断言：active 回到 A，persona 逐字回到 A 槽的内容", () => {
  withHome((home) => {
    const r = runRollbackDrill(home);
    assert.notEqual(r.a, r.b);
    assert.equal(r.activeAfterRollback, r.a);
    assert.equal(r.coreAfterRollback, r.coreFromReleaseA);
  });
});

test("回滚演练核心断言：用户数据文件没被删、内容没被改", () => {
  withHome((home) => {
    const r = runRollbackDrill(home);
    assert.ok(r.userDataPaths.length >= 3);
    for (const p of r.userDataPaths) assert.ok(existsSync(p), `用户数据文件应存在：${p}`);
    assert.match(readFileSync(join(home, "inbox", "keep.md"), "utf8"), /别删我/);
    assert.ok(existsSync(join(home, "memory.db")), "memory.db 不该被删");
  });
});

test("回滚演练脚本产出完整步骤记录且整体不抛异常", () => {
  withHome((home) => {
    const r = runRollbackDrill(home);
    assert.ok(r.steps.length >= 4, `步骤应覆盖写 A/写 B/失败/回滚，实际 ${r.steps.length}`);
    assert.ok(r.steps.some((s) => s.includes("rollback")), "应有看门狗自动回滚这一步");
  });
});
