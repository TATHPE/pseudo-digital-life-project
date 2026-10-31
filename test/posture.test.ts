import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { applyDefaultPosture } from "../src/posture.ts";
import { currentPreset, setPreset } from "../src/grant.ts";
import { egressStatus } from "../src/egress.ts";
import { isCorePath, coreLabel } from "../src/coreguard.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-posture-"));

test("默认姿态：开箱就是 write + 外发开放（不残疾）", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const r = applyDefaultPosture(d.db, home, { env: {} });
  assert.equal(r.preset, "write");
  assert.equal(r.presetApplied, true);
  assert.equal(currentPreset(home).preset, "write");
  assert.equal(egressStatus(home, { env: {} }).until !== null, true, "外发默认开放");
});

test("默认姿态：JJ_PARANOID=1 回到「什么都问」", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const r = applyDefaultPosture(d.db, home, { env: { JJ_PARANOID: "1" } });
  assert.equal(r.preset, "ask");
  assert.equal(currentPreset(home).preset, "ask");
});

test("默认姿态：用户手动切过的档不被覆盖", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  setPreset(home, "read", {});
  const r = applyDefaultPosture(d.db, home, { env: {} });
  assert.equal(r.presetApplied, false, "已经有窗口就不动");
  assert.equal(currentPreset(home).preset, "read", "用户的选择优先");
});

test("记忆核心：数据库/密钥/人格/事件流 一律受保护，其余放行", () => {
  const home = H();
  mkdirSync(join(home, "workspace"), { recursive: true });
  mkdirSync(join(home, "persona"), { recursive: true });
  writeFileSync(join(home, "memory.db"), "x");
  writeFileSync(join(home, "persona", "core.md"), "x");

  for (const p of ["memory.db", "memory.db-wal", "persona/core.md", "inbox/2026-10-31.jsonl", "secrets/deepseek.json", "trash/a.md"]) {
    assert.equal(isCorePath(home, join(home, p)), true, p + " 应当受保护");
  }
  for (const p of ["workspace/a.md", "docs/01.md", "config.json", "sources/x.pdf", "notes.txt"]) {
    assert.equal(isCorePath(home, join(home, p)), false, p + " 应当可动");
  }
  assert.equal(coreLabel("memory.db"), "记忆库本体");
  assert.equal(coreLabel("persona/core.md"), "人格设定");
  void existsSync;
});

test("记忆核心：`data/` 前缀也要认（home 可能有一层 data/）", () => {
  const home = H();
  mkdirSync(join(home, "data", "persona"), { recursive: true });
  writeFileSync(join(home, "data", "memory.db"), "x");
  writeFileSync(join(home, "data", "persona", "core.md"), "x");
  assert.equal(isCorePath(home, join(home, "data/memory.db")), true);
  assert.equal(isCorePath(home, join(home, "data/persona/core.md")), true);
});
