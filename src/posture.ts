/**
 * 默认姿态（用户 2026-10-31 的判断）：
 *
 * > 我们的核心是**记忆可持续 + 数据本地**，不是通过各种限制让它残疾。
 * > 而且我们是有兜底的（审计 / 回收站 / pre-image / 事务回滚），为什么不能放开。
 *
 * 之前的问题：`ask` 是默认档 + 代码外发默认拒 —— 于是刚装好、什么都没批过的时候，
 * 它读不了自己的代码、跑不了测试，聊天里只会反复回"E_NEEDS_EGRESS / E_NEEDS_CONFIRM"。
 * 那不是安全，那是残疾。
 *
 * 现在的默认：
 *   · 权限档 = `write`（注册模板 + workspace 内，会话级）
 *   · 代码外发 = 会话内开放（每次仍留 audit，面板上可一键关）
 *
 * **没有放开的**（不可逆或不可审计的，放开等于没有兜底）：
 *   删除 / 磁盘 / 系统配置 / 下载器 / 壳  → 永久拒
 *   密钥类环境变量 → 不进子进程
 *   taint=external 的内容 → 不能改任务、权限、时限、凭据
 *   结果不确定的外发动作 → 不自动重试
 *
 * 想回到"什么都问"：JJ_PARANOID=1（或面板上切「逐次确认」）。
 */
import type { DatabaseSync } from "node:sqlite";
import { setPreset, currentPreset, chosenPreset, type Preset } from "./grant.ts";
import { allowFor, egressStatus } from "./egress.ts";

export interface AppliedDefaults {
  preset: Preset;
  presetApplied: boolean;
  egressOpened: boolean;
  paranoid: boolean;
}

// 2026-11-05 用户：「所有权限*限制*都撤了，等软件能用了再谈限制」。
// 所以默认 full：启动就开一个全量授权窗口，执行类能力不再逐次问。
export const DEFAULT_PRESET: Preset = "full";

// 2026-11-01 用户定：默认从 write 提到 **full** —— 开箱就能跑任意命令，
// 不然每次"帮我改一下/跑个测试"都要先去切档，那就是残疾。
// 记忆核心（memory.db / persona / secrets / inbox / trash / snapshots）仍然拒
// （coreguard 挡），删/磁盘/系统/下载/壳仍然拒（FULL_DENY 挡）。
// 想回到"只在家目录里改"：面板上切 write；想什么都问：JJ_PARANOID=1。

export function applyDefaultPosture(
  db: DatabaseSync, home: string, opts: { env?: Record<string, string | undefined>; now?: Date } = {},
): AppliedDefaults {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const paranoid = env.JJ_PARANOID === "1";
  if (paranoid) return { preset: "ask", presetApplied: false, egressOpened: false, paranoid: true };

  const wanted = (env.JJ_DEFAULT_PRESET as Preset | undefined) ?? DEFAULT_PRESET;
  const valid: Preset[] = ["ask", "read", "write", "full"];
  const def = valid.includes(wanted) ? wanted : DEFAULT_PRESET;
  // 2026-11-05 用户：限制全部撤掉。默认 full，启动自动开窗口（20 秒后第一次执行不用问）。
  const chosen = null as null | ReturnType<typeof chosenPreset>;
  void chosenPreset;
  const effective = chosen ?? def;
  const want = effective === "ask" ? "ask" : effective;
  const presetApplied = currentPreset(home, now).preset !== want;
  if (presetApplied) setPreset(home, want, { because: chosen ? `沿用你上次选的档位（${chosen}）` : `启动默认姿态（${def}）` }, now);
  const preset = want;

  // 代码外发：默认开放（2026-11-05 限制全撤），每次仍写 audit。
  let egressOpened = false;
  if (egressStatus(home, { env, now }).until === null) {
    allowFor(home, 24 * 60 * 60_000, "限制已撤：会话内允许外发");
    egressOpened = true;
  }
  void db;
  return { preset, presetApplied, egressOpened, paranoid: false };
}
