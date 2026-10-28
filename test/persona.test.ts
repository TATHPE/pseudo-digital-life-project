import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersona, loadPersonaText, savePersonaFile, seedPersona } from "../src/persona.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-persona-"));

test("空 home：整套人格回落到 bundled，不返回空串", () => {
  const home = H();
  const p = loadPersona(home);
  assert.ok(p.core.length > 20, "core 不能为空");
  assert.ok(p.boundaries.length > 5);
  assert.ok(p.evidenceOrder.includes("证据优先级"));
  const all = loadPersonaText(home);
  assert.ok(Object.values(all).every((v) => v.length > 0), "六个文件都应有内容");
});

test("保存一个文件后，其余文件仍然齐全（seed + 回落）", () => {
  const home = H();
  savePersonaFile(home, "voice", "# voice\n【日常】嗯。", new Date("2026-10-28T10:00:00Z"));
  const p = loadPersona(home);
  assert.ok(p.core.length > 20, "core 不该因为只改了 voice 而变空");
  assert.match(loadPersonaText(home).voice, /【日常】嗯。/);
  assert.equal(readdirSync(join(home, "persona")).length, 7, "六个 md + versions");
});

test("seedPersona 幂等：已有的不覆盖", () => {
  const home = H();
  savePersonaFile(home, "core", "我自己的 core", new Date("2026-10-28T10:00:00Z"));
  seedPersona(home);
  assert.equal(loadPersona(home).core, "我自己的 core");
});
