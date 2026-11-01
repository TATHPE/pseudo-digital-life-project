/**
 * 本地 Web 面板（17 §4）：127.0.0.1:7700，零前端依赖，SSE 流式。
 * 不提供"新对话"——只有"忘记"（需要确认，走 memories 面板）。
 */
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { PAGE } from "./page.ts";
import * as deskT from "./desk.ts";
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
import { listPending, getPending, updatePending } from "../confirm.ts";
import { bumpGenerationIfChanged, currentGeneration } from "../generation.ts";
import { listProposals, getProposal, setProposalStatus } from "../proposals.ts";
import { reviewQueue, noteReviewed } from "../surface.ts";
import { openThreads, closeThread } from "../threads.ts";
import { openGrant, listGrants, revokeGrant, currentPreset, setPreset, PRESETS, type Preset } from "../grant.ts";
import { egressStatus, allowOnce, allowFor, revokeEgress } from "../egress.ts";
import { readSession, startSetup, pauseSetup, resumeSetup, undoSetup, detect, SETUP_STEPS, type SetupStep } from "../setup.ts";
import { runStep } from "../setupsteps.ts";
import { listReceipts, markSeen, unseenCount } from "../notify.ts";
import { listStanding, disableStanding } from "../standing.ts";
import { cutLink, linkKey } from "../links.ts";
import { readStateSafe } from "../deploy/slot.ts";
import { listDocs, forgetDoc, setDocSensitivity, ingestPath, collectFiles } from "../ingest.ts";
import { bigramText } from "../text.ts";
import { atomicWriteFile } from "../fsx.ts";
import { safePath } from "../verbs.ts";
import { listProject } from "../project.ts";
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
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
const joinDir = (a: string, b: string) => join(a, b);
const posixPath = (p: string) => p.split("\\").join("/");
import type { StreamTransport } from "../transport.ts";
import type { Embedder } from "../embed.ts";
import type { MemoryLine, Tier } from "../types.ts";

/**
 * 给首次配置用的表达模型取用器：有云端 key 就返回一个 complete；没有就 null。
 * 返回 null 不是错误 —— 调用方会用模板并**明说**这是模板。
 */
async function expressComplete(deps: { home: string }): Promise<((system: string, user: string) => Promise<string>) | null> {
  try {
    const { resolveConfig } = await import("../configfile.ts");
    const { createChatTransport, routerFrom } = await import("../transport.ts");
    const { createStore } = await import("../auth.ts");
    const cfg = resolveConfig(deps.home);
    const store = createStore(`${deps.home}/secrets`);
    const keys: Record<string, string> = {};
    for (const p of ["deepseek", "anthropic", "openai"] as const) { const k = store.get(p); if (k) keys[p] = k; }
    if (!Object.keys(keys).length) return null;
    const chat = createChatTransport(routerFrom(cfg.roles as never), { apiKeys: keys });
    return async (system, user) => {
      let out = "";
      let finish = "";
      for await (const ev of chat.chat("express", [{ role: "system", content: system }, { role: "user", content: user }], {
        // 发的是人格设定（用户刚写的答案），不是记忆原文；面板已在访谈前告知
        // 900 不够：实测 finish="length" 且 **delta 为空**（预算被推理吃掉），
        // 上层只能看到空串，于是"模型写不出草稿"——其实是根本没给它写完的额度。
        containsMemory: false, purpose: "setup-interview", maxTokens: 4096, temperature: 0.4,
      })) {
        if (ev.type === "delta") out += ev.text;
        else if (ev.type === "done") finish = String((ev as { finish?: string }).finish ?? "");
      }
      // 空输出 + finish=length：不是"没内容"，是额度被吃完了（推理模型常见）。
      // 必须区分开 —— 否则上层会把它当成"模型写不出来"然后静默退回模板，真因就被埋了。
      if (!out.trim() && finish === "length") throw new Error("E_OUTPUT_TRUNCATED: 额度用尽但没产出内容");
      return out;
    };
  } catch { return null; }
}
// H-4：首次配置的后台任务状态（pull 模型可能要几分钟，不能把 HTTP 请求挂着）
const jobState: { running: boolean; step: string | null; note: string; done: boolean; ok: boolean } =
  { running: false, step: null, note: "", done: true, ok: true };

export interface WebDeps {
  /** 桌面端启动令牌；给了就要求页面请求带它（见 web/desk.ts）。测试不传 = 不校验 */
  deskToken?: string;
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
/** 该不该进引导页：没开始过，或者上次没跑完（paused / aborted / running 都算没跑完） */
export function needsWelcome(home: string): boolean {
  try {
    const s = readSession(home);
    if (!s) return true;
    return s.status !== "done";
  } catch { return true; }
}

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

const STATIC = join(dirname(fileURLToPath(import.meta.url)), "static");

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



export function createWebServer(deps: WebDeps) {
  const now = deps.now ?? (() => new Date());
  // 每次请求都 createStore 会重新做一遍 DPAPI 探测（又是一个 PowerShell 进程）；
  // 存储本身无状态，进程内复用即可（clear/set 会自己让解密缓存失效）。
  let secretStore: ReturnType<typeof createStore> | null = null;
  const secrets = () => (secretStore ??= createStore(joinDir(deps.home, "secrets")));

  return httpCreateServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // ── 桌面端令牌（2026-11-01）──
    // 「软件只有桌面端」的机制：知道 127.0.0.1:7700 也没用，得先拿到壳手里的令牌。
    // deps.deskToken 不传（测试 / CLI 直连）时不校验。
    if (deps.deskToken && !deskT.tokenExempt(url.pathname)) {
      const got = deskT.tokenFromRequest(url, req.headers.cookie);
      if (!deskT.sameToken(got, deps.deskToken)) {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(
          "<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>从这里打不开</title>" +
          "<body style='background:#0b0e0b;color:#e9f0f2;font:14px/1.8 ui-monospace,Consolas,monospace;padding:48px'>" +
          "<p><b>鲸鲸是桌面应用。</b></p>" +
          "<p>这一页不能从浏览器直接打开 —— 从桌面上的鲸鲸图标启动，它会带着自己的一次性令牌加载界面。</p>" +
          "<p style='color:#9fb0b3'>（排障用：令牌在 data/.desk.json，每次启动重新生成。）</p>" +
          "</body></html>",
        );
        return;
      }
      if (url.searchParams.get("k")) {
        res.setHeader("set-cookie", deskT.DESK_COOKIE + "=" + deps.deskToken + "; HttpOnly; SameSite=Strict; Path=/");
      }
    }
    try {
      // 桌面工作台里的「真数据层」：独立页面，供 iframe 嵌入（Trianon 会吞掉所有按键与点击）

      // 桌面工作台（Trianon，MIT，整块搬来的单文件）：同源提供、不联网、离线自包含。
      // 壳的窗口指向这里；`/` 仍然是给用户/PWA 的内置面板。
      // 旧壳兼容（2026-11-01）：改动前构建的 exe 只会去 /desk。
      // 那条线（Trianon）已经删了，这里给一条 302 到 / —— 新壳直接指 /，这条可以随时删。
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/desk") {
        res.writeHead(302, { location: "/" });
        res.end();
        return;
      }

      // 首次配置的引导页：分流放在**服务端**，所以桌面壳一行都不用改（窗口仍然加载 /）
      if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/welcome")) {
        const forced = url.pathname === "/welcome";
        const skip = url.searchParams.get("skip") === "1";
        if (forced || (!skip && needsWelcome(deps.home))) {
          const { WELCOME } = await import("./welcome.ts");
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(req.method === "HEAD" ? undefined : WELCOME);
          return;
        }
      }
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
        // H-7 附：向量也交给它同一次写 —— 面板不再自己 INSERT vec_memories（那会变成第二个写入口）
        if (text !== cur.text) {
          let newEmb: Float32Array | null = null;
          try {
            const v = deps.getEmbedder();
            if (v) newEmb = (await v.embed([text]))[0] ?? null;
          } catch { /* 算不出向量不算失败：检索会退化为纯词法 */ }
          try { updateMemoryText(deps.db, id, text, "human:panel", now(), newEmb); }
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
        // text_bigram / FTS / 向量 已由 updateMemoryText 一次写完（这里不再裸写）
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
      // ── 超级权限（2026-11-01）：完全接管电脑，也能改记忆与人格 ──
      // 模型**没有**任何路径能开它：只有这里，且要手输确认词（前端的 confirm 只是提示，
      // 真正的关口是下面的 word 校验 + writeGuarded + 审计事件）。
      if (req.method === "GET" && url.pathname === "/api/super") {
        const sg = await import("../supergrant.ts");
        json(res, 200, {
          ...sg.readSuper(deps.home),
          stillDeny: [...sg.SUPER_STILL_DENY],
          keepDirs: [...sg.SUPER_KEEP_DIRS],
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/super") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const sg = await import("../supergrant.ts");
        const body = JSON.parse(await readBody(req)) as { action?: string; word?: string; because?: string };
        if (body.action === "off") {
          const r = sg.disableSuper(deps.home) as Extract<Awaited<ReturnType<typeof sg.disableSuper>>, { ok: true }>;
          try {
            appendEvent(deps.inboxDir, {
              v: 1, id: newEventId(), ts: now().toISOString(), kind: "super_grant_close", actor: "user", payload: {},
            });
          } catch { /* 事件写不下不影响 */ }
          json(res, 200, { ok: true, state: r.state });
          return;
        }
        // 开：必须手输「接管」两个字。这一条是代码校验，不是提示词。
        if (String(body.word ?? "").trim() !== "接管") {
          json(res, 400, { error: "E_NEED_WORD", why: "要开超级权限，得手输「接管」两个字" });
          return;
        }
        const r = sg.enableSuper(deps.home, { because: body.because, now: now() });
        if (!r.ok) { json(res, 400, r); return; }
        try {
          appendEvent(deps.inboxDir, {
            v: 1, id: newEventId(), ts: now().toISOString(), kind: "super_grant_open", actor: "user",
            payload: { because: body.because ?? "" },
          });
        } catch { /* 同上 */ }
        json(res, 200, { ok: true, state: r.state });
        return;
      }

      // ── 插件（MCP）与技能：装/删（写操作，走 writeGuarded + 审计）──
      if (req.method === "GET" && url.pathname === "/api/plugins") {
        const pl = await import("../plugins.ts");
        json(res, 200, { ok: true, ...pl.installedPlugins(deps.home) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/plugins") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const pl = await import("../plugins.ts");
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
        return;
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
        return;
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
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/project/file") {
        const path = String(url.searchParams.get("path") ?? "");
        const policy = deps.policy ?? await loadPolicy(deps.home);
        const r = await execute({ db: deps.db, policy, ctx: { home: deps.home, now } },
          "project.read", { path });
        json(res, r.ok ? 200 : 400, { ok: r.ok, path, text: r.output.slice(0, 200_000), code: r.code ?? null });
        return;
      }

      // ── 技能（docs/11 第二优先）：只读列表；正文走 skill.read（同一条闸门） ──
      if (req.method === "GET" && url.pathname === "/api/skills") {
        const sk = await import("../skills.ts");
        const agentsDir = join(process.env.AGENTS_HOME ?? join(homedir(), ".agents"), "skills");
        json(res, 200, {
          dirs: [join(deps.home, "skills"), agentsDir],
          skills: sk.scanSkills(deps.home).map((x) => ({
            id: x.id, name: x.name, description: x.description, source: x.source,
            bytes: x.bytes, parsed: x.parsed, file: x.file,
          })),
        });
        return;
      }

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
      if (req.method === "GET" && url.pathname === "/api/persona") {
        // H-5：连当前代一起给面板（面板要显示「第几代」）
        const gen = currentGeneration(deps.db, deps.home);
        json(res, 200, { files: loadPersonaText(deps.home), editable: PERSONA_FILES, generation: gen });
        return;
      }
      if (req.method === "PUT" && url.pathname === "/api/persona") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
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
             ORDER BY weight DESC, updated_at DESC LIMIT ? OFFSET ?`)
            .all(
              Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 40))),
              Math.max(0, Number(url.searchParams.get("offset") ?? 0)),
            ) as Array<{ id: number; text: string; stage: string; weight: number; kind: string }>);
        json(res, 200, rows);
        return;
      }
      const memId = url.pathname.match(/^\/api\/memories\/(\d+)$/);
      if (req.method === "GET" && memId) {
        const id = Number(memId[1]);
        const row = deps.db.prepare(
          `SELECT id,text,kind,layer,subject,stage,weight,w0,importance,sensitivity,taint,scored_by,status,
                  quote,source_kind,source_ref,superseded_by,created_under_gen,created_at,updated_at,last_decay_at
           FROM memories WHERE id=?`).get(id) as Record<string, unknown> | undefined;
        if (!row) { json(res, 404, { error: "E_NOT_FOUND" }); return; }

        // F-1 #5「看不出来源」：一条记忆必须能回答"它从哪来、改过什么"
        // pre-image 来自 events(kind='memory_text_changed')，旧正文存在 payload 里（E-4/E-5 写的）
        const changes = (deps.db.prepare(
          `SELECT ts, actor, payload FROM events WHERE kind='memory_text_changed' AND target=? ORDER BY ts DESC LIMIT 10`,
        ).all(String(id)) as Array<{ ts: string; actor: string; payload: string }>)
          .map((e) => {
            // 字段名是 store.ts 写的 `before_text`（不是 old）—— 这里猜错过一次
            let old = "";
            try {
              const j = JSON.parse(e.payload) as { before_text?: string; old?: string };
              old = String(j.before_text ?? j.old ?? "");
            } catch { /* 老记录没有 pre-image */ }
            return { at: e.ts, by: e.actor, old };
          })
          .filter((x) => x.old);

        // 文档来源：source_ref 存的是相对路径（ingest 时写的），能对上的给出 doc id
        let doc: { id: string; title: string } | null = null;
        const ref = String(row.source_ref ?? "");
        if (row.source_kind === "doc" && ref) {
          try {
            const d = deps.db.prepare(
              "SELECT id,title FROM documents WHERE rel_path=? AND deleted_at IS NULL LIMIT 1",
            ).get(ref) as { id: string; title: string } | undefined;
            if (d) doc = { id: d.id, title: d.title };
          } catch { /* 没有 documents 表也不该 500 */ }
        }
        // H-5：这条记忆出生时是哪一代人格（改人格不改写旧记忆的解释）
        let generation: { gen: number; fingerprint: string; createdAt: string; because: string } | null = null;
        try {
          const g = Number((row.created_under_gen as number | undefined) ?? 0);
          const { generationOf } = await import("../generation.ts");
          generation = generationOf(deps.db, g) ?? {
            gen: g, fingerprint: "", createdAt: "",
            because: g === 0 ? "未封存（迁移前的老记忆）" : "那条分代记录已不在日志里",
          };
        } catch { /* 读不到不影响详情 */ }
        json(res, 200, { ...row, generation, provenance: { changes, doc } });
        return;
      }
      // F-3：忘记的**撤销**。忘记是软删（status='deleted'），所以能原样放回；
      // 只回 status，不动 weight —— 权重已经按时间衰减过，硬抬回去等于假装它没被忘过。
      const memRestore = url.pathname.match(/^\/api\/memories\/(\d+)\/restore$/);
      if (req.method === "POST" && memRestore) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const id = Number(memRestore[1]);
        const row = deps.db.prepare("SELECT status FROM memories WHERE id=?").get(id) as { status?: string } | undefined;
        if (!row) { json(res, 404, { error: "E_NOT_FOUND" }); return; }
        if (row.status !== "deleted") { json(res, 409, { error: "E_NOT_DELETED" }); return; }
        deps.db.prepare("UPDATE memories SET status='active', updated_at=? WHERE id=?").run(now().toISOString(), id);
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "memory_restore", actor: "user",
          payload: { id },
        });
        json(res, 200, { ok: true });
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
      // F-3：撤销「忘掉这篇」——5 秒内能反悔。作废是写 deleted_at，恢复就是把它们清空并重建 FTS。
      const docRestore = url.pathname.match(/^\/api\/docs\/(doc_[0-9a-f]+)\/restore$/);
      if (req.method === "POST" && docRestore) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const id = String(docRestore[1]);
        const rows = deps.db.prepare("SELECT id,text_bigram,heading_path FROM chunks WHERE doc_id=?").all(id) as Array<{ id: number; text_bigram: string; heading_path: string }>;
        if (!rows.length) { json(res, 404, { error: "E_NO_DOC" }); return; }
        deps.db.exec("BEGIN");
        try {
          deps.db.prepare("UPDATE chunks SET deleted_at=NULL WHERE doc_id=?").run(id);
          deps.db.prepare("UPDATE documents SET deleted_at=NULL WHERE id=?").run(id);
          // 只重插索引行：forget 时已经用 'delete' 命令正确地移除过
          for (const r of rows) {
            deps.db.prepare("INSERT INTO chunks_fts(rowid, text_bigram, heading_path) VALUES(?,?,?)")
              .run(BigInt(r.id), r.text_bigram, r.heading_path);
          }
          deps.db.exec("COMMIT");
        } catch (e) { deps.db.exec("ROLLBACK"); json(res, 500, { error: String(e).slice(0, 120) }); return; }
        appendEvent(deps.inboxDir, { v: 1, id: newEventId(), ts: now().toISOString(), kind: "doc_restore", actor: "user", payload: { docId: id } });
        json(res, 200, { ok: true, chunks: rows.length });
        return;
      }
      // ── 提议（K-2）：它想做的事，人一句话决定 ──────────
      if (req.method === "GET" && url.pathname === "/api/proposals") {
        const st = (url.searchParams.get("status") ?? "open") as "open" | "accepted" | "rejected" | "all";
        json(res, 200, listProposals(deps.home, { status: st }));
        return;
      }
      const propId = url.pathname.match(/^\/api\/proposals\/(prp_[0-9a-z]{6,40})$/);
      if (req.method === "POST" && propId) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { action?: string; reason?: string };
        const p = getProposal(deps.home, String(propId[1]));
        if (!p) { json(res, 404, { error: "E_PROPOSAL_NOT_FOUND" }); return; }
        if (body.action !== "accept" && body.action !== "reject") { json(res, 400, { error: "E_BAD_ACTION" }); return; }
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
        return;
      }

      // ── 人格访谈（H-4 ⑥）：5 问 → 6 块草稿 → 逐块确认 → 封存 ──
      if (req.method === "GET" && url.pathname === "/api/setup/interview") {
        const iv = await import("../interview.ts");
        json(res, 200, { questions: iv.QUESTIONS, draft: iv.readDraft(deps.home) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/setup/interview") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const iv = await import("../interview.ts");
        const body = JSON.parse(await readBody(req)) as {
          action?: string; answers?: Record<string, string>; blocks?: Record<string, Array<{ text: string; source: string }>>; because?: string;
        };
        if (body.action === "draft") {
          const answers = body.answers ?? {};
          // 一个字都没填就别让模型写：它会输出"未提供具体内容（仅出现字段名）"这种句子，
          // 而我们在面板上看到的是一屏看起来很像内容的垃圾（真踩过）。
          const filled = Object.values(answers).filter((v) => String(v ?? "").trim().length > 0);
          // 一个字都没答：不叫模型（它只会说"未提供具体内容"），直接用中立模板拼 —— 并明说。
          if (!filled.length) {
            const t = iv.templateDraft(answers, now());
            iv.saveDraft(deps.home, t);
            json(res, 200, { ok: true, draft: t, modelAdded: iv.countModelAdded(t), via: "template" });
            return;
          }
          // 答得少时，没答的那些用问题自带的 fallback 顶上（中立模板，不是编造）。
          // 这样模型总有事可做，不会因为"信息太少"把整份草稿写成借口。
          for (const q of iv.QUESTIONS) {
            const v = String(answers[q.id] ?? "").trim();
            if (!v) answers[q.id] = q.fallback;
          }
          // 有表达模型就用它写；没有就模板（**明说**，不假装是模型写的）
          let d = iv.templateDraft(answers, now());
          const complete = await expressComplete(deps);
          if (complete) {
            try {
              const prompt = [
                "下面是一个人对自己 AI 伴侣的 5 个回答。请把它整理成 6 块设定。",
                "铁律：只能整理他说过的话，不能添加他没说过的具体事实、名称、数字。",
                "输出格式：**块的标题必须恰好是这些英文小写**：## core / ## boundaries / ## values / ## voice / ## evidence / ## tools。",
                "每条一行，行首用 - 开头。不要用中文标题，不要加别的段落。",
                "例子（照这个形状写）：",
                "## core",
                "- 她叫我主人（你原话）",
                "## boundaries",
                "- 不替我确认（你原话）",
                "你自己补充的理解，行尾必须写（模型补的，请确认）。",
                "用户的原话（每条一问一答，问题只是标签）：",
                ...Object.entries(answers).map(([k, v]) => `问（${k}）：${v}`),
              ].join(String.fromCharCode(10));
              const raw = await complete(prompt, "现在开始整理，只输出那 6 段。");
              d = iv.parseDraft(raw, answers, now());
            } catch (e) {
              d = { ...iv.templateDraft(answers, now()), note: "模型写失败了，用你的原话 + 中立模板：" + String(e).slice(0, 80) };
            }
          }
          if ((d as { emptyAll?: boolean }).emptyAll) {
            // 模型没产出 → 退回模板（有兜底，但不能假装是模型写的）
            const t = iv.templateDraft(answers, now());
            t.note = "模型这次没写出可用的内容，下面是用你的原话 + 中立模板拼的";
            iv.saveDraft(deps.home, t);
            json(res, 200, { ok: true, draft: t, modelAdded: iv.countModelAdded(t), via: "template", fellBack: true });
            return;
          }
          iv.saveDraft(deps.home, d);
          json(res, 200, { ok: true, draft: d, modelAdded: iv.countModelAdded(d) });
          return;
        }
        if (body.action === "discard") {
          iv.discardDraft(deps.home);
          json(res, 200, { ok: true, draft: null });
          return;
        }
        if (body.action === "save") {
          const cur = iv.readDraft(deps.home);
          if (!cur) { json(res, 404, { error: "E_NO_DRAFT" }); return; }
          const next = { ...cur, blocks: body.blocks ?? cur.blocks } as typeof cur;
          iv.saveDraft(deps.home, next);
          json(res, 200, { ok: true, draft: next });
          return;
        }
        if (body.action === "seal") {
          const r = iv.sealDraft(deps.db, deps.home, { because: String(body.because ?? ""), now: now() });
          if (!r.ok) { json(res, 400, r); return; }
          try {
            appendEvent(deps.inboxDir, {
              v: 1, id: newEventId(), ts: now().toISOString(), kind: "persona_seal", actor: "user",
              payload: { gen: r.gen, files: r.files },
            });
          } catch { /* 事件写不下不影响封存 */ }
          const miss = r.missing.map((f) => f + ".md").join("、");
          json(res, 200, {
            ok: true, gen: r.gen, files: r.files, missing: r.missing,
            note: "已封存为第 " + r.gen + " 代；之后要改就是开新一代" +
              (miss ? "（" + miss + " 访谈里没说到，仍是出厂默认 —— 可以去设置里补）" : ""),
          });
          return;
        }
        json(res, 400, { error: "E_BAD_ACTION" });
        return;
      }

      // ── 试运行（⑦）与第一句话（⑧）──
      if (req.method === "POST" && url.pathname === "/api/setup/smoke") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const fr = await import("../firstrun.ts");
        const { loadPersonaText } = await import("../persona.ts");
        const files = loadPersonaText(deps.home);
        const personaText = Object.entries(files).map(([k, v]) => `# ${k}` + String.fromCharCode(10) + v).join(String.fromCharCode(10, 10));
        const r = await fr.runSmoke({ personaText, ...(await expressComplete(deps) ? { complete: (await expressComplete(deps))! } : {}) });
        json(res, 200, r);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/setup/first") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const fr = await import("../firstrun.ts");
        const { loadPersonaText } = await import("../persona.ts");
        const files = loadPersonaText(deps.home);
        const personaText = Object.entries(files).map(([k, v]) => `# ${k}` + String.fromCharCode(10) + v).join(String.fromCharCode(10, 10));
        const r = await fr.sayFirstWords({
          inboxDir: deps.inboxDir, personaText, now: now(),
          ...(await expressComplete(deps) ? { complete: (await expressComplete(deps))! } : {}),
        });
        json(res, 200, r);
        return;
      }
      // ── 首次配置（H-4）：可暂停、可终止、终止先给预览 ──
      if (req.method === "GET" && url.pathname === "/api/setup") {
        const session = readSession(deps.home);
        let d: Awaited<ReturnType<typeof detect>> | null = null;
        if (url.searchParams.get("detect") === "1") { try { d = await detect(deps.home); } catch { d = null; } }
        json(res, 200, { session, steps: SETUP_STEPS, job: jobState, detected: d });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/setup") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { action?: string; step?: string; confirm?: boolean };
        if (body.action === "start") { json(res, 200, { ok: true, session: startSetup(deps.home) }); return; }
        if (body.action === "pause") { json(res, 200, { ok: true, session: pauseSetup(deps.home) }); return; }
        if (body.action === "resume") { json(res, 200, { ok: true, session: resumeSetup(deps.home) }); return; }
        if (body.action === "run") {
          const step = String(body.step ?? "") as SetupStep;
          if (!SETUP_STEPS.includes(step)) { json(res, 400, { error: "E_BAD_STEP" }); return; }
          if (jobState.running) { json(res, 409, { error: "E_SETUP_BUSY" }); return; }
          Object.assign(jobState, { running: true, step, note: "开始…", done: false, ok: true });
          // 后台跑：pull 模型可能要几分钟，HTTP 不能挂着
          void (async () => {
            try {
              const { execFileSync } = await import("node:child_process");
              const runner = {
                run(cmd: string, args: string[], o?: { timeoutMs?: number }) {
                  try { return { ok: true, out: String(execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: o?.timeoutMs ?? 600_000 })) }; }
                  catch (e) { return { ok: false, out: String((e as Error).message).slice(0, 200) }; }
                },
              };
              const r = runStep(deps.home, step, runner);
              Object.assign(jobState, { running: false, note: r.note, done: true, ok: r.ok });
            } catch (e) {
              Object.assign(jobState, { running: false, done: true, ok: false, note: String(e).slice(0, 200) });
            }
          })();
          json(res, 202, { ok: true, job: jobState });
          return;
        }
        if (body.action === "abort") {
          const session = readSession(deps.home);
          const a = session?.artifacts;
          // **先说再做**：预览里列出会删什么、会恢复什么；没 confirm 就只返回预览
          const preview = {
            models: a?.pulledModels ?? [],
            files: (a?.files ?? []).map((f) => f.path),
            processes: (a?.startedProcesses ?? []).map((p) => p.name),
            dirs: a?.tempDirs ?? [],
          };
          if (body.confirm !== true) { json(res, 200, { ok: true, needConfirm: true, preview }); return; }
          const report = undoSetup(deps.home);
          json(res, 200, { ok: true, report });
          return;
        }
        json(res, 400, { error: "E_BAD_ACTION" });
        return;
      }
      // ── 代码外发（H-7）：默认拒；这里让人批「只这一次」/「10 分钟」──
      if (req.method === "GET" && url.pathname === "/api/egress") {
        json(res, 200, egressStatus(deps.home, { now: now() }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/egress") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { action?: string; path?: string; ttlMin?: number };
        if (body.action === "once") {
          if (!body.path) { json(res, 400, { error: "E_BAD_PATH" }); return; }
          allowOnce(deps.home, body.path);
          json(res, 200, { ok: true, ...egressStatus(deps.home, { now: now() }) });
          return;
        }
        if (body.action === "window") {
          const ttl = Math.min(60, Math.max(1, Number(body.ttlMin ?? 10))) * 60_000;
          const r = allowFor(deps.home, ttl, "面板上批了「这段时间可以」");
          json(res, 200, { ok: true, ...r, ...egressStatus(deps.home, { now: now() }) });
          return;
        }
        if (body.action === "revoke") {
          revokeEgress(deps.home);
          json(res, 200, { ok: true, ...egressStatus(deps.home, { now: now() }) });
          return;
        }
        json(res, 400, { error: "E_BAD_ACTION" });
        return;
      }
      // ── 权限档位（形状照 DSH：当前会话用输入框旁的选择器切）──
      if (req.method === "GET" && url.pathname === "/api/permission") {
        const cur = currentPreset(deps.home, now());
        json(res, 200, { ...cur, presets: PRESETS });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/permission") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { preset?: string; because?: string; ttlMin?: number };
        const preset = String(body.preset ?? "") as Preset;
        if (!PRESETS.some((x) => x.id === preset)) { json(res, 400, { error: "E_BAD_PRESET" }); return; }
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
        return;
      }

      // ── 回执（D-3 的前置通道）：它做完的事必须能被看见 ──
      if (req.method === "GET" && url.pathname === "/api/receipts") {
        const unseenOnly = url.searchParams.get("unseen") !== "0";
        json(res, 200, { unseen: unseenCount(deps.home), items: listReceipts(deps.home, { unseenOnly, limit: 20 }) });
        return;
      }
      const seenId = url.pathname.match(/^\/api\/receipts\/(rcp_[0-9a-z]{6,40})\/seen$/);
      if (req.method === "POST" && seenId) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const r = markSeen(deps.home, String(seenId[1]), now());
        json(res, r ? 200 : 404, r ? { ok: true, seen: true } : { error: "E_RECEIPT_NOT_FOUND" });
        return;
      }

      // ── 常驻指令（D-3）：只读 + 停用；真正的触发由外部调 `jingjing standing tick` ──
      if (req.method === "GET" && url.pathname === "/api/standing") {
        json(res, 200, listStanding(deps.home));
        return;
      }
      const standingOff = url.pathname.match(/^\/api\/standing\/([a-z][a-z0-9-]{2,30})\/disable$/);
      if (req.method === "POST" && standingOff) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { reason?: string };
        const o = disableStanding(deps.home, String(standingOff[1]), String(body.reason ?? "面板上停用"), now());
        json(res, o ? 200 : 404, o ? { ok: true, enabled: o.enabled } : { error: "E_STANDING_NOT_FOUND" });
        return;
      }
      // ── 会话授权（K-3）：窗口活在**这个进程**里，重启即失效 ──
      if (req.method === "GET" && url.pathname === "/api/grants") {
        json(res, 200, listGrants(deps.home, now()));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/grants") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
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
        return;
      }
      const grantRevoke = url.pathname.match(/^\/api\/grants\/(grn_[0-9a-z]+)\/revoke$/);
      if (req.method === "POST" && grantRevoke) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const ok = revokeGrant(deps.home, String(grantRevoke[1]));
        json(res, ok ? 200 : 404, { ok, error: ok ? undefined : "E_NO_GRANT" });
        return;
      }
      // ── 线索层：还没闭合的事（借 Twig 的 thread 概念，不新建表）──
      // ── 卷宗（右栏三签）：一把拿齐 Plan / Changes / Context ─────────
      // 为什么合成一个接口：三张卡每次都要一起刷新，分三个请求会让它们互相错位；
      // 而且这里**只读**（不写库、不跑命令），所以不需要 writeGuarded。
      if (req.method === "GET" && url.pathname === "/api/dossier") {
        const nowD = now();
        const agenda = await import("../agenda.ts");
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
        try { const sk = await import("../skills.ts"); skillsN = sk.scanSkills(deps.home).length; } catch { /* 没装技能 */ }
        let mcpServers = 0, mcpTools = 0;
        try {
          const mc = (await import("../mcp.ts")).loadMcpConfig(deps.home);
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
          },
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/threads") {
        json(res, 200, openThreads(deps.db, now()));
        return;
      }
      const threadClose = url.pathname.match(/^\/api\/threads\/(\d+)\/close$/);
      if (req.method === "POST" && threadClose) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { note?: string };
        const ok = closeThread(deps.db, Number(threadClose[1]), String(body.note ?? ""), now());
        json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "E_THREAD_CLOSED" });
        return;
      }

      // ── 抽检（J-5b）：把线送到眼前，当场能断 ────────────
      if (req.method === "GET" && url.pathname === "/api/surface/review") {
        json(res, 200, reviewQueue(deps.db, now()));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/surface/review") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const body = JSON.parse(await readBody(req)) as { src_id?: number; dst_id?: number; rel?: string; ok?: boolean };
        if (!body.src_id || !body.dst_id || !body.rel) { json(res, 400, { error: "E_BAD_LINK" }); return; }
        const key = linkKey(body.src_id, body.dst_id, body.rel);
        noteReviewed(deps.db, now(), key);
        if (body.ok === false) {
          cutLink(deps.db, { src_id: body.src_id, dst_id: body.dst_id, rel: body.rel }, now());
        }
        json(res, 200, { ok: true, cut: body.ok === false, key });
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
        // H-a / H-b：她自己在惦记的事 + 对人的理解（每句都带出处）
        let agendaLines: string[] = [];
        let interpLines: string[] = [];
        try {
          const ag = await import("../agenda.ts");
          agendaLines = ag.agendaForBrief(deps.home, 2);
        } catch { /* 没有就算了 */ }
        try {
          const ip = await import("../interpret.ts");
          interpLines = ip.interpretationsForBrief(deps.db, 2);
        } catch { /* 没有就算了 */ }
        // 技能索引：只放「名字（一句描述）」，正文让模型自己 skill.read 取
        let skillIdx: string | null = null;
        try {
          const sk = await import("../skills.ts");
          skillIdx = sk.skillsIndexText(sk.indexableSkills(sk.scanSkills(deps.home))) || null;
        } catch { /* 没有技能不影响对话 */ }
        const selfState = advance(deps.db, { turns: 1, silenceDays: last ? (now().getTime() - new Date(last.ts).getTime()) / 86400000 : 0 }, now());
        const brief = buildBrief({
          now: now(), persona: loadPersona(deps.home), contracts, recalled,
          lastSeenAt: last ? new Date(last.ts) : null,
          outage: pending,
          state: { energy: selfState.energy, closeness: selfState.closeness, mood: selfState.mood ?? undefined },
          agenda: agendaLines,
          interpretations: interpLines,
          skills: skillIdx,
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
          // 用户分不清本地/云端 —— 首帧就把答案给他（面板在消息 meta 里显示）
          responder: (() => {
            try {
              const ex = deps.getConfig().roles["express"] as { kind?: string; model?: string; provider?: string } | undefined;
              const kind = ex?.kind === "local" ? "local" : "cloud";
              return {
                kind, model: ex?.model ?? null, provider: ex?.provider ?? null,
                label: (kind === "local" ? "本地" : "云端") + " · " + (ex?.model ?? "未配置"),
              };
            } catch {
              return { kind: "unknown", model: null, provider: null, label: "未知" };
            }
          })(),
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
