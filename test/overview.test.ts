/**
 * 状态总览（阶段 1）纯函数闸门（2026-11-15）。
 * 守住四件事：扫描不跟随链接、上限要如实标不完整、能力五态不误报、
 * WSL 永远如实标「未探测」（绝不在这个模块里 spawn wsl.exe）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseConfig } from "../src/config.ts";
import type { Capabilities } from "../src/capabilities.ts";
import {
  buildOverview, capabilityRows, checkRows, classifyPath, humanBytes,
  modelRows, scanHome, type OverviewInput,
} from "../src/overview.ts";

const OLLAMA = "http://127.0.0.1:11434";
const EMPTY_SCAN = { groups: [], totalBytes: 0, totalFiles: 0, truncated: false, depthLimited: 0 };

function mkCaps(patch: Partial<Capabilities> = {}): Capabilities {
  return {
    version: "0.1.1",
    schema: null,
    classes: { tool: [], command: [], hook: [], cron: [], panel: [], provider: [] },
    providers: {
      roles: [
        { role: "express", kind: "cloud", provider: "deepseek", model: "deepseek-flash", source: "default" },
        { role: "embed", kind: "local", provider: "ollama", model: "bge-m3", source: "default" },
      ],
      ollama: { base: OLLAMA, online: false, models: [] },
    },
    degraded: [],
    notes: [],
    ...patch,
  };
}

function mkInput(patch: Partial<OverviewInput> = {}): OverviewInput {
  return {
    cfg: baseConfig(),
    file: {},
    sources: {},
    caps: mkCaps(),
    secrets: {},
    beatRunning: false,
    beatConfigured: false,
    memory: { total: 0, added7d: 0 },
    usage: { todayUsd: 0, calls: 0, inTokens: 0, outTokens: 0 },
    proc: { rss: 1000, heapUsed: 500, external: 10, uptimeS: 1, node: "v24.0.0", pid: 1 },
    scan: EMPTY_SCAN,
    ollamaProbed: false,
    ...patch,
  };
}

test("classifyPath：按顶层第一段归类，db-wal 归到记忆库", () => {
  assert.equal(classifyPath("memory.db").key, "memory");
  assert.equal(classifyPath("memory.db-wal").key, "memory");
  assert.equal(classifyPath("memory.db-shm").key, "memory");
  assert.equal(classifyPath("pal/avatars/u-1/x.moc3").key, "pal");
  assert.equal(classifyPath("tts/model/v.onnx").key, "tts");
  assert.equal(classifyPath("workspace\\captures\\a.png").key, "workspace");
  assert.equal(classifyPath("config.json").key, "other");
  assert.equal(classifyPath("wsl/snapshots/a.tar").key, "snapshots");
});

test("scanHome：分类统计体积与文件数，目录不存在返回空快照", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-overview-"));
  try {
    mkdirSync(join(home, "pal"));
    mkdirSync(join(home, "tts"));
    writeFileSync(join(home, "memory.db"), "abcd");
    writeFileSync(join(home, "memory.db-wal"), "123456");
    writeFileSync(join(home, "pal", "a.png"), "x");
    writeFileSync(join(home, "tts", "b.onnx"), "xx");
    const s = scanHome(home);
    assert.equal(s.totalFiles, 4);
    assert.equal(s.totalBytes, 13);
    assert.equal(s.truncated, false);
    assert.equal(s.groups.find((g) => g.key === "memory")?.bytes, 10);
    assert.equal(s.groups.find((g) => g.key === "pal")?.files, 1);
    // 按体积降序，最大的排最前
    assert.equal(s.groups[0]?.key, "memory");
    assert.deepEqual(scanHome(join(home, "不存在")), EMPTY_SCAN);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanHome：junction / symlink 不跟随，也不计入体积", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-overview-link-"));
  const outside = mkdtempSync(join(tmpdir(), "jj-overview-out-"));
  try {
    writeFileSync(join(home, "memory.db"), "abcd");
    writeFileSync(join(outside, "big.bin"), "x".repeat(1000));
    try { symlinkSync(outside, join(home, "linked"), "junction"); }
    catch { /* 少数 Windows 环境不给建 junction；此时下面的断言退化为普通扫描 */ }
    const s = scanHome(home);
    assert.equal(s.totalFiles, 1, "链接目标的文件不能被算进来");
    assert.equal(s.totalBytes, 4, "链接目标的体积不能被算进来");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("scanHome：超过文件上限要如实标 truncated，不能把不完整当完整", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-overview-cap-"));
  try {
    for (let i = 0; i < 6; i++) writeFileSync(join(home, `f${i}.txt`), "x");
    const s = scanHome(home, { maxFiles: 2 });
    assert.equal(s.truncated, true);
    assert.ok(s.totalFiles <= 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanHome：一棵子树超深度只跳过它本身，不能把整轮扫描停掉", () => {
  const home = mkdtempSync(join(tmpdir(), "jj-overview-depth-"));
  try {
    // aaa 是深链，字典序在前：若深度超限被当成「整轮停止」，后面的 zzz 就读不到
    mkdirSync(join(home, "aaa", "b", "c"), { recursive: true });
    writeFileSync(join(home, "aaa", "one.txt"), "1");
    writeFileSync(join(home, "aaa", "b", "two.txt"), "22");
    writeFileSync(join(home, "aaa", "b", "c", "deep.txt"), "333");
    mkdirSync(join(home, "zzz"));
    writeFileSync(join(home, "zzz", "late.txt"), "4444");
    writeFileSync(join(home, "root.txt"), "55555");

    const s = scanHome(home, { maxDepth: 2 });
    assert.equal(s.totalFiles, 4, "深层树被跳过，但同级的 zzz 与根目录文件必须照常统计");
    assert.equal(s.totalBytes, 1 + 2 + 4 + 5);
    assert.equal(s.truncated, true, "有子树被深度跳过，结果不完整要如实标");
    assert.equal(s.depthLimited, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("capabilityRows：默认状态下未启用/缺模型/需开闸都如实列出，不隐藏", () => {
  const rows = capabilityRows(mkInput());
  const by = Object.fromEntries(rows.map((r) => [r.id, r.state]));
  assert.equal(by.heartbeat, "off");
  assert.equal(by.vision, "missing");
  assert.equal(by.wsl, "unknown");
  assert.equal(by.express, "gated");
  assert.equal(by.embed, "missing");
  assert.equal(by["local-chat"], "off");
  assert.equal(by.night, "enabled");
  assert.equal(by["update-check"], "enabled");
  // 缺环境的能力必须给安装引导（用户决策 5）
  assert.match(rows.find((r) => r.id === "vision")?.installHint ?? "", /ollama pull qwen2\.5vl:3b/);
  assert.match(rows.find((r) => r.id === "wsl")?.installHint ?? "", /jingjing wsl setup/);
  // 开关写的是**配置键**（ui.beat），命令行参数那条路保留但不再是唯一入口（2026-11-15 决策 2）
  assert.equal(rows.find((r) => r.id === "heartbeat")?.toggleKey, "ui.beat");
  assert.equal(rows.find((r) => r.id === "heartbeat")?.restartRequired, true);
});

test("capabilityRows：装齐模型、登记密钥、带 --beat 后转为 enabled", () => {
  const caps = mkCaps({
    providers: {
      roles: mkCaps().providers.roles,
      ollama: { base: OLLAMA, online: true, models: ["qwen2.5vl:3b", "bge-m3", "qwen2.5:7b-instruct"] },
    },
  });
  const rows = capabilityRows(mkInput({
    caps,
    secrets: { deepseek: true },
    beatRunning: true,
    file: { local: { default: "qwen2.5:7b-instruct" } },
  }));
  const by = Object.fromEntries(rows.map((r) => [r.id, r.state]));
  assert.equal(by.heartbeat, "enabled");
  assert.equal(by.vision, "enabled");
  assert.equal(by.express, "enabled");
  assert.equal(by.embed, "enabled");
  assert.equal(by["local-chat"], "enabled");
  assert.equal(by.wsl, "unknown", "WSL 不因为别的就绪就假称可用");
});

test("capabilityRows：配置开了心跳但进程没重启 → 不许报「已启用」", () => {
  const rows = capabilityRows(mkInput({ beatConfigured: true, beatRunning: false }));
  const hb = rows.find((r) => r.id === "heartbeat");
  assert.equal(hb?.state, "off", "写进配置不等于正在跑，谎报成 enabled 就是骗人");
  assert.ok(hb?.detail.includes("重启"), "要说清重启才生效");
  assert.equal(hb?.restartRequired, true);
  assert.equal(hb?.toggleKey, "ui.beat", "开关写的是配置键，不是命令行参数");

  const running = capabilityRows(mkInput({ beatConfigured: true, beatRunning: true })).find((r) => r.id === "heartbeat");
  assert.equal(running?.state, "enabled");
  assert.ok(!running?.detail.includes("重启"));
});

test("capabilityRows：WSL 无论如何都不做探测结论，且永远给安装引导", () => {
  for (const input of [mkInput(), mkInput({ file: { wsl: { autonomous: true } }, beatRunning: true })]) {
    const wsl = capabilityRows(input).find((r) => r.id === "wsl");
    assert.equal(wsl?.state, "unknown");
    assert.ok(wsl?.detail.includes("不执行 wsl.exe"));
    assert.ok(wsl?.installHint);
  }
});

test("checkRows：从能力行派生 7 项，带跳转目标与修复提示", () => {
  const checks = checkRows(capabilityRows(mkInput()));
  assert.equal(checks.length, 7);
  assert.ok(checks.every((c) => c.detail), "每项都要有说明");
  assert.equal(checks.find((c) => c.id === "heartbeat")?.target, "", "心跳的开关在本页，不该给「去设置」");
  // 已就绪的项不挂安装提示（挂就是噪音）：给一个装了 bge-m3 的环境
  const withEmbed = checkRows(capabilityRows(mkInput({
    caps: mkCaps({ providers: { roles: mkCaps().providers.roles, ollama: { base: OLLAMA, online: true, models: ["bge-m3"] } } }),
  })));
  assert.equal(withEmbed.find((c) => c.id === "embed")?.state, "enabled");
  assert.equal(withEmbed.find((c) => c.id === "embed")?.hint, undefined);
  assert.equal(checks.find((c) => c.id === "express")?.target, "接口 · 云端");
  assert.ok(checks.find((c) => c.id === "vision")?.hint);
});

test("modelRows：本地与云端共用一张表，缺模型/缺密钥分别标 missing / gated", () => {
  const rows = modelRows(mkInput());
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.purpose, "日常对话");
  assert.equal(rows[0]?.side, "云端");
  assert.equal(rows[0]?.state, "gated");
  assert.equal(rows[0]?.source, "default");
  assert.equal(rows[1]?.purpose, "向量嵌入");
  assert.equal(rows[1]?.side, "本地");
  assert.equal(rows[1]?.state, "missing");

  const ok = modelRows(mkInput({
    secrets: { deepseek: true },
    caps: mkCaps({
      providers: { roles: mkCaps().providers.roles, ollama: { base: OLLAMA, online: true, models: ["bge-m3"] } },
    }),
  }));
  assert.equal(ok[0]?.state, "enabled");
  assert.equal(ok[1]?.state, "enabled");
});

test("buildOverview：只做当前快照，输出不含密钥值，边界写进 notes", () => {
  const o = buildOverview(mkInput({ now: new Date("2026-11-15T08:00:00.000Z"), memory: { total: 42, added7d: 3 } }));
  assert.equal(o.generatedAt, "2026-11-15T08:00:00.000Z");
  assert.equal(o.resources.process.rss, 1000);
  assert.equal(o.counters.memories, 42);
  assert.equal(o.counters.added7d, 3);
  assert.ok(o.capabilities.length >= 10);
  assert.ok(o.checks.length > 0 && o.models.length > 0);
  assert.ok(o.notes.some((n) => n.includes("不访问外网")));
  assert.ok(o.notes.some((n) => n.includes("未做发行版探测")));
  assert.ok(o.notes.some((n) => n.includes("全部列出")));
  const text = JSON.stringify(o);
  assert.ok(!text.includes("sk-") && !text.includes("ghp_"), "不能把密钥值带进输出");
});

test("humanBytes：边界与单位", () => {
  assert.equal(humanBytes(0), "0 B");
  assert.equal(humanBytes(1023), "1023 B");
  assert.equal(humanBytes(1024), "1.0 KB");
  assert.equal(humanBytes(58 * 1024 * 1024), "58.0 MB");
});
