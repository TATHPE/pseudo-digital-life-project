/**
 * 卸载守卫（2026-11-14 P2 产品化）：NSIS 会沿 junction 递归删目录，
 * 所以卸载前必须能把它扫出来，并且守卫自己一个字节都不能删。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessUninstall, dataInsideInstall, scanLinks } from "../tools/uninstall-guard.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "jj-uninstall-"));
const clean = (p: string) => rmSync(p, { recursive: true, force: true });

test("干净的安装目录：无链接、无内嵌数据 → 可以卸载", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "app", "src"), { recursive: true });
    writeFileSync(join(root, "app", "src", "a.ts"), "x");
    const a = assessUninstall(root);
    assert.deepEqual(a.links, []);
    assert.deepEqual(a.dataInside, []);
    assert.equal(a.safe, true);
    assert.ok(a.advice.some((s) => s.includes("外部数据目录")));
  } finally { clean(root); }
});

test("junction 被报出来（且不会跟随进去扫），守卫判红并给回滚步骤", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "outside"), { recursive: true });
    writeFileSync(join(root, "outside", "keep.ts"), "x");
    mkdirSync(join(root, "app"), { recursive: true });
    try {
      symlinkSync(join(root, "outside"), join(root, "app", "src"),
        process.platform === "win32" ? "junction" : "dir");
    } catch { return; } // 无权限建链接的环境跳过这条（CI 上其余断言仍守着）
    const links = scanLinks(root);
    assert.ok(links.some((l) => l.endsWith("app/src")), JSON.stringify(links));
    assert.ok(!links.some((l) => l.includes("outside/keep.ts")), "不许跟随链接进去");
    const a = assessUninstall(root);
    assert.equal(a.safe, false);
    assert.ok(a.advice.some((s) => s.includes("Rename-Item")));
    assert.ok(existsSync(join(root, "outside", "keep.ts")), "守卫只读，不能删目标");
  } finally { clean(root); }
});

test("数据躺在安装目录里 → 判红（卸载会一起删）", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "memory.db"), "x");
    assert.deepEqual(dataInsideInstall(root), ["data"]);
    const a = assessUninstall(root);
    assert.equal(a.safe, false);
    assert.ok(a.advice.some((s) => s.includes("导出备份")));
  } finally { clean(root); }
});
