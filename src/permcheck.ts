/**
 * 权限自查（docs/ops/22 §0.4「权限自查」）：回答「**这个能力现在为什么不能用**」。
 *
 * 刻意不写能力清单：verbs 来自 `verbs.ts`，授权来自真跑 `loadPolicy.authorize`，
 * T3 还要真跑一遍 `capability()` → `checkGrant()`（execute.ts 就是这么判的）。
 * 手抄一份「谁能干什么」一定会和代码漂移，那就又变成装饰列了。
 *
 * 闸门顺序照 `src/execute.ts`（2026-11-04 之后的版本），三条容易写错的事实：
 *  ① T3 的「确认」层已经删了，现在是 **授权窗口**（checkGrant）放行；
 *     `grant:<id>` 不再是动作级一次性令牌，而是窗口 id。
 *  ② `strength=enforce` 只有 **T2** 才弹人工确认；T1 的 enforce 是「留快照/可回滚」，不拦。
 *  ③ 授权窗口与出网闸都是**会话级内存状态**，进程重启即失效；CLI 里查到的永远是「没开」。
 *     所以这张表报的是「本进程此刻能不能跑」，不是「配置上允许不允许」。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verbs } from "./verbs.ts";
import type { VerbCtx } from "./verbs.ts";
import { loadPolicy, policyPath } from "./policy.ts";
import type { Strength } from "./policy.ts";
import { checkGrant, currentPreset } from "./grant.ts";
import { egressStatus } from "./egress.ts";
import { readSuper } from "./supergrant.ts";
import { templateCatalog } from "./shell.ts";
import type { SlotSpec } from "./shell.ts";
import type { Tier } from "./types.ts";

export type PermVerdict = "ready" | "confirm" | "grant" | "blocked" | "probe";

export interface PermRow {
  /** 展示名；档位随模板变的写成 `shell.run(node.version)` */
  verb: string;
  /** verbs 表里的原名（策略按它匹配） */
  base: string;
  tier: Tier;
  target: string;
  strength: Strength | null;
  /** 命中的策略行（p, eft, tier, verb, target, strength） */
  rule: string | null;
  /** 拦下的错误码：E_NO_RULE / E_DENIED / E_NO_GRANT / E_BAD_ARGV … */
  code: string | null;
  /** 策略之外还要过的闸门（人话，照 execute.ts 的顺序） */
  gates: string[];
  verdict: PermVerdict;
  /** 「为什么不能用」一句话；能用时说明为什么能用 */
  why: string;
}

export interface PermEnv {
  policyFile: string;
  preset: string;
  remainingS: number;
  superEnabled: boolean;
  egressOpen: boolean;
  egressForced: boolean;
}

export interface PermReport {
  at: string;
  env: PermEnv;
  rows: PermRow[];
  /** 会真拦住能力的结构问题（--strict 判红） */
  issues: string[];
  /** 不影响运行的历史遗留（死规则），只提示不判红 */
  warnings: string[];
  summary: Record<PermVerdict, number> & { total: number };
}

export interface PermDeps {
  home: string;
  now?: Date;
}

/**
 * 探针输入。**不是能力清单**：只用来让 `target()` / `capability()` 算出一个真实目标，
 * 从而让策略 glob 与 T3 窗口判定拿到和运行时同形状的参数。
 * 模板那一维不写死：从 `templateCatalog()` 真读，逐个探（档位由模板决定）。
 */
const PROBE: Record<string, unknown> = {
  path: "workspace/probe.txt",
  dir: "workspace",
  name: "probe",
  pattern: "probe",
  glob: "*.md",
  script: "workspace/probe.mjs",
  argv: ["node", "--version"],
  cwd: "workspace",
  // 模板槽要的是**文件名**（renderTemplate 会自己拼 workspace/ 并校验真实存在），不是路径
  slots: { script: "probe.mjs" },
  text: "probe",
};

/**
 * 模板槽从**真实 workspace/** 里挑一个符合 pattern 的文件名（只读，不造文件）。
 * 挑得到 → T3 能渲染出确切 argv，自查表就能一路探到授权窗口；
 * 挑不到 → 归到「探针未就绪」，不说成「能力不可用」。
 */
function probeSlots(home: string, specs: Record<string, SlotSpec>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const under = spec.must_be_under ?? "workspace/";
    let hit: string | undefined;
    try {
      const re = new RegExp(spec.pattern);
      hit = readdirSync(join(home, under), { withFileTypes: true })
        .filter((e) => e.isFile()).map((e) => e.name).find((n) => re.test(n));
    } catch { /* 目录不存在 = 退回占位名 */ }
    out[name] = hit ?? (PROBE.slots as Record<string, unknown>)[name] ?? "probe.mjs";
  }
  return out;
}

/** 策略行解析：只认 `p,` 开头；`policy.ts` 里的同款解析不导出，这里只读不写 */
function policyRules(home: string): Array<{ eft: string; tier: string; verb: string; target: string; strength: string }> {
  try {
    return readFileSync(policyPath(home), "utf8").split(String.fromCharCode(10))
      .map((l) => l.trim()).filter((l) => l.startsWith("p,"))
      .map((l) => l.slice(2).split(",").map((x) => x.trim()))
      .filter((c) => c.length >= 4)
      .map((c) => ({ eft: c[0]!, tier: c[1]!, verb: c[2]!, target: c[3]!, strength: c[4] ?? "enforce" }));
  } catch { return []; }
}

/** 把 execute.ts 里那几道闸门的现状写成短句（不判断能不能过，只说「要过什么」） */
function gatesFor(tier: Tier, strength: Strength | null, base: string): string[] {
  const out: string[] = [];
  if (strength === "advise") out.push("advise：只记审计，不拦");
  else if (strength === "enforce") {
    out.push(tier === "T2" ? "enforce+T2：要 approved 确认" : "enforce：留快照/可回滚，不弹确认");
  }
  if (tier === "T3") out.push("T3：策略放行后还要过授权窗口 checkGrant");
  if (base === "shell.exec") out.push("任意 argv 只允许在「完全权限」窗口");
  if (base === "script.run" || base === "shell.run") out.push("argv 由模板渲染，参数错就 E_BAD_ARGV");
  return out;
}

export async function permsReport(deps: PermDeps): Promise<PermReport> {
  const now = deps.now ?? new Date();
  const home = deps.home;
  const ctx: VerbCtx = { home, now: () => now, env: process.env };
  const policy = await loadPolicy(home);
  const rows: PermRow[] = [];

  /** 逐能力探一次；shell.run 按模板目录逐个探（它的档位由模板决定） */
  const probes: Array<{ base: string; label: string; args: Record<string, unknown> }> = [];
  for (const v of verbs) {
    if (v.name === "shell.run") {
      for (const t of templateCatalog()) {
        probes.push({ base: v.name, label: `${v.name}(${t.id})`, args: { ...PROBE, template: t.id, slots: probeSlots(home, t.slots) } });
      }
    } else {
      probes.push({ base: v.name, label: v.name, args: PROBE });
    }
  }

  for (const p of probes) {
    const def = verbs.find((v) => v.name === p.base)!;
    let tier: Tier;
    let target: string;
    try {
      tier = def.tierFor ? def.tierFor(p.args) : def.tier;
      target = def.target(p.args, ctx);
    } catch (e) {
      rows.push({
        verb: p.label, base: p.base, tier: def.tier, target: "", strength: null, rule: null,
        code: "E_BAD_TARGET", gates: [], verdict: "blocked",
        why: `连目标都算不出来：${String((e as Error).message).slice(0, 100)}`,
      });
      continue;
    }

    const auth = await policy.authorize(p.base, tier, target);
    const gates = gatesFor(tier, auth.strength, p.base);
    const rule = auth.rule ? `p, ${auth.rule.join(", ")}` : null;
    const common = { verb: p.label, base: p.base, tier, target, strength: auth.strength, rule, gates };

    if (!auth.allow) {
      const noRule = auth.reason === "E_NO_RULE";
      rows.push({
        ...common, code: auth.reason ?? "E_DENIED", verdict: "blocked",
        why: noRule
          ? `策略里没有 (${tier}, ${p.base}) 这一行 → 默认拒绝。放开要往 policy.csv 加：p, allow, ${tier}, ${p.base}, *, advise`
          : `策略显式拒绝（${rule ?? "deny 规则"}）；T4 恒拒、人写的 deny 都走这里`,
      });
      continue;
    }

    if (tier === "T3") {
      // execute.ts:84-118 —— 与真实链路同一条：先渲染 argv，再过窗口闸门。
      if (!def.capability) {
        rows.push({ ...common, code: "E_NO_CAPABILITY", verdict: "blocked", why: "T3 却没有 argv 渲染器，execute 会直接拒" });
        continue;
      }
      let proposal: { argv: string[]; cwd: string };
      try {
        proposal = def.capability(p.args, ctx);
      } catch (e) {
        // 探针凑不齐参数（比如模板要求 workspace/ 下真实存在脚本）≠ 能力被禁。
        // 单独分一档，别把「没测成」说成「不可用」——那是自查表自己撒谎。
        // safePath 的错误会带上绝对路径和「同级文件」列表：只取第一行、抹掉 home，别把本机目录倒进报告
        const raw = String((e as Error).message);
        const first = raw.split(String.fromCharCode(10))[0]!.split(home).join("<home>");
        rows.push({
          ...common, code: first.split(":")[0] || "E_BAD_ARGV", verdict: "probe",
          why: `策略已放行，但探针凑不齐参数（${first.slice(0, 90)}）。T3 模板要求 workspace/ 下真实存在且符合 pattern 的脚本，这不代表能力被禁；带对参数后下一道是授权窗口（当前无窗口）`,
        });
        continue;
      }
      const gate = checkGrant(home, {
        argv: proposal.argv, cwd: proposal.cwd, verb: p.base,
        ...(p.base === "script.run" ? { asInterpreter: true } : {}),
      }, now);
      if (!gate.ok) {
        rows.push({ ...common, code: gate.code, verdict: "grant", why: `策略放行，但${gate.why}（${gate.code}）。窗口是会话级：在面板切到「完全权限」或 grant open` });
        continue;
      }
      rows.push({ ...common, code: null, verdict: "ready", why: `授权窗口 ${gate.id} 命中，按 ${proposal.argv[0]} 这条 argv 放行；逐条审计` });
      continue;
    }

    if (auth.strength === "enforce" && tier === "T2") {
      rows.push({ ...common, code: "E_NEEDS_CONFIRM", verdict: "confirm", why: "策略放行，但 T2+enforce 需要 approved 才执行；没有它这一轮会停在确认上" });
      continue;
    }
    rows.push({ ...common, code: null, verdict: "ready", why: auth.strength === "advise" ? "可直接调用，只记审计" : "可直接调用；写操作会留快照便于回滚" });
  }

  // ── 结构一致性：策略与能力表互相核对 ─────────────────────────
  const issues: string[] = [];
  const warnings: string[] = [];
  const names = new Set(verbs.map((v) => v.name));
  const orphans = [...new Set(policyRules(home)
    .filter((r) => r.verb !== "*" && !r.verb.includes("*") && !names.has(r.verb))
    .map((r) => r.verb))];
  // 孤儿规则永远匹配不上任何请求，不影响运行 → 只提示，别让 --strict 永远红
  if (orphans.length) warnings.push(`policy.csv 里这些 verb 在能力表里不存在：${orphans.join("、")}（历史遗留死规则，删掉不影响行为）`);
  const noRule = rows.filter((r) => r.code === "E_NO_RULE").map((r) => `${r.base}(${r.tier})`);
  if (noRule.length) issues.push(`能力存在但策略没写规则、默认拒绝：${[...new Set(noRule)].join("、")}`);

  const preset = currentPreset(home, now);
  const sup = readSuper(home);
  const eg = egressStatus(home, { now });
  const summary = {
    total: rows.length,
    ready: rows.filter((r) => r.verdict === "ready").length,
    confirm: rows.filter((r) => r.verdict === "confirm").length,
    grant: rows.filter((r) => r.verdict === "grant").length,
    blocked: rows.filter((r) => r.verdict === "blocked").length,
    probe: rows.filter((r) => r.verdict === "probe").length,
  };

  return {
    at: now.toISOString(),
    env: {
      policyFile: policyPath(home), preset: preset.preset, remainingS: preset.remainingS,
      superEnabled: sup.enabled, egressOpen: eg.open, egressForced: eg.forced,
    },
    rows, issues, warnings, summary,
  };
}

const MARK: Record<PermVerdict, string> = {
  ready: "✅ 可用", confirm: "⚠ 需确认", grant: "🔒 缺窗口", blocked: "❌ 不可用", probe: "⚪ 探针未就绪",
};

/** r.at 是 ISO UTC；显示成本地时间，别让人把它读成「现在」 */
function localStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 给人看的一张表：ASCII 列对齐，「为什么」按被拦的逐条列在下面（中文不参与对齐） */
export function formatPerms(r: PermReport): string {
  const NL = String.fromCharCode(10);
  const out: string[] = [];
  out.push(`权限自查 ${localStamp(r.at)} ｜ ${r.summary.total} 行：可用 ${r.summary.ready} · 需确认 ${r.summary.confirm} · 缺窗口 ${r.summary.grant} · 不可用 ${r.summary.blocked} · 探针未就绪 ${r.summary.probe}`);
  out.push(`档位  能力                              目标                       结论`);
  for (const row of r.rows) {
    const shortTarget = row.target.length > 24 ? row.target.slice(0, 23) + "…" : row.target;
    out.push(`${row.tier.padEnd(5)} ${row.verb.padEnd(34)} ${shortTarget.padEnd(26)} ${MARK[row.verdict]}`);
  }
  out.push("");
  out.push("── 被拦的 / 没测成的，逐条说为什么 ──");
  const stuck = r.rows.filter((x) => x.verdict !== "ready");
  if (!stuck.length) out.push("  （没有：全部可直接调用）");
  for (const row of stuck) {
    out.push(`  ${row.verb}  [${row.code ?? "—"}]  ${row.why}`);
    if (row.gates.length) out.push(`      闸门：${row.gates.join("；")}`);
  }
  out.push("");
  out.push(`── 本进程状态 ──`);
  out.push(`  授权档 ${r.env.preset}${r.env.remainingS > 0 ? `（还剩 ${r.env.remainingS}s）` : ""} · 超级权限 ${r.env.superEnabled ? "开" : "关"} · 出网闸 ${r.env.egressOpen ? (r.env.egressForced ? "开（环境变量强制）" : "开") : "关"}`);
  out.push(`  窗口/出网都是会话级内存状态，进程重启即失效；这里报的是「此刻」，不是「配置上」。`);
  out.push(`  T3 的确认层已在 2026-11-04 删除：策略放行后由授权窗口决定，不再逐次问人。`);
  out.push("");
  if (r.issues.length) {
    out.push(`── 结构问题 ${r.issues.length} 项（--strict 会判红）──`);
    for (const i of r.issues) out.push(`  · ${i}`);
  } else out.push("✅ 没有会拦住能力的结构问题");
  if (r.warnings.length) {
    out.push(`── 历史遗留 ${r.warnings.length} 项（不判红）──`);
    for (const w of r.warnings) out.push(`  · ${w}`);
  }
  return out.join(NL);
}
