/**
 * 她写文件 → 自动一版 git 提交（学自 Coopanion 的 commitAllAsync）。
 * 审计告诉你"她写过"，git 才拿得回原文。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { autoCommit, isGitRepo } from "../src/autocommit.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("写文件留一版：作者是她，能 rev-parse 出来", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jj-git-"));
  try {
    git(dir, "init", "-q");
    writeFileSync(join(dir, "a.txt"), "第一版\n");
    const r1 = await autoCommit(dir, "a.txt", "写了", "小满");
    assert.ok(r1.hash, "第一次要留下版本");
    assert.match(git(dir, "log", "-1", "--pretty=%an %s"), /小满 写了 a\.txt/);

    // 内容没变 → 不该产生空提交
    const r2 = await autoCommit(dir, "a.txt", "写了", "小满");
    assert.equal(r2.hash, null);
    assert.equal(r2.why, "no_change");

    // 改了 → 新的一版
    writeFileSync(join(dir, "a.txt"), "第二版\n");
    const r3 = await autoCommit(dir, "a.txt", "写了", "小满");
    assert.ok(r3.hash);
    assert.equal(git(dir, "rev-list", "--count", "HEAD"), "2");
    assert.equal(git(dir, "show", "HEAD:a.txt"), "第二版");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("不是 git 仓库就不做，也不报错（不能因为没配 git 就写不了文件）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jj-nogit-"));
  try {
    assert.equal(isGitRepo(dir), false);
    writeFileSync(join(dir, "a.txt"), "x");
    const r = await autoCommit(dir, "a.txt", "写了");
    assert.equal(r.hash, null);
    assert.equal(r.why, "not_a_repo");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("只 add 那一个路径：别人工作区里的改动不许卷进来", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jj-git2-"));
  try {
    git(dir, "init", "-q");
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, "add", "a.txt", "b.txt"); git(dir, "commit", "-qm", "init");

    writeFileSync(join(dir, "a.txt"), "a2\n");
    writeFileSync(join(dir, "b.txt"), "b2（别人的改动）\n");
    await autoCommit(dir, "a.txt", "写了", "小满");

    // b.txt 应该还留在工作区未提交
    assert.equal(git(dir, "status", "--porcelain"), "M b.txt");
    assert.equal(git(dir, "show", "HEAD:b.txt"), "b");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
