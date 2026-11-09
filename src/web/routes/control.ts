/**
 * 面板控制路由（从 web/server.ts 抽出，行为逐字不变）：提议 / 外发 / 闲时整理 /
 * 模式 / 权限档 / 回执 / 常驻指令 / 授权窗口 / 卷宗 / 线索 / 抽检 / 待确认。
 * 命中任一路由就自己写响应并 return true；没命中 return false。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { ToolRegistry } from "../../tools.ts";
import type { Mode } from "../../mode.ts";
import { loadPolicy, type Policy } from "../../policy.ts";
import { listProposals, getProposal, setProposalStatus } from "../../proposals.ts";
import { egressStatus, allowOnce, allowFor, revokeEgress } from "../../egress.ts";
import { readFileConfig, writeFileConfig } from "../../configfile.ts";
import { openGrant, listGrants, revokeGrant, currentPreset, setPreset, PRESETS, type Preset } from "../../grant.ts";
import { listReceipts, markSeen, unseenCount } from "../../notify.ts";
import { listStanding, disableStanding } from "../../standing.ts";
import { openThreads, closeThread } from "../../threads.ts";
import { reviewQueue, noteReviewed } from "../../surface.ts";
import { cutLink, linkKey } from "../../links.ts";
import { listPending, getPending, updatePending } from "../../confirm.ts";
import { execute } from "../../execute.ts";
import { appendEvent, newEventId } from "../../journal.ts";

/** 只声明本模块真正用到的 deps 字段（结构化类型，WebDeps 天然可赋值）。 */
export interface ControlDeps {
  db: DatabaseSync;
  home: string;
  inboxDir: string;
  tools?: ToolRegistry;
  getConfig: () => { roles: Record<string, { provider: string; model: string; baseUrl?: string }>; ollama: string };
  runNight?: () => Promise<number>;
  policy?: Policy;
}

export interface ControlCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  deps: ControlDeps;
  now: () => Date;
  /** createWebServer 的粘性档位：每次请求读当前值 */
  lastMode: Mode;
  json: (res: ServerResponse, code: number, obj: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
  writeGuarded: (req: IncomingMessage) => { ok: boolean; reason?: string };
}

export async function handleControl(ctx: ControlCtx): Promise<boolean> {
  const { req, res, url, deps, now, lastMode, json, readBody, writeGuarded } = ctx;
      // ── 提议（K-2）：它想做的事，人一句话决定 ──────────
      if (req.method === "GET" && url.pathname === "/api/proposals") {
        const st = (url.searchParams.get("status") ?? "open") as "open" | "accepted" | "rejected" | "all";
        json(res, 200, listProposals(deps.home, { status: st }));
        return true;
      }
      const propId = url.pathname.match(/^\/api\/proposals\/(prp_[0-9a-z]{6,40})$/);
      if (req.method === "POST" && propId) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { action?: string; reason?: string };
        const p = getProposal(deps.home, String(propId[1]));
        if (!p) { json(res, 404, { error: "E_PROPOSAL_NOT_FOUND" }); return true; }
        if (body.action !== "accept" && body.action !== "reject") { json(res, 400, { error: "E_BAD_ACTION" }); return true; }
        const next = setProposalStatus(
          deps.home, p.id, body.action === "accept" ? "accepted" : "rejected",
          String(body.reason ?? "").slice(0, 300) || (body.action === "accept" ? "我同意，你来做" : "不做"),
        );
        // 让它记住这次决定（下次别再提同一张卡）
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "utterance", actor: "user",
          payload: { text: `（关于「${p.title}」：${body.action === "accept" ? "我同意，你来做" : "不做"}${body.reason ? "，因为" + String(body.reason).slice(0, 80) : ""}）` },
        });
        json(res, 200, { ok: true, status: next?.status ?? null });
        return true;
      }

      // ── 代码外发（H-7）：默认拒；这里让人批「只这一次」/「10 分钟」──
      if (req.method === "GET" && url.pathname === "/api/egress") {
        json(res, 200, egressStatus(deps.home, { now: now() }));
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/egress") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { action?: string; path?: string; ttlMin?: number };
        if (body.action === "once") {
          if (!body.path) { json(res, 400, { error: "E_BAD_PATH" }); return true; }
          allowOnce(deps.home, body.path);
          json(res, 200, { ok: true, ...egressStatus(deps.home, { now: now() }) });
          return true;
        }
        if (body.action === "window") {
          const ttl = Math.min(60, Math.max(1, Number(body.ttlMin ?? 10))) * 60_000;
          const r = allowFor(deps.home, ttl, "面板上批了「这段时间可以」");
          json(res, 200, { ok: true, ...r, ...egressStatus(deps.home, { now: now() }) });
          return true;
        }
        if (body.action === "revoke") {
          revokeEgress(deps.home);
          json(res, 200, { ok: true, ...egressStatus(deps.home, { now: now() }) });
          return true;
        }
        json(res, 400, { error: "E_BAD_ACTION" });
        return true;
      }
      // ── 权限档位（形状照 DSH：当前会话用输入框旁的选择器切）──
      // ── 闲时整理：该不该跑（GET）+ 现在跑一次（POST）──
      if (req.method === "GET" && url.pathname === "/api/night/due") {
        try {
          const { dueInfo, nightRunning } = await import("../../nightdue.ts");
          json(res, 200, { ...dueInfo(deps.db), running: nightRunning() });
        } catch (e) { json(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 120) }); }
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/night/run") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        if (!deps.runNight) { json(res, 400, { error: "E_NO_NIGHT", why: "这个进程没有闲时整理入口" }); return true; }
        try {
          const code = await deps.runNight();
          json(res, 200, { ok: code === 0, code });
        } catch (e) {
          json(res, 500, { error: "E_NIGHT", why: String((e as Error)?.message ?? e).slice(0, 160) });
        }
        return true;
      }

      // ── 工作/聊天模式：chat 靠记忆召回，work 带最近几轮历史 + 更宽预算 ──
      if (req.method === "GET" && url.pathname === "/api/mode") {
        try {
          const raw = String(readFileConfig(deps.home).mode ?? "auto");
          const mode = raw === "work" ? "work" : raw === "chat" ? "chat" : "auto";
          json(res, 200, { mode, auto: mode === "auto", resolved: lastMode });
        }
        catch { json(res, 200, { mode: "chat" }); }
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/mode") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { mode?: string };
        const mode = body.mode === "work" ? "work" : body.mode === "chat" ? "chat" : "auto";
        writeFileConfig(deps.home, { mode });
        json(res, 200, { ok: true, mode });
        return true;
      }

      if (req.method === "GET" && url.pathname === "/api/permission") {
        const cur = currentPreset(deps.home, now());
        json(res, 200, { ...cur, presets: PRESETS });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/permission") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { preset?: string; because?: string; ttlMin?: number };
        const preset = String(body.preset ?? "") as Preset;
        if (!PRESETS.some((x) => x.id === preset)) { json(res, 400, { error: "E_BAD_PRESET" }); return true; }
        const r = setPreset(deps.home, preset, {
          ...(body.because ? { because: body.because } : {}),
          ...(body.ttlMin ? { ttlMs: Math.min(120, Math.max(1, Number(body.ttlMin))) * 60_000 } : {}),
        }, now());
        if (r.ok && preset === "full") {
          try {
            appendEvent(deps.inboxDir, {
              v: 1, id: newEventId(), ts: now().toISOString(), kind: "grant_full_open", actor: "user",
              payload: { preset, because: body.because ?? "", expiresAt: r.grant?.expiresAt ?? null },
            });
          } catch { /* 事件写不下不影响切档 */ }
        }
        json(res, r.ok ? 200 : 400, r);
        return true;
      }

      // ── 回执（D-3 的前置通道）：它做完的事必须能被看见 ──
      if (req.method === "GET" && url.pathname === "/api/receipts") {
        const unseenOnly = url.searchParams.get("unseen") !== "0";
        json(res, 200, { unseen: unseenCount(deps.home), items: listReceipts(deps.home, { unseenOnly, limit: 20 }) });
        return true;
      }
      const seenId = url.pathname.match(/^\/api\/receipts\/(rcp_[0-9a-z]{6,40})\/seen$/);
      if (req.method === "POST" && seenId) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const r = markSeen(deps.home, String(seenId[1]), now());
        json(res, r ? 200 : 404, r ? { ok: true, seen: true } : { error: "E_RECEIPT_NOT_FOUND" });
        return true;
      }

      // ── 常驻指令（D-3）：只读 + 停用；真正的触发由外部调 `jingjing standing tick` ──
      if (req.method === "GET" && url.pathname === "/api/standing") {
        json(res, 200, listStanding(deps.home));
        return true;
      }
      const standingOff = url.pathname.match(/^\/api\/standing\/([a-z][a-z0-9-]{2,30})\/disable$/);
      if (req.method === "POST" && standingOff) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { reason?: string };
        const o = disableStanding(deps.home, String(standingOff[1]), String(body.reason ?? "面板上停用"), now());
        json(res, o ? 200 : 404, o ? { ok: true, enabled: o.enabled } : { error: "E_STANDING_NOT_FOUND" });
        return true;
      }
      // ── 会话授权（K-3）：窗口活在**这个进程**里，重启即失效 ──
      if (req.method === "GET" && url.pathname === "/api/grants") {
        json(res, 200, listGrants(deps.home, now()));
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/grants") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { commands?: string; scope?: string; ttlMin?: number; because?: string; full?: boolean };
        const r = openGrant(deps.home, {
          full: body.full === true,
          commands: String(body.commands ?? "node").split(","),
          scope: String(body.scope ?? "workspace"),
          ttlMs: Math.min(120, Math.max(1, Number(body.ttlMin ?? 30))) * 60_000,
          because: String(body.because ?? ""),
        });
        if (r.ok && body.full === true) {
          // 全权窗口开过就要留痕：这条比普通窗口重要得多
          try {
            appendEvent(deps.inboxDir, {
              v: 1, id: newEventId(), ts: now().toISOString(), kind: "grant_full_open", actor: "user",
              payload: { id: r.grant.id, because: r.grant.because, expiresAt: r.grant.expiresAt },
            });
          } catch { /* 事件写不下不影响开窗 */ }
        }
        json(res, r.ok ? 200 : 400, r);
        return true;
      }
      const grantRevoke = url.pathname.match(/^\/api\/grants\/(grn_[0-9a-z]+)\/revoke$/);
      if (req.method === "POST" && grantRevoke) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const ok = revokeGrant(deps.home, String(grantRevoke[1]));
        json(res, ok ? 200 : 404, { ok, error: ok ? undefined : "E_NO_GRANT" });
        return true;
      }
      // ── 线索层：还没闭合的事（借 Twig 的 thread 概念，不新建表）──
      // ── 卷宗（右栏三签）：一把拿齐 Plan / Changes / Context ─────────
      // 为什么合成一个接口：三张卡每次都要一起刷新，分三个请求会让它们互相错位；
      // 而且这里**只读**（不写库、不跑命令），所以不需要 writeGuarded。
      if (req.method === "GET" && url.pathname === "/api/dossier") {
        const nowD = now();
        const agenda = await import("../../agenda.ts");
        let plan: Array<{ k: string; t: string; from: string; aging?: boolean }> = [];
        try {
          for (const it of agenda.openItems(deps.home).slice(0, 5)) {
            plan.push({ k: it.via === "human" ? "你" : it.via === "rule" ? "规则" : "模型", t: it.text, from: it.from });
          }
        } catch { /* 没有 agenda.json 就当空 */ }
        let threads: Array<{ id: number; t: string; d: number; aging: boolean }> = [];
        try {
          threads = openThreads(deps.db, nowD).slice(0, 6).map((x) => ({ id: x.id, t: x.text, d: x.ageDays, aging: x.aging }));
        } catch { /* 表还没建 */ }

        // Changes：只认自己的账本（exec_audit 里真的动过东西的那几条），不猜、不跑命令
        const WRITEY = ["fs.write", "fs.patch", "fs.mkdir", "fs.rm", "shell.run", "shell.exec", "code.run"];
        const chg = deps.db.prepare(
          `SELECT verb, argv_json, decision, ts, exit_code FROM exec_audit
           WHERE verb IN (${WRITEY.map(() => "?").join(",")}) AND decision = (?)
           ORDER BY rowid DESC LIMIT 8`,
        ).all(...WRITEY, "allowed") as Array<{ verb: string; argv_json: string; decision: string; ts: string; exit_code: number }>;

        const mem = deps.db.prepare("SELECT stage, count(*) c FROM memories WHERE status='active' GROUP BY stage").all() as Array<{ stage: string; c: number }>;
        const memAll = mem.reduce((a, b) => a + b.c, 0);
        const docs = (deps.db.prepare("SELECT count(*) c FROM documents WHERE deleted_at IS NULL").get() as { c: number }).c;
        const chunks = (deps.db.prepare("SELECT count(*) c FROM chunks").get() as { c: number }).c;
        const usage = deps.db.prepare("SELECT coalesce(sum(in_tokens),0) p, coalesce(sum(out_tokens),0) c, coalesce(sum(usd),0) u FROM usage WHERE substr(ts,1,10)=?").get(nowD.toISOString().slice(0, 10)) as { p: number; c: number; u: number };
        let skillsN = 0;
        try { const sk = await import("../../skills.ts"); skillsN = sk.scanSkills(deps.home).length; } catch { /* 没装技能 */ }
        let mcpServers = 0, mcpTools = 0;
        try {
          const mc = (await import("../../mcp.ts")).loadMcpConfig(deps.home);
          mcpServers = Object.keys(mc.servers ?? {}).length;
          for (const v of Object.values(mc.servers ?? {})) mcpTools += (v.tools ?? []).length;
        } catch { /* 没配 MCP */ }
        // 只数原生 verbs：MCP 那些已经在「插件」里算过一次了（否则同一个工具数两遍）
        const toolN = deps.tools ? deps.tools.list().filter((t) => !t.name.startsWith("mcp__")).length : 0;
        // 当前在用的表达模型：读**真配置**（roles.express），不是某个从没写过的 meta 键。
        // 之前读 meta("model_express")，于是永远显示"未配置"，而它明明在回话。
        let model: string | null = null;
        try {
          const ex = deps.getConfig().roles["express"];
          if (ex && ex.model) model = (ex.provider ? ex.provider + "/" : "") + ex.model;
        } catch { /* 配置读不出来就留空 */ }

        json(res, 200, {
          plan: { agenda: plan, threads },
          changes: chg.map((r) => ({ verb: r.verb, argv: r.argv_json.slice(0, 160), ts: r.ts, ok: r.exit_code === 0 })),
          context: {
            memories: memAll, stages: mem, docs, chunks,
            tools: toolN, plugins: { servers: mcpServers, tools: mcpTools }, skills: skillsN,
            model, todayTokens: usage.p + usage.c, todayUsd: usage.u,
            // 兜底状态：有值 = 最近一次是用本地答的（真配好 key 并成功调用后会自动清）
            expressFallback: (() => {
              try {
                const row = deps.db.prepare("SELECT value FROM meta WHERE key='express_fallback'").get() as { value?: string } | undefined;
                if (!row?.value) return null;
                return JSON.parse(row.value) as { at: string; model: string };
              } catch { return null; }
            })(),
          },
        });
        return true;
      }

      if (req.method === "GET" && url.pathname === "/api/threads") {
        json(res, 200, openThreads(deps.db, now()));
        return true;
      }
      const threadClose = url.pathname.match(/^\/api\/threads\/(\d+)\/close$/);
      if (req.method === "POST" && threadClose) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { note?: string };
        const ok = closeThread(deps.db, Number(threadClose[1]), String(body.note ?? ""), now());
        json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "E_THREAD_CLOSED" });
        return true;
      }

      // ── 抽检（J-5b）：把线送到眼前，当场能断 ────────────
      if (req.method === "GET" && url.pathname === "/api/surface/review") {
        json(res, 200, reviewQueue(deps.db, now()));
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/surface/review") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { src_id?: number; dst_id?: number; rel?: string; ok?: boolean };
        if (!body.src_id || !body.dst_id || !body.rel) { json(res, 400, { error: "E_BAD_LINK" }); return true; }
        const key = linkKey(body.src_id, body.dst_id, body.rel);
        noteReviewed(deps.db, now(), key);
        if (body.ok === false) {
          cutLink(deps.db, { src_id: body.src_id, dst_id: body.dst_id, rel: body.rel }, now());
        }
        json(res, 200, { ok: true, cut: body.ok === false, key });
        return true;
      }

      if (req.method === "GET" && url.pathname === "/api/pending") {
        // 待确认的 T3 提案（面板上那张卡）：带确切 argv，人看完才能点
        json(res, 200, listPending(deps.home, now()).map((p) => ({
          id: p.id, verb: p.verb, template: p.template, argv: p.argv, cwd: p.cwd,
          status: p.status, created_at: p.created_at, expires_at: p.expires_at,
          expired: Date.parse(p.expires_at) <= now().getTime(), result: p.result ?? null,
        })));
        return true;
      }
      const pendId = url.pathname.match(/^\/api\/pending\/(pnd_[0-9a-z]+)$/);
      if (req.method === "POST" && pendId) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { action?: string };
        const p = getPending(deps.home, String(pendId[1]));
        if (!p) { json(res, 404, { error: "E_PENDING_NOT_FOUND" }); return true; }
        if (p.status !== "pending") { json(res, 409, { error: `E_PENDING_${p.status.toUpperCase()}` }); return true; }

        if (body.action === "reject") {
          updatePending(deps.home, p.id, { status: "rejected", result: "你拒绝了这一条" });
          json(res, 200, { ok: true, status: "rejected" });
          return true;
        }
        if (body.action !== "confirm") { json(res, 400, { error: "E_BAD_ACTION" }); return true; }
        if (Date.parse(p.expires_at) <= now().getTime()) {
          updatePending(deps.home, p.id, { status: "rejected", result: "确认窗口已过期（15 分钟）" });
          json(res, 409, { error: "E_PENDING_EXPIRED" });
          return true;
        }

        // 确认 = 服务端现场签发一枚绑这条 argv 的令牌、立即用掉。页面拿不到令牌。
        const policy = deps.policy ?? await loadPolicy(deps.home);
        const r = await execute({ db: deps.db, policy, ctx: { home: deps.home, now } },
          p.verb, p.args, { approved: true });
        const output = r.output.slice(0, 4000);
        updatePending(deps.home, p.id, { status: r.ok ? "done" : "failed", result: output.slice(0, 1500) });
        // 结果要说出来（并且是白纸黑字“按你的确认跑的”），否则刷新后就没了
        const say = `已按你的确认执行：${p.argv.join(" ")}` + String.fromCharCode(10) +
          `（${r.ok ? "成功" : "失败"} · ${r.ms}ms${r.capability ? ` · 令牌 ${r.capability}` : ""}）` +
          String.fromCharCode(10) + String.fromCharCode(10) + output;
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "agent_reply", actor: "agent",
          payload: { text: say, tools: [{ name: "shell.run", args: JSON.stringify(p.args), result: output.slice(0, 1200), ms: r.ms }] },
        });
        json(res, 200, { ok: r.ok, status: r.ok ? "done" : "failed", output: output.slice(0, 2000), capability: r.capability ?? null });
        return true;
      }

  return false;
}
