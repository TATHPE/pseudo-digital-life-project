import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { seedPersona } from "../src/persona.ts";
import {
  activate, applyRelease, assertReleaseId, hashPayload, installRelease, listReleases, manifestPath,
  readManifest, readState, readStateSafe, releaseDir, rollbackTarget, statePath, verifyRelease, writeState,
} from "../src/deploy/slot.ts";
import {
  apply, assertNotFrozen, bootAttempt, evaluate, isFrozen, markHealthy, tick, DEFAULT_DEPLOY_POLICY,
} from "../src/deploy/watchdog.ts";
import { runSmoke } from "../src/deploy/smoke.ts";
import { supervise } from "../src/cli/deploy.ts";
import { toolFp } from "../src/deploy/fingerprint.ts";

const T0 = new Date("2026-10-28T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function rig() {
  const home = mkdtempSync(join(tmpdir(), "jj-deploy-"));
  seedPersona(home);
  openDb(join(home, "memory.db")).db.close();
  return { home, dbFile: join(home, "memory.db") };
}

/** A 槽：打版 + 切过去 + 上报健康（有 lastHealthy 才有回滚目标） */
function healthyA(home: string, because = "A 槽基线") {
  const a = installRelease(home, { because, now: T0 });
  activate(home, a.id, "install", T0);
  applyRelease(home, a.id);
  markHealthy(home, a.id, T0);
  return a;
}

// ── 槽位本体 ────────────────────────────────────────────────

test("打版必须有理由（18 §4.4：没有理由的改动不是成长）", () => {
  const { home } = rig();
  assert.throws(() => installRelease(home, { because: "   " }), /E_DEPLOY_NO_REASON/);
});

test("打版产出清单：六个 persona 文件 + 三重指纹 + 上一版", () => {
  const { home } = rig();
  const a = installRelease(home, { because: "初始", now: T0 });
  const m = readManifest(home, a.id);
  const files = Object.keys(m.files).sort();
  assert.equal(files.length, 6, files.join(","));
  assert.ok(files.every((f) => f.startsWith("persona/") && f.endsWith(".md")));
  assert.match(m.coreFp.schema, /^v5-/);
  assert.match(m.coreFp.tool, /^n\d+-/);
  assert.equal(m.parentId, null);
  assert.ok(existsSync(join(releaseDir(home, a.id), "record.md")), "要留「我变了」的记录");
  assert.match(readFileSync(join(releaseDir(home, a.id), "record.md"), "utf8"), /初始/);
});

test("versions/ 不进载荷（否则每发一版历史翻一倍）", () => {
  const { home } = rig();
  mkdirSync(join(home, "persona", "versions"), { recursive: true });
  writeFileSync(join(home, "persona", "versions", "2026-10-28-1.md"), "# 历史");
  const version = "2026-10-28-1";
  assert.match(version, /\d{4}/);
  const a = installRelease(home, { because: "x", now: T0 });
  assert.ok(!existsSync(join(releaseDir(home, a.id), "persona", "versions")));
});

test("哈希稳定：内容相同 → 同一个值；改一个字节 → changed", () => {
  const { home } = rig();
  const a = installRelease(home, { because: "x", now: T0 });
  const h1 = hashPayload(releaseDir(home, a.id));
  const h2 = hashPayload(releaseDir(home, a.id));
  assert.deepEqual(h1, h2);
  assert.equal(verifyRelease(home, a.id).ok, true);

  const p = join(releaseDir(home, a.id), "persona", "core.md");
  writeFileSync(p, readFileSync(p, "utf8") + "改了一个字");
  const v = verifyRelease(home, a.id);
  assert.equal(v.ok, false);
  assert.deepEqual(v.changed, ["persona/core.md"]);
  assert.throws(() => applyRelease(home, a.id), /E_RELEASE_CORRUPT/);
});

test("applyRelease：恢复被改动的文件，且第二次不写（幂等）", () => {
  const { home } = rig();
  const a = installRelease(home, { because: "x", now: T0 });
  writeFileSync(join(home, "persona", "core.md"), "被改掉了");
  assert.deepEqual(applyRelease(home, a.id).written, ["persona/core.md"]);
  assert.equal(
    readFileSync(join(home, "persona", "core.md"), "utf8"),
    readFileSync(join(releaseDir(home, a.id), "persona", "core.md"), "utf8"),
  );
  assert.equal(applyRelease(home, a.id).written.length, 0);
});

test("id 拼进路径前必须先验形状（state.json 里一个 ../.. 就是路径穿越）", () => {
  assert.throws(() => assertReleaseId("../../etc"), /E_BAD_RELEASE_ID/);
  assert.throws(() => assertReleaseId("a/b"), /E_BAD_RELEASE_ID/);
  assert.equal(assertReleaseId("20261028-120000-abcd"), "20261028-120000-abcd");
  const { home } = rig();
  assert.throws(() => activate(home, "../x", "t", T0), /E_BAD_RELEASE_ID/);
});

test("切槽记 history/prev，并清掉 applied", () => {
  const { home } = rig();
  const a = healthyA(home);
  const b = installRelease(home, { because: "B", now: T0, id: "b-1" });
  const st = activate(home, b.id, "promote", T0);
  assert.equal(st.active, b.id);
  assert.equal(st.prev, a.id);
  assert.equal(st.applied, null);
  assert.equal(st.lastAttempt, null);
  assert.deepEqual(st.history.map((h) => `${h.from}->${h.to}`), [`null->${a.id}`, `${a.id}->${b.id}`]);
});

test("state.json 损坏：启动路径降级而不是崩（读严版仍然抛）", () => {
  const { home } = rig();
  mkdirSync(join(home, "deploy"), { recursive: true });
  writeFileSync(statePath(home), "{ 坏掉的 json");
  assert.throws(() => readState(home), /E_DEPLOY_STATE/);
  const s = readStateSafe(home);
  assert.equal(s.corrupt, true);
  assert.equal(s.state.active, null);
});

// ── 看门狗 / 自动回滚（18 §4.5 变异测试）─────────────────────

test("观察窗口内不误判（wait）；过窗口才记失败并回滚", () => {
  const { home } = rig();
  const a = healthyA(home);
  const b = installRelease(home, { because: "B", now: T0, id: "b-bad" });
  activate(home, b.id, "install", T0);
  bootAttempt(home, b.id, { now: T0, pid: 1, boot: "test" });

  const early = evaluate(home, at(60_000), DEFAULT_DEPLOY_POLICY);
  assert.equal(early.action, "wait");

  const late = evaluate(home, at(DEFAULT_DEPLOY_POLICY.deadlineMs + 1), DEFAULT_DEPLOY_POLICY);
  assert.equal(late.action, "rollback");
  assert.equal(late.action === "rollback" && late.to, a.id);

  apply(home, late, at(DEFAULT_DEPLOY_POLICY.deadlineMs + 1), DEFAULT_DEPLOY_POLICY);
  const st = readState(home);
  assert.equal(st.active, a.id);
  assert.equal(st.failures[b.id], 1);
  assert.equal(st.applied, null, "回滚后要重新应用 A 的载荷");
  assert.equal(st.history.at(-1)?.why, "auto-rollback");
});

test("同一版本重复启动不重置时钟（否则崩溃重启循环永远等不到 deadline）", () => {
  const { home } = rig();
  const a = healthyA(home);
  const b = installRelease(home, { because: "B", now: T0, id: "b-loop" });
  activate(home, b.id, "install", T0);
  bootAttempt(home, b.id, { now: T0 });
  const first = readState(home).lastAttempt?.at;
  bootAttempt(home, b.id, { now: at(300_000) });
  assert.equal(readState(home).lastAttempt?.at, first, "时钟不该被重启刷新");
  assert.equal(evaluate(home, at(300_000 + DEFAULT_DEPLOY_POLICY.deadlineMs + 1), DEFAULT_DEPLOY_POLICY).action, "rollback");
  void a;
});

test("连续两次失败 → 冻结 24h，且发布闸拒绝自我更新", () => {
  const { home } = rig();
  const a = healthyA(home);
  const p = DEFAULT_DEPLOY_POLICY;

  // 第一次：B 挂了 → 回滚到 A
  const b = installRelease(home, { because: "B", now: T0, id: "b-1" });
  activate(home, b.id, "install", T0);
  bootAttempt(home, b.id, { now: T0 });
  tick(home, at(p.deadlineMs + 1), p, { force: true });
  assert.equal(readState(home).active, a.id);
  assert.equal(readState(home).failStreak, 1);

  // 第二次：C 也挂了 → 连续 2 次 → 冻结
  const c = installRelease(home, { because: "C", now: T0, id: "c-1" });
  activate(home, c.id, "install", T0);
  bootAttempt(home, c.id, { now: T0 });
  const d = tick(home, at(p.deadlineMs + 2), p, { force: true });
  assert.equal(d.action, "rollback");
  const st = readState(home);
  assert.equal(st.active, a.id);
  assert.equal(st.failStreak, 2);
  assert.ok(st.freezeUntil, "连续两次失败必须冻结");
  const until = Date.parse(String(st.freezeUntil));
  assert.equal(until, at(p.deadlineMs + 2).getTime() + p.freezeMs);
  assert.equal(isFrozen(st, at(p.freezeMs)), true);

  assert.throws(() => assertNotFrozen(home, at(p.freezeMs - 1000)), /E_DEPLOY_FROZEN/);
  assert.doesNotThrow(() => assertNotFrozen(home, at(p.deadlineMs + 2 + p.freezeMs + 1000)));

  // 冻结期内巡检不动手
  assert.equal(evaluate(home, at(p.freezeMs - 2000), p).action, "frozen");
});

test("上报健康会清零连续失败", () => {
  const { home } = rig();
  const a = healthyA(home);
  writeState(home, { ...readState(home), failStreak: 3 });
  markHealthy(home, a.id, T0);
  assert.equal(readState(home).failStreak, 0);
});

test("没有可回滚的上一版 → halt（宁停不装作成功）", () => {
  const { home } = rig();
  const solo = installRelease(home, { because: "唯一一版", now: T0, id: "solo" });
  activate(home, solo.id, "install", T0);
  bootAttempt(home, solo.id, { now: T0 });
  assert.equal(rollbackTarget(home, solo.id), null);
  const d = tick(home, at(DEFAULT_DEPLOY_POLICY.deadlineMs + 1), DEFAULT_DEPLOY_POLICY, { force: true });
  assert.equal(d.action, "halt");
  assert.equal(readState(home).active, solo.id, "不能把自己「回滚」没了");
  assert.equal(readState(home).lastAttempt, null, "halt 后不重复计数");
});

// ── 冒烟 20 项 ─────────────────────────────────────────────

test("冒烟 20 项：健康的 home 全过，且人格指纹稳定", () => {
  const { home, dbFile } = rig();
  const rep = runSmoke({ home, dbFile });
  assert.equal(rep.rows.length, 20);
  assert.equal(rep.pass, true, rep.rows.filter((r) => !r.ok).map((r) => `${r.n} ${r.name} ${r.detail}`).join("\n"));
  assert.match(rep.personaHash, /^[0-9a-f]{16}$/);
  assert.equal(runSmoke({ home, dbFile }).personaHash, rep.personaHash);
});

test("冒烟对某一版打分（而不是对 live home）", () => {
  const { home, dbFile } = rig();
  const a = installRelease(home, { because: "x", now: T0 });
  const rep = runSmoke({ home, dbFile, release: a.id });
  assert.equal(rep.pass, true, rep.rows.filter((r) => !r.ok).map((r) => r.name).join(","));

  const p = join(releaseDir(home, a.id), "persona", "core.md");
  writeFileSync(p, "   ");
  const bad = runSmoke({ home, dbFile, release: a.id });
  assert.ok(bad.failed.includes("persona.core_size"));
  assert.ok(bad.failed.includes("persona.nonempty"));
});

test("冒烟拦控制字符 / 密钥 / 主机绝对路径", () => {
  const { home, dbFile } = rig();
  const a = installRelease(home, { because: "x", now: T0 });
  const dir = join(releaseDir(home, a.id), "persona");
  writeFileSync(join(dir, "voice.md"), "说话要轻" + String.fromCharCode(7) + "一点");
  writeFileSync(join(dir, "values.md"), "key: sk-abcdefghijklmnopqrstuvwx");
  writeFileSync(join(dir, "evidence.md"), "证据在 D:\\LLM\\jingjing\\data 里");
  const rep = runSmoke({ home, dbFile, release: a.id });
  assert.ok(rep.failed.includes("persona.controls"), rep.failed.join(","));
  assert.ok(rep.failed.includes("persona.no_secret"), rep.failed.join(","));
  assert.ok(rep.failed.includes("persona.no_host_path"), rep.failed.join(","));
});

test("冒烟拦载荷里的目录联接（红队 #4 的同款教训）", () => {
  const { home, dbFile } = rig();
  const a = installRelease(home, { because: "x", now: T0 });
  const dir = join(releaseDir(home, a.id), "persona");
  try {
    symlinkSync(join(home, "workspace"), join(dir, "escape"), "junction");
  } catch {
    return; // 平台不允许建联接就跳过（Windows 非开发者模式）
  }
  const rep = runSmoke({ home, dbFile, release: a.id });
  assert.ok(rep.failed.includes("persona.no_symlink"), rep.failed.join(","));
});

test("冒烟拦指纹漂移（工具集变了却想推旧版）", () => {
  const { home, dbFile } = rig();
  const a = installRelease(home, { because: "x", now: T0 });
  const mp = manifestPath(home, a.id);
  const m = JSON.parse(readFileSync(mp, "utf8"));
  m.coreFp.tool = "n0-deadbeef";
  writeFileSync(mp, JSON.stringify(m, null, 2));
  const rep = runSmoke({ home, dbFile, release: a.id });
  assert.ok(rep.failed.includes("fp.tool"), rep.failed.join(","));
});

// ── 端到端：真的起一个"启动即崩"的进程 ──────────────────────

test("supervise：子进程起来就死 → 自动切回 A 槽", async () => {
  const { home } = rig();
  const a = healthyA(home);
  const b = installRelease(home, { because: "B", now: T0, id: "b-crash" });
  activate(home, b.id, "install", T0);

  const policy = { deadlineMs: 300, freezeMs: 60_000, maxStreak: 2 };
  const lines: string[] = [];
  const r = await supervise({
    home,
    cmd: [process.execPath, "-e", "process.exit(1)"],
    policy, maxRestarts: 2, stopOnRollback: true,
    log: (s) => lines.push(s),
  });

  assert.equal(r.rolledBack, true, lines.join("\n"));
  const st = readState(home);
  assert.equal(st.active, a.id);
  assert.equal(st.failures[b.id], 1);
  assert.equal(st.failStreak, 1);
  assert.equal(listReleases(home).includes(b.id), true, "失败版本保留现场，别删");
});

test("supervise：进程活着但不上报健康 → 窗口到期回滚，并杀掉旧进程", async () => {
  const { home } = rig();
  const a = healthyA(home);
  const b = installRelease(home, { because: "B", now: T0, id: "b-hang" });
  activate(home, b.id, "install", T0);

  const policy = { deadlineMs: 300, freezeMs: 60_000, maxStreak: 2 };
  const t0 = Date.now();
  const r = await supervise({
    home,
    cmd: [process.execPath, "-e", "setTimeout(function(){}, 5000)"],
    policy, maxRestarts: 1, stopOnRollback: true,
    log: () => {},
  });
  const elapsed = Date.now() - t0;

  assert.equal(r.rolledBack, true);
  const st = readState(home);
  assert.equal(st.active, a.id);
  assert.equal(st.lastHealthy?.id, a.id, "已被回滚的版本不能被记成健康");
  assert.ok(elapsed < 4000, `应在窗口到期后立刻回滚并杀进程，实际 ${elapsed}ms`);
});

test("回滚目标不会选回那个已经失败的版本（mutate 演练后的脚枪）", () => {
  const { home } = rig();
  const a = healthyA(home);
  const b = installRelease(home, { because: "B", now: T0, id: "b-x" });
  activate(home, b.id, "install", T0);
  bootAttempt(home, b.id, { now: T0 });
  tick(home, at(DEFAULT_DEPLOY_POLICY.deadlineMs + 1), DEFAULT_DEPLOY_POLICY, { force: true });
  assert.equal(readState(home).active, a.id);
  assert.equal(readState(home).failures[b.id], 1);
  // 再问一次"回滚到哪"：不能是 b（它明确坏过）
  assert.notEqual(rollbackTarget(home, a.id), b.id);
  assert.equal(rollbackTarget(home, a.id), null, "没有别的可信版本 → 宁可说没有");
});
