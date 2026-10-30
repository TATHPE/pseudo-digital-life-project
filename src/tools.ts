/**
 * 工具面（给模型看）——现在只有**一条**执行路径：
 *
 *   模型 → tool → execute() → policy → verb → exec_audit
 *
 * 之前 `tools.ts` 自己实现了一套 fs/memory 工具，和 `verbs.ts` 并行存在，
 * 等于"两扇门，其中一扇没锁"。2026-10-28 合并：这里只做适配，不再有实现。
 */
import type { DatabaseSync } from "node:sqlite";
import { execute, type ExecDeps, type ExecResult } from "./execute.ts";
import { verbs, type VerbCtx } from "./verbs.ts";

/**
 * 模型 API 的函数名只允许 `^[a-zA-Z0-9_-]+$`（DeepSeek/OpenAI 实测会 400）。
 * 我们的 verb 用点号命名（fs.read）是为了可读，所以对外暴露一份**下划线别名**，
 * 内部仍按点号记策略与审计。
 */
export const apiName = (canonical: string): string => canonical.replace(/\./g, "_");

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tier: string;
}

export interface ToolRegistry {
  list(): ToolSpec[];
  schema(): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>;
  run(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string; needsConfirm?: boolean; tier: string }>;
}

export interface RegistryDeps {
  db: DatabaseSync;
  policy: ExecDeps["policy"];
  ctx: VerbCtx;
  /** 外部工具（MCP）：同样要走策略与审计，只是实现不在 verbs 里 */
  external?: Array<ToolSpec & { call(args: Record<string, unknown>): Promise<string> }>;
  /**
   * 白名单：只暴露这些 verb（按规范名，如 `memory.search`）。
   *
   * 用途是「最小权限面」：夜间整理的模型只需要**只读**能力去核对已有记忆，
   * 不需要 shell、不需要写文件、更不需要 memory.remember —— 写入由确定性代码做。
   * 不给这个参数时保持原样（全部 verb），面板照旧拿全量。
   */
  allow?: (name: string) => boolean;
}

export function createToolRegistry(deps: RegistryDeps): ToolRegistry {
  const externals = deps.external ?? [];
  const mine = deps.allow ? verbs.filter((v) => deps.allow!(v.name)) : verbs;
  const ext = deps.allow ? externals.filter((e) => deps.allow!(e.name)) : externals;
  const all: ToolSpec[] = [
    ...mine.map((v) => ({ name: v.name, description: v.description, parameters: v.params, tier: v.tier })),
    ...ext.map(({ name, description, parameters, tier }) => ({ name, description, parameters, tier })),
  ];

  const alias = new Map(all.map((t) => [apiName(t.name), t.name]));
  const resolve = (n: string): string => alias.get(n) ?? n;

  return {
    list: () => all,
    schema: () => all.map((t) => ({
      type: "function" as const,
      function: { name: apiName(t.name), description: t.description, parameters: t.parameters },
    })),

    async run(rawName, args) {
      const name = resolve(rawName);
      // 白名单必须在**执行侧**也生效：只从 schema 里藏起来不算数 ——
      // 模型硬报一个名字（幻觉/被注入）就能绕过，那就等于没有白名单。
      if (!all.some((t) => t.name === name)) {
        return { ok: false, output: `E_NO_CAPABILITY: ${name}`, tier: "?" };
      }
      // 内部 verb：走完整 execute（策略 + 审计）
      if (mine.some((v) => v.name === name)) {
        const r: ExecResult = await execute({ db: deps.db, policy: deps.policy, ctx: deps.ctx }, name, args);
        return { ok: r.ok, output: r.output, tier: r.tier, ...(r.needsConfirm ? { needsConfirm: true } : {}) };
      }
      // 外部工具（MCP）：先策略、后执行、再审计
      const found = ext.find((e) => e.name === name);
      if (!found) return { ok: false, output: `E_NO_CAPABILITY: ${name}`, tier: "?" };
      const target = name.startsWith("mcp__") ? name : `ext:${name}`;
      const auth = await deps.policy.authorize(name, found.tier as never, target);
      const t0 = Date.now();
      if (!auth.allow) {
        audit(deps, name, found.tier, target, "denied", auth.reason, Date.now() - t0);
        return { ok: false, output: `E_DENIED(${auth.reason}): ${name}`, tier: found.tier };
      }
      try {
        const out = await found.call(args);
        audit(deps, name, found.tier, target, "allowed", undefined, Date.now() - t0);
        return { ok: true, output: out, tier: found.tier };
      } catch (e) {
        const code = String((e as Error).message ?? e).split(":")[0] || "E_TOOL";
        audit(deps, name, found.tier, target, "error", code, Date.now() - t0);
        return { ok: false, output: `E_TOOL(${code}): ${String(e).slice(0, 200)}`, tier: found.tier };
      }
    },
  };
}

function audit(
  deps: RegistryDeps, verb: string, tier: string, target: string,
  decision: string, code: string | undefined, ms: number,
): void {
  try {
    deps.db.prepare(
      `INSERT INTO exec_audit(id,ts,verb,tier,argv_json,cwd,exit_code,duration_ms,decision,deny_reason)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `ext-${Date.now()}-${Math.round(Math.random() * 1e6)}`, deps.ctx.now().toISOString(),
      verb, tier, target.slice(0, 200), deps.ctx.home, decision === "allowed" ? 0 : 1, ms, decision, code ?? null,
    );
  } catch { /* 审计失败不阻断，但会在 verify 里暴露 */ }
}
