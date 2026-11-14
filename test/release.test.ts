/**
 * 发布与更新的纯函数闸门（2026-11-14 P2 产品化）。
 * 守住三件事：六处版本号不能漂、更新检查不能联网/下载、产物哈希必须核得出来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  UPDATE_POLICY, appVersion, checkUpdate, checkVersionConsistency, compareVersions,
  diffDataSnapshots, isIgnoredDataPath, releaseInfo, verifyArtifact, versionSources,
  type DataSnapshot, type ReleaseManifest,
} from "../src/release.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const fixture = (cargoVersion: string) => {
  const root = mkdtempSync(join(tmpdir(), "jj-release-"));
  mkdirSync(join(root, "desktop", "src-tauri"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3", engines: { node: ">=24" } }));
  writeFileSync(join(root, "desktop", "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(root, "desktop", "src-tauri", "Cargo.toml"), `[package]\nversion = "${cargoVersion}"\n`);
  writeFileSync(join(root, "src", "capabilities.ts"), 'const VERSION = "1.2.3";');
  writeFileSync(join(root, "src", "mcp.ts"), 'clientInfo: { name: "jingjing", version: "1.2.3" },');
  writeFileSync(join(root, "README.md"), "- **Not a mature product**: 1.2.3, built and used by one person");
  return root;
};

test("六处版本号逐字一致（发布闸门）", () => {
  const c = checkVersionConsistency(ROOT);
  assert.equal(c.sources.length, 6);
  assert.equal(c.ok, true, JSON.stringify(c.mismatches));
  assert.equal(c.version, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
});

test("漏改一处（Cargo.toml）→ 判红并精确指出文件", () => {
  const root = fixture("1.2.2");
  try {
    const c = checkVersionConsistency(root);
    assert.equal(c.ok, false);
    assert.deepEqual(c.mismatches.map((m) => m.file), ["desktop/src-tauri/Cargo.toml"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("六处全齐时一致；缺文件标 missing 而不是静默放过", () => {
  const root = fixture("1.2.3");
  try {
    assert.equal(checkVersionConsistency(root).ok, true);
    rmSync(join(root, "src", "mcp.ts"));
    const s = versionSources(root).find((x) => x.file === "src/mcp.ts");
    assert.equal(s?.missing, true);
    assert.equal(checkVersionConsistency(root).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compareVersions：三段比较，非法版本抛错", () => {
  assert.equal(compareVersions("0.1.2", "0.1.1"), 1);
  assert.equal(compareVersions("0.1.1", "0.2.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.throws(() => compareVersions("0.1", "0.1.1"), /E_BAD_VERSION/);
});

const mf = (version: string): ReleaseManifest => ({
  version, releasedAt: "2026-11-14T00:00:00.000Z", minNode: ">=24",
  changelog: "CHANGELOG.md", notes: "修了开机启动", downloadUrl: "https://example.invalid/jj.exe",
  artifacts: [{ name: "jj.exe", sha256: "a".repeat(64), size: 123 }],
});

test("checkUpdate：只比较、不外联；新版给哈希与地址，旧版/同版不提示", () => {
  const newer = checkUpdate("0.1.1", mf("0.1.2"));
  assert.equal(newer.hasUpdate, true);
  assert.equal(newer.policy, UPDATE_POLICY);
  assert.equal(newer.sha256, "a".repeat(64));
  assert.equal(newer.downloadUrl, "https://example.invalid/jj.exe");
  assert.equal(checkUpdate("0.1.2", mf("0.1.2")).hasUpdate, false);
  assert.equal(checkUpdate("0.1.3", mf("0.1.2")).hasUpdate, false);
  assert.equal(checkUpdate("0.1.1", null).hasUpdate, false, "坏清单不该带崩面板");
  assert.equal(checkUpdate("0.1.1", { ...mf("9.9.9"), version: "bad" }).hasUpdate, false);
});

test("verifyArtifact：哈希对得上才放行（大小写不敏感）", () => {
  const root = mkdtempSync(join(tmpdir(), "jj-release-"));
  try {
    const p = join(root, "payload.bin");
    writeFileSync(p, "hello");
    const sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    assert.equal(verifyArtifact(p, sha), true);
    assert.equal(verifyArtifact(p, sha.toUpperCase()), true);
    assert.equal(verifyArtifact(p, "f".repeat(64)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("releaseInfo 自报家门：版本与 package.json 一致、策略是人工校验", () => {
  const info = releaseInfo();
  assert.equal(info.version, appVersion());
  assert.equal(info.updatePolicy, "manual-verified");
  assert.equal(info.minNode, ">=24");
  assert.match(info.node, /^v\d+/);
});

/* ── 覆盖安装前后的数据目录指纹（2026-11-14，学自 dsh-world update-world.mjs）── */
const fp = (sha: string, size = 100) => ({ sha256: sha, size });
const snap = (files: DataSnapshot["files"], root = "D:/Pseudo Digital Life Project/data"): DataSnapshot => ({
  version: 1, root, takenAt: "2026-11-14T00:00:00.000Z", files,
});

test("数据指纹：逐文件一致才放行", () => {
  const a = snap({ "memory.db": fp("a".repeat(64)), "persona/core.md": fp("b".repeat(64)) });
  const d = diffDataSnapshots(a, snap({ "memory.db": fp("a".repeat(64)), "persona/core.md": fp("b".repeat(64)) }));
  assert.equal(d.ok, true);
  assert.deepEqual(d.violations, []);
});

test("数据指纹：memory.db 被改写 → 判红并点名", () => {
  const a = snap({ "memory.db": fp("a".repeat(64)), "persona/core.md": fp("b".repeat(64)) });
  const d = diffDataSnapshots(a, snap({ "memory.db": fp("c".repeat(64)), "persona/core.md": fp("b".repeat(64)) }));
  assert.equal(d.ok, false);
  assert.deepEqual(d.changed, ["memory.db"]);
  assert.match(d.violations[0]!, /memory\.db/);
});

test("数据指纹：日志 / WAL / 临时文件 / 启动指针按白名单忽略", () => {
  const a = snap({ "shell.log": fp("a".repeat(64)), "memory.db-wal": fp("b".repeat(64)), "data/.desk.json": fp("c".repeat(64)) });
  const b = snap({ "shell.log": fp("x".repeat(64)), "memory.db-wal": fp("y".repeat(64)), "data/.desk.json": fp("z".repeat(64)) });
  const d = diffDataSnapshots(a, b);
  assert.equal(d.ok, true);
  assert.equal(d.ignored.length, 3);
  assert.equal(isIgnoredDataPath("serve.log"), true);
  assert.equal(isIgnoredDataPath("memory.db"), false);
});

test("数据指纹：多出 / 少了关键文件、目录不一致都判红", () => {
  const a = snap({ "memory.db": fp("a".repeat(64)) });
  const d = diffDataSnapshots(a, snap({ "inbox/new.txt": fp("b".repeat(64)) }));
  assert.equal(d.ok, false);
  assert.deepEqual(d.added, ["inbox/new.txt"]);
  assert.deepEqual(d.removed, ["memory.db"]);
  const e = diffDataSnapshots(a, snap({ "memory.db": fp("a".repeat(64)) }, "E:/other"));
  assert.equal(e.ok, false);
  assert.match(e.violations[0]!, /不一致/);
});

test("数据指纹：白名单不能把关键数据也放行", () => {
  const a = snap({ "memory.db": fp("a".repeat(64)) });
  assert.equal(diffDataSnapshots(a, snap({ "memory.db": fp("b".repeat(64)) }), []).ok, false);
});
