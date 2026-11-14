/**
 * A/B 双槽回滚「可复跑」演练（补上 docs/ops/26 §5 记着的「A/B 双槽回滚实测」）。
 *
 * 复用发布级 A/B 槽的现有函数，**不重写回滚逻辑**：
 *   src/deploy/slot.ts      installRelease / activate / applyRelease / readState / hasRelease / releaseDir
 *   src/deploy/watchdog.ts  bootAttempt / markHealthy / tick（= CLI 里的 deployTick，看门狗自动回滚）
 * （注：applyRelease / deployTick 就在这两个文件里；src/selfupdate.ts 是另一套「技能级」A/B 槽，
 *  与本演练的看门狗自动回滚不是同一条链路，故这里复用真正承载自动回滚的 deploy 模块。）
 *
 * 流程（全部在 mkdtempSync 建的临时 home 里，跑完 rmSync 清理）：
 *   写用户数据 → 写槽 A → 应用 A → 上报健康(lastHealthy)
 *   → 造出 B 并应用（live 人格从 A 变成 B 的内容）
 *   → 制造失败条件：用 B 启动(bootAttempt) 但不上报健康 → 观察窗口到期
 *   → 触发看门狗自动回滚 tick(force) → applyRelease(回滚目标 = A)
 *   → 断言：active 回到 A、live 人格逐字回到 A 的内容、用户数据文件没被删、失败的 B 保留现场
 *
 * 直接跑：node --experimental-strip-types tools/rollback-e2e.ts   （成功 0 / 失败 1）
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedPersona } from "../src/persona.ts";
import { openDb } from "../src/db.ts";
import {
  activate, applyRelease, hasRelease, installRelease, readState, releaseDir,
} from "../src/deploy/slot.ts";
import { bootAttempt, markHealthy, tick as deployTick } from "../src/deploy/watchdog.ts";

const T0 = new Date("2026-11-14T12:00:00Z");
const POLICY = { deadlineMs: 10 * 60_000, freezeMs: 24 * 3_600_000, maxStreak: 2 };

/** 不在发布载荷内、回滚绝不该碰的用户数据文件（path → 原始内容）。 */
function seedUserData(home: string): Record<string, string> {
  const files: Record<string, string> = {
    [join(home, "inbox", "keep.md")]: "用户写的一封信：别删我。",
    [join(home, "secrets", "api-key.txt")]: "user-secret-0123456789",
    [join(home, "data", "notes.json")]: '{"keep":true,"memo":"升级/回滚都不该动"}',
  };
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf8");
  }
  return files;
}

export interface DrillResult {
  a: string;
  b: string;
  activeAfterRollback: string;
  coreAfterRollback: string;
  coreFromReleaseA: string;
  userDataPaths: string[];
  steps: string[];
}

/** 演练主体：在给定 home 上跑完整个「写 A → 应用 → 失败 → 自动回滚 → 断言」闭环。 */
export function runRollbackDrill(home: string): DrillResult {
  const steps: string[] = [];
  const say = (s: string) => steps.push(s);
  const corePath = join(home, "persona", "core.md");

  // 0) 建一个「像真 home」的环境：人格六块 + 记忆库 + 用户数据
  seedPersona(home);
  openDb(join(home, "memory.db")).db.close();
  const dbFile = join(home, "memory.db");
  const userData = seedUserData(home);
  say("准备临时 home：人格六块 + memory.db + 3 个用户数据文件");

  // 1) 槽 A：写入 → 应用 → 上报健康（有 lastHealthy 才有回滚目标）
  const a = installRelease(home, { because: "A 槽基线（演练）", now: T0, id: "slot-a" });
  activate(home, a.id, "install", T0);
  applyRelease(home, a.id);
  markHealthy(home, a.id, T0);
  const coreA = readFileSync(corePath, "utf8");
  const coreFromReleaseA = readFileSync(join(releaseDir(home, a.id), "persona", "core.md"), "utf8");
  say(`写槽 A=${a.id} 并上报健康`);

  // 2) 造出与 A 不同的 B：临时把 live 改成 B → 打快照 B → 把 live 还原成 A（模拟用户还在跑 A）
  const bContent = "B 试验版人格（和 A 不同，用来验证内容真的回退）：\n她现在说话很冲。";
  writeFileSync(corePath, bContent, "utf8");
  const b = installRelease(home, { because: "B 试验版（演练）", now: T0, id: "slot-b", parentId: a.id });
  writeFileSync(corePath, coreA, "utf8");
  activate(home, b.id, "promote", T0);
  const wB = applyRelease(home, b.id); // 真正把 B 的载荷应用到 live：core 从 A → B
  assert.equal(readFileSync(corePath, "utf8"), bContent, "应用 B 后 live 人格应变成 B 的内容");
  say(`写槽 B=${b.id} 并应用（live 人格已变，写入 ${wB.written.length} 个文件）`);

  // 3) 制造失败条件：用 B 启动但**不上报健康**（模拟启动即崩 / 自检没过），窗口到期触发看门狗
  bootAttempt(home, b.id, { now: T0, pid: 1, boot: "rollback-e2e" });
  const late = new Date(T0.getTime() + POLICY.deadlineMs + 1);
  const decision = deployTick(home, late, POLICY, { force: true });
  assert.equal(decision.action, "rollback", "看门狗应判定自动回滚");
  assert.equal(decision.action === "rollback" ? decision.to : "", a.id, "回滚目标应为 A 槽");
  say("制造失败：bootAttempt(B) 后不 markHealthy，窗口到期 → tick 判 rollback→A");

  // 4) 应用回滚：看门狗只切 state，真正的文件复制走 applyRelease（和 CLI 的 deployTick 一致）
  const wBack = applyRelease(home, a.id);
  const coreAfter = readFileSync(corePath, "utf8");
  say(`applyRelease(A) 应用回滚（写入 ${wBack.written.length} 个文件）`);

  // ── 核心断言 ─────────────────────────────────────────────
  const st = readState(home);
  assert.equal(st.active, a.id, "回滚后 active 必须回到 A 槽");
  assert.equal(coreAfter, coreFromReleaseA, "live 人格必须逐字回到 A 槽的内容");
  assert.equal(coreAfter, coreA, "live 人格必须等于打 A 快照时的内容");
  assert.notEqual(coreAfter, bContent, "不能还停留在 B 的内容");
  for (const [p, want] of Object.entries(userData)) {
    assert.ok(existsSync(p), `用户数据文件不该被回滚删掉：${p}`);
    assert.equal(readFileSync(p, "utf8"), want, `用户数据文件内容不该被改动：${p}`);
  }
  assert.ok(existsSync(dbFile), "memory.db 不该被删");
  assert.ok(hasRelease(home, b.id), "失败的 B 版本要保留现场，别删");

  return {
    a: a.id, b: b.id, activeAfterRollback: st.active ?? "",
    coreAfterRollback: coreAfter, coreFromReleaseA,
    userDataPaths: Object.keys(userData), steps,
  };
}

// ── 只有「直接运行本文件」才跑演练；被测试 import 时只导出函数，不设退出码、不建临时目录。──
const argv1 = process.argv[1];
const mainPath = argv1 ? resolve(argv1).toLowerCase() : "";
const isMain = mainPath !== "" && fileURLToPath(import.meta.url).toLowerCase() === mainPath;

if (isMain) {
  const home = mkdtempSync(join(tmpdir(), "jj-rollback-e2e-"));
  let code = 0;
  try {
    const r = runRollbackDrill(home);
    for (const s of r.steps) console.log("· " + s);
    console.log(
      `✅ A/B 双槽回滚演练通过：active 回到 ${r.activeAfterRollback}，persona 逐字回到 A，` +
      `${r.userDataPaths.length} 个用户数据文件完好，失败的 B 保留现场`,
    );
  } catch (e) {
    console.error("❌ A/B 双槽回滚演练失败：" + String((e as Error).message ?? e));
    code = 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  process.exitCode = code;
}
