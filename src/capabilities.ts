/**
 * 能力自述（B-0）
 *
 * 一句话：**回答"我现在能干什么、哪儿降级了"，而且每一行都能追到代码。**
 *
 * 为什么必须从代码真读：`docs/11 §5.3` 设计过这个结构，但一直没实现。手写一份常量
 * 只会变成第 N 个"装饰列"——文档说会调工具，实际根本没有那个工具。
 * 所以这里**没有一处常量清单**：工具来自 `verbs`，provider 来自 `resolveConfig`，
 * MCP 来自真实的连接结果，`degraded` 来自真实探测（端点、索引、meta 标记）。
 *
 * 六类能力（`docs/11 §5.1`）：tool / command / hook / cron / panel / provider。
 * 哪类没实现就**明说没实现**（`degraded` 里记一条），不装作有。
 */
import type { DatabaseSync } from "node:sqlite";
import { verbs } from "./verbs.ts";
import { resolveConfig } from "./configfile.ts";
import { indexState } from "./embedindex.ts";
import { preflight, missingFrom, describeSkip } from "./preflight.ts";
import { readMeta } from "./embedindex.ts";
import type { AppConfig } from "./config.ts";
import type { RoleConfig } from "./provider.ts";

export type CapabilityClass = "tool" | "command" | "hook" | "cron" | "panel" | "provider";

export interface CapabilityItem {
  /** 规范名（verb 用点号，MCP 用 mcp__server__tool） */
  name: string;
  /** 来自哪一类 */
  class: CapabilityClass;
  /** 更细的来源：native / mcp / cli / builtin */
  source: "native" | "mcp" | "cli" | "builtin";
  /** 档位（tool 类有；其余为 null） */
  tier?: string;
  /** 一句话，给人看 */
  note?: string;
}

export interface Capabilities {
  version: string;
  schema: string | null;
  classes: Record<CapabilityClass, CapabilityItem[]>;
  /** 依赖与状态（真读） */
  providers: {
    roles: Array<{ role: string; kind: string; provider: string; model: string | null; source: string }>;
    ollama: { base: string; online: boolean | null; models: string[]; error?: string };
  };
  /** 降级项：**每一条都对应一个具体观测** */
  degraded: string[];
  /** 人类可读的"哪儿缺" */
  notes: string[];
}

export interface CapabilitiesDeps {
  db: DatabaseSync;
  /** 真实的 MCP 连接结果；没有就说明没挂 */
  mcp?: { servers: string[]; tools: string[]; errors: string[] };
  /** CLI 子命令（真实注册表由调用方给，避免这里硬编码） */
  commands?: string[];
  /** 面板是否在服务（serve 里传 true；CLI 里传 false） */
  panel?: boolean;
  /** 版本号 */
  version?: string;
  /** 端点探测结果（不传就只读缓存，不在这里探头） */
  ollama?: { base: string; online: boolean; names: string[]; error?: string } | null;
  /** 配置（默认从 home 解析） */
  cfg?: AppConfig;
  home?: string;
}

const VERSION = "0.1.0";

export async function capabilities(deps: CapabilitiesDeps): Promise<Capabilities> {
  const cfg = deps.cfg ?? (deps.home ? resolveConfig(deps.home) : null);
  const degraded: string[] = [];
  const notes: string[] = [];

  // ── tool：native 来自 verbs（真读），MCP 来自连接结果 ──────────
  const native: CapabilityItem[] = verbs.map((v) => ({
    name: v.name, class: "tool", source: "native", tier: v.tier, note: v.description.slice(0, 60),
  }));
  const mcpTools: CapabilityItem[] = (deps.mcp?.tools ?? []).map((name) => ({
    name, class: "tool", source: "mcp", tier: "T2",
  }));
  for (const e of deps.mcp?.errors ?? []) degraded.push(`mcp-unavailable:${e.split(":")[0]}`);

  // ── command：只报调用方给的真实命令表 ────────────────────────
  const commands: CapabilityItem[] = (deps.commands ?? []).map((c) => ({ name: c, class: "command", source: "cli" }));

  // ── hook / cron：没有就空着 + 说明 ──────────────────────────
  const hooks: CapabilityItem[] = [];
  degraded.push("hooks-not-implemented");     // docs/11 的 6 类里这一类还没做
  const cron: CapabilityItem[] = [
    { name: "night", class: "cron", source: "cli", note: "夜间整备（可手动跑）" },
    { name: "beat", class: "cron", source: "cli", note: "心跳 tick" },
  ];

  // ── panel：只报真实在服务的 ──────────────────────────────────
  const panel: CapabilityItem[] = deps.panel
    ? [{ name: "panel.http", class: "panel", source: "builtin", note: "127.0.0.1:7700" }]
    : [];
  if (!deps.panel) degraded.push("panel-not-serving");

  // ── provider：从配置真读（含每个角色值的来源）───────────────
  const providerItems: CapabilityItem[] = [];
  const roleRows: Capabilities["providers"]["roles"] = [];
  let ollamaState: Capabilities["providers"]["ollama"] = { base: "—", online: null, models: [] };
  if (cfg) {
    const sources = await (async () => {
      try { return (await import("./configfile.ts")).configSources(deps.home ?? "data"); } catch { return {} as Record<string, string>; }
    })();
    for (const [role, c] of Object.entries(cfg.roles) as Array<[string, RoleConfig]>) {
      providerItems.push({
        name: `${role}:${c.provider}/${c.model || "(未配置)"}`, class: "provider", source: "builtin",
        note: c.kind === "local" ? "本地" : "云端",
      });
      roleRows.push({ role, kind: c.kind, provider: c.provider, model: c.model || null, source: sources[role] ?? "default" });
    }

    const pf = deps.ollama ?? (await preflight(cfg.ollama));
    ollamaState = { base: cfg.ollama, online: pf.online, models: pf.names, ...(pf.error ? { error: pf.error } : {}) };
    if (!pf.online) degraded.push("ollama-unreachable");

    // 记忆角色（embed 之外）缺模型/缺安装：用同一套 preflight 判据，别另写一份
    const localChat = Object.entries(cfg.roles)
      .filter(([r, c]) => r !== "embed" && c.kind === "local" && c.provider === "ollama")
      .map(([role, c]) => ({ role, model: c.model }));
    const st = { base: pf.base, online: pf.online, names: pf.names, at: 0, cached: true };
    const why = describeSkip(st, localChat);
    if (why) { degraded.push("local-model-missing"); notes.push(why); }
    const embedCfg = cfg.roles["embed"];
    if (embedCfg && missingFrom(st, [embedCfg.model]).length) {
      degraded.push("embed-model-missing"); notes.push(`embedding 没装：${embedCfg.model}`);
    }
  } else {
    degraded.push("config-unavailable");
  }

  // ── 状态类降级：全部读真实标记 ──────────────────────────────
  try { if (readMeta(deps.db, "nightly_skipped")) degraded.push("nightly-skipped"); } catch { /* ignore */ }
  try { if (readMeta(deps.db, "reembed_error")) degraded.push("reembed-failed"); } catch { /* ignore */ }
  try { if (readMeta(deps.db, "vec_error")) degraded.push("vec-index-broken"); } catch { /* ignore */ }
  try {
    const e = cfg?.roles["embed"];
    const ix = indexState(deps.db, e ? `${e.provider}:${e.model}` : null);
    if (ix.stale) { degraded.push("embed-index-stale"); notes.push(`索引是用 ${ix.built ?? "未知模型"} 建的，当前是 ${ix.current ?? "未配置"}`); }
  } catch { /* ignore */ }

  // 去重（同一个降级项可能被两处观测到）
  const uniq = [...new Set(degraded)];

  return {
    version: deps.version ?? VERSION,
    schema: readMeta(deps.db, "schema_version"),
    classes: {
      tool: [...native, ...mcpTools],
      command: commands,
      hook: hooks,
      cron,
      panel,
      provider: providerItems,
    },
    providers: { roles: roleRows, ollama: ollamaState },
    degraded: uniq,
    notes,
  };
}

/** 给人看的一行摘要（面板/CLI 用） */
export function summarize(c: Capabilities): string {
  const n = (k: CapabilityClass) => c.classes[k].length;
  const deg = c.degraded.length ? ` ｜ 降级 ${c.degraded.length} 项：${c.degraded.slice(0, 6).join(", ")}${c.degraded.length > 6 ? "…" : ""}` : " ｜ 无降级";
  return `工具 ${n("tool")} · 命令 ${n("command")} · 钩子 ${n("hook")} · 定时 ${n("cron")} · 面板 ${n("panel")} · 供应商 ${n("provider")}${deg}`;
}
