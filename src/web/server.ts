/**
 * 本地 Web 面板（17 §4）：127.0.0.1:7700，零前端依赖，SSE 流式。
 * 不提供"新对话"——只有"忘记"（需要确认，走 memories 面板）。
 */
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { PAGE } from "./page.ts";
import { groupTimeline, gapLabel, type Msg } from "./timeline.ts";
import { appendEvent, newEventId, readEvents } from "../journal.ts";
import { readFileSync } from "node:fs";
import { search } from "../retrieve.ts";
import { buildBrief } from "../brief.ts";
import { loadPersona } from "../persona.ts";
import { expenseLine } from "./state.ts";
import { loadPersonaText, savePersonaFile, PERSONA_FILES, type PersonaFile } from "../persona.ts";
import { writeFileConfig, readFileConfig, resolveConfig } from "../configfile.ts";
import { AVATAR_FRAMES, DEFAULT_AVATAR, isAvatarFrame } from "./avatar.ts";
import { getPending, listPending, updatePending } from "../confirm.ts";
import { readStateSafe } from "../deploy/slot.ts";
import { listDocs, forgetDoc, setDocSensitivity } from "../ingest.ts";
import { recallForBrief, omissionNote } from "../recall.ts";
import { meta } from "../db.ts";
import { execute } from "../execute.ts";
import { loadPolicy, type Policy } from "../policy.ts";
import { createStore, fingerprint, type Provider } from "../auth.ts";
import type { ToolRegistry } from "../tools.ts";
import { runAgent, type ChatFn } from "../agent.ts";
import { renderMarkdown, esc } from "../md.ts";
import { loadState, advance, describe } from "../state.ts";
import type { Outage } from "../types.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const joinDir = (a: string, b: string) => join(a, b);
import type { StreamTransport } from "../transport.ts";
import type { Embedder } from "../embed.ts";
import type { MemoryLine, Tier } from "../types.ts";

export interface WebDeps {
  db: DatabaseSync;
  inboxDir: string;
  /** 面板可改配置，所以 transport/embedder 必须"每次现取"而不是构造时定死 */
  getTransport: () => StreamTransport;
  getConfig: () => { roles: Record<string, { provider: string; model: string; baseUrl?: string }>; ollama: string };
  home: string;
  tools?: ToolRegistry;
  getChat?: () => ChatFn;

  /** 启动时检测到的缺口（只报告一次，首轮后清空） */
  pendingOutage?: Outage | null;
  getEmbedder: () => Embedder | null;
  now?: () => Date;
  /** 测试可注入：把"模型回复"换成生成器 */
  reply?: (brief: string, user: string) => AsyncGenerator<string>;
  budgetUsd?: number;
  /** T3 确认要过策略；不传就现加载（测试里省事） */
  policy?: Policy;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((res) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d as Buffer)); req.on("end", () => res(Buffer.concat(c).toString("utf8"))); });

/**
 * 编码闸（本项目的老毛病：GBK 会静默污染记忆，见 README）
 * 非 UTF-8 的请求体解出来会出现 U+FFFD；宁可拒收，也不要写进记忆。
 */
export function looksMojibake(s: string): boolean {
  return s.includes("�");
}

const json = (res: ServerResponse, code: number, obj: unknown) => {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
};

interface ToolUse { name: string; args: string; result: string; ms: number }
interface MsgEx extends Msg { tools?: ToolUse[] }

function messages(db: DatabaseSync, inboxDir: string): MsgEx[] {
  const { events } = readEvents(inboxDir);
  return events
    .filter((e) => e.kind === "utterance" || e.kind === "agent_reply")
    .map((e) => {
      const p = (e.payload ?? {}) as { text?: string; tools?: ToolUse[] };
      return {
        ts: e.ts,
        role: e.kind === "utterance" ? ("user" as const) : ("agent" as const),
        text: String(p.text ?? ""),
        ...(p.tools?.length ? { tools: p.tools } : {}),
      };
    });
}

/** 工具卡（服务端渲染，前端只负责展开/收起） */
export function toolCardHtml(t: ToolUse): string {
  const name = esc(t.name);
  return `<details class="tool"><summary><span class="tn">${name}</span>` +
    `<span class="tms">${t.ms}ms</span></summary>` +
    `<pre class="targs">${esc(t.args)}</pre>` +
    `<pre class="tres">${esc(t.result.slice(0, 1200))}</pre></details>`;
}

/**
 * 本地面板的写操作守卫：
 *  - 必须带 `x-jj: 1`（跨站的表单/图片发不出自定义头，浏览器会先发 preflight）
 *  - Origin 若存在，必须是**回环**或**与本机 Host 同源**
 *
 * 为什么要允许“同源”：手机通过 Tailscale 访问时 Origin 是 `https://xxx.ts.net`，
 * 既不是回环也不是跳站——只认回环的话，手机能看但什么都不能做（发消息/改设置全 403）。
 * 同源不削弱防护：跳站页面无法把 Origin 伪造成我们的 Host（浏览器写真实来源），
 * 而自定义头 `x-jj` 仍让跨站请求过不去（预检不放行）。
 */
export function writeGuarded(req: IncomingMessage): { ok: boolean; reason?: string } {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(o.hostname);
      const sameOrigin = typeof req.headers.host === "string" && o.host === req.headers.host;
      if (!loopback && !sameOrigin) return { ok: false, reason: "E_ORIGIN" };
    } catch { return { ok: false, reason: "E_ORIGIN" }; }
  }
  if (req.headers["x-jj"] !== "1") return { ok: false, reason: "E_CSRF" };
  return { ok: true };
}

// ── PWA（19 §7.5）：manifest / 图标 / 离线壳 ───────────────

const STATIC = join(dirname(fileURLToPath(import.meta.url)), "static");
/** 图标是构建期生成的 PNG（见 tools/make-icons.mjs），不在运行时画 */
export const ICON_FILES = ["icon-180.png", "icon-192.png", "icon-512.png"] as const;

export function manifestJson(): string {
  return JSON.stringify({
    name: "鲸鲸",
    short_name: "鲸鲸",
    description: "本地记忆 + 人格 + 断电感知",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b0e0b",
    theme_color: "#0b0e0b",
    lang: "zh-CN",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }, null, 2);
}

/**
 * service worker：只缓存**外壳**（页面/图标/manifest）。
 * `/api/*` 一律不缓存——面板的价值在于“现在是什么状态”，缓存它等于擒谎。
 * 离线时它只能把一个空壳打开，所以页面自己必须说清楚“现在连不上”。
 */
export function serviceWorkerJs(): string {
  return [
    "const CACHE = 'jj-shell-v1';",
    "const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];",
    "self.addEventListener('install', (e) => {",
    "  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));",
    "});",
    "self.addEventListener('activate', (e) => {",
    "  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));",
    "});",
    "self.addEventListener('fetch', (e) => {",
    "  const u = new URL(e.request.url);",
    "  if (e.request.method !== 'GET') return;",
    "  if (u.pathname.startsWith('/api/')) return;",
    "  if (u.pathname === '/health') return;",
    "  if (e.request.mode === 'navigate') {",
    "    e.respondWith(fetch(e.request).catch(() => caches.match('/')));",
    "    return;",
    "  }",
    "  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));",
    "});",
  ].join(String.fromCharCode(10));
}

export function createWebServer(deps: WebDeps) {
  const now = deps.now ?? (() => new Date());
  const secrets = () => createStore(joinDir(deps.home, "secrets"));

  return httpCreateServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
        // 面板会被频繁改样式：禁止缓存，避免"我改了但你还看旧页面"
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : PAGE);
        return;
      }
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/manifest.webmanifest") {
        res.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : manifestJson());
        return;
      }
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/sw.js") {
        // 注意：SW 必须能从站点根作用域拿到 → 路径就放根，别塞进 /static/
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : serviceWorkerJs());
        return;
      }
      const icon = url.pathname.match(/^\/icon-(\d+)\.png$/);
      if ((req.method === "GET" || req.method === "HEAD") && icon) {
        const name = `icon-${icon[1]}.png`;
        if (!(ICON_FILES as readonly string[]).includes(name)) { json(res, 404, { error: "E_NO_ICON" }); return; }
        const buf = readFileSync(join(STATIC, name));
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(buf.byteLength),
          // 图标内容由构建期生成、文件名带尺寸 → 可以长缓存
          "cache-control": "public, max-age=86400",
        });
        res.end(req.method === "HEAD" ? undefined : buf);
        return;
      }
      // 健康检查（19 §7.3 / compose healthcheck）：只回答“能不能服务”，不做重活（不跑 quick_check）
      if (req.method === "GET" && url.pathname === "/health") {
        const dep = readStateSafe(deps.home);
        const degraded: string[] = [];
        if (dep.corrupt) degraded.push("deploy_state_corrupt");
        let memories = 0;
        try { memories = Number((deps.db.prepare("SELECT count(*) c FROM memories WHERE status='active'").get() as { c?: number })?.c ?? 0); }
        catch { degraded.push("db_unreadable"); }
        json(res, 200, {
          ok: true,
          schema: meta(deps.db, "schema_version") ?? null,
          release: dep.state.active,
          frozen: dep.state.freezeUntil && Date.parse(dep.state.freezeUntil) > now().getTime() ? dep.state.freezeUntil : null,
          memories,
          uptimeS: Math.round(process.uptime()),
          degraded,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const msgs = messages(deps.db, deps.inboxDir);
        const last = msgs.length ? msgs[msgs.length - 1]! : null;
        const gapDays = last ? (now().getTime() - new Date(last.ts).getTime()) / 86400000 : null;
        const mem = deps.db.prepare("SELECT stage, count(*) c FROM memories WHERE status='active' GROUP BY stage").all() as Array<{ stage: string; c: number }>;
        const st = loadState(deps.db);
        json(res, 200, {
          now: now().toISOString(),
          lastSeenAt: last?.ts ?? null,
          line: expenseLine(gapDays, mem),
          memories: mem,
          state: { ...st, text: describe(st) },
          outage: deps.pendingOutage
            ? { from: deps.pendingOutage.from.toISOString(), to: deps.pendingOutage.to.toISOString(), kind: deps.pendingOutage.kind }
            : null,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/timeline") {
        const blocks = groupTimeline(messages(deps.db, deps.inboxDir) as Msg[]);
        // 顺带把 agent 正文渲染成 HTML（markdown 只实现一份，在服务端）
        const out = blocks.map((b) => {
          if (b.type !== "msg") return b;
          const src = (messages(deps.db, deps.inboxDir) as MsgEx[]).find((m) => m.ts === b.ts && m.role === "agent");
          const html = b.role === "agent" ? renderMarkdown(b.text) : null;
          return { ...b, ...(html ? { html } : {}), ...(src?.tools ? { tools: src.tools.map(toolCardHtml) } : {}) };
        });
        json(res, 200, out);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/tools") {
        const reg = deps.tools;
        json(res, 200, (reg ? reg.list() : []).map((t) => ({ name: t.name, description: t.description, tier: t.tier, parameters: t.parameters })));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        const cfg = deps.getConfig();
        const store = secrets();
        const ex = cfg.roles["express"]!;
        json(res, 200, {
          provider: ex.provider,
          model: ex.model,
          baseUrl: ex.baseUrl ?? null,
          ollama: cfg.ollama,
          secretStore: store.kind,
          hasKey: Boolean(store.get(ex.provider as Provider)),
          keyFingerprint: (() => {
            const k = store.get(ex.provider as Provider);
            return k ? fingerprint(k) : null;
          })(),
          budgetUsd: deps.budgetUsd ?? 2,
        });
        return;
      }
      if (req.method === "PUT" && url.pathname === "/api/config") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as {
          provider?: string; model?: string; baseUrl?: string; key?: string;
        };
        if (body.key !== undefined && body.key !== "") {
          if (body.key.includes("�")) { json(res, 400, { error: "E_ENCODING" }); return; }
          if (!/^\S{8,}$/.test(body.key)) { json(res, 400, { error: "E_BAD_KEY" }); return; }
          const provider = (body.provider ?? deps.getConfig().roles["express"]!.provider) as Provider;
          secrets().set(provider, body.key.trim());
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
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/ui") {
        const av = readFileConfig(deps.home).ui?.avatar;
        json(res, 200, { avatar: isAvatarFrame(av) ? av : DEFAULT_AVATAR, frames: AVATAR_FRAMES });
        return;
      }
      if (req.method === "PUT" && url.pathname === "/api/ui") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { avatar?: string };
        // 白名单：外观偏好也是写操作，不能让面板把任意字符串塞进 config.json
        if (!isAvatarFrame(body.avatar)) { json(res, 400, { error: "E_BAD_FRAME" }); return; }
        writeFileConfig(deps.home, { ui: { avatar: body.avatar } });
        json(res, 200, { ok: true, avatar: body.avatar });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/persona") {
        json(res, 200, { files: loadPersonaText(deps.home), editable: PERSONA_FILES });
        return;
      }
      if (req.method === "PUT" && url.pathname === "/api/persona") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { file?: string; content?: string; because?: string };
        try {
          const r = savePersonaFile(deps.home, body.file as PersonaFile, body.content ?? "", now(), String(body.because ?? "").slice(0, 500));
          json(res, 200, { ok: true, ...r });
        } catch (e) {
          json(res, 400, { error: String(e).replace(/^Error: /, "") });
        }
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/memories") {
        const q = url.searchParams.get("q") ?? "";
        const rows = q
          ? (deps.getEmbedder()
            ? (await search(deps.db, deps.getEmbedder()!, q, { k: 12 })).hits.map((h) => ({
              id: h.id, text: h.text, stage: h.stage, weight: h.weight, kind: "episode",
            }))
            : [])
          : (deps.db.prepare(
            `SELECT id,text,stage,weight,kind FROM memories WHERE status='active'
             ORDER BY weight DESC, updated_at DESC LIMIT 40`).all() as Array<{ id: number; text: string; stage: string; weight: number; kind: string }>);
        json(res, 200, rows);
        return;
      }
      const memId = url.pathname.match(/^\/api\/memories\/(\d+)$/);
      if (req.method === "GET" && memId) {
        const row = deps.db.prepare(
          `SELECT id,text,kind,layer,stage,weight,importance,sensitivity,taint,status,created_at,last_decay_at
           FROM memories WHERE id=?`).get(Number(memId[1]));
        if (!row) { json(res, 404, { error: "E_NOT_FOUND" }); return; }
        json(res, 200, row);
        return;
      }
      const forget = url.pathname.match(/^\/api\/memories\/(\d+)\/forget$/);
      if (req.method === "POST" && forget) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        deps.db.prepare("UPDATE memories SET status='deleted', updated_at=? WHERE id=?")
          .run(now().toISOString(), Number(forget[1]));
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "memory_forget", actor: "user",
          payload: { id: Number(forget[1]) },
        });
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/docs") {
        json(res, 200, listDocs(deps.db, 200));
        return;
      }
      const docIdRe = url.pathname.match(/^\/api\/docs\/(doc_[0-9a-f]+)$/);
      if (req.method === "GET" && docIdRe) {
        const id = String(docIdRe[1]);
        const doc = deps.db.prepare(
          `SELECT id,title,rel_path,n_chunks,bytes,converter,created_at FROM documents WHERE id=? AND deleted_at IS NULL`,
        ).get(id) as Record<string, unknown> | undefined;
        if (!doc) { json(res, 404, { error: "E_NO_DOC" }); return; }
        const chunks = deps.db.prepare(
          `SELECT ord,heading_path,text,n_tokens FROM chunks
            WHERE doc_id=? AND deleted_at IS NULL ORDER BY ord`,
        ).all(id);
        json(res, 200, { doc, chunks });
        return;
      }
      const docSens = url.pathname.match(/^\/api\/docs\/(doc_[0-9a-f]+)\/sensitivity$/);
      if (req.method === "POST" && docSens) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { value?: string };
        if (body.value !== "shareable" && body.value !== "local_only") {
          json(res, 400, { error: "E_BAD_SENSITIVITY" }); return;
        }
        const ok = setDocSensitivity(deps.db, String(docSens[1]), body.value, now());
        if (!ok) { json(res, 404, { error: "E_NO_DOC" }); return; }
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "doc_sensitivity", actor: "user",
          payload: { docId: String(docSens[1]), value: body.value },
        });
        json(res, 200, { ok: true, value: body.value });
        return;
      }
      const docForget = url.pathname.match(/^\/api\/docs\/(doc_[0-9a-f]+)\/forget$/);
      if (req.method === "POST" && docForget) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const n = forgetDoc(deps.db, String(docForget[1]), now());
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "doc_forget", actor: "user",
          payload: { docId: String(docForget[1]), chunks: n },
        });
        json(res, 200, { ok: true, chunks: n });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/pending") {
        // 待确认的 T3 提案（面板上那张卡）：带确切 argv，人看完才能点
        json(res, 200, listPending(deps.home, now()).map((p) => ({
          id: p.id, verb: p.verb, template: p.template, argv: p.argv, cwd: p.cwd,
          status: p.status, created_at: p.created_at, expires_at: p.expires_at,
          expired: Date.parse(p.expires_at) <= now().getTime(), result: p.result ?? null,
        })));
        return;
      }
      const pendId = url.pathname.match(/^\/api\/pending\/(pnd_[0-9a-z]+)$/);
      if (req.method === "POST" && pendId) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { action?: string };
        const p = getPending(deps.home, String(pendId[1]));
        if (!p) { json(res, 404, { error: "E_PENDING_NOT_FOUND" }); return; }
        if (p.status !== "pending") { json(res, 409, { error: `E_PENDING_${p.status.toUpperCase()}` }); return; }

        if (body.action === "reject") {
          updatePending(deps.home, p.id, { status: "rejected", result: "你拒绝了这一条" });
          json(res, 200, { ok: true, status: "rejected" });
          return;
        }
        if (body.action !== "confirm") { json(res, 400, { error: "E_BAD_ACTION" }); return; }
        if (Date.parse(p.expires_at) <= now().getTime()) {
          updatePending(deps.home, p.id, { status: "rejected", result: "确认窗口已过期（15 分钟）" });
          json(res, 409, { error: "E_PENDING_EXPIRED" });
          return;
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
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/say") {
        const body = JSON.parse(await readBody(req)) as { text?: string };
        const text = (body.text ?? "").trim();
        if (!text) { json(res, 400, { error: "E_EMPTY" }); return; }
        if (looksMojibake(text)) {
          json(res, 400, { error: "E_ENCODING", hint: "请求体不是 UTF-8（可能是 GBK），拒绝写入记忆" });
          return;
        }

        const ts = now().toISOString();
        appendEvent(deps.inboxDir, { v: 1, id: newEventId(), ts, kind: "utterance", actor: "user", payload: { text } });

        // 召回 → 简报。云端只收 shareable；local_only 只报个数（13 §10）
        const emb = deps.getEmbedder();
        // 召回装配在 recall.ts 里（隐私闸门所在：只有 shareable 会进简报）
        const rc = await recallForBrief(deps.db, emb, text, { memK: 6, docK: 4 });
        const omitted = rc.omittedMem;
        const recalled: MemoryLine[] = rc.recalled;
        const contracts = (deps.db.prepare(
          `SELECT text FROM memories WHERE layer='contract' AND status='active' ORDER BY importance DESC LIMIT 15`)
          .all() as Array<{ text: string }>).map((r) => r.text);
        const last = messages(deps.db, deps.inboxDir).slice(0, -1).pop();
        const pending = deps.pendingOutage ?? null;
        deps.pendingOutage = null;                     // 只报告一次（18 §2.3）
        const selfState = advance(deps.db, { turns: 1, silenceDays: last ? (now().getTime() - new Date(last.ts).getTime()) / 86400000 : 0 }, now());
        const brief = buildBrief({
          now: now(), persona: loadPersona(deps.home), contracts, recalled,
          lastSeenAt: last ? new Date(last.ts) : null,
          outage: pending,
          state: { energy: selfState.energy, closeness: selfState.closeness, mood: selfState.mood ?? undefined },
          user: (() => { const note = omissionNote(omitted, rc.omittedDocs); return note ? note + String.fromCharCode(10) : ""; })() + text,
        });

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store", connection: "keep-alive",
        });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}` + String.fromCharCode(10, 10));
        send({ type: "brief", tokens: brief.tokens, prefix: brief.prefixHash, confidence: brief.confidence, omitted, omittedDocs: rc.omittedDocs, recall: recalled.length, recallDocs: recalled.filter((r) => r.source === "doc").length });

        let full = "";
        const used: ToolUse[] = [];
        const chat = deps.getChat && deps.tools ? deps.getChat() : null;
        try {
          if (chat) {
            const agent = runAgent({ chat, tools: deps.tools! }, brief.text, text);
            for await (const ev of agent) {
              if (ev.type === "delta") { full += ev.text; send({ type: "delta", text: ev.text }); }
              else if (ev.type === "tool") send({ type: "tool", id: ev.id, name: ev.name, args: ev.args });
              else if (ev.type === "tool_result") {
                used.push({ name: ev.name, args: "", result: ev.result, ms: ev.ms });
                send({ type: "tool_result", id: ev.id, name: ev.name, result: ev.result.slice(0, 1500), ms: ev.ms });
              }
              else if (ev.type === "error") send({ type: "error", message: ev.message });
              else if (ev.type === "done") send({ type: "done", steps: ev.steps });
            }
          } else if (deps.reply) {
            for await (const d of deps.reply(brief.text, text)) { full += d; send({ type: "delta", text: d }); }
            send({ type: "done", steps: 1 });
          } else {
            const gen = deps.getTransport().completeStream("express",
              [{ role: "system", content: brief.text }, { role: "user", content: text }],
              { containsMemory: false, purpose: "express", maxTokens: 512 });
            for await (const d of gen) { full += d; send({ type: "delta", text: d }); }
            send({ type: "done", steps: 1 });
          }
        } catch (e) {
          send({ type: "error", message: String(e).slice(0, 200) });
        }
        if (full) {
          appendEvent(deps.inboxDir, {
            v: 1, id: newEventId(), ts: now().toISOString(), kind: "agent_reply", actor: "agent",
            payload: { text: full, tools: used },
          });
        }
        res.end();
        return;
      }
      json(res, 404, { error: "E_NOT_FOUND" });
    } catch (e) {
      json(res, 500, { error: String(e).slice(0, 300) });
    }
  });
}
