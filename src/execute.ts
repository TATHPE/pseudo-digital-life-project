/**
 * 执行入口（04 §4）：**策略 → 执行 → 审计**，一个都不能少。
 * 所有 verb 调用都必须走这里，包括 agent 通过工具调用触发的。
 */
import type { DatabaseSync } from "node:sqlite";
import { verbByName, type VerbCtx, type VerbDef } from "./verbs.ts";
import type { Policy } from "./policy.ts";
import { newEventId } from "./journal.ts";

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
}

export interface ExecDeps {
  db: DatabaseSync;
  policy: Policy;
  ctx: VerbCtx;
}

const AUDIT = `INSERT INTO exec_audit(id,ts,verb,tier,argv_json,cwd,exit_code,duration_ms,decision,deny_reason)
               VALUES(?,?,?,?,?,?,?,?,?,?)`;

export async function execute(
  deps: ExecDeps, verb: string, args: Record<string, unknown>, opts: { approved?: boolean } = {},
): Promise<ExecResult> {
  const def: VerbDef | undefined = verbByName(verb);
  const t0 = Date.now();
  const ts = deps.ctx.now().toISOString();
  const audit = (decision: string, code?: string, tier = "?", ms = 0) => {
    try {
      deps.db.prepare(AUDIT).run(newEventId(new Date(ts)), ts, verb, tier, JSON.stringify(args).slice(0, 500),
        deps.ctx.home, decision === "allowed" ? 0 : 1, ms, decision, code ?? null);
    } catch { /* 审计失败不该拖垮执行，但也绝不静默——失败会体现在 verify 里 */ }
  };

  if (!def) {
    audit("denied", "E_NO_CAPABILITY");
    return { ok: false, output: `E_NO_CAPABILITY: ${verb}（能力表里没有它）`, tier: "?", strength: null, verb, ms: 0, code: "E_NO_CAPABILITY" };
  }

  const target = def.target(args, deps.ctx);
  const auth = await deps.policy.authorize(def.name, def.tier, target);
  if (!auth.allow) {
    audit("denied", auth.reason, def.tier);
    return { ok: false, output: `E_DENIED(${auth.reason}): ${verb} ${target}`, tier: def.tier, strength: auth.strength, verb, ms: 0, code: auth.reason };
  }

  // advise 档：记录但不拦。enforce 档：T2/T3 需要显式 approved
  // 只有 T2 及以上才需要人工确认；T1 的 enforce 含义是"必须留快照/可回滚"，不是"必须问你"
  if (auth.strength === "enforce" && (def.tier === "T2" || def.tier === "T3") && !opts.approved) {
    audit("needs_confirm", "E_NEEDS_CONFIRM", def.tier);
    return {
      ok: false, output: `E_NEEDS_CONFIRM: ${verb} 需要你确认（档位 ${def.tier}）`,
      tier: def.tier, strength: auth.strength, verb, ms: 0, code: "E_NEEDS_CONFIRM", needsConfirm: true,
    };
  }

  try {
    const out = await def.run(args, deps.ctx);
    const ms = Date.now() - t0;
    audit("allowed", undefined, def.tier, ms);
    return { ok: true, output: out, tier: def.tier, strength: auth.strength, verb, ms };
  } catch (e) {
    const code = String((e as Error).message ?? e).split(":")[0] || "E_VERB";
    const ms = Date.now() - t0;
    audit("error", code, def.tier, ms);
    return { ok: false, output: `E_VERB(${code}): ${String((e as Error).message ?? e).slice(0, 200)}`, tier: def.tier, strength: auth.strength, verb, ms, code };
  }
}
