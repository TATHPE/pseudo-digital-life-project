import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkDesktopBundle, syncDesktopBundle, syncIfNeeded } from "../tools/sync-desktop.ts";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const install = (stage: string) => put(join(stage, "node_modules/.package-lock.json"), "{}");
function rig() {
  const root = mkdtempSync(join(tmpdir(), "jj-bundle-"));
  put(join(root, "src/cli/jingjing.ts"), "新版中文源码");
  put(join(root, "persona/core.md"), "新版人格");
  put(join(root, "package.json"), '{"version":"0.1.1"}');
  put(join(root, "package-lock.json"), '{"lockfileVersion":3}');
  put(join(root, "desktop/src-tauri/tauri.conf.json"), '{"version":"0.1.1"}');
  put(join(root, "desktop/src-tauri/Cargo.toml"), '[package]\nversion = "0.1.1"');
  const app = join(root, "desktop/bundle-src/app");
  put(join(app, "src/old.ts"), "旧文件");
  put(join(app, "persona/persona/stale.md"), "错误嵌套");
  return { root, app };
}

test("桌面快照：完全替换旧 src/persona，包与锁同步，重复运行幂等", () => {
  const { root, app } = rig();
  assert.equal(syncDesktopBundle(root, install).files, 4);
  assert.equal(readFileSync(join(app, "src/cli/jingjing.ts"), "utf8"), "新版中文源码");
  assert.equal(existsSync(join(app, "src/old.ts")), false);
  assert.equal(existsSync(join(app, "persona/persona")), false);
  const first = readFileSync(join(app, "bundle-manifest.json"), "utf8");
  syncDesktopBundle(root, install);
  assert.equal(readFileSync(join(app, "bundle-manifest.json"), "utf8"), first);
  assert.deepEqual(readdirSync(dirname(app)), ["app"]);
});

test("syncIfNeeded：已一致时跳过，不产生千文件旧快照（构建钩子用）", () => {
  const { root, app } = rig();
  assert.equal(syncIfNeeded(root, install).skipped, false, "第一次要真同步");
  assert.equal(syncIfNeeded(root, install).skipped, true, "已一致就该跳过");
  assert.deepEqual(readdirSync(dirname(app)), ["app"], "跳过时不该留下 .stage-*-previous");
});

test("Tauri beforeBuildCommand 带 --if-needed", () => {
  const conf = JSON.parse(readFileSync(join(ROOT, "desktop/src-tauri/tauri.conf.json"), "utf8"));
  assert.match(String(conf.build?.beforeBuildCommand?.script ?? ""), /--if-needed/);
});

test("桌面快照：安装失败保留旧快照，暂存目录不残留", () => {
  const { root, app } = rig();
  assert.throws(() => syncDesktopBundle(root, () => { throw new Error("安装失败"); }), /安装失败/);
  assert.equal(readFileSync(join(app, "src/old.ts"), "utf8"), "旧文件");
  assert.deepEqual(readdirSync(dirname(app)), ["app"]);
});

test("桌面快照：版本不一致、同步中改源码或未装依赖均拒绝替换", () => {
  const { root, app } = rig();
  put(join(root, "desktop/src-tauri/Cargo.toml"), 'version = "0.1.0"');
  assert.throws(() => syncDesktopBundle(root, install), /版本不一致/);
  put(join(root, "desktop/src-tauri/Cargo.toml"), 'version = "0.1.1"');
  assert.throws(() => syncDesktopBundle(root, (stage) => {
    install(stage); put(join(root, "src/cli/jingjing.ts"), "过程中改了");
  }), /源码发生变化/);
  assert.throws(() => syncDesktopBundle(root, () => {}), /生产依赖未生成/);
  assert.ok(existsSync(join(app, "src/old.ts")));
});

test("桌面快照：只检查不修复，源码漂移或旧文件残留都判红", () => {
  const { root, app } = rig();
  syncDesktopBundle(root, install);
  put(join(app, "src/stale.ts"), "残留");
  assert.throws(() => checkDesktopBundle(root), /不一致/);
  syncDesktopBundle(root, install);
  put(join(root, "src/cli/jingjing.ts"), "修改后");
  assert.throws(() => checkDesktopBundle(root), /不一致/);
  assert.equal(readFileSync(join(app, "src/cli/jingjing.ts"), "utf8"), "新版中文源码");
});

test("桌面快照：拒绝内部 junction 和意外数据，不动链接目标", () => {
  const { root, app } = rig();
  symlinkSync(join(root, "src"), join(app, "src/linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => syncDesktopBundle(root, install), /链接/);
  assert.equal(readFileSync(join(root, "src/cli/jingjing.ts"), "utf8"), "新版中文源码");
  const other = rig();
  put(join(other.app, "data/memory.db"), "不得触碰");
  assert.throws(() => syncDesktopBundle(other.root, install), /未知内容/);
  assert.equal(readFileSync(join(other.app, "data/memory.db"), "utf8"), "不得触碰");
});

test("桌面快照：显式保留旧 app 时数据完整移到打包范围外，新快照无数据", () => {
  const { root, app } = rig();
  put(join(app, "data/memory.db"), "不得删除的数据");
  const result = syncDesktopBundle(root, install, true);
  assert.ok(result.archived?.startsWith(join(root, "tmp")));
  assert.equal(readFileSync(join(result.archived!, "data/memory.db"), "utf8"), "不得删除的数据");
  assert.equal(readFileSync(join(result.archived!, "src/old.ts"), "utf8"), "旧文件");
  assert.equal(existsSync(join(app, "data")), false);
  assert.equal(checkDesktopBundle(root).files, 4);
  syncDesktopBundle(root, install);
  assert.ok(existsSync(join(result.archived!, "data/memory.db")), "后续同步不动已保留备份");
  put(join(app, "data/accidental.txt"), "意外内容");
  assert.throws(() => checkDesktopBundle(root), /未知内容/);
});

test("桌面快照：Tauri 直接构建也走钩子，cwd 从 src-tauri 定位代码仓", () => {
  const root = resolve(import.meta.dirname, "..");
  const config = JSON.parse(readFileSync(join(root, "desktop/src-tauri/tauri.conf.json"), "utf8"));
  const hook = config.build.beforeBuildCommand;
  assert.equal(resolve(root, "desktop/src-tauri", hook.cwd), root);
  assert.equal(hook.script, "node tools/sync-desktop.ts --if-needed");
});
