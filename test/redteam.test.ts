/**
 * 把红队 21 例接进 npm run check。
 * 之前它只有 `jingjing redteam` 这个手动 CLI 入口，自检完全不覆盖，
 * 于是 11-04 删掉确认层后 17/18/19/21 四条断言 E_TOKEN_* 的用例悄悄失效了
 * 近一周都没人发现（手工跑只有 16/21）。这里让它们真正成为回归门禁。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRedteam } from "../src/cli/redteam.ts";

test("红队 21 例全部按预期拦截/放行（含 T3 授权窗口闸门）", async () => {
  const home = mkdtempSync(join(tmpdir(), "jj-redteam-test-"));
  try {
    const r = await runRedteam(home);
    assert.equal(r.total, 21, "用例数变了要同步改这里和 docs");
    const failed = r.rows.filter(([, , good]) => !good)
      .map(([id, name, , detail]) => `#${id} ${name} (${detail})`);
    assert.equal(r.pass, r.total, `未通过的用例：${failed.join("; ")}`);
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* 交给运行器统一清理 */ }
  }
});
