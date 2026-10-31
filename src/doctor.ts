/**
 * 体检（D-6）
 *
 * 它不是"再写一套检查"，而是把已经有的事实**汇总成一句话**：
 * 库能不能开、策略能不能读、配置能不能解、索引是不是过期、端点通不通、能力表降级了啥。
 * 数据全来自既有模块（`selfCheck` / `checkConfig` / `indexState` / `preflight` / `capabilities`）。
 *
 * 两个刻意的取舍：
 *  1. **默认只做结构检查**（<1 s）。要跑四条完整自检（check / eval / redteam / smoke）用 `--full`
 *     —— 那四条加起来十几秒，不该混进"快速看一眼"。
 *  2. **导出必须脱敏**：诊断包会发给别人看，所以路径里的 home 变成 `<home>`，
 *     任何 `sk-…` 形状的串一律抹掉，**不打包 `data/secrets/` 与记忆正文**。
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { selfCheck } from "./db.ts";
import { checkConfig } from "./startupcheck.ts";
import { indexState } from "./embedindex.ts";
import { preflight } from "./preflight.ts";
import { capabilities, type Capabilities } from "./capabilities.ts";
import { resolveConfig } from "./configfile.ts";
import { modelKeyOf } from "./config.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  at: string;
  checks: Check[];
  degraded: string[];
  capabilities?: Capabilities;
}

export interface DoctorDeps {
  db: DatabaseSync;
  home: string;
  /** 跳过端点探测（测试里用） */
  skipPreflight?: boolean;
  /** 带上真实 MCP 结果 */
  mcp?: { servers: string[]; tools: string[]; errors: string[] };
}

export async function doctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: Check[] = [];
  const cfg = resolveConfig(deps.home);

  // ① 库
  try {
    const sc = selfCheck({ db: deps.db, vecLoaded: true } as never);
    const notes = sc.notes.filter((n) => !n.includes("vec"));
    checks.push({ name: "db", ok: notes.length === 0, detail: notes.length ? notes.join("；") : "quick_check ok · schema 一致" });
  } catch (e) {
    checks.push({ name: "db", ok: false, detail: String((e as Error).message).slice(0, 120) });
  }

  // ② 配置与策略（结构，不连网）
  const cfgProblems = checkConfig(deps.home);
  const fatal = cfgProblems.filter((p) => p.fatal);
  checks.push({
    name: "config", ok: fatal.length === 0,
    detail: fatal.length ? fatal.map((p) => `[${p.code}] ${p.detail}`).join("；") : (cfgProblems.length ? `仅警告 ${cfgProblems.length} 项` : "config/policy 结构正常"),
  });

  // ③ 索引身份
  try {
    const ix = indexState(deps.db, modelKeyOf(cfg.roles["embed"]));
    checks.push({
      name: "index", ok: !ix.stale,
      detail: ix.stale ? `索引用 ${ix.built ?? "未知"} 建，当前 ${ix.current ?? "未配置"}（跑 jingjing reembed）` : `${ix.vectors} 条向量 · ${ix.current ?? "—"}`,
    });
  } catch (e) {
    checks.push({ name: "index", ok: false, detail: String((e as Error).message).slice(0, 120) });
  }

  // ④ 端点（只读缓存 or 探一次）
  if (!deps.skipPreflight) {
    const pf = await preflight(cfg.ollama);
    checks.push({
      name: "endpoint", ok: pf.online,
      detail: pf.online ? `${pf.base} · 已装 ${pf.names.length} 个模型` : `${pf.base} 不可达${pf.error ? `（${pf.error}）` : ""}`,
    });
  }

  // ⑤ 能力表（它已经把 degraded 汇总好了）
  const cap = await capabilities({
    db: deps.db, home: deps.home, cfg, commands: [],
    ...(deps.mcp ? { mcp: deps.mcp } : {}),
    ...(deps.skipPreflight ? { ollama: null } : {}),
  });

  return {
    // ok 只看 checks：degraded 里有些是"已知缺口"（没装本地模型、hooks 未实现），
    // 它们不该让体检永远退 1 —— 那就没法定成门。要卡它们用 --strict。
    ok: checks.every((c) => c.ok),
    at: new Date().toISOString(),
    checks,
    degraded: cap.degraded,
    capabilities: cap,
  };
}

/** 脱敏：路径里的 home → <home>；`sk-…` 形状 → <redacted> */
export function redact(text: string, home: string): string {
  const out = String(text)
    .split(home).join("<home>")
    .split(home.split("\\").join("/")).join("<home>")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "<redacted-key>");
  return out;
}

export interface ExportResult { dir: string; files: string[]; bytes: number }

/**
 * 导出诊断包。**不打包 secrets 与记忆正文**，只放：体检报告、能力表、最近事件、环境摘要。
 */
export function exportDiag(report: DoctorReport, home: string, db: DatabaseSync, extra: Record<string, unknown> = {}): ExportResult {
  const dir = join(home, "diag", report.at.replace(/[:.]/g, "-").slice(0, 19));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const put = (name: string, content: string) => {
    const body = redact(content, home);
    writeFileSync(join(dir, name), body, "utf8");
    files.push(name);
  };

  put("doctor.json", JSON.stringify(report, null, 2));
  put("env.json", JSON.stringify({
    node: process.version, platform: process.platform, arch: process.arch,
    cwd: process.cwd(), home, ...extra,
  }, null, 2));

  // 最近 20 条事件（不含 payload 里的记忆正文，只留 kind/actor/target）
  try {
    const rows = db.prepare("SELECT ts,kind,actor,target,ok FROM events ORDER BY rowid DESC LIMIT 20").all();
    put("events.json", JSON.stringify(rows, null, 2));
  } catch { /* 没有 events 表就算了 */ }

  let bytes = 0;
  for (const f of files) {
    try { bytes += statSync(join(dir, f)).size; } catch { /* ignore */ }
  }
  return { dir, files, bytes };
}
