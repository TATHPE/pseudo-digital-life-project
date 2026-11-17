import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkStatus, collectFacts, renderStatus, writeStatus } from "../tools/status.ts";
import { syncDesktopBundle } from "../tools/sync-desktop.ts";

const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const install = (stage: string) => put(join(stage, "node_modules/.package-lock.json"), "{}");

/** 最小夹具：六处版本号齐全、载荷可同步；不是 git 仓库（git 事实如实记 repo:false）。 */
function rig() {
  const root = mkdtempSync(join(tmpdir(), "jj-status-"));
  put(join(root, "package.json"), '{"version":"0.1.1","dependencies":{"b":"1","a":"1"}}');
  put(join(root, "package-lock.json"), '{"lockfileVersion":3}');
  put(join(root, "src/schema.ts"), "export const SCHEMA_VERSION = 12;");
  put(join(root, "src/cli/jingjing.ts"), "源码");
  put(join(root, "src/capabilities.ts"), 'const VERSION = "0.1.1"');
  put(join(root, "src/mcp.ts"), 'clientInfo: { name: "jingjing", version: "0.1.1" }');
  put(join(root, "persona/core.md"), "人格");
  put(join(root, "README.md"), "Not a mature product: 0.1.1");
  put(join(root, "desktop/src-tauri/tauri.conf.json"), '{"version":"0.1.1"}');
  put(join(root, "desktop/src-tauri/Cargo.toml"), '[package]\nversion = "0.1.1"');
  syncDesktopBundle(root, install);
  return root;
}

test("STATUS 渲染确定性：同夹具两次实测渲染逐字一致", () => {
  const root = rig();
  const a = renderStatus(collectFacts(root));
  const b = renderStatus(collectFacts(root));
  assert.equal(a, b);
  assert.match(a, /0\.1\.1，逐字一致/);
  assert.match(a, /v12/);
  assert.match(a, /2 个：a \/ b/);
  assert.match(a, /不是 git 仓库/);
});

test("STATUS 新鲜度闸门：生成后 check 过，篡改一个事实即红", () => {
  const root = rig();
  writeStatus(root);
  assert.equal(checkStatus(root).ok, true);
  const file = join(root, "STATUS.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("0.1.1，逐字一致", "9.9.9，逐字一致"));
  const r = checkStatus(root);
  assert.equal(r.ok, false);
  assert.match(r.detail, /npm run status/);
});

test("STATUS 时间行豁免：只改生成时间行，check 仍过", () => {
  const root = rig();
  writeStatus(root);
  const file = join(root, "STATUS.md");
  const text = readFileSync(file, "utf8").replace(/^生成时间：.*$/m, "生成时间：1999-01-01T00:00:00.000Z");
  writeFileSync(file, text);
  assert.equal(checkStatus(root).ok, true);
});

test("STATUS 快照红如实呈现：源码漂移后含红项，且旧 STATUS 被闸门抓住", () => {
  const root = rig();
  writeStatus(root);
  assert.match(readFileSync(join(root, "STATUS.md"), "utf8"), /打包快照（bundle-src） \| ✅ 一致/);
  put(join(root, "src/cli/jingjing.ts"), "改了源码没同步快照");
  const body = renderStatus(collectFacts(root));
  assert.match(body, /打包快照（bundle-src） \| ❌ .*不一致/);
  assert.equal(checkStatus(root).ok, false, "快照红了而 STATUS.md 还写着绿，必须判红");
});

test("STATUS 提交自指豁免：新提交改了 HEAD，check 不红；稳定事实漂移仍红", () => {
  const root = rig();
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", windowsHide: true });
  execFileSync("git", ["init", "-q", "-b", "main", root], { windowsHide: true });
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  writeStatus(root);
  assert.equal(checkStatus(root).ok, true);
  const headBefore = readFileSync(join(root, "STATUS.md"), "utf8").match(/\| HEAD \| `(\w+)`/)?.[1];
  assert.ok(headBefore, "夹具是真仓库，STATUS 应记 HEAD");
  git("commit", "-q", "--allow-empty", "-m", "second"); // 模拟「提交」：HEAD 变了
  assert.equal(checkStatus(root).ok, true, "HEAD 随提交变化是自指，不该判红");
  put(join(root, "src/schema.ts"), "export const SCHEMA_VERSION = 13;"); // 稳定事实漂移
  assert.equal(checkStatus(root).ok, false, "schema 变了而 STATUS 没更新，必须红");
});