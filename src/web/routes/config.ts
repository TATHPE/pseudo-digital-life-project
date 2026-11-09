/**
 * 配置 / 诊断 / 项目 / 导出路由（从 web/server.ts 抽出，行为逐字不变）。
 * 命中任一路由就自己写响应并 return true；没命中 return false。
 * 只通过 ConfigCtx 拿闭包量，不与 server.ts 形成运行期循环依赖。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readFileConfig, writeFileConfig, resolveConfig, configSources, normalizeAgentName } from "../../configfile.ts";
import { lastPreflight, preflight } from "../../preflight.ts";
import { capabilities } from "../../capabilities.ts";
import { CLI_COMMANDS } from "../../commands.ts";
import { indexState } from "../../embedindex.ts";
import { modelKeyOf } from "../../config.ts";
import { isInstalled } from "../../ollama.ts";
import { fingerprint, type Provider } from "../../auth.ts";
import { gate as coolGate, reset as coolReset } from "../../cooldown.ts";
import { currentGeneration, bumpGenerationIfChanged } from "../../generation.ts";
import { loadPersonaText, savePersonaFile, PERSONA_FILES, type PersonaFile } from "../../persona.ts";
import { appendEvent, newEventId } from "../../journal.ts";
import { loadPolicy, type Policy } from "../../policy.ts";
import { listProject } from "../../project.ts";
import { execute } from "../../execute.ts";
import type { ToolRegistry } from "../../tools.ts";

type SecretStore = ReturnType<typeof import("../../auth.ts").createStore>;
const joinDir = (a: string, b: string) => join(a, b);

/** 只声明本模块真正用到的 deps 字段（结构化类型，WebDeps 天然可赋值）。
 *  不 import server.ts 的 WebDeps —— 连 type-only 反向引用都不留。 */
export interface ConfigDeps {
  db: DatabaseSync;
  home: string;
  inboxDir: string;
  tools?: ToolRegistry;
  mcpInfo?: { servers: string[]; tools: string[]; errors: string[]; running?: string | null };
  getConfig: () => { roles: Record<string, { provider: string; model: string; baseUrl?: string }>; ollama: string };
  budgetUsd?: number;
  deskToken?: string;
  policy?: Policy;
}

export interface ConfigCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  deps: ConfigDeps;
  now: () => Date;
  json: (res: ServerResponse, code: number, obj: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
  writeGuarded: (req: IncomingMessage) => { ok: boolean; reason?: string };
  secrets: () => SecretStore;
}

export async function handleConfig(ctx: ConfigCtx): Promise<boolean> {
  const { req, res, url, deps, now, json, readBody, writeGuarded, secrets } = ctx;
      if (req.method === "GET" && url.pathname === "/api/tools") {
        const reg = deps.tools;
        json(res, 200, (reg ? reg.list() : []).map((t) => ({ name: t.name, description: t.description, tier: t.tier, parameters: t.parameters })));
        return true;
      }
      // ── 本地模型（C-4）：一个端点、列已装、拿当前生效值，面板据此分两块 ──
      // B-0：能力自述（工具来自 verbs / provider 来自配置 / degraded 来自真探测）
      // ── 外观偏好（现在只剩开机片头档位；头像框已删 2026-11-01）──
      if (req.method === "GET" && url.pathname === "/api/ui") {
        const boot = await import("../boot.ts");
        const ui = (readFileConfig(deps.home).ui ?? {}) as { splash?: string; shell?: string; theme?: string };
        json(res, 200, {
          splash: boot.splashMode(ui),
          theme: ui.theme === "hermes" ? "hermes" : "ledger",
          modes: boot.SPLASH_MODES,
          shell: ui.shell === "notebook" ? "notebook" : "classic",
          shells: ["classic", "notebook"],
        });
        return true;
      }
      if (req.method === "PUT" && url.pathname === "/api/ui") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { splash?: string; shell?: string; theme?: string };
        const boot = await import("../boot.ts");
        // 三个都能单独改：只传哪个就改哪个（别把别的顺手写回默认值）
        const patch: { splash?: string; shell?: "classic" | "notebook"; theme?: "ledger" | "hermes" } = {};
        if (body.theme !== undefined) {
          const v = String(body.theme ?? "");
          if (v !== "ledger" && v !== "hermes") {
            json(res, 400, { error: "E_BAD_THEME", why: "只能是 ledger / hermes" });
            return true;
          }
          patch.theme = v;
        }
        if (body.splash !== undefined) {
          const v = String(body.splash ?? "");
          if (!(boot.SPLASH_MODES as readonly string[]).includes(v)) {
            json(res, 400, { error: "E_BAD_SPLASH", why: "只能是 " + boot.SPLASH_MODES.join(" / ") });
            return true;
          }
          patch.splash = v;
        }
        if (body.shell !== undefined) {
          const v = String(body.shell ?? "");
          if (v !== "classic" && v !== "notebook") {
            json(res, 400, { error: "E_BAD_SHELL", why: "只能是 classic / notebook" });
            return true;
          }
          patch.shell = v;
        }
        if (!Object.keys(patch).length) { json(res, 400, { error: "E_EMPTY_PATCH" }); return true; }
        writeFileConfig(deps.home, { ui: patch });
        json(res, 200, { ok: true, ...patch });
        return true;
      }

      // ── 任务编排（M7 最小切片）：列表 / 推进 / 改状态 / 新建 ──
      if (req.method === "GET" && url.pathname === "/api/tasks") {
        const tk = await import("../../tasks.ts");
        const all = tk.listTasks(deps.db);
        json(res, 200, { tasks: all.map((t) => ({ id: t.id, goal: t.goal, status: t.status, stalled: t.stalled,
          steps: t.steps.map((x) => ({ n: x.n, intent: x.intent, verb: x.verb ?? null, ok: x.ok ?? null,
            verified: x.verified ?? null, result: (x.result ?? "").slice(0, 400), verifyWhy: x.verifyWhy ?? null, at: x.at })) })) });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/tasks") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { action?: string; id?: number; goal?: string };
        const tk = await import("../../tasks.ts");
        if (body.action === "create") {
          try {
            const t = tk.createTask(deps.db, String(body.goal ?? ""));
            json(res, 200, { ok: true, task: { id: t.id, goal: t.goal, status: t.status } });
          } catch (e) { json(res, 400, { error: String((e as Error).message) }); }
          return true;
        }
        const id = Number(body.id ?? 0);
        const t = tk.getTask(deps.db, id);
        if (!t) { json(res, 404, { error: "E_NO_TASK" }); return true; }
        if (body.action === "pause" || body.action === "resume" || body.action === "done" || body.action === "abandon") {
          const map = { pause: "paused", resume: "active", done: "done", abandon: "abandoned" } as const;
          tk.setTaskStatus(deps.db, id, map[body.action as keyof typeof map]);
          json(res, 200, { ok: true, status: map[body.action as keyof typeof map] });
          return true;
        }
        if (body.action === "tick") {
          if (t.status !== "active") { json(res, 409, { error: "E_TASK_NOT_ACTIVE", status: t.status }); return true; }
          const { tickOnce, localAsk, realRun } = await import("../../taskrunner.ts");
          const verdict = await tickOnce({ db: deps.db, home: deps.home, ask: localAsk(deps.home), run: realRun(deps.home, deps.db) }, t);
          json(res, 200, { ok: true, kind: verdict.kind, stalled: verdict.task.stalled, status: verdict.task.status,
            step: "step" in verdict ? { n: verdict.step.n, intent: verdict.step.intent, ok: verdict.step.ok, verified: verdict.step.verified ?? null, result: (verdict.step.result ?? "").slice(0, 400) } : null });
          return true;
        }
        json(res, 400, { error: "E_BAD_ACTION", why: "create / tick / pause / resume / done / abandon" });
        return true;
      }

      // ── 工作区域：数据放哪（2026-11-06 用户：不能全在 C 盘）──
      if (req.method === "GET" && url.pathname === "/api/where") {
        const dd = await import("../../datadir.ts");
        const root = dd.readRoot();
        json(res, 200, {
          root: root ?? dd.defaultRoot(),
          home: deps.home,
          custom: Boolean(root),
          defaultRoot: dd.defaultRoot(),
          hasPointer: Boolean(dd.whereFilePath()),
        });
        return true;
      }
      if (req.method === "PUT" && url.pathname === "/api/where") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const dd = await import("../../datadir.ts");
        const body = JSON.parse(await readBody(req)) as { root?: string; move?: boolean };
        const v = dd.validRoot(String(body.root ?? ""));
        if (!v.ok) { json(res, 400, { error: v.why }); return true; }
        // 搬迁是可选的：默认不搬（安全），搬的时候先复制、核对文件数
        let report = null as null | { ok: boolean; files: number; why?: string; to: string };
        if (body.move) {
          const m = dd.moveData(deps.home, v.root);
          report = { ok: m.ok, files: m.files, to: m.to, ...(m.why ? { why: m.why } : {}) };
          if (!m.ok) { json(res, 500, { error: m.why ?? "E_MOVE_FAILED", moved: report }); return true; }
        }
        try { dd.writeRoot(v.root); } catch (e) { json(res, 400, { error: String((e as Error).message) }); return true; }
        json(res, 200, { ok: true, root: v.root, moved: report, needsRestart: true });
        return true;
      }

      // ── 清空重来：先备份 → 写标记 → 下次启动在 openDb 之前真删（2026-11-06）──
      if (req.method === "POST" && url.pathname === "/api/reset") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { action?: string; confirm?: string };
        if (body.action !== "wipe") { json(res, 400, { error: "E_BAD_ACTION", why: "只支持 wipe" }); return true; }
        if (String(body.confirm ?? "") !== "清空") { json(res, 400, { error: "E_NEED_CONFIRM", why: "确认词要写「清空」" }); return true; }
        const dd = await import("../../datadir.ts");
        const ts = now().toISOString().replace(/[:.]/g, "-");
        const backup = join(dirname(deps.home), "backup-" + ts);
        try {
          const { cpSync } = await import("node:fs");
          cpSync(deps.home, backup, { recursive: true });
        } catch (e) { json(res, 500, { error: "E_BACKUP_FAILED", why: String((e as Error).message) }); return true; }
        try { dd.markWipe(deps.home, backup); }
        catch (e) { json(res, 500, { error: "E_WIPE_MARK_FAILED", why: String((e as Error).message), backup }); return true; }
        json(res, 200, { ok: true, backup, needsRestart: true });
        return true;
      }

      // ── 宿主层：跑脚本用哪个解释器（默认 PowerShell；Git Bash 让用户自己配）──
      if (req.method === "GET" && url.pathname === "/api/host") {
        const h = await import("../../host.ts");
        const found = h.detectShells({ gitbashPath: readFileConfig(deps.home).host?.gitbashPath });
        const cur = h.resolveShell(deps.home);
        json(res, 200, {
          wanted: readFileConfig(deps.home).host?.shell ?? "auto",
          active: { kind: cur.shell.kind, label: cur.shell.label, path: cur.shell.path, profile: h.profileOf(cur.shell) },
          fellBack: cur.fellBack, reason: cur.reason ?? null,
          available: Object.values(found).filter((x) => x.kind !== "none").map((x) => ({ kind: x.kind, label: x.label, path: x.path })),
          gitbashPath: readFileConfig(deps.home).host?.gitbashPath ?? null,
        });
        return true;
      }
      if (req.method === "PUT" && url.pathname === "/api/host") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { shell?: string; gitbashPath?: string };
        const allowed = ["auto", "powershell", "pwsh", "gitbash", "bash"];
        const shell = String(body.shell ?? "auto");
        if (!allowed.includes(shell)) { json(res, 400, { error: "E_BAD_SHELL", why: "只能是 " + allowed.join(" / ") }); return true; }
        const patch: { shell: string; gitbashPath?: string } = { shell };
        if (typeof body.gitbashPath === "string") {
          const p = body.gitbashPath.trim();
          if (p && !existsSync(p)) { json(res, 400, { error: "E_NO_BASH", why: "这个路径上找不到 bash.exe：" + p }); return true; }
          if (p) patch.gitbashPath = p;
        }
        writeFileConfig(deps.home, { host: patch });
        json(res, 200, { ok: true, host: patch });
        return true;
      }

      // ── 超级权限（2026-11-01）：完全接管电脑，也能改记忆与人格 ──
      // 模型**没有**任何路径能开它：只有这里，且要手输确认词（前端的 confirm 只是提示，
      // 真正的关口是下面的 word 校验 + writeGuarded + 审计事件）。
      if (req.method === "GET" && url.pathname === "/api/super") {
        const sg = await import("../../supergrant.ts");
        json(res, 200, {
          ...sg.readSuper(deps.home),
          stillDeny: [...sg.SUPER_STILL_DENY],
          keepDirs: [...sg.SUPER_KEEP_DIRS],
        });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/super") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const sg = await import("../../supergrant.ts");
        const body = JSON.parse(await readBody(req)) as { action?: string; word?: string; because?: string };
        if (body.action === "off") {
          const r = sg.disableSuper(deps.home) as Extract<Awaited<ReturnType<typeof sg.disableSuper>>, { ok: true }>;
          try {
            appendEvent(deps.inboxDir, {
              v: 1, id: newEventId(), ts: now().toISOString(), kind: "super_grant_close", actor: "user", payload: {},
            });
          } catch { /* 事件写不下不影响 */ }
          json(res, 200, { ok: true, state: r.state });
          return true;
        }
        // 2026-11-01 用户定：**确认步骤取消** —— 点一下就能开。
        // 边界改由这几条扛：只有人在设置里能点（writeGuarded + 同源）、必须留一句理由、
        // 开关写进 super.json 与 inbox、随时一键收回。
        const r = sg.enableSuper(deps.home, { because: body.because, now: now() });
        if (!r.ok) { json(res, 400, r); return true; }
        try {
          appendEvent(deps.inboxDir, {
            v: 1, id: newEventId(), ts: now().toISOString(), kind: "super_grant_open", actor: "user",
            payload: { because: body.because ?? "" },
          });
        } catch { /* 同上 */ }
        json(res, 200, { ok: true, state: r.state });
        return true;
      }

      // ── 插件（MCP）与技能：装/删（写操作，走 writeGuarded + 审计）──
      if (req.method === "GET" && url.pathname === "/api/plugins") {
        const pl = await import("../../plugins.ts");
        json(res, 200, { ok: true, ...pl.installedPlugins(deps.home) });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/plugins") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const pl = await import("../../plugins.ts");
        const body = JSON.parse(await readBody(req)) as {
          action?: string; kind?: string; name?: string; command?: string; args?: string[]; trust?: string; tools?: string[]; content?: string;
        };
        const kind = body.kind === "skill" ? "skill" : "mcp";
        const action = body.action === "remove" ? "remove" : "add";
        const name = String(body.name ?? "");
        const r = kind === "skill"
          ? (action === "remove" ? pl.removeSkill(deps.home, name) : pl.writeSkill(deps.home, { id: name, content: body.content }))
          : (action === "remove" ? pl.removeMcpServer(deps.home, name)
             : pl.addMcpServer(deps.home, { name, command: body.command, args: body.args, trust: body.trust, tools: body.tools }));
        if (r.ok) {
          try {
            appendEvent(deps.inboxDir, {
              v: 1, id: newEventId(), ts: now().toISOString(),
              kind: (kind === "skill" ? "skill_" : "mcp_") + action, actor: "user",
              payload: { name, command: body.command ?? null },
            });
          } catch { /* 事件写不下不影响结果 */ }
          try {
            deps.db.prepare(
              "INSERT INTO exec_audit(id,ts,verb,tier,argv_json,cwd,exit_code,duration_ms,decision,deny_reason) VALUES(?,?,?,?,?,?,?,?,?,?)",
            ).run(newEventId(), now().toISOString(), kind === "skill" ? "panel.skill" : "panel.mcp", "T1",
              JSON.stringify({ action, name }).slice(0, 500), deps.home, 0, 0, "allowed", null);
          } catch { /* 审计失败不该拖垮结果，但上面已经有 inbox 事件 */ }
        }
        json(res, r.ok ? 200 : 400, r.ok ? { ok: true, note: r.note ?? null, ...pl.installedPlugins(deps.home) } : r);
        return true;
      }

      // ── git 校样（只读）：status / diff / log 都走 verbs → execute → policy → audit ──
      if (req.method === "GET" && url.pathname === "/api/git") {
        const what = String(url.searchParams.get("what") ?? "status");
        const verb = what === "diff" ? "git.diff" : what === "log" ? "git.log" : "git.status";
        const path = url.searchParams.get("path");
        const policy = deps.policy ?? await loadPolicy(deps.home);
        const r = await execute({ db: deps.db, policy, ctx: { home: deps.home, now } },
          verb, path ? { path } : {});
        json(res, r.ok ? 200 : 400, { ok: r.ok, what, output: r.output.slice(0, 200_000), tier: r.tier, code: r.code ?? null });
        return true;
      }

      // ── 文件面板（只读）：项目两个根下的目录与文件，白名单与 project.* 同一套 ──
      if (req.method === "GET" && url.pathname === "/api/project/tree") {
        const dir = String(url.searchParams.get("dir") ?? "");
        try {
          const entries = listProject(dir);
          json(res, 200, { ok: true, dir, roots: ["jingjing", "docs"], entries });
        } catch (e) {
          json(res, 400, { ok: false, error: String((e as Error).message ?? e).slice(0, 200) });
        }
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/project/file") {
        const path = String(url.searchParams.get("path") ?? "");
        const policy = deps.policy ?? await loadPolicy(deps.home);
        const r = await execute({ db: deps.db, policy, ctx: { home: deps.home, now } },
          "project.read", { path });
        json(res, r.ok ? 200 : 400, { ok: r.ok, path, text: r.output.slice(0, 200_000), code: r.code ?? null });
        return true;
      }

      // ── 技能（docs/runtime/11 第二优先）：只读列表；正文走 skill.read（同一条闸门） ──
      if (req.method === "GET" && url.pathname === "/api/skills") {
        const sk = await import("../../skills.ts");
        const agentsDir = join(process.env.AGENTS_HOME ?? join(homedir(), ".agents"), "skills");
        json(res, 200, {
          dirs: [join(deps.home, "skills"), agentsDir],
          skills: sk.scanSkills(deps.home).map((x) => ({
            id: x.id, name: x.name, description: x.description, source: x.source,
            bytes: x.bytes, parsed: x.parsed, file: x.file,
          })),
        });
        return true;
      }

      // ── 诊断 / 部署 / 导出：面板要能自己说清楚「现在什么状态」──
      if (req.method === "GET" && url.pathname === "/api/doctor") {
        try {
          const { doctor } = await import("../../doctor.ts");
          const rep = await doctor({ db: deps.db, home: deps.home });
          json(res, 200, rep);
        } catch (e) { json(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 200) }); }
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/deploy") {
        try {
          const { coreFpFromHome } = await import("../../deploy/fingerprint.ts");
          const pkgPath = joinDir(process.cwd(), "package.json");
          let version = "?";
          try { version = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "?"; } catch { /* dev 下没有也正常 */ }
          let dbBytes = 0;
          try { dbBytes = statSync(joinDir(deps.home, "memory.db")).size; } catch { /* 新装还没建库 */ }
          json(res, 200, {
            version,
            mode: deps.deskToken ? "desktop" : "dev",
            home: deps.home,
            node: process.version,
            uptimeS: Math.round(process.uptime()),
            dbBytes,
            fingerprint: coreFpFromHome(deps.home),
          });
        } catch (e) { json(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 200) }); }
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/export") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        try {
          const { exportHome, defaultExportDir } = await import("../../handoff.ts");
          const r = exportHome(deps.home, defaultExportDir(deps.home));
          json(res, 200, { ...r, ok: true });
        } catch (e) { json(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 200) }); }
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/export/verify") {
        const dir = String(url.searchParams.get("dir") ?? "");
        if (!dir) { json(res, 400, { error: "E_NO_DIR" }); return true; }
        try {
          const { verifyExport } = await import("../../handoff.ts");
          const v = verifyExport(dir);
          json(res, 200, { ok: v.ok, files: v.manifest ? Object.keys(v.manifest.files).length : 0, counts: v.manifest?.counts ?? null, problems: v.problems.slice(0, 10) });
        } catch (e) { json(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 200) }); }
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/capabilities") {
        const cfgNow = deps.getConfig();
        const pf = lastPreflight(cfgNow.ollama);          // 只读缓存，不在这里探头
        const cap = await capabilities({
          db: deps.db, home: deps.home, cfg: resolveConfig(deps.home),
          ollama: pf ? { base: pf.base, online: pf.online, names: pf.names, ...(pf.error ? { error: pf.error } : {}) } : null,
          ...(deps.mcpInfo ? { mcp: deps.mcpInfo } : {}),
          hooks: (await import("../../hooks.ts")).loadHooks(deps.home),
          commands: CLI_COMMANDS,
          panel: true,
        });
        json(res, 200, cap);
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/models") {
        const cfg = deps.getConfig();
        const src = configSources(deps.home);
        const probe = await preflight(cfg.ollama);        // C-3：统一前置检查（5 分钟按端点缓存）
        json(res, 200, {
          endpoint: cfg.ollama,
          online: probe.online,
          error: probe.error ?? null,
          installed: probe.names,
          index: (() => {
            try {
              const e = cfg.roles["embed"];
              return indexState(deps.db, modelKeyOf(e));
            } catch { return null; }
          })(),
          roles: ["embed", "route", "extract", "salience", "conflict", "night"].map((r) => ({
            role: r, model: cfg.roles[r]?.model ?? "", source: src[r] ?? "default",
            installed: cfg.roles[r]?.model ? isInstalled(probe.names, cfg.roles[r]!.model) : null,
          })),
        });
        return true;
      }
      if (req.method === "PUT" && url.pathname === "/api/models") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { default?: string; night?: string; embed?: string };
        const patch: Record<string, string> = {};
        for (const k of ["default", "night", "embed"] as const) {
          const v = body[k];
          if (v === undefined) continue;
          if (typeof v !== "string" || v.length > 120 || /[\u0000-\u001f]/.test(v)) {
            json(res, 400, { error: "E_BAD_MODEL" }); return true;
          }
          patch[k] = v;
        }
        if (!Object.keys(patch).length) { json(res, 400, { error: "E_NOTHING_TO_DO" }); return true; }
        writeFileConfig(deps.home, { local: patch });
        const cfg = deps.getConfig();
        json(res, 200, { ok: true, now: Object.fromEntries(Object.entries(cfg.roles).map(([r, c]) => [r, c.model || null])) });
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        const cfg = deps.getConfig();
        const store = secrets();
        const ex = cfg.roles["express"]!;
        // 只读一次：每次 get() 在 Windows 上是一个 PowerShell 进程（DPAPI 解密）
        const key = store.get(ex.provider as Provider);
        json(res, 200, {
          agent: { name: normalizeAgentName(readFileConfig(deps.home).agent?.name) },
          provider: ex.provider,
          model: ex.model,
          baseUrl: ex.baseUrl ?? null,
          ollama: cfg.ollama,
          secretStore: store.kind,
          hasKey: Boolean(key),
          keyFingerprint: key ? fingerprint(key) : null,
          // D-2：冷却中要让 banner 说得出来（不是静默失败）
          cooldown: (() => {
            const g = coolGate(ex.provider);
            return g.blocked ? { reason: g.reason ?? "冷却中", remainingMs: g.remainingMs ?? 0 } : null;
          })(),
          budgetUsd: deps.budgetUsd ?? 2,
        });
        return true;
      }
      if (req.method === "PUT" && url.pathname === "/api/config") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as {
          provider?: string; model?: string; baseUrl?: string; key?: string | null;
          agent?: { name?: string };
        };
        // 改她的名字：「鲸鲸」只是预置人格名，不是项目名（和接口配置无关，单独一次请求）
        if (body.agent && typeof body.agent.name === "string") {
          const name = normalizeAgentName(body.agent.name);
          writeFileConfig(deps.home, { agent: { name } });
          json(res, 200, { ok: true, agent: { name } });
          return true;
        }
        // key: null = 清除（不能用 ""，那个语义已经被“没传”占用了）
        if (body.key === null) {
          const provider = (body.provider ?? deps.getConfig().roles["express"]!.provider) as Provider;
          const removed = secrets().clear(provider);
          json(res, 200, { ok: true, provider, removed, hasKey: false });
          return true;
        }
        if (body.key !== undefined && body.key !== "") {
          if (body.key.includes("�")) { json(res, 400, { error: "E_ENCODING" }); return true; }
          if (!/^\S{8,}$/.test(body.key)) { json(res, 400, { error: "E_BAD_KEY" }); return true; }
          const provider = (body.provider ?? deps.getConfig().roles["express"]!.provider) as Provider;
          secrets().set(provider, body.key.trim());
          coolReset(provider);          // 换了新 key 就立刻解冷却，否则"换好了还要等 5 分钟"没法学
        }
        const patch: Record<string, unknown> = {};
        if (body.provider || body.model || body.baseUrl) {
          patch.express = {
            ...(body.provider ? { provider: body.provider } : {}),
            ...(body.model ? { model: body.model } : {}),
            ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
          };
        }
        if (Object.keys(patch).length) writeFileConfig(deps.home, patch as any);
        const cfg = deps.getConfig();
        json(res, 200, {
          ok: true,
          provider: cfg.roles["express"]!.provider,
          model: cfg.roles["express"]!.model,
          hasKey: Boolean(secrets().get(cfg.roles["express"]!.provider as Provider)),
        });
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/persona") {
        // H-5：连当前代一起给面板（面板要显示「第几代」）
        const gen = currentGeneration(deps.db, deps.home);
        json(res, 200, { files: loadPersonaText(deps.home), editable: PERSONA_FILES, generation: gen });
        return true;
      }
      if (req.method === "PUT" && url.pathname === "/api/persona") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { file?: string; content?: string; because?: string };
        try {
          const r = savePersonaFile(deps.home, body.file as PersonaFile, body.content ?? "", now(), String(body.because ?? "").slice(0, 500));
          // H-5 分代：人格**真的变了**才开新代（重复保存不该产生新一代）
          let gen = null;
          if ((r as { changed?: boolean }).changed) {
            const b = bumpGenerationIfChanged(deps.db, deps.home, String(body.because ?? ""), now());
            gen = b.generation;
            if (b.bumped) {
              appendEvent(deps.inboxDir, {
                v: 1, id: newEventId(), ts: now().toISOString(), kind: "persona_gen", actor: "user",
                payload: { gen: gen.gen, fingerprint: gen.fingerprint, because: gen.because },
              } as never);
            }
          } else {
            gen = currentGeneration(deps.db, deps.home);
          }
          json(res, 200, {
            ok: true, ...r,
            generation: gen,
            note: "之后的记忆属于这一代；旧记忆仍按原来的代解释（要追溯请用 jingjing persona migrate）",
          });
        } catch (e) {
          json(res, 400, { error: String(e).replace(/^Error: /, "") });
        }
        return true;
      }

  return false;
}
