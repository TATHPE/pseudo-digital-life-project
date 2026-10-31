/**
 * 执行入口（04 §4）：**策略 → 执行 → 审计**，一个都不能少。
 * 所有 verb 调用都必须走这里，包括 agent 通过工具调用触发的。
 *
 * T3 的确认不走"布尔许可"，走**一次性令牌**（04 §4.1）：
 *   无令牌 → E_NEEDS_CONFIRM（附将要执行的确切 argv，人可以照着复现）
 *   带令牌 → 校验 argv_sha256 + 过期 + 单次，**标记 used 之后**才执行
 *   人确认 → 现场签发一枚、立刻用掉（同一个函数，不一分为二）
 * 于是"确认一次、后面随便用"在设计上就不成立：令牌用完就是死的。
 */
import type { DatabaseSync } from "node:sqlite";
import { verbByName, type VerbCtx, type VerbDef } from "./verbs.ts";
import type { Policy } from "./policy.ts";
import { newEventId } from "./journal.ts";
import { argvSha256, consumeToken, hostProfile, issueToken } from "./shell.ts";
import { checkGrant } from "./grant.ts";
import { recordPending } from "./confirm.ts";

export interface ExecResult {
  ok: boolean;
  output: string;
  tier: string;
  strength: string | null;
  verb: string;
  ms: number;
  code?: string;
  /** 需要用户确认（advise/enforce 的下一阶段由调用方决定） */
  needsConfirm?: boolean;
  /** T3：本次执行用的令牌 id（审计里也能查到） */
  capability?: string;
  /** T3：确认时要人看到的东西（确切 argv，不是"大概要跑什么"） */
  confirm?: { template: string; argv: string[]; cwd: string; digest: string };
}

export interface ExecDeps {
  db: DatabaseSync;
  policy: Policy;
  ctx: VerbCtx;
}

const AUDIT = `INSERT INTO exec_audit(id,ts,verb,tier,argv_json,cwd,exit_code,duration_ms,decision,deny_reason,capability,host_profile)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`;

export async function execute(
  deps: ExecDeps, verb: string, args: Record<string, unknown>,
  opts: { approved?: boolean; token?: string } = {},
): Promise<ExecResult> {
  const def: VerbDef | undefined = verbByName(verb);
  const t0 = Date.now();
  const ts = deps.ctx.now().toISOString();
  const home = deps.ctx.home;
  const audit = (
    decision: string, code?: string, tier = "?", ms = 0,
    extra: { argv?: string[]; cwd?: string; capability?: string; profile?: string } = {},
  ) => {
    try {
      deps.db.prepare(AUDIT).run(newEventId(new Date(ts)), ts, verb, tier,
        (extra.argv ? JSON.stringify({ template: args.template, argv: extra.argv, slots: args.slots ?? {} })
          : JSON.stringify(args)).slice(0, 500),
        extra.cwd ?? home, decision === "allowed" ? 0 : 1, ms, decision, code ?? null,
        extra.capability ?? null, extra.profile ?? null);
    } catch { /* 审计失败不该拖垮执行，但也绝不静默——失败会体现在 verify 里 */ }
  };

  if (!def) {
    audit("denied", "E_NO_CAPABILITY");
    return { ok: false, output: `E_NO_CAPABILITY: ${verb}（能力表里没有它）`, tier: "?", strength: null, verb, ms: 0, code: "E_NO_CAPABILITY" };
  }

  const target = def.target(args, deps.ctx);
  // 有效档位：默认就是 verb 自己的档位；shell.run 这种由参数（模板）决定档位的走 tierFor
  const tier = def.tierFor ? def.tierFor(args) : def.tier;
  const auth = await deps.policy.authorize(def.name, tier, target);
  if (!auth.allow) {
    audit("denied", auth.reason, tier);
    return { ok: false, output: `E_DENIED(${auth.reason}): ${verb} ${target}`, tier: tier, strength: auth.strength, verb, ms: 0, code: auth.reason };
  }

  // ── T3：先把参数渲染成确切 argv，再谈令牌 ──────────────────
  let proposal: { argv: string[]; cwd: string; template: string; profile?: string } | null = null;
  let digest = "";
  let tokenId: string | undefined;
  // K-3：授权窗口命中时记下它，传给 verb（shell.run 靠它决定要不要脱敏环境）
  let grantHit: ReturnType<typeof checkGrant> | null = null;
  let grantCtx: { id: string; commands: string[]; scope: string } | undefined;
  if (tier === "T3") {
    try {
      proposal = def.capability ? def.capability(args, deps.ctx) : null;
    } catch (e) {
      const code = String((e as Error).message ?? e).split(":")[0] || "E_BAD_ARGV";
      audit("denied", code, tier);
      return { ok: false, output: String((e as Error).message ?? e).slice(0, 300), tier: tier, strength: auth.strength, verb, ms: 0, code };
    }
    if (!proposal) {
      audit("denied", "E_NO_CAPABILITY", tier);
      return { ok: false, output: `E_NO_CAPABILITY: ${verb} 是 T3 但没有 argv 渲染器，无法签发令牌`, tier: tier, strength: auth.strength, verb, ms: 0, code: "E_NO_CAPABILITY" };
    }
    digest = argvSha256(proposal.argv, proposal.cwd);
    // 人不在终端时，把"这次想跑什么"留在面板上（否则这张拒绝就是一张废纸）
    const remember = () => {
      try {
        recordPending(home, {
          verb: def!.name, template: proposal!.template,
          args: { template: String(args.template ?? ""), slots: (args.slots ?? {}) },
          argv: proposal!.argv, cwd: proposal!.cwd, digest, source: "agent", now: new Date(ts),
        });
      } catch { /* 记不下不影响拒绝本身 */ }
    };

    const given = String(opts.token ?? args.token ?? "");
    if (given) {
      const c = consumeToken(home, given, { verb: def.name, digest }, new Date(ts));
      if (!c.ok) {
        audit("denied", c.code, tier, 0, { argv: proposal.argv, cwd: proposal.cwd, profile: hostProfile() });
        remember();
        return {
          ok: false, output: `${c.code}: 令牌无效（${def.name} ${proposal.template}）——需要重新确认`,
          tier: tier, strength: auth.strength, verb, ms: 0, code: c.code, needsConfirm: true,
          confirm: { template: proposal.template, argv: proposal.argv, cwd: proposal.cwd, digest },
        };
      }
      tokenId = c.token.token;
    } else if (opts.approved) {
      // 人就在跟前：签发一枚绑定到这条 argv 的令牌，立刻用掉
      const t = issueToken(home, {
        verb: def.name, template: proposal.template, digest, cwd: proposal.cwd,
        now: new Date(ts), issuedBy: "user",
      });
      const c = consumeToken(home, t.token, { verb: def.name, digest }, new Date(ts));
      if (!c.ok) {
        audit("denied", c.code, tier);
        return { ok: false, output: `${c.code}: 令牌签发后立刻失效（系统时钟？）`, tier: tier, strength: auth.strength, verb, ms: 0, code: c.code };
      }
      tokenId = t.token;
    } else if ((grantHit = checkGrant(home, { argv: proposal.argv, cwd: proposal.cwd }, new Date(ts))).ok) {
      // K-3：落在会话授权窗口里 → 不再逐次要令牌，但仍然逐条审计（capability = grant:<id>）
      const g = grantHit as { ok: true; id: string; commands: string[]; scope: string; expiresAt: string };
      tokenId = `grant:${g.id}`;
      grantCtx = { id: g.id, commands: g.commands, scope: g.scope };
    } else {
      audit("needs_confirm", "E_NEEDS_CONFIRM", tier, 0, { argv: proposal.argv, cwd: proposal.cwd, profile: hostProfile() });
      remember();
      return {
        ok: false,
        output: `E_NEEDS_CONFIRM: ${verb} 需要你确认（档位 T3）` + String.fromCharCode(10) +
          `将执行：${proposal.argv.map((x) => (x.includes(" ") ? JSON.stringify(x) : x)).join(" ")}` + String.fromCharCode(10) +
          `目录：${proposal.cwd}  ｜ 指纹：${digest.slice(0, 16)}`,
        tier: tier, strength: auth.strength, verb, ms: 0, code: "E_NEEDS_CONFIRM", needsConfirm: true,
        confirm: { template: proposal.template, argv: proposal.argv, cwd: proposal.cwd, digest },
      };
    }
  }

  // advise 档：记录但不拦。enforce 档：T2 需要显式 approved
  // 只有 T2 及以上才需要人工确认；T1 的 enforce 含义是"必须留快照/可回滚"，不是"必须问你"
  if (auth.strength === "enforce" && tier === "T2" && !opts.approved) {
    audit("needs_confirm", "E_NEEDS_CONFIRM", tier);
    return {
      ok: false, output: `E_NEEDS_CONFIRM: ${verb} 需要你确认（档位 ${tier}）`,
      tier: tier, strength: auth.strength, verb, ms: 0, code: "E_NEEDS_CONFIRM", needsConfirm: true,
    };
  }

  const extra = {
    argv: proposal?.argv, cwd: proposal?.cwd,
    capability: tokenId,
    profile: tier === "T3" ? (proposal?.profile ?? hostProfile()) : undefined,
  };
  try {
    const out = await def.run(args, grantCtx ? { ...deps.ctx, grant: grantCtx } : deps.ctx);
    const ms = Date.now() - t0;
    audit("allowed", undefined, tier, ms, extra);
    return { ok: true, output: out, tier: tier, strength: auth.strength, verb, ms, ...(tokenId ? { capability: tokenId } : {}) };
  } catch (e) {
    const code = String((e as Error).message ?? e).split(":")[0] || "E_VERB";
    const ms = Date.now() - t0;
    audit("error", code, tier, ms, extra);
    return { ok: false, output: `E_VERB(${code}): ${String((e as Error).message ?? e).slice(0, 200)}`, tier: tier, strength: auth.strength, verb, ms, code, ...(tokenId ? { capability: tokenId } : {}) };
  }
}
