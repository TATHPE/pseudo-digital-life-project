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

test("默认姿态：开箱就是 full + 外发开放（不残疾）", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const r = applyDefaultPosture(d.db, home, { env: {} });
  // 2026-11-01：write → full（开箱能跑任意命令；记忆核心与硬禁名单仍拒）
  assert.equal(r.preset, "full");
  assert.equal(r.presetApplied, true);
  assert.equal(currentPreset(home).preset, "full");
  assert.equal(egressStatus(home, { env: {} }).until !== null, true, "外发默认开放");
});

test("默认姿态：JJ_PARANOID=1 回到「什么都问」", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const r = applyDefaultPosture(d.db, home, { env: { JJ_PARANOID: "1" } });
  assert.equal(r.preset, "ask");
  assert.equal(currentPreset(home).preset, "ask");
});

test("默认姿态：永远 full（2026-11-04 档位 UI 删了）", () => {
  // 用户当时说「把哪些限制档和确认档删了」「去掉」。
  // 旧的 read 档不再被尊重：UI 没了以后也没办法改回来，尊重它等于把她永久锁死。
  const home = H();
  const d = openDb(join(home, "m.db"));
  setPreset(home, "read", { because: "假装用户上次选了只读" });
  const r = applyDefaultPosture(d.db, home, { env: {} });
  assert.equal(r.preset, "full", "启动就拉到 full");
  assert.equal(currentPreset(home).preset, "full");
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
