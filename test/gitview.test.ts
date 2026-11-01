import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiff, gitLog, gitStatus, parsePorcelain } from "../src/gitview.ts";

const hasGit = (() => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "jj-gitview-"));
  const g = (args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, stdio: "ignore" });
  g(["init", "-b", "main"]);
  writeFileSync(join(dir, "a.txt"), "hello" + String.fromCharCode(10));
  g(["add", "."]);
  g(["commit", "-m", "first"]);
  return dir;
}

test("parsePorcelain：状态码、重命名箭头、中文路径", () => {
  const out = [
    " M src/a.ts",
    "?? new file.md",
    "A  added.md",
    "R  old/名字.txt -> new/名字.txt",
    " D gone.md",
  ].join(String.fromCharCode(10));
  const f = parsePorcelain(out);
  assert.equal(f.length, 5);
  assert.deepEqual(f[0], { x: " ", y: "M", path: "src/a.ts" });
  assert.deepEqual(f[1], { x: "?", y: "?", path: "new file.md" });
  assert.equal(f[3]!.path, "new/名字.txt");
  assert.equal(f[3]!.from, "old/名字.txt");
  assert.deepEqual(parsePorcelain(""), []);
});

test("git status / diff / log：在真仓库上看得到改动", { skip: !hasGit }, async () => {
  const dir = repo();
  try {
    const clean = await gitStatus(dir);
    assert.equal(clean.ok, true);
    if (clean.ok) {
      assert.equal(clean.data.clean, true);
      assert.equal(clean.data.branch, "main");
    }
    writeFileSync(join(dir, "a.txt"), "hello" + String.fromCharCode(10) + "world" + String.fromCharCode(10));
    writeFileSync(join(dir, "b.txt"), "new" + String.fromCharCode(10));
    const st = await gitStatus(dir);
    assert.equal(st.ok, true);
    if (st.ok) {
      assert.equal(st.data.clean, false);
      assert.ok(st.data.files.some((f) => f.path === "a.txt"));
      assert.ok(st.data.files.some((f) => f.path === "b.txt"));
    }
    const stat = await gitDiff(dir);
    assert.equal(stat.ok, true);
    if (stat.ok) {
      assert.equal(stat.data.stat, true, "不给 path 就是 --stat 摘要");
      assert.match(stat.data.text, /a\.txt/);
    }
    const one = await gitDiff(dir, "a.txt");
    assert.equal(one.ok, true);
    if (one.ok) {
      assert.equal(one.data.stat, false);
      assert.match(one.data.text, /\+world/, "完整 diff 里要能看到加的那行");
    }
    const log = await gitLog(dir, 5);
    assert.equal(log.ok, true);
    if (log.ok) assert.match(log.data.text, /first/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("git diff：文件名当路径用，选项注入与 .. 穿越一律拒", { skip: !hasGit }, async () => {
  const dir = repo();
  try {
    for (const bad of ["--upload-pack=evil", "-c core.pager=cat", "../../etc/passwd", ""]) {
      const r = await gitDiff(dir, bad);
      if (bad === "") continue;   // 空字符串等于"没给 path" → 走 stat，不应该报错
      assert.equal(r.ok, false, bad + " 应该被拒");
      if (!r.ok) assert.equal(r.code, "E_BAD_PATH");
    }
    const empty = await gitDiff(dir, "");
    assert.equal(empty.ok, true, "空 path 当没给");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("不是 git 仓库时给人话，而不是抛原始 stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jj-nogit-"));
  try {
    mkdirSync(join(dir, "sub"), { recursive: true });
    const r = await gitStatus(join(dir, "sub"));
    if (!hasGit) { assert.equal(r.ok, false); return; }
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "E_NOT_A_REPO");
      assert.match(r.why, /不是 git 仓库/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
