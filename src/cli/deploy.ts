#!/usr/bin/env node
/**
 * A/B 双槽 CLI（18 §4.3 / §4.5，99 §5.1）
 *
 *   deploy status                     看当前槽位 / 历史 / 失败计数 / 冻结
 *   deploy install --because "…"      把 live home 打成 A 槽基线（没有理由不允许）
 *   deploy promote --id <id>          冒烟 20 项 → 切槽 → 应用（冻结期内拒绝）
 *   deploy rollback [--to <id>]       手动回滚
 *   deploy smoke [--id <id>]          单跑冒烟 20 项
 *   deploy tick                       单次巡检（判定 + 落盘）
 *   deploy supervise -- <cmd…>        起子进程 + 观察窗口 + 崩了自动回滚重来
 *   deploy mutate                     变异测试：故意跑一个"启动即崩"的版本，验证自动回槽
 */
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activate, applyRelease, hasRelease, installRelease, listReleases, manifestPath, readState, readStateSafe,
  releaseDir, readManifest, rollbackTarget, verifyRelease, pruneReleases, newReleaseId,
} from "../deploy/slot.ts";
import {
  assertNotFrozen, bootAttempt, describe, isFrozen, markHealthy, policyFromEnv, tick,
  type DeployPolicy,
} from "../deploy/watchdog.ts";
import { runSmoke } from "../deploy/smoke.ts";

const HOME = process.env.JJ_HOME ?? join(process.cwd(), "data");
const dbFile = join(HOME, "memory.db");

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  return rest[i + 1];
}
const has = (rest: string[], name: string) => rest.includes(name);

function cmdline(rest: string[]): string[] {
  const i = rest.indexOf("--");
  return i < 0 ? [] : rest.slice(i + 1);
}

interface ExitInfo {
  code: number;
  /** 是否是被看门狗叫停的（回滚前的旧进程不能留着） */
  killedForRollback: boolean;
}

/** 起一个子进程，并把它交给调用方处置（以便回滚时能杀掉） */
function start(cmd: string[], env: Record<string, string>) {
  if (!cmd.length) throw new Error("E_NO_CMD: 用 `-- <cmd…>` 指定要守护的命令");
  return spawn(cmd[0] as string, cmd.slice(1), {
    stdio: "inherit",
    env: { ...process.env, ...env },
    windowsHide: true,
  });
}

async function spawnOnce(cmd: string[], env: Record<string, string>): Promise<number> {
  const child = start(cmd, env);
  return await new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    child.on("error", () => resolve(127));
  });
}

export interface SuperviseOpts {
  home: string;
  cmd: string[];
  policy: DeployPolicy;
  maxRestarts?: number;
  /** 演练用：一旦发生回滚就退出（否则会一直守着 A 槽重试） */
  stopOnRollback?: boolean;
  log?: (s: string) => void;
}

/** 守护循环：起进程 → 观察窗口 → 非零退出就判定 → 回滚则换槽重来 */
export async function supervise(o: SuperviseOpts): Promise<{ code: number; rolledBack: boolean }> {
  const log = o.log ?? ((s: string) => console.log(s));
  const max = o.maxRestarts ?? 5;
  let rolledBack = false;

  for (let i = 0; i < max; i++) {
    const { state: st } = readStateSafe(o.home);
    if (isFrozen(st)) {
      log(`⛔ 自我更新冻结至 ${st.freezeUntil}：不再尝试切换`);
      return { code: 3, rolledBack };
    }
    if (!st.active) {
      log("未启用双槽（没有 active 版本），直接跑，不做回滚保护");
      return { code: await spawnOnce(o.cmd, {}), rolledBack };
    }
    bootAttempt(o.home, st.active);

    const child = start(o.cmd, { JJ_RELEASE: st.active });
    const startedAt = Date.now();
    let killedForRollback = false;
    const every = Math.max(200, Math.min(30_000, Math.floor(o.policy.deadlineMs / 4)));
    const timer = setInterval(() => {
      const d = tick(o.home, new Date(), o.policy);
      if (d.action === "rollback" || d.action === "halt" || d.action === "frozen") {
        log(`[watchdog] ${describe(d)}`);
        // 回滚了就不能让旧版本的进程继续跑：它已经不被信任了
        killedForRollback = true;
        try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
        const hard = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }, 2000);
        (hard as { unref?: () => void }).unref?.();
      } else if (d.action === "ok") {
        log(`[watchdog] ${describe(d)}`);
      }
    }, every);
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref(): void }).unref();

    log(`▶ 启动 ${st.active}（观察窗口 ${Math.round(o.policy.deadlineMs / 1000)}s）`);
    const exit: ExitInfo = await new Promise<ExitInfo>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), killedForRollback }));
      child.on("error", () => resolve({ code: 127, killedForRollback }));
    });
    clearInterval(timer);
    const aliveMs = Date.now() - startedAt;

    if (exit.killedForRollback) {
      rolledBack = true;
      log(`↩ ${st.active} 已被回滚，杀掉旧进程（存活 ${Math.round(aliveMs / 1000)}s）`);
      if (o.stopOnRollback) return { code: 0, rolledBack };
      continue;
    }

    if (exit.code === 0) {
      // 只在槽位没变时才算健康：回滚过的旧版本跑完不能给新状态“洗白”
      const cur = readStateSafe(o.home).state;
      if (cur.active === st.active) markHealthy(o.home, st.active);
      else log(`（已切到 ${cur.active}，不给 ${st.active} 记健康）`);
      log(`■ ${st.active} 正常退出（${Math.round(aliveMs / 1000)}s）`);
      return { code: 0, rolledBack };
    }

    log(`✖ ${st.active} 退出码 ${exit.code}（存活 ${Math.round(aliveMs / 1000)}s）`);
    const d = tick(o.home, new Date(), o.policy, { force: true });
    log(`[watchdog] ${describe(d)}`);
    if (d.action === "rollback") {
      rolledBack = true;
      if (o.stopOnRollback) return { code: 0, rolledBack };
      continue;
    }
    if (d.action === "frozen" || d.action === "halt") return { code: 4, rolledBack };
    if (d.action === "ok") log("（曾上报健康，按运行期崩溃处理，不回滚）");
  }
  log(`达到重启上限 ${max} 次，收手`);
  return { code: 5, rolledBack };
}

function printStatus(): void {
  const { state: st, corrupt } = readStateSafe(HOME);
  const now = new Date();
  const rows = listReleases(HOME).map((id) => {
    let flagText = "ok";
    try {
      const v = verifyRelease(HOME, id);
      if (!v.ok) flagText = `损坏(miss=${v.missing.length},chg=${v.changed.length})`;
      else flagText = readManifest(HOME, id).createdAt.slice(0, 16).replace("T", " ");
    } catch { flagText = "清单不可读"; }
    return { id, note: flagText, active: id === st.active, failures: st.failures[id] ?? 0 };
  });
  console.log(JSON.stringify({
    home: HOME,
    state: corrupt ? "损坏（本次无回滚保护）" : "ok",
    active: st.active, prev: st.prev, applied: st.applied,
    frozenUntil: isFrozen(st, now) ? st.freezeUntil : null,
    failStreak: st.failStreak,
    lastAttempt: st.lastAttempt, lastHealthy: st.lastHealthy,
    history: st.history.slice(-6),
    releases: rows,
  }, null, 2));
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  const policy = policyFromEnv();
  const now = () => new Date();

  switch (sub) {
    case "status":
      printStatus();
      return;

    case "install": {
      const because = flag(rest, "--because") ?? "";
      const m = installRelease(HOME, { because, now: now(), id: flag(rest, "--id") });
      console.log(`✅ 已打版 ${m.id}（${Object.keys(m.files).length} 个文件）`);
      console.log(`   ${manifestPath(HOME, m.id)}`);
      console.log(`   上一版：${m.parentId ?? "无"}`);
      return;
    }

    case "smoke": {
      const id = flag(rest, "--id") ?? null;
      const rep = runSmoke({ home: HOME, dbFile, release: id });
      for (const r of rep.rows) {
        console.log(`${r.ok ? "✅" : "❌"} #${String(r.n).padStart(2)} ${r.name.padEnd(22)} ${r.detail}`);
      }
      console.log(`${rep.pass ? "✅ 全部通过" : `❌ ${rep.failed.length} 项未过：${rep.failed.join(", ")}`} ｜ 人格指纹 ${rep.personaHash}`);
      process.exitCode = rep.pass ? 0 : 1;
      return;
    }

    case "promote": {
      const id = flag(rest, "--id");
      if (!id) { console.error("用法: deploy promote --id <release>"); process.exitCode = 1; return; }
      if (!hasRelease(HOME, id)) { console.error(`E_NO_RELEASE: ${id}`); process.exitCode = 1; return; }
      assertNotFrozen(HOME, now());
      const rep = runSmoke({ home: HOME, dbFile, release: id });
      if (!rep.pass) {
        for (const r of rep.rows.filter((x) => !x.ok)) console.log(`❌ #${r.n} ${r.name} ${r.detail}`);
        console.error(`❌ 冒烟未过（${rep.failed.length} 项），不切槽`);
        process.exitCode = 2;
        return;
      }
      const st = activate(HOME, id, "promote", now());
      const w = applyRelease(HOME, id);
      pruneReleases(HOME, 5);
      console.log(`✅ 冒烟 20/20 → 已切到 ${id}（上一版 ${st.prev ?? "无"}，应用 ${w.written.length} 个文件）`);
      console.log("   重启面板后生效；若 10 分钟内没有上报健康，看门狗会自己切回去。");
      return;
    }

    case "rollback": {
      const to = flag(rest, "--to");
      const st = readState(HOME);
      const target = to ?? rollbackTarget(HOME, st.active ?? "");
      if (!target) { console.error("E_NO_TARGET: 没有可回滚的版本"); process.exitCode = 1; return; }
      const before = st.active;
      activate(HOME, target, "rollback", now());
      const w = applyRelease(HOME, target);
      console.log(`↩ 已从 ${before ?? "无"} 回滚到 ${target}（应用 ${w.written.length} 个文件）`);
      return;
    }

    case "tick": {
      const d = tick(HOME, now(), policy, { force: has(rest, "--force") });
      console.log(JSON.stringify({ decision: d, describe: describe(d) }, null, 2));
      return;
    }

    case "supervise": {
      const cmd = cmdline(rest);
      const r = await supervise({ home: HOME, cmd, policy, maxRestarts: Number(flag(rest, "--max") ?? 5) });
      process.exitCode = r.code;
      return;
    }

    /**
     * 变异测试（18 §4.5）：注入"启动即崩"的一版，验证看门狗把它切回去。
     * 真实观察窗口是 10 分钟；演练时用 JJ_DEPLOY_DEADLINE_MS=300 把窗口压到几百毫秒。
     */
    case "mutate": {
      const t0 = Date.now();
      const log = (s: string) => console.log(`  ${s}`);

      // A 槽：当前 live home 的基线，并且真的上报过健康（否则没有回滚目标）
      const a = installRelease(HOME, { because: "变异测试：A 槽基线（当前 live home）", now: now() });
      activate(HOME, a.id, "install", now());
      const w = applyRelease(HOME, a.id);
      markHealthy(HOME, a.id, now());
      console.log(`A = ${a.id}（应用 ${w.written.length} 个文件，已标记健康）`);

      // B 槽：一个必然起不来的版本 —— 载荷正常，但进程立刻退出
      const bId = newReleaseId(now(), "bad");
      const b = installRelease(HOME, { because: "变异测试：故意注入启动即崩", now: now(), id: bId, parentId: a.id });
      activate(HOME, b.id, "install", now());
      console.log(`B = ${b.id}（注入"启动即崩"→ ${has(rest, "--") ? "自定义命令" : "node -e process.exit(1)"}）`);

      const crash = cmdline(rest);
      const cmd = crash.length ? crash : [process.execPath, "-e", "process.exit(1)"];
      const r = await supervise({ home: HOME, cmd, policy, maxRestarts: 2, stopOnRollback: true, log });

      const after = readState(HOME);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const pass = r.rolledBack && after.active === a.id;
      console.log(`${pass ? "✅" : "❌"} 回滚演练：${after.active === a.id ? `已回到 A（${a.id}）` : `仍停在 ${after.active}`}` +
        ` ｜ B 失败次数 ${after.failures[b.id] ?? 0} ｜ 连续失败 ${after.failStreak} ｜ ${secs}s`);
      if (!pass) process.exitCode = 1;
      return;
    }

    default:
      console.log("用法: node src/cli/deploy.ts <status|install|promote|rollback|smoke|tick|supervise|mutate>");
      console.log(`  当前 home = ${HOME}`);
  }
}

// 只在被直接执行时跑 CLI：测试要 import supervise，不能顺手把命令跑了
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}