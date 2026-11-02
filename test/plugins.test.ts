import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ID_RE, addMcpServer, removeMcpServer, writeSkill, removeSkill, installedPlugins,
} from "../src/plugins.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-plug-"));

test("id 白名单：只收小写字母/数字/_/-，路径一律由我们拼", () => {
  for (const ok of ["markitdown", "weekly-recap", "a1", "x_y"]) assert.ok(ID_RE.test(ok), ok);
  for (const bad of ["../evil", "a/b", "中文", "A-B", "", "-x", "x".repeat(41), "a b", "a.b"]) {
    assert.equal(ID_RE.test(bad), false, bad + " 不该通过");
  }
});

test("插件：加 → 落盘 → 列出来 → 删", () => {
  const home = H();
  const add = addMcpServer(home, { name: "markitdown", command: "D:/tools/md.exe", args: ["--stdio"], tools: ["convert"] });
  assert.equal(add.ok, true);
  const cfg = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8"));
  assert.equal(cfg.servers.markitdown.command, "D:/tools/md.exe");
  assert.deepEqual(cfg.servers.markitdown.args, ["--stdio"]);
  assert.equal(cfg.servers.markitdown.trust, "local", "默认 local");
  assert.match(cfg.servers.markitdown.trust, /local/);

  const list = installedPlugins(home);
  assert.equal(list.servers.length, 1);
  assert.equal(list.servers[0]!.tools, 1);

  const dup = addMcpServer(home, { name: "markitdown", command: "x" });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.code, "E_EXISTS");

  const del = removeMcpServer(home, "markitdown");
  assert.equal(del.ok, true);
  assert.deepEqual(installedPlugins(home).servers, []);
  const again = removeMcpServer(home, "markitdown");
  assert.equal(again.ok, false);
});

test("插件：命令里的引号/换行、坏名字都拒（不是靠前端）", () => {
  const home = H();
  for (const bad of [
    { name: "x", command: "cmd\" /c run" },
    { name: "x", command: "line" + String.fromCharCode(10) + "break" },
    { name: "x", command: "" },
    { name: "../x", command: "ok.exe" },
  ]) {
    const r = addMcpServer(home, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal(addMcpServer(home, { name: "x", args: ["a" + String.fromCharCode(10)], command: "ok.exe" }).ok, false);
});

test("技能：写 → 能扫到 → 覆盖留 .bak → 删", async () => {
  const home = H();
  const body = ["---", "name: 周末回顾", "description: 只讲变了的地方。", "---", "", "# 步骤", "1. 找这一周"].join(String.fromCharCode(10));
  const w = writeSkill(home, { id: "weekly-recap", content: body });
  assert.equal(w.ok, true);
  const file = join(home, "skills", "weekly-recap", "SKILL.md");
  assert.ok(existsSync(file));

  const { scanSkills } = await import("../src/skills.ts");
  const found = scanSkills(home, { env: { AGENTS_HOME: join(home, "nope") } });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.description, "只讲变了的地方。");

  const again = writeSkill(home, { id: "weekly-recap", content: body + String.fromCharCode(10) + "2. 压成三句" });
  assert.equal(again.ok, true);
  assert.ok(existsSync(file + ".bak"), "覆盖时旧版留 .bak");

  assert.equal(removeSkill(home, "weekly-recap").ok, true);
  assert.equal(existsSync(join(home, "skills", "weekly-recap")), false);
  assert.equal(removeSkill(home, "weekly-recap").ok, false);
});

test("技能：空内容 / 超大 / 坏名字都拒", () => {
  const home = H();
  assert.equal(writeSkill(home, { id: "x", content: "   " }).ok, false);
  assert.equal(writeSkill(home, { id: "../x", content: "hi" }).ok, false);
  const huge = "y".repeat(70 * 1024);
  const r = writeSkill(home, { id: "big", content: huge });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "E_TOO_BIG");
});

test("删技能只删这个目录，不碰别的", () => {
  const home = H();
  mkdirSync(join(home, "skills", "keep"), { recursive: true });
  writeFileSync(join(home, "skills", "keep", "SKILL.md"), "# keep", "utf8");
  writeSkill(home, { id: "drop", content: "# drop" });
  removeSkill(home, "drop");
  assert.deepEqual(readdirSync(join(home, "skills")), ["keep"]);
});

test("待生效：磁盘上的 mcp.json 改了、进程里还是旧的 —— 要看得出来", async () => {
  // 学自 Coopanion：装完扩展先进【待生效】，重启进程才生效。
  // 我们之前只写了一句"不假装已生效"，但**没人算过到底生没生效**。
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mcpFingerprint } = await import("../src/plugins.ts");

  const home = mkdtempSync(join(tmpdir(), "jj-mcp-"));
  try {
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ servers: { a: { command: "x" } } }));
    const before = mcpFingerprint(home);
    assert.ok(before, "算得出指纹");

    // 进程里加载的是 before；磁盘被改成两份配置
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ servers: { a: { command: "x" }, b: { command: "y" } } }));
    const after = mcpFingerprint(home);
    assert.notEqual(after, before, "改了就要对不上（→ mcp-restart-needed）");

    // 内容一样但重写一次：指纹应当稳定（不然每次保存都报待生效）
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ servers: { a: { command: "x" }, b: { command: "y" } } }));
    assert.equal(mcpFingerprint(home), after, "同样的内容指纹要稳定");
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
