/**
 * 本地 Web 面板（17 §4）：127.0.0.1:7700，零前端依赖，SSE 流式。
 * 不提供"新对话"——只有"忘记"（需要确认，走 memories 面板）。
 */
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { PAGE } from "./page.ts";
import { groupTimeline, gapLabel, type Msg } from "./timeline.ts";
import { appendEvent, newEventId, readEvents } from "../journal.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { search, searchDocs } from "../retrieve.ts";
import { buildBrief } from "../brief.ts";
import { loadPersona } from "../persona.ts";
import { expenseLine } from "./state.ts";
import { loadPersonaText, savePersonaFile, PERSONA_FILES, type PersonaFile } from "../persona.ts";
import { writeFileConfig, readFileConfig, resolveConfig, configSources } from "../configfile.ts";
import { isInstalled } from "../ollama.ts";
import { recompute, w0FromImportance, type Stage } from "../decay.ts";
import { modelKeyOf } from "../config.ts";
import { capabilities } from "../capabilities.ts";
import { CLI_COMMANDS } from "../commands.ts";
import { gate as coolGate, reset as coolReset } from "../cooldown.ts";
import { preflight, lastPreflight } from "../preflight.ts";
import { indexState } from "../embedindex.ts";
import { AVATAR_FRAMES, DEFAULT_AVATAR, isAvatarFrame } from "./avatar.ts";
import { getPending, listPending, updatePending } from "../confirm.ts";
import { readStateSafe } from "../deploy/slot.ts";
import { listDocs, forgetDoc, setDocSensitivity, ingestPath, collectFiles } from "../ingest.ts";
import { bigramText } from "../text.ts";
import { atomicWriteFile } from "../fsx.ts";
import { safePath } from "../verbs.ts";
import { SUPPORTED_EXTS, MAX_INGEST_BYTES } from "../ingest.ts";
import { createTransport, routerFrom } from "../transport.ts";
import { spentToday } from "../budget.ts";
import { recallForBrief, omissionNote } from "../recall.ts";
import { decideSurface, pickSurface, noteSurfaced, usedToday } from "../surface.ts";
import { reinforce, updateMemoryText, patchMemoryMeta } from "../store.ts";
import { meta } from "../db.ts";
import { openContracts } from "../store.ts";
import { execute } from "../execute.ts";
import { loadPolicy, type Policy } from "../policy.ts";
import { createStore, fingerprint, type Provider } from "../auth.ts";
import type { ToolRegistry } from "../tools.ts";
import { runAgent, type ChatFn } from "../agent.ts";
import { renderMarkdown, esc } from "../md.ts";
import { loadState, advance, describe } from "../state.ts";
import type { Outage } from "../types.ts";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
const joinDir = (a: string, b: string) => join(a, b);
const posixPath = (p: string) => p.split("\\").join("/");
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
  /** B-0：真实 MCP 连接结果（面板要能说清"哪个 server 没挂上"） */
  mcpInfo?: { servers: string[]; tools: string[]; errors: string[] };
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

/** 收原始字节（上传用），带大小上限：超了立刻断开，不把内存吃干净 */
const readRawBody = (req: IncomingMessage, cap: number): Promise<Buffer> =>
  new Promise((res, rej) => {
    const c: Buffer[] = [];
    let n = 0;
    req.on("data", (d: Buffer) => {
      n += d.length;
      if (n > cap) { rej(new Error("E_TOO_BIG")); req.destroy(); return; }
      c.push(d);
    });
    req.on("end", () => res(Buffer.concat(c)));
    req.on("error", () => rej(new Error("E_UPLOAD")));
  });

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
interface MsgEx extends Msg {
  tools?: ToolUse[];
  cites?: string[];
  omitted?: number;
  omittedDocs?: number;
}

function messages(db: DatabaseSync, inboxDir: string): MsgEx[] {
  const { events } = readEvents(inboxDir);
  return events
    .filter((e) => e.kind === "utterance" || e.kind === "agent_reply")
    .map((e) => {
      const p = (e.payload ?? {}) as { text?: string; tools?: ToolUse[]; cites?: string[]; omitted?: number; omittedDocs?: number };
      return {
        ts: e.ts,
        role: e.kind === "utterance" ? ("user" as const) : ("agent" as const),
        text: String(p.text ?? ""),
        ...(p.tools?.length ? { tools: p.tools } : {}),
        ...(p.cites?.length ? { cites: p.cites } : {}),
        ...(p.omitted ? { omitted: p.omitted } : {}),
        ...(p.omittedDocs ? { omittedDocs: p.omittedDocs } : {}),
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

/**
 * 标签页图标：把页面里那一个鲸尾 symbol 的 path 抽出来，拼成独立 SVG。
 * 以前是前端运行时用 data URI 生成 —— 但 viewBox 写死成 24×24（symbol 是 512×512），
 * 图标等于画到框外，标签页上什么也没有。现在服务端给矢量图，尺寸天然正确。
 */
/** 头像文件：按扩展名探测（一次只留一个） */
export function avatarFile(home: string, role: "agent" | "user"): { path: string; mime: string; v: number } | null {
  const mimes: Array<[string, string]> = [["png", "image/png"], ["jpg", "image/jpeg"], ["webp", "image/webp"]];
  for (const [ext, mime] of mimes) {
    const p = join(home, "avatars", `${role}.${ext}`);
    if (existsSync(p)) return { path: p, mime, v: statSync(p).mtimeMs };
  }
  return null;
}

/**
 * 解析 `data:image/png;base64,...`，并且**验文件头**：
 * 声明的 mime 是用户说了算的，只有魔数才是真的。SVG 一律拒（它能带脚本）。
 */
export function parseImageDataUrl(dataUrl: string): { buf: Buffer; ext: string; mime: string } | null {
  const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  let buf: Buffer;
  try { buf = Buffer.from(m[2]!, "base64"); } catch { return null; }
  if (buf.byteLength < 64) return null;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isWebp = buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
  if (isPng) return { buf, ext: "png", mime: "image/png" };
  if (isJpg) return { buf, ext: "jpg", mime: "image/jpeg" };
  if (isWebp) return { buf, ext: "webp", mime: "image/webp" };
  return null;
}

export function faviconSvg(): string {
  const m = PAGE.match(/<symbol id="whale" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/);
  const vb = m?.[1] ?? "0 0 512 512";
  const body = m?.[2] ?? "";
  // 两个都设：path 用的是 currentColor，独立 SVG 里它取决于 color（默认黑）
  // 标签页图标用黑色：浏览器标签栏大多是浅底，青色在深色栏里反而不显
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" fill="#000" color="#000">${body}</svg>`;
}

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
  // 每次请求都 createStore 会重新做一遍 DPAPI 探测（又是一个 PowerShell 进程）；
  // 存储本身无状态，进程内复用即可（clear/set 会自己让解密缓存失效）。
  let secretStore: ReturnType<typeof createStore> | null = null;
  const secrets = () => (secretStore ??= createStore(joinDir(deps.home, "secrets")));

  return httpCreateServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
        // 面板会被频繁改样式：禁止缓存，避免"我改了但你还看旧页面"
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        // 把 sources/ 的**绝对路径**注入页面：用户点了"摄入"却不知道文件该放哪，
        // 只说 "data/sources" 对 Windows 用户没有意义（那是相对仓库根说的）。
        const sourcesDir = joinDir(deps.home, "sources");
        const html = PAGE.replace(
          "window.SOURCES_DIR = null;",
          "window.SOURCES_DIR = " + JSON.stringify(sourcesDir) + ";",
        );
        res.end(req.method === "HEAD" ? undefined : html);
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
      // ── 头像自定义（上传的是图片，不是 SVG：SVG 里能带脚本，直接当图片打开就执行了）──
      if (req.method === "GET" && url.pathname === "/api/avatars") {
        json(res, 200, {
          agent: avatarFile(deps.home, "agent") ? { url: "/avatar/agent?v=" + avatarFile(deps.home, "agent")!.v } : null,
          user: avatarFile(deps.home, "user") ? { url: "/avatar/user?v=" + avatarFile(deps.home, "user")!.v } : null,
        });
        return;
      }
      const avServe = url.pathname.match(/^\/avatar\/(agent|user)$/);
      if ((req.method === "GET" || req.method === "HEAD") && avServe) {
        const f = avatarFile(deps.home, String(avServe[1]) as "agent" | "user");
        if (!f) { json(res, 404, { error: "E_NO_AVATAR" }); return; }
        const buf = readFileSync(f.path);
        res.writeHead(200, {
          "content-type": f.mime,
          "content-length": String(buf.byteLength),
          // 头像是用户上传的二进制：别让浏览器去猜类型（nosniff），也别让它执行任何东西
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'",
          "cache-control": "private, max-age=86400",
        });
        res.end(req.method === "HEAD" ? undefined : buf);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/avatar") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { role?: string; dataUrl?: string };
        const role = body.role === "user" ? "user" : body.role === "agent" ? "agent" : null;
        if (!role) { json(res, 400, { error: "E_BAD_ROLE" }); return; }
        const parsed = parseImageDataUrl(String(body.dataUrl ?? ""));
        if (!parsed) { json(res, 400, { error: "E_BAD_IMAGE", hint: "只收 png / jpeg / webp，且要真的是图片（会查文件头）" }); return; }
        if (parsed.buf.byteLength > 512 * 1024) { json(res, 400, { error: "E_TOO_BIG", hint: "≤512KB" }); return; }
        mkdirSync(joinDir(deps.home, "avatars"), { recursive: true });
        // 一次只留一个文件：换格式时把旧的删掉，免得 /avatar 拿到旧图
        for (const ext of ["png", "jpg", "webp"]) rmSync(join(deps.home, "avatars", `${role}.${ext}`), { force: true });
        const path = join(deps.home, "avatars", `${role}.${parsed.ext}`);
        atomicWriteFile(path, parsed.buf);
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "avatar_set", actor: "user",
          payload: { role, bytes: parsed.buf.byteLength, mime: parsed.mime },
        });
        json(res, 200, { ok: true, role, url: `/avatar/${role}?v=${Date.now()}` });
        return;
      }
      if (req.method === "DELETE" && url.pathname === "/api/avatar") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const role = url.searchParams.get("role") === "user" ? "user" : "agent";
        for (const ext of ["png", "jpg", "webp"]) rmSync(join(deps.home, "avatars", `${role}.${ext}`), { force: true });
        json(res, 200, { ok: true, role });
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/icon.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=3600" });
        res.end(req.method === "HEAD" ? undefined : faviconSvg());
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
        // 夜间整备降级是**可见状态**，不是日志里的一行（E-6：否则 energy 滑到 0 也没人知道为什么）
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
        });
        return;
      }
      // ── P0/P1 的支撑接口：动作审计 / 搜索 / 记忆纠错 / 面板内摄入 / 测连接 / 用量 ──
      if (req.method === "GET" && url.pathname === "/api/audit") {
        const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 60) || 60);
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
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) { json(res, 200, { mem: [], docs: [] }); return; }
        const emb = deps.getEmbedder();
        const mem = emb ? (await search(deps.db, emb, q, { k: 8 })).hits : [];
        const docs = emb ? (await searchDocs(deps.db, emb, q, { k: 6 })).hits : [];
        const sens = new Map<number, string>();
        if (mem.length) {
          const got = deps.db.prepare(
            `SELECT id, sensitivity FROM memories WHERE id IN (SELECT value FROM json_each(?))`,
          ).all(JSON.stringify(mem.map((h) => h.id))) as Array<{ id: number; sensitivity?: string }>;
          for (const g of got) sens.set(Number(g.id), g.sensitivity ?? "local_only");
        }
        json(res, 200, {
          mem: mem.map((h) => ({
            id: h.id, text: h.text, stage: h.stage, weight: h.weight,
            sensitivity: sens.get(h.id) ?? "local_only",
          })),
          docs: docs.map((h) => ({
            cite: h.cite, docId: h.docId, ord: h.ord, title: h.title,
            headingPath: h.headingPath, text: h.text.slice(0, 300),
            sensitivity: h.sensitivity,
          })),
        });
        return;
      }

      const memEdit = url.pathname.match(/^\/api\/memories\/(\d+)$/);
      if (req.method === "PUT" && memEdit) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as {
          text?: string; importance?: number; sensitivity?: string;
        };
        const id = Number(memEdit[1]);
        const cur = deps.db.prepare("SELECT text,importance,sensitivity,layer FROM memories WHERE id=? AND status='active'")
          .get(id) as { text: string; importance: number; sensitivity: string; layer: string } | undefined;
        if (!cur) { json(res, 404, { error: "E_NO_MEMORY" }); return; }

        const text = body.text === undefined ? cur.text : String(body.text).trim();
        if (!text) { json(res, 400, { error: "E_EMPTY" }); return; }
        if (text.includes("\uFFFD")) { json(res, 400, { error: "E_ENCODING" }); return; }
        if (Buffer.byteLength(text, "utf8") > 2000) { json(res, 400, { error: "E_TOO_BIG" }); return; }
        const importance = body.importance === undefined ? cur.importance : Math.max(1, Math.min(5, Math.round(Number(body.importance))));
        const sensitivity = body.sensitivity === "shareable" ? "shareable"
          : body.sensitivity === "local_only" ? "local_only" : cur.sensitivity;

        // 纠错也是"变更"：留一条事件，并在面板上说明改了什么（02 §5 / 17 §4）
        // E-3：人改过重要性 → 记下“是人在打分”，并把 w0 跟着重算
        //（否则改了 importance 权重不变，很迷惑）
        const layer = cur.layer === "contract" ? "contract" : "narrative";
        const changedImportance = body.importance !== undefined && importance !== cur.importance;
        // E-5：正文改动只走 store.updateMemoryText（它只接受 human:*，并留 pre-image）
        if (text !== cur.text) {
          try { updateMemoryText(deps.db, id, text, "human:panel", now()); }
          catch (e) { json(res, 400, { error: String((e as Error).message).slice(0, 120) }); return; }
        }
        if (changedImportance) {
          const w0 = w0FromImportance(importance, layer);
          const row = deps.db.prepare("SELECT kind,recall_count,last_decay_at,stage FROM memories WHERE id=?").get(id) as
            { kind: string; recall_count: number; last_decay_at: string; stage: Stage };
          // 锚点不动：改 importance 不是“再巩固”（后者才动 last_decay_at）
          const r = recompute({ id: String(id), layer, kind: row.kind, w0, recallCount: row.recall_count, lastDecayAt: new Date(row.last_decay_at), stage: row.stage }, now());
          // E-5 / Standards #1：**元数据走 patchMemoryMeta**（白名单 + 事件），不再裸 UPDATE。
          // 以前这里直接写 SQL，于是“模型只能改元数据”那道闸门在生产路径上是死的（只有测试调用它）。
          patchMemoryMeta(deps.db, id, {
            importance, sensitivity, w0, weight: r.weight, stage: r.stage, scored_by: "human:panel",
          }, "human:panel", now());
        } else {
          patchMemoryMeta(deps.db, id, { importance, sensitivity }, "human:panel", now());
        }
        // text_bigram / FTS 已由 updateMemoryText 处理（这里不再裸写）
        if (text !== cur.text) {
          try {
            const v = deps.getEmbedder();
            if (v) {
              const emb = (await v.embed([text]))[0];
              if (emb) {
                deps.db.prepare("UPDATE memories SET embedding=? WHERE id=?")
                  .run(new Uint8Array(emb.buffer, emb.byteOffset, emb.byteLength), id);
                try { deps.db.prepare("DELETE FROM vec_memories WHERE memory_id=?").run(BigInt(id)); } catch { /* 没有扩展就跳过 */ }
                try { deps.db.prepare("INSERT INTO vec_memories(memory_id,embedding) VALUES(?,?)").run(BigInt(id), emb); } catch { /* 同上 */ }
              }
            }
          } catch { /* 向量没更新不算失败，检索会退化为纯 BM25 */ }
        }
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "memory_edit", actor: "user",
          payload: { id, before: cur.text, after: text, importance, sensitivity },
        });
        json(res, 200, { ok: true, text, importance, sensitivity });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/ingest/candidates") {
        // 面板不能读客户端文件系统 —— 只能列服务端 data/sources 下还没摄入的东西
        const dir = join(deps.home, "sources");
        const done = new Set((deps.db.prepare("SELECT rel_path FROM documents WHERE deleted_at IS NULL").all() as Array<{ rel_path: string }>)
          .map((r) => String(r.rel_path ?? "")));
        json(res, 200, collectFiles(dir)
          .map((f) => posixPath(relative(dir, f)))
          .filter((rel) => !done.has(rel))
          .slice(0, 50)
          .map((rel) => ({ rel, path: "sources/" + rel })));
        return;
      }
      // 上传：面板拿不到你电脑上的绝对路径（浏览器不给），所以让浏览器把字节传上来，
      // 服务端落到约定的 sources/ 再走同一条 ingest。仍然要 writeGuarded + 白名单扩展名 + 大小上限。
      if (req.method === "POST" && url.pathname === "/api/ingest/upload") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const raw = String(url.searchParams.get("name") ?? "");
        // 只收"一个文件名"：不允许路径分隔符、不允许 ..、不允许控制字符
        const name = raw.trim();
        if (!name || name.includes("/") || name.includes("\\") || name.includes("..") ||
            [...name].some((c) => c.codePointAt(0)! < 32) || name.length > 160) {
          json(res, 400, { error: "E_BAD_NAME", hint: "只要文件名，不要路径" }); return;
        }
        const ext = extname(name).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) {
          json(res, 400, { error: "E_UNSUPPORTED", hint: "支持：" + [...SUPPORTED_EXTS].join(" ") }); return;
        }
        let buf: Buffer;
        try { buf = await readRawBody(req, MAX_INGEST_BYTES); }
        catch (e) {
          const code = String((e as Error).message || "E_UPLOAD");
          json(res, code === "E_TOO_BIG" ? 413 : 400, { error: code, hint: "上限 " + Math.round(MAX_INGEST_BYTES / 1048576) + " MB" });
          return;
        }
        if (!buf.length) { json(res, 400, { error: "E_EMPTY" }); return; }
        const dir = joinDir(deps.home, "sources");
        mkdirSync(dir, { recursive: true });
        const abs = safePath(deps.home, "sources/" + name, false);
        writeFileSync(abs, buf);
        json(res, 200, { ok: true, path: "sources/" + name, bytes: buf.length });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/ingest") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { path?: string; shareable?: boolean };
        const target = String(body.path ?? "").trim();
        // 编码闸（和 /api/say 同一条）：GBK 请求体解出来是 U+FFFD，
        // 不拦的话会变成"查一个乱码路径 → E_NOT_FOUND"，让人以为是文件不存在
        if (looksMojibake(target)) { json(res, 400, { error: "E_ENCODING", hint: "请求体不是 UTF-8（可能是 GBK）" }); return; }
        if (!target) { json(res, 400, { error: "E_NO_PATH" }); return; }
        // 只允许 home 内的路径（面板不是文件管理器；sources/ 是约定的落点）
        let abs: string;
        try {
          abs = safePath(deps.home, target.endsWith("/") ? target : target, false);
        } catch { json(res, 400, { error: "E_OUTSIDE_HOME", hint: "路径必须在 data/ 里，例如 sources/我的笔记.md" }); return; }
        if (!existsSync(abs)) { json(res, 400, { error: "E_NOT_FOUND", hint: abs }); return; }
        const r = await ingestPath(deps.db, abs, {
          home: deps.home, root: joinDir(deps.home, "sources"), embedder: deps.getEmbedder(),
          sensitivity: body.shareable ? "shareable" : "local_only", now: now(),
        });
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "ingest", actor: "user",
          payload: { path: target, ...r.total },
        });
        json(res, 200, { ok: true, ...r.total, results: r.results.map((x) => ({ file: x.file, chunks: x.chunks, skipped: x.skipped, degraded: x.degraded })) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/test-cloud") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const cfg = deps.getConfig();
        const ex = cfg.roles["express"]!;
        const key = secrets().get(ex.provider as Provider);
        if (!key) { json(res, 400, { error: "E_NO_KEY", hint: `缺 ${ex.provider} 的 key` }); return; }
        const t0 = Date.now();
        try {
          const r = await createTransport(routerFrom(cfg.roles as never), { apiKeys: { [ex.provider]: key } })
            .complete("express", [
              { role: "system", content: "只回答一个字。" },
              { role: "user", content: "回复：好" },
            ], { containsMemory: false, maxTokens: 8, purpose: "panel-test" });
          json(res, 200, { ok: true, ms: Date.now() - t0, reply: r.text.slice(0, 20), model: ex.model });
        } catch (e) {
          json(res, 200, { ok: false, ms: Date.now() - t0, error: String((e as Error).message ?? e).slice(0, 200) });
        }
        return;
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
          // E-6 第二步：ENERGY 旁边的自解释。缺模型时 energy 不会恢复，
          // 不写清就只能看着数字往下掉却不知道为什么。
          nightlySkipped: (() => { try { return meta(deps.db, "nightly_skipped"); } catch { return null; } })(),
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
          return {
            ...b, ...(html ? { html } : {}),
            ...(src?.tools ? { tools: src.tools.map(toolCardHtml) } : {}),
            ...(src?.cites ? { cites: src.cites } : {}),
            ...(src?.omitted ? { omitted: src.omitted } : {}),
            ...(src?.omittedDocs ? { omittedDocs: src.omittedDocs } : {}),
          };
        });
        json(res, 200, out);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/tools") {
        const reg = deps.tools;
        json(res, 200, (reg ? reg.list() : []).map((t) => ({ name: t.name, description: t.description, tier: t.tier, parameters: t.parameters })));
        return;
      }
      // ── 本地模型（C-4）：一个端点、列已装、拿当前生效值，面板据此分两块 ──
      // B-0：能力自述（工具来自 verbs / provider 来自配置 / degraded 来自真探测）
      if (req.method === "GET" && url.pathname === "/api/capabilities") {
        const cfgNow = deps.getConfig();
        const pf = lastPreflight(cfgNow.ollama);          // 只读缓存，不在这里探头
        const cap = await capabilities({
          db: deps.db, home: deps.home, cfg: resolveConfig(deps.home),
          ollama: pf ? { base: pf.base, online: pf.online, names: pf.names, ...(pf.error ? { error: pf.error } : {}) } : null,
          ...(deps.mcpInfo ? { mcp: deps.mcpInfo } : {}),
          commands: CLI_COMMANDS,
          panel: true,
        });
        json(res, 200, cap);
        return;
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
        return;
      }
      if (req.method === "PUT" && url.pathname === "/api/models") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { default?: string; night?: string; embed?: string };
        const patch: Record<string, string> = {};
        for (const k of ["default", "night", "embed"] as const) {
          const v = body[k];
          if (v === undefined) continue;
          if (typeof v !== "string" || v.length > 120 || /[\u0000-\u001f]/.test(v)) {
            json(res, 400, { error: "E_BAD_MODEL" }); return;
          }
          patch[k] = v;
        }
        if (!Object.keys(patch).length) { json(res, 400, { error: "E_NOTHING_TO_DO" }); return; }
        writeFileConfig(deps.home, { local: patch });
        const cfg = deps.getConfig();
        json(res, 200, { ok: true, now: Object.fromEntries(Object.entries(cfg.roles).map(([r, c]) => [r, c.model || null])) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        const cfg = deps.getConfig();
        const store = secrets();
        const ex = cfg.roles["express"]!;
        // 只读一次：每次 get() 在 Windows 上是一个 PowerShell 进程（DPAPI 解密）
        const key = store.get(ex.provider as Provider);
        json(res, 200, {
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
        return;
      }
      if (req.method === "PUT" && url.pathname === "/api/config") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as {
          provider?: string; model?: string; baseUrl?: string; key?: string | null;
        };
        // key: null = 清除（不能用 ""，那个语义已经被“没传”占用了）
        if (body.key === null) {
          const provider = (body.provider ?? deps.getConfig().roles["express"]!.provider) as Provider;
          const removed = secrets().clear(provider);
          json(res, 200, { ok: true, provider, removed, hasKey: false });
          return;
        }
        if (body.key !== undefined && body.key !== "") {
          if (body.key.includes("�")) { json(res, 400, { error: "E_ENCODING" }); return; }
          if (!/^\S{8,}$/.test(body.key)) { json(res, 400, { error: "E_BAD_KEY" }); return; }
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
          `SELECT id,text,kind,layer,stage,weight,w0,importance,sensitivity,taint,scored_by,status,created_at,last_decay_at
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
        let omitted = rc.omittedMem;
        const recalled: MemoryLine[] = rc.recalled;

        // 只取**还没过期**的契约：已了结的承诺不该每轮继续喂给模型（否则它会反复提）
        const contracts = openContracts(deps.db, now()).map((r) => r.text);
        const last = messages(deps.db, deps.inboxDir).slice(0, -1).pop();
        const pending = deps.pendingOutage ?? null;
        deps.pendingOutage = null;                     // 只报告一次（18 §2.3）
        // ── 浮现时机（J-4）：不是"每轮都查"，是"挑时机"──────────
        // 每天 ≤2 条，同一根线 7 天不重复；浮上来的那条带 viaLink（为什么是它）。
        try {
          const prev = String(last?.text ?? "").slice(0, 400);
          const dec = decideSurface({
            now: now(), lastMsgAt: last ? new Date(last.ts) : null, prevText: prev, text,
            firstOfDay: !last || new Date(last.ts).toDateString() !== now().toDateString(),
          }, usedToday(deps.db, now()));
          if (dec.ok) {
            const pick = pickSurface(deps.db, now());
            if (pick) {
              const row = deps.db.prepare("SELECT sensitivity, taint, layer, kind FROM memories WHERE id=?")
                .get(pick.id) as { sensitivity?: string; taint?: string; layer: string; kind: string } | undefined;
              if (row && row.sensitivity === "shareable" && (row.taint ?? "trusted") === "trusted") {
                recalled.push({
                  id: `mem:${pick.id}`, layer: row.layer === "contract" ? "contract" : "narrative", kind: row.kind,
                  stage: "dormant", weight: 0.5, text: pick.text, sensitivity: "shareable", source: "memory",
                  ...(pick.quote ? { quote: pick.quote } : {}),
                  viaLink: { from: pick.from, why: pick.why },
                } as MemoryLine);
                noteSurfaced(deps.db, now(), pick);
              }
            }
          }
        } catch { /* 浮现失败不影响正常回答 */ }
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
        const send = (o: unknown) => { try { res.write(`data: ${JSON.stringify(o)}` + String.fromCharCode(10, 10)); } catch { /* 已断开 */ } };
        // 用户点“停止”/关页面时浏览器会断开；服务端必须跟着停，否则只是“看不见”，token 照烧
        let aborted = false;
        res.on("close", () => { aborted = true; });
        send({
          type: "brief", tokens: brief.tokens, prefix: brief.prefixHash, confidence: brief.confidence,
          omitted, omittedDocs: rc.omittedDocs, recall: recalled.length,
          recallDocs: recalled.filter((r) => r.source === "doc").length,
          cites: recalled.map((r) => r.id),
        });

        let full = "";
        const used: ToolUse[] = [];
        try {
          // getChat 必须在 try 里面：routerFrom 会对空 model 报 E_CONFIG，
          // 而它以前在 try 外面 —— 一抛就穿透到外层 catch，SSE 已经开始，
          // 于是 json(500) 抛 ERR_HTTP_HEADERS_SENT，整个面板进程被打死。
          const chat = deps.getChat && deps.tools ? deps.getChat() : null;
          if (chat) {
            const agent = runAgent({ chat, tools: deps.tools! }, brief.text, text);
            for await (const ev of agent) {
              if (aborted) break;
              if (ev.type === "delta") { full += ev.text; send({ type: "delta", text: ev.text }); }
              else if (ev.type === "notice") send({ type: "notice", text: ev.text });
              else if (ev.type === "tool") send({ type: "tool", id: ev.id, name: ev.name, args: ev.args });
              else if (ev.type === "tool_result") {
                used.push({ name: ev.name, args: "", result: ev.result, ms: ev.ms });
                send({ type: "tool_result", id: ev.id, name: ev.name, result: ev.result.slice(0, 1500), ms: ev.ms });
              }
              else if (ev.type === "error") send({ type: "error", message: ev.message });
              else if (ev.type === "done") send({ type: "done", steps: ev.steps });
            }
          } else if (deps.reply) {
            for await (const d of deps.reply(brief.text, text)) { if (aborted) break; full += d; send({ type: "delta", text: d }); }
            send({ type: "done", steps: 1 });
          } else {
            const gen = deps.getTransport().completeStream("express",
              [{ role: "system", content: brief.text }, { role: "user", content: text }],
              { containsMemory: false, purpose: "express", maxTokens: 512 });
            for await (const d of gen) { if (aborted) break; full += d; send({ type: "delta", text: d }); }
            send({ type: "done", steps: 1 });
          }
        } catch (e) {
          // 给人看的话，不是给开发者看的栈
          const raw = String((e as Error)?.message ?? e);
          const msg = raw.includes("E_CONFIG")
            ? "还没有可用的模型。去设置里填云端 key，或装本地模型：ollama pull bge-m3，再 jingjing models use <模型名>"
            : raw.slice(0, 200);
          send({ type: "error", message: msg });
        }
        if (full) {
          appendEvent(deps.inboxDir, {
            v: 1, id: newEventId(), ts: now().toISOString(), kind: "agent_reply", actor: "agent",
            payload: {
              text: full, tools: used,
              ...(recalled.length ? { cites: recalled.map((r) => r.id) } : {}),
              ...(omitted ? { omitted } : {}),
              ...(rc.omittedDocs ? { omittedDocs: rc.omittedDocs } : {}),
            },
          });
        }
        // 再巩固（J-1）：只有**真的进了装配块**的才算"被想起"（不是被检索到）。
        // 之前 reconsolidate() 全库零调用 → recall_count 永远 0 → "想一次就更牢"从没生效。
        try {
          const ids = recalled.filter((r) => r.source === "memory" && !r.viaLink)
            .map((r) => Number(String(r.id).replace("mem:", "")))
            .filter((n) => Number.isFinite(n));
          if (ids.length) reinforce(deps.db, ids, now());
        } catch { /* 加固失败不影响回答 */ }

        res.end();
        return;
      }
      json(res, 404, { error: "E_NOT_FOUND" });
    } catch (e) {
      // 这里必须看 headersSent：/api/say 是 SSE，一旦开始吐字就不能再写头。
      // 以前不管这个 —— 一次失败的聊天就能让 json() 抛 ERR_HTTP_HEADERS_SENT，
      // 而那个抛是在 catch 里，直接**打死整个面板进程**（实测：无 key + 无本地模型即可复现）。
      console.error("[api-error]", req.method, url.pathname, String((e as Error)?.stack ?? e).slice(0, 600));
      if (res.headersSent) {
        try { res.write("data: " + JSON.stringify({ type: "error", message: String(e).slice(0, 300) }) + String.fromCharCode(10, 10)); } catch { /* 已断开 */ }
        try { res.end(); } catch { /* 已断开 */ }
      } else {
        json(res, 500, { error: String(e).slice(0, 300) });
      }
    }
  });
}
