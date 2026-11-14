/**
 * 状态 / 只读 GET 路由（从 web/server.ts 抽出，行为逐字不变）。
 * 命中任一路由就自己写响应并 return true；没命中 return false。
 * 只通过 StatusCtx 拿闭包量，不与 server.ts 形成运行期循环依赖。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { intParam } from "../query.ts";
import type { DatabaseSync } from "node:sqlite";
import { readEvents } from "../../journal.ts";
import { getSession } from "../../sessions.ts";
import { readStateSafe } from "../../deploy/slot.ts";
import { meta } from "../../db.ts";
import { lastPreflight } from "../../preflight.ts";
import { modelKeyOf } from "../../config.ts";
import { gate as coolGate } from "../../cooldown.ts";
import { indexState } from "../../embedindex.ts";
import { spentToday } from "../../budget.ts";
import { releaseInfo, checkLocalUpdate, workspaceRoot } from "../../release.ts";

/**
 * 只声明本模块真正用到的 deps 字段（结构化类型，WebDeps 天然可赋值）。
 * 不 import server.ts 的 WebDeps —— 连 type-only 的反向引用都不留，
 * 否则 server.ts → status.ts → server.ts 又是一个结构上的环。
 */
export interface StatusDeps {
  db: DatabaseSync;
  inboxDir: string;
  home: string;
  getConfig: () => { roles: Record<string, { provider: string; model: string; baseUrl?: string }>; ollama: string };
  budgetUsd?: number;
  /** 测试可注入：/api/update-check 读哪份 release.json；不传就用工作区根目录。 */
  releaseRoot?: string;
}

export interface StatusCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  deps: StatusDeps;
  now: () => Date;
  json: (res: ServerResponse, code: number, obj: unknown) => void;
}

export async function handleStatus(ctx: StatusCtx): Promise<boolean> {
  const { req, res, url, deps, now, json } = ctx;

  // 「我装的到底是哪版」：版本 / 运行时 / 更新策略。只读 package.json，不碰 DB、不联网。
  // 更新走人工校验覆盖安装，不在这里检查新版本（见 docs/ops/26）。
  if (req.method === "GET" && url.pathname === "/api/version") {
    json(res, 200, releaseInfo());
    return true;
  }

  // 只读：读工作区根目录的 release.json → 纯函数比版本（docs/ops/26 §1）。
  // 绝不联网 / 下载 / 安装；前端只把 notes / downloadUrl / sha256 当文本展示。
  // 没有清单或坏清单时回 hasUpdate:false + 中文说明，不让设置页被一份坏文件带崩。
  if (req.method === "GET" && url.pathname === "/api/update-check") {
    json(res, 200, checkLocalUpdate(deps.releaseRoot ?? workspaceRoot()));
    return true;
  }

  // ── 最近几晚闲时整理干了什么（用户：本地 LLM 完全未知）──
  if (req.method === "GET" && url.pathname === "/api/nightlog") {
    try {
      const rows = deps.db.prepare("SELECT ts,ok,payload FROM events WHERE kind='night' ORDER BY ts DESC LIMIT 14").all() as Array<{ ts: string; ok: number; payload?: string }>;
      json(res, 200, {
        runs: rows.map((r) => {
          let p: Record<string, unknown> = {};
          try { p = JSON.parse(String(r.payload ?? "{}")) as Record<string, unknown>; } catch { /* 坏数据当空 */ }
          return { ts: r.ts, ok: r.ok === 1, ...p };
        }),
      });
    } catch (e) {
      json(res, 500, { error: "E_NIGHTLOG", why: String((e as Error).message ?? e).slice(0, 120) });
    }
    return true;
  }

  // ── 活动：跨会话的最近几条（2026-11-05）──
  if (req.method === "GET" && url.pathname === "/api/activity") {
    try {
      const limit = intParam(url, "limit", 8, 1, 30);
      const { events } = readEvents(deps.inboxDir);
      const titles = new Map<string, string>();
      const rows = events
        .filter((e) => e.kind === "utterance" || e.kind === "agent_reply")
        .map((e) => {
          const p = (e.payload ?? {}) as { text?: string; session?: string };
          return { ts: e.ts, role: e.kind === "utterance" ? "user" : "agent", text: String(p.text ?? ""), session: String(p.session ?? "") };
        })
        .filter((r) => r.text.trim())
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, limit);
      for (const r of rows) {
        if (!r.session || titles.has(r.session)) continue;
        titles.set(r.session, getSession(deps.db, r.session)?.title ?? "");
      }
      json(res, 200, {
        items: rows.map((r) => ({ ...r, text: r.text.slice(0, 120), title: titles.get(r.session) ?? "" })),
      });
    } catch (e) { json(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 160) }); }
    return true;
  }

  // ── 日志：执行层的审计（2026-11-05）。按时间倒序，可按 verb/decision 过滤 ──
  if (req.method === "GET" && url.pathname === "/api/logs") {
    try {
      const limit = intParam(url, "limit", 100, 1, 300);
      const q = String(url.searchParams.get("q") ?? "").trim();
      const rows = deps.db.prepare(
        "SELECT ts,verb,tier,decision,exit_code,duration_ms,argv_json,deny_reason,capability FROM exec_audit ORDER BY ts DESC LIMIT ?",
      ).all(limit) as Array<Record<string, unknown>>;
      const items = rows.map((r) => ({
        ts: String(r.ts ?? ""),
        verb: String(r.verb ?? ""),
        tier: r.tier == null ? null : Number(r.tier),
        decision: String(r.decision ?? ""),
        exit: r.exit_code == null ? null : Number(r.exit_code),
        ms: r.duration_ms == null ? null : Number(r.duration_ms),
        argv: String(r.argv_json ?? "").slice(0, 400),
        why: r.deny_reason == null ? null : String(r.deny_reason).slice(0, 200),
        capability: r.capability == null ? null : String(r.capability),
      })).filter((x) => !q || (x.verb + " " + x.argv + " " + x.decision).toLowerCase().includes(q.toLowerCase()));
      json(res, 200, { items, count: items.length });
    } catch (e) { json(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 160) }); }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    const dep = readStateSafe(deps.home);
    const degraded: string[] = [];
    if (dep.corrupt) degraded.push("deploy_state_corrupt");
    let memories = 0;
    try { memories = Number((deps.db.prepare("SELECT count(*) c FROM memories WHERE status='active'").get() as { c?: number })?.c ?? 0); }
    catch { degraded.push("db_unreadable"); }
    // 闲时整理降级是**可见状态**，不是日志里的一行（E-6：否则 energy 滑到 0 也没人知道为什么）
    try { if (meta(deps.db, "nightly_skipped")) degraded.push("nightly-skipped"); } catch { /* ignore */ }
    // 索引身份（C-2）：换了 embedding 模型却没重建 → 召回不可信，必须让探针看得见
    try {
      const cfgNow0 = deps.getConfig();
      const localRoles0 = Object.values(cfgNow0.roles).filter((r) => String((r as { kind?: string }).kind) === "local");
      if (localRoles0.length) {
        // 只读缓存，不在这里探头（探针不该拉长探针）
        const st = lastPreflight(cfgNow0.ollama);
        if (st && !st.online) degraded.push("ollama-unreachable");
      }
    } catch { /* ignore */ }
    try {
      const cfgNow = deps.getConfig();
      const cur = modelKeyOf(cfgNow.roles["embed"]);
      const cg = coolGate(cfgNow.roles["express"]?.provider ?? "");
      if (cg.blocked) degraded.push("cloud-cooldown");
      const ix = indexState(deps.db, cur);
      if (ix.stale) degraded.push("embed-index-stale");
      // 覆盖率：模型没换也可能"有记忆没向量"（实测 157 条里只有 29 条有）——
      // 那时检索会静默漏掉一多半记忆，而 /health 一直说一切正常。
      if (ix.missing > 0) degraded.push("embed-index-incomplete:" + ix.missing);
    } catch { /* ignore */ }
    // 本地模型到底在干什么：这一块之前完全没有出口（用户原话：完全未知）。
    let localInfo: Record<string, unknown> = {};
    try {
      const cfgL = deps.getConfig();
      const { probeOllama } = await import("../../ollama.ts");
      const { embedStats } = await import("../../embed.ts");
      const pf = await probeOllama(cfgL.ollama ?? "http://127.0.0.1:11434", 700).catch(() => null);
      const anyCfg = cfgL as unknown as { local?: { default?: string; night?: string } };
      const loc = anyCfg.local ?? {};
      let running: string[] = [];
      try {
        const ps = await fetch((cfgL.ollama ?? "http://127.0.0.1:11434") + "/api/ps", { signal: AbortSignal.timeout(700) });
        const j = (await ps.json()) as { models?: Array<{ name?: string }> };
        running = (j.models ?? []).map((m) => String(m.name ?? "")).filter(Boolean);
      } catch { /* 没在跑就是空的 */ }
      localInfo = {
        endpoint: cfgL.ollama ?? "http://127.0.0.1:11434",
        online: Boolean(pf && pf.online),
        installed: pf?.names ?? [],
        running,
        roles: { embed: cfgL.roles["embed"]?.model ?? null, night: loc.night ?? loc.default ?? null, shared: loc.default ?? null },
        embed: { calls: embedStats.calls, texts: embedStats.texts, ms: embedStats.ms, failed: embedStats.failed, lastAt: embedStats.lastAt || null },
      };
      if (meta(deps.db, "reembed_error")) degraded.push("reembed-failed");
    } catch { /* ignore */ }
    json(res, 200, {
      ok: true,
      schema: meta(deps.db, "schema_version") ?? null,
      release: dep.state.active,
      frozen: dep.state.freezeUntil && Date.parse(dep.state.freezeUntil) > now().getTime() ? dep.state.freezeUntil : null,
      memories,
      uptimeS: Math.round(process.uptime()),
      degraded,
      // 本地模型的状态（用户：「我根本就不知道它在干什么，它的工作状态完全未知」）
      local: localInfo,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    const limit = intParam(url, "limit", 60, 1, 200);
    const rows = deps.db.prepare(
      `SELECT ts,verb,tier,decision,deny_reason,duration_ms,capability,host_profile,cwd
         FROM exec_audit ORDER BY rowid DESC LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>;
    // 带上总数：只回“最近 N 条”却让人以为是全部，也是一种说谎
    const total = Number((deps.db.prepare("SELECT count(*) c FROM exec_audit").get() as { c?: number })?.c ?? 0);
    json(res, 200, {
      total,
      rows: rows.map((r) => ({
        ts: String(r.ts), verb: String(r.verb), tier: String(r.tier), decision: String(r.decision),
        reason: r.deny_reason ? String(r.deny_reason) : null,
        ms: Number(r.duration_ms ?? 0), capability: r.capability ? String(r.capability) : null,
        host: r.host_profile ? String(r.host_profile) : null,
      })),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/usage") {
    const spent = spentToday(deps.db);
    const row = deps.db.prepare(
      `SELECT count(*) n, sum(in_tokens) i, sum(out_tokens) o FROM usage WHERE ts >= date('now','localtime')`,
    ).get() as { n?: number; i?: number; o?: number };
    json(res, 200, {
      todayUsd: +spent.toFixed(6),
      calls: Number(row.n ?? 0),
      inTokens: Number(row.i ?? 0),
      outTokens: Number(row.o ?? 0),
      budgetUsd: deps.budgetUsd ?? 2,
    });
    return true;
  }

  return false;
}
