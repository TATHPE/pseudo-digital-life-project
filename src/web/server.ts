/**
 * 本地 Web 面板（17 §4）：127.0.0.1:7700，零前端依赖，SSE 流式。
 * 不提供"新对话"——只有"忘记"（需要确认，走 memories 面板）。
 */
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { whaleSvg } from "./brand.ts";
import * as deskT from "./desk.ts";
import { groupTimeline, type Msg } from "./timeline.ts";
import { appendEvent, newEventId, readEvents } from "../journal.ts";
import { openSession, touchSession, closeSession, listSessions, getSession, titleFrom, branchSession, undoSession, undoKeep } from "../sessions.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { search, searchDocs } from "../retrieve.ts";
import { buildBrief } from "../brief.ts";
import { loadPersona } from "../persona.ts";
import { expenseLine } from "./state.ts";
import {readFileConfig, normalizeAgentName} from "../configfile.ts";
import { recompute, w0FromImportance, type Stage } from "../decay.ts";
import { capabilities } from "../capabilities.ts";
import { preflight } from "../preflight.ts";
import {listProposals} from "../proposals.ts";
import {currentPreset} from "../grant.ts";
import {egressStatus} from "../egress.ts";
import { readSession } from "../setup.ts";
import {ingestPath, collectFiles} from "../ingest.ts";
import { atomicWriteFile } from "../fsx.ts";
import { safePath } from "../pathsafe.ts";
import { SUPPORTED_EXTS, MAX_INGEST_BYTES } from "../ingest.ts";
import { createTransport, routerFrom } from "../transport.ts";
import { recallForBrief, omissionNote } from "../recall.ts";
import { toolHuman } from "../toolhint.ts";
import { mcpFingerprint } from "../plugins.ts";
import { decideSurface, pickSurface, noteSurfaced, usedToday } from "../surface.ts";
import { reinforce, updateMemoryText, patchMemoryMeta } from "../store.ts";
import { meta } from "../db.ts";
import { openContracts } from "../store.ts";
import { execute } from "../execute.ts";
import { loadPolicy, type Policy } from "../policy.ts";
import {createStore, type Provider} from "../auth.ts";
import type { ToolRegistry } from "../tools.ts";
import { runAgent, type ChatFn } from "../agent.ts";
import { resolveMode, type Mode } from "../mode.ts";
import { handleStatus } from "./routes/status.ts";
import { handleConfig } from "./routes/config.ts";
import { handleSetup } from "./routes/setup.ts";
import { handleMemory } from "./routes/memory.ts";
import { handleControl } from "./routes/control.ts";

/** 上一轮实际用的档：自动判定靠它做粘性（**每个 server 一份**，不是进程级） */
import { renderMarkdown, esc } from "../md.ts";
import { loadState, advance, describe } from "../state.ts";
import type { Outage } from "../types.ts";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
const joinDir = (a: string, b: string) => join(a, b);
const posixPath = (p: string) => p.split("\\").join("/");
import type { StreamTransport } from "../transport.ts";
import type { Embedder } from "../embed.ts";
import type { MemoryLine } from "../types.ts";


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
  /** 云端能不能用（有 key 才算）。没有就整轮走本地、不给工具 */
  cloudReady?: () => boolean;

  /** 启动时检测到的缺口（只报告一次，首轮后清空） */
  pendingOutage?: Outage | null;
  /** B-0：真实 MCP 连接结果（面板要能说清"哪个 server 没挂上"） */
  mcpInfo?: { servers: string[]; tools: string[]; errors: string[]; /** 启动时加载的那份 mcp.json 指纹（判「待生效」） */ running?: string | null };
  getEmbedder: () => Embedder | null;
  /** 手动跑一次闲时整理（面板按钮用）。返回退出码 */
  runNight?: () => Promise<number>;
  /** 重连 MCP（不给 server 就全部）。返回最新实况 */
  reconnectMcp?: (server?: string) => Promise<{ servers: string[]; tools: string[]; errors: string[]; dropped: number; added: number }>;
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
  trace?: Array<{ k: string; t: string; ms?: number }>;
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
      const p = (e.payload ?? {}) as { text?: string; tools?: ToolUse[]; trace?: Array<{ k: string; t: string; ms?: number }>; cites?: string[]; omitted?: number; omittedDocs?: number };
      return {
        ts: e.ts,
        role: e.kind === "utterance" ? ("user" as const) : ("agent" as const),
        text: String(p.text ?? ""),
        ...(p.tools?.length ? { tools: p.tools } : {}),
        ...(p.trace?.length ? { trace: p.trace } : {}),
        ...(p.cites?.length ? { cites: p.cites } : {}),
        ...(p.omitted ? { omitted: p.omitted } : {}),
        ...(p.omittedDocs ? { omittedDocs: p.omittedDocs } : {}),
      };
    });
}

/**
 * 把正文里**明写的思考**拆出去（2026-11-05）。
 *
 * 有两类「思考混进正文」：
 *  · 模型把推理写成正文（“我先跑一条 curl，结果报错，再换一种…”）——这类靠提示词约束 + 推理通道分离；
 *  · 模型用 <think>…</think> 或 ```think 把推理包起来 —— 这类是**确定的**，这里直接拆走，
 *    正文只留结论，拆出来的丢进过程（trace）。
 */
export function splitThink(text: string): { text: string; thinks: string[] } {
  const thinks: string[] = [];
  let out = String(text ?? "");
  out = out.replace(/<think(?:ing)?>([\s\S]*?)<\/(?:think|thinking)>/gi, (_m, body: string) => {
    if (body.trim()) thinks.push(body.trim().slice(0, 1200));
    return "";
  });
  out = out.replace(/```think\n([\s\S]*?)```/gi, (_m, body: string) => {
    if (body.trim()) thinks.push(body.trim().slice(0, 1200));
    return "";
  });
  return { text: out.trim(), thinks };
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
    // 跳过过（「先用着」）就不再拦：那是用户明确的选择，不该每次启动都再问一遍
    return s.status !== "done" && s.status !== "skipped";
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
  // 图标从 brand.ts 来 —— 旧面板从程序里撤下之后，唯一还需要它的地方就是这里
  return whaleSvg("#000");
}




/** 从事件流里把「一问一答」配成轮次：一条 utterance 开一轮，后面那条 agent_reply 是它的回答 */
interface TurnRow { id: string; userTs: string; agentTs: string | null; user: string; agent: string; tools: number }
function readTurns(deps: WebDeps, sessionId: string): TurnRow[] {
  const { events } = readEvents(deps.inboxDir);
  const mine = events
    .filter((e) => (e.kind === "utterance" || e.kind === "agent_reply") &&
      String(((e.payload ?? {}) as { session?: string }).session ?? "") === sessionId)
    .slice()
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const out: TurnRow[] = [];
  for (const e of mine) {
    const p = (e.payload ?? {}) as { text?: string; tools?: unknown[] };
    if (e.kind === "utterance") {
      out.push({ id: e.id, userTs: e.ts, agentTs: null, user: String(p.text ?? ""), agent: "", tools: 0 });
    } else {
      const last = out[out.length - 1];
      if (last) {
        last.agentTs = e.ts;
        last.agent = String(p.text ?? "");
        last.tools = Array.isArray(p.tools) ? p.tools.length : 0;
      }
    }
  }
  return out;
}

export function createWebServer(deps: WebDeps) {
  /** 自动切档的粘性：每个 server 自己记上一轮，跨 home / 跨测试互不影响 */
  let lastMode: Mode = "chat";
  const now = deps.now ?? (() => new Date());
  // 每次请求都 createStore 会重新做一遍 DPAPI 探测（又是一个 PowerShell 进程）；
  // 存储本身无状态，进程内复用即可（clear/set 会自己让解密缓存失效）。
  let secretStore: ReturnType<typeof createStore> | null = null;
  const secrets = () => (secretStore ??= createStore(joinDir(deps.home, "secrets")));
  // 正在流式回答的会话 → 打断函数（interrupt 用；进程内存，重启即空）
  const activeSays = new Map<string, () => void>();

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
          "<p><b>" + normalizeAgentName(readFileConfig(deps.home).agent?.name) + " 是桌面应用。</b></p>" +
          "<p>这一页不能从浏览器直接打开 —— 从桌面上的 Pseudo Digital Life Project 图标启动，它会带着自己的一次性令牌加载界面。</p>" +
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
      // 首次配置的引导页：分流放在**服务端**，所以桌面壳一行都不用改（窗口仍然加载 /）
      if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/welcome")) {
        const forced = url.pathname === "/welcome";
        const skip = url.searchParams.get("skip") === "1";
        if (forced || (!skip && needsWelcome(deps.home))) {
          const { WELCOME } = await import("./welcome.ts");
          // 名字可能是用户自己取的（默认是预置人格「鲸鲸」）
          const nm = normalizeAgentName(readFileConfig(deps.home).agent?.name);
          // 引导页：尊重同一份配置（off 就不播；simple/full 照选）
          const bootMod2 = await import("./boot.ts");
          const splash2 = bootMod2.splashMode(readFileConfig(deps.home).ui);
          const bootHtml = splash2 === "off" ? "" : bootMod2.bootOverlay(splash2 === "simple" ? "simple" : "full");
          const page = WELCOME.split("{{AGENT}}").join(nm).split("<!--BOOT-->").join(bootHtml);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(req.method === "HEAD" ? undefined : page);
          return;
        }
      }

      // 界面：2026-11-05 起**只有记录本**。
      // 旧面板（page.ts）从程序里撤下来了：没有路由、没有开关、没有第二套。
      // 代码留在仓里备查（用户要求"不删"），要回退去 git history 里找。
      // ── 界面脚本（2026-11-06）：从模板字符串里抽出来的真文件 ──
      // 只认 src/web/ui/<名字>.js，名字里不许有路径分隔符；改完不用重启就生效（no-store）。
      const uiAsset = url.pathname.match(/^\/ui\/([a-z0-9-]+\.js)$/);
      if ((req.method === "GET" || req.method === "HEAD") && uiAsset) {
        const f = new URL("./ui/" + String(uiAsset[1]), import.meta.url);
        try {
          const body = readFileSync(f, "utf8");
          res.writeHead(200, {
            "content-type": "application/javascript; charset=utf-8",
            "content-length": String(Buffer.byteLength(body)),
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          if (req.method === "HEAD") { res.end(); return; }
          res.end(body);
        } catch {
          json(res, 404, { error: "E_NO_ASSET" });
        }
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/notebook")) {
        const { NOTEBOOK } = await import("./notebook.ts");
        // 片头仍然按配置播（ui.splash：off / simple / full），记录本里留了 <!--BOOT--> 占位
        const bootMod = await import("./boot.ts");
        const splash = bootMod.splashMode(readFileConfig(deps.home).ui);
        const bootHtml = splash === "off" ? ""
          : splash === "full"
            ? [
                '<iframe id="jjboot" src="/splash" title="" aria-hidden="true" style="position:fixed;inset:0;z-index:9999;border:0;background:#050706;width:100%;height:100%"></iframe>',
                "<script>(function(){",
                "  var f=document.getElementById('jjboot');if(!f)return;var done=false;",
                "  function off(){if(done)return;done=true;f.style.transition='opacity .5s';f.style.opacity='0';",
                "    setTimeout(function(){if(f&&f.parentNode)f.parentNode.removeChild(f);},520);}",
                "  window.addEventListener('message',function(e){if(e.data==='jjboot-done')off();});",
                "  setTimeout(off,22000);",
                "})();</script>",
              ].join(String.fromCharCode(10))
            : bootMod.bootOverlay(splash);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        // 主题在服务端就写进 <html>：否则首屏会是默认主题，闪一下再变（2026-11-06）
        const themeAttr = readFileConfig(deps.home).ui?.theme === "hermes" ? ' data-theme="hermes"' : "";
        const agentName = normalizeAgentName(readFileConfig(deps.home).agent?.name);
        const page = NOTEBOOK
          .replace('<html lang="zh-CN">', '<html lang="zh-CN"' + themeAttr + '>')
          .split("{{AGENT}}").join(agentName)
          .split("<!--BOOT-->").join(bootHtml);
        res.end(req.method === "HEAD" ? undefined : page);
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

      // ── 插件重连：不用重启整个 sidecar（学 Coopanion 的 World 单独重启）──
      if (req.method === "POST" && url.pathname === "/api/plugins/reconnect") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        if (!deps.reconnectMcp) { json(res, 400, { error: "E_NO_HUB", why: "这个进程没有 MCP 连接中心" }); return; }
        let body: { server?: string } = {};
        try { body = JSON.parse(await readBody(req)) as { server?: string }; } catch { /* 空 body = 全部 */ }
        try {
          const st = await deps.reconnectMcp(body.server);
          if (deps.mcpInfo) { deps.mcpInfo.servers = st.servers; deps.mcpInfo.tools = st.tools; deps.mcpInfo.errors = st.errors; }
          json(res, 200, { ok: true, ...st });
        } catch (e) {
          json(res, 500, { error: "E_RECONNECT", why: String((e as Error).message ?? e).slice(0, 160) });
        }
        return;
      }

      // ── 状态 / 只读 GET 路由（已抽到 ./routes/status.ts）──
      if (await handleStatus({ req, res, url, deps, now, json })) return;

      // ── 完整档片头：550C 骨架上改出来的那份，数据现取（拿不到的显示 —）──
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/splash") {
        try {
          const { renderSplash } = await import("./splash.ts");
          const cfg = deps.getConfig();
          const meta = (k: string) => { const r = deps.db.prepare("SELECT value v FROM meta WHERE key=?").get(k) as { v?: string } | undefined; return r?.v; };
          const cnt = (sql: string) => Number((deps.db.prepare(sql).get() as { c?: number })?.c ?? 0);
          const emb = cfg.roles["embed"];
          const ex = cfg.roles["express"];
          let skillsN: number | undefined;
          try { const sk = await import("../skills.ts"); skillsN = sk.scanSkills(deps.home).length; } catch { /* 没装技能 */ }
          let mcpServers: number | undefined;
          try {
            const mc = (await import("../mcp.ts")).loadMcpConfig(deps.home);
            mcpServers = Object.keys(mc.servers ?? {}).length;
          } catch { /* 没配 MCP */ }
          // 端口用请求自己的 host（比猜 deps 里有什么可靠）
          const host = String(req.headers.host ?? "");
          const html = renderSplash({
            schema: meta("schema_version") ?? undefined,
            memories: cnt("SELECT count(*) c FROM memories WHERE status='active'"),
            docs: cnt("SELECT count(*) c FROM documents WHERE deleted_at IS NULL"),
            chunks: cnt("SELECT count(*) c FROM chunks"),
            tools: deps.tools ? deps.tools.list().filter((t) => !t.name.startsWith("mcp__")).length : undefined,
            skills: skillsN,
            plugins: mcpServers === undefined ? undefined : String(mcpServers) + " server",
            embed: emb ? String(emb.model) + (emb.provider ? " · " + String(emb.provider) : "") : undefined,
            model: ex ? String(ex.provider) + "/" + String(ex.model) : undefined,
            sidecar: host ? host : undefined,
          });
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(req.method === "HEAD" ? undefined : html);
        } catch (e) {
          json(res, 500, { error: "E_SPLASH", why: String((e as Error).message ?? e).slice(0, 120) });
        }
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/icon.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=3600" });
        res.end(req.method === "HEAD" ? undefined : faviconSvg());
        return;
      }
      // 健康检查（19 §7.3 / compose healthcheck）：只回答“能不能服务”，不做重活（不跑 quick_check）
      // 体面退出（2026-11-05）：壳关窗时先打这里，把 data/.desk.json 清掉再退。
      // 原来直接 taskkill /F，node 的 exit 钩子来不及跑，令牌文件就留在磁盘上。
      if (req.method === "POST" && url.pathname === "/api/shutdown") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const deskT2 = await import("./desk.ts");
        deskT2.clearDeskRuntime(deps.home);
        json(res, 200, { ok: true, bye: true });
        // 先把响应发出去，再退（否则壳那边拿到的是连接被重置）
        setTimeout(() => process.exit(0), 60);
        return;
      }
      // ── QQ 接入（OneBot 11）：读写 data/bridge.json + 报桥的运行状态 ──
      if (req.method === "GET" && url.pathname === "/api/bridge") {
        try {
          const b = await import("../bridge.ts");
          const cfg = b.readBridgeConfig(deps.home);
          json(res, 200, { config: cfg, state: b.bridgeState(), path: b.configPath(deps.home) });
        } catch (e) { json(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 160) }); }
        return;
      }
      if (req.method === "PUT" && url.pathname === "/api/bridge") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        try {
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          const b = await import("../bridge.ts");
          const cur = b.readBridgeConfig(deps.home);
          const str = (v: unknown, d: string) => (typeof v === "string" ? v.trim() : d);
          const arr = (v: unknown, d: string[]) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 50) : d);
          const mode = String(body.mode ?? cur.mode ?? "private");
          if (!["private", "group", "all"].includes(mode)) { json(res, 400, { error: "E_BAD_MODE", why: "private | group | all" }); return; }
          const next = {
            enabled: body.enabled === undefined ? Boolean(cur.enabled) : Boolean(body.enabled),
            ws: str(body.ws, String(cur.ws ?? "")),
            accessToken: str(body.accessToken, String(cur.accessToken ?? "")),
            selfId: str(body.selfId, String(cur.selfId ?? "")),
            mode: mode as "private" | "group" | "all",
            allowUsers: arr(body.allowUsers, cur.allowUsers ?? []),
            allowGroups: arr(body.allowGroups, cur.allowGroups ?? []),
            prefix: str(body.prefix, String(cur.prefix ?? "")),
          };
          if (next.enabled && !/^wss?:\/\//i.test(next.ws)) { json(res, 400, { error: "E_BAD_WS", why: "要 ws:// 或 wss:// 开头" }); return; }
          writeFileSync(joinDir(deps.home, "bridge.json"), JSON.stringify({ onebot: next }, null, 2) + String.fromCharCode(10));
          // 保存即生效：开了就当场起，关了当场停（不用重启软件）
          try {
            if (next.enabled) void b.startBridge(deps.home, { log: (x) => console.log("[bridge] " + x) });
            else if (b.bridgeState().running) b.stopBridge();
          } catch { /* 起不来不影响保存 */ }
          json(res, 200, { ok: true, config: next, state: b.bridgeState() });
        } catch (e) { json(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 160) }); }
        return;
      }
      // ── 待你处理：提议 + 代码外发，合成一个列表（2026-11-05）──
      // 回复仍然走各自原有的接口（/api/proposals/:id、/api/egress），这里只做汇总。
      if (req.method === "GET" && url.pathname === "/api/approvals") {
        try {
          const { listProposals } = await import("../proposals.ts");
          const { egressStatus } = await import("../egress.ts");
          const props = listProposals(deps.home, { status: "open" }) as Array<{ id: string; title?: string; why?: string; createdAt?: string }>;
          const eg = egressStatus(deps.home, { now: now() });
          const items = [
            ...props.map((p) => ({
              id: p.id, kind: "proposal",
              title: String(p.title ?? ""), detail: String(p.why ?? ""),
              at: String(p.createdAt ?? ""), route: "/api/proposals/" + p.id,
            })),
            ...(eg.pending || []).map((x) => ({
              id: "egress:" + x.path, kind: "egress",
              title: "要把代码发出去：" + x.path,
              detail: String(x.verb ?? "") + " · " + String(x.at ?? ""),
              at: String(x.at ?? ""), route: "/api/egress",
            })),
          ];
          json(res, 200, { items, count: items.length });
        } catch (e) { json(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 160) }); }
        return;
      }
      // ── 会话：一次可指认的对话（2026-11-05）──
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        try { json(res, 200, { sessions: listSessions(deps.db, Number(url.searchParams.get("limit") ?? 30)) }); }
        catch (e) { json(res, 500, { error: String((e as Error)?.message ?? e).slice(0, 160) }); }
        return;
      }
      const sessGet = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{4,40})$/);
      if (req.method === "GET" && sessGet) {
        const id = String(sessGet[1]);
        const row = getSession(deps.db, id);
        if (!row) { json(res, 404, { error: "E_NO_SESSION" }); return; }
        const { events } = readEvents(deps.inboxDir);
        const keep = undoKeep(deps.db, id);
        const msgs = events
          .filter((e) => (e.kind === "utterance" || e.kind === "agent_reply") &&
            String(((e.payload ?? {}) as { session?: string }).session ?? "") === id)
          .map((e) => {
            const p = (e.payload ?? {}) as { text?: string };
            return { role: e.kind === "utterance" ? "user" : "agent", text: String(p.text ?? ""), ts: e.ts };
          });
        // 工具轨迹：从 agent_reply 的 tools 里抽（这是我们现在真有的数据）
        const tools: Array<{ name: string; args: string; result: string; ms?: number }> = [];
        for (const e of events) {
          if (e.kind !== "agent_reply") continue;
          if (String(((e.payload ?? {}) as { session?: string }).session ?? "") !== id) continue;
          const p = (e.payload ?? {}) as { tools?: Array<{ name?: string; args?: string; result?: string; ms?: number }> };
          for (const t of p.tools ?? []) {
            tools.push({
              name: String(t.name ?? ""), args: String(t.args ?? ""), result: String(t.result ?? ""),
              ...(typeof t.ms === "number" ? { ms: t.ms } : {}),
            });
          }
        }
        const shown = keep == null ? msgs : msgs.slice(0, keep);
        json(res, 200, { session: row, messages: shown, tools });
        return;
      }
      // ── 轮次：一问一答 = 一轮（2026-11-05）。能单独撤回、重问、看这一轮的审计 ──
      const turnList = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{4,40})\/turns$/);
      if (req.method === "GET" && turnList) {
        const id = String(turnList[1]);
        json(res, 200, { turns: readTurns(deps, id) });
        return;
      }
      const turnAct = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{4,40})\/turns\/([A-Za-z0-9_-]{4,40})\/(undo|retry|audit|steer)$/);
      if (req.method === "POST" && turnAct) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const sid = String(turnAct[1]);
        const tid = String(turnAct[2]);
        const what = String(turnAct[3]);
        const turns = readTurns(deps, sid);
        const idx = turns.findIndex((t) => t.id === tid);
        if (idx < 0) { json(res, 404, { error: "E_NO_TURN" }); return; }
        if (what === "undo") {
          // 保留这一轮之前的消息（每轮两条：问 + 答）
          const ok = undoSession(deps.db, sid, idx * 2);
          json(res, 200, { ok });
          return;
        }
        if (what === "steer") {
          // 真的重答：同一句用户原话 + 一条补充要求，模型重新生成一次，
          // 新回答作为这一轮的最新答复（readTurns 取最后一条）。
          const body = JSON.parse(await readBody(req)) as { note?: string };
          const note = String(body.note ?? "").trim().slice(0, 300);
          if (!note) { json(res, 400, { error: "E_NO_NOTE" }); return; }
          const t = turns[idx]!;
          const emb = deps.getEmbedder();
          const rc = await recallForBrief(deps.db, emb, t.user, { memK: 4, docK: 0, home: deps.home });
          const memLines = rc.recalled.filter((m) => m.layer === "contract" || m.source === "memory")
            .slice(0, 5).map((m) => "- " + String(m.text).slice(0, 120));
          const persona = loadPersona(deps.home);
          const system = [
            persona.core,
            memLines.length ? "你能确定的事实：" + String.fromCharCode(10) + memLines.join(String.fromCharCode(10)) : "",
            "这一轮用户要求你换一种说法重答，要求是：" + note,
            "不要解释你在重答，直接给出新的回答。",
          ].filter(Boolean).join(String.fromCharCode(10));
          let out = "";
          try {
            if (deps.reply) { for await (const d of deps.reply(system, t.user)) out += d; }
            else {
              const gen = deps.getTransport().completeStream("express",
                [{ role: "system", content: system }, { role: "user", content: t.user }],
                { containsMemory: true, purpose: "steer", maxTokens: 1200 });
              for await (const d of gen) out += d;
            }
          } catch (e) {
            json(res, 502, { error: "E_STEER_MODEL", why: String((e as Error)?.message ?? e).slice(0, 160) });
            return;
          }
          const text2 = out.trim();
          if (!text2) { json(res, 502, { error: "E_STEER_EMPTY" }); return; }
          appendEvent(deps.inboxDir, {
            v: 1, id: newEventId(), ts: now().toISOString(), kind: "agent_reply", actor: "agent",
            payload: { text: text2, session: sid, steerOf: tid },
          });
          json(res, 200, { ok: true, text: text2 });
          return;
        }
        if (what === "retry") {
          // 重问：把用户原话交回去，由面板重新发（不在服务端偷偷重跑）
          json(res, 200, { ok: true, text: turns[idx]!.user });
          return;
        }
        // 这一轮的审计：按 [用户时间, 回复时间] 取 exec_audit
        const from = turns[idx]!.userTs;
        const to = turns[idx]!.agentTs || now().toISOString();
        const rows = deps.db.prepare(
          "SELECT ts,verb,decision,exit_code,argv_json FROM exec_audit WHERE ts>=? AND ts<=? ORDER BY ts ASC LIMIT 50",
        ).all(from, to) as Array<{ ts: string; verb: string; decision: string; exit_code: number | null; argv_json: string }>;
        json(res, 200, { audit: rows.map((r) => ({ ts: r.ts, verb: r.verb, decision: r.decision, exit: r.exit_code, argv: String(r.argv_json ?? '').slice(0, 200) })) });
        return;
      }
      const sessAct = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{4,40})\/(close|rename|interrupt|branch|undo)$/);
      if (req.method === "POST" && sessAct) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return; }
        const id = String(sessAct[1]);
        const what = String(sessAct[2]);
        if (what === "close") { json(res, 200, { ok: closeSession(deps.db, id, now()) }); return; }
        if (what === "branch") {
          const r = branchSession(deps.db, id, now());
          json(res, r ? 200 : 404, r ? { ok: true, session: r } : { error: "E_NO_SESSION" });
          return;
        }
        if (what === "undo") {
          // 撤回这一问一答：用会话自己的消息计数（不依赖时间戳，也不重扫 inbox）
          const cur = getSession(deps.db, id);
          if (!cur) { json(res, 404, { error: "E_NO_SESSION" }); return; }
          if (cur.msgs <= 0) { json(res, 400, { error: "E_NOTHING_TO_UNDO" }); return; }
          const ok = undoSession(deps.db, id, Math.max(0, cur.msgs - 2));
          json(res, 200, { ok });
          return;
        }
        if (what === "rename") {
          const body = JSON.parse(await readBody(req)) as { title?: string };
          touchSession(deps.db, id, { title: String(body.title ?? "") });
          json(res, 200, { ok: true });
          return;
        }
        const abort = activeSays.get(id);
        if (abort) { abort(); json(res, 200, { ok: true, interrupted: true }); }
        else json(res, 200, { ok: true, interrupted: false });
        return;
      }
      // ── P0/P1 的支撑接口：动作审计 / 搜索 / 记忆纠错 / 面板内摄入 / 测连接 / 用量 ──

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
            ...(src?.trace?.length ? { trace: src.trace } : {}),   // 过程要能回看（右栏第四个签）
            ...(src?.cites ? { cites: src.cites } : {}),
            ...(src?.omitted ? { omitted: src.omitted } : {}),
            ...(src?.omittedDocs ? { omittedDocs: src.omittedDocs } : {}),
          };
        });
        json(res, 200, out);
        return;
      }
      if (await handleConfig({ req, res, url, deps, now, json, readBody, writeGuarded, secrets })) return;
      if (await handleMemory({ req, res, url, deps, now, json, readBody, writeGuarded })) return;
      if (await handleSetup({ req, res, url, deps, now, json, readBody, writeGuarded, secrets })) return;
      if (await handleControl({ req, res, url, deps, now, json, readBody, writeGuarded, lastMode })) return;
      if (req.method === "POST" && url.pathname === "/api/say") {
        const body = JSON.parse(await readBody(req)) as { text?: string };
        const text = (body.text ?? "").trim();
        if (!text) { json(res, 400, { error: "E_EMPTY" }); return; }
        if (looksMojibake(text)) {
          json(res, 400, { error: "E_ENCODING", hint: "请求体不是 UTF-8（可能是 GBK），拒绝写入记忆" });
          return;
        }

        const ts = now().toISOString();
        // 会话对象：这一轮挂在哪个 session 上（4 小时内的连续对话算同一次）
        let sess: { id: string; title: string } = { id: "", title: "" };
        try {
          sess = openSession(deps.db, now(), { title: titleFrom(text) });
          if (!sess.title) touchSession(deps.db, sess.id, { title: titleFrom(text) });
        } catch { /* 会话记账失败不影响对话 */ }
        appendEvent(deps.inboxDir, { v: 1, id: newEventId(), ts, kind: "utterance", actor: "user", payload: { text, session: sess.id } });

        // 当场记住（2026-11-04）：明确的记性请求不排队等夜里那一次批处理。
        // 纯规则、不看模型（认不出就交给夜间整理）—— 误记比漏记贵。
        // 记下了要**说出来**：不说的话，"她记住了"和"她没听见"在界面上长得一模一样。
        const memos: string[] = [];
        try {
          const { captureExplicit, writeExplicit } = await import("../explicit.ts");
          for (const e of captureExplicit(text)) {
            if (writeExplicit(deps.db, e, text, now())) memos.push(e.text);
          }
        } catch { /* 捕获失败不影响这轮对话 */ }

        // 召回 → 简报。云端只收 shareable；local_only 只报个数（13 §10）
        const emb = deps.getEmbedder();
        // 召回装配在 recall.ts 里（隐私闸门所在：只有 shareable 会进简报）
        const rc = await recallForBrief(deps.db, emb, text, { memK: 6, docK: 4, home: deps.home });
        let omitted = rc.omittedMem;
        const recalled: MemoryLine[] = rc.recalled;
        // 这一轮是不是只能靠本地（云端没有 key / 只有本地 express）。
        // 只算一次：自动切档与 P15 用的是同一个事实，算两次迟早会不一致。
        let localOnlyTurn = false;
        try { localOnlyTurn = deps.cloudReady ? !deps.cloudReady() : false; } catch { localOnlyTurn = false; }
        // 模式：chat（默认，靠记忆召回） / work（带最近几轮历史 + 更宽的预算）
        // 自动切档（2026-11-07）：config.mode = auto 时按这句话判；手动设了就用手动值
        const modePick = (() => {
          let raw = "auto";
          try { raw = String(readFileConfig(deps.home).mode ?? "auto"); } catch { raw = "auto"; }
          if (raw === "work" || raw === "chat") return { mode: raw as "chat" | "work", why: "手动", auto: false };
          const d = resolveMode(text, { prev: lastMode, hasTools: !localOnlyTurn });
          lastMode = d.mode;
          return { mode: d.mode, why: d.why + (d.sticky ? "（承接）" : ""), auto: true };
        })();
        const mode = modePick.mode;
        // 两档都带历史（2026-11-06）。以前只有工作模式带，聊天模式连「刚才那条」都接不住，
        // 那不叫聊天。差别只在长度：聊天近而短（8 条 / 220 字），工作远而长（16 条 / 600 字）。
        // 不含工具轨迹 —— 跨轮的 tool 消息在协议上不合法，细节已经在右栏里。
        const history = messages(deps.db, deps.inboxDir)
          .slice(-(mode === "work" ? 16 : 8))
          .map((m) => ({
            role: (m.role === "user" ? "user" : "agent") as "user" | "agent",
            text: String(m.text ?? "").slice(0, mode === "work" ? 600 : 220),
          }))
          .filter((m) => m.text.trim());
        // P16：她自己的容量（问「你能读多少记忆」时要能直接答，不用去查库）
        let capMem = 0, capDocs: number | undefined, capChunks: number | undefined;
        try {
          capMem = Number((deps.db.prepare("SELECT count(*) c FROM memories WHERE status='active'").get() as { c?: number })?.c ?? 0);
          capDocs = Number((deps.db.prepare("SELECT count(*) c FROM documents WHERE deleted_at IS NULL").get() as { c?: number })?.c ?? 0);
          capChunks = Number((deps.db.prepare("SELECT count(*) c FROM chunks").get() as { c?: number })?.c ?? 0);
        } catch { /* 查不到就不写这一槽 */ }
        const capacity = { memories: capMem, ...(capDocs === undefined ? {} : { docs: capDocs }), ...(capChunks === undefined ? {} : { chunks: capChunks }), recallMax: 8, searchMax: 20 };

        // 插件现状：在跑的 / 连不上的 / 改了还没重启的。
        // 学自 Coopanion：它把 World 的生死直接告诉模型；我们之前一句话都没有。
        const pluginState = (() => {
          const mi = deps.mcpInfo;
          if (!mi) return undefined;
          let pending = false;
          try {
            const disk = mcpFingerprint(deps.home);
            pending = Boolean(disk && mi.running && disk !== mi.running);
          } catch { /* 算不出就不报 */ }
          return { running: mi.servers ?? [], errors: mi.errors ?? [], pending };
        })();

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
        // 我现在的权限（P15）：不说这一句，她明明能跑命令也会说「我不能操作你的电脑」
        let powers: string | null = null;
        try {
          const sg = await import("../supergrant.ts");
          const perm = currentPreset(deps.home, now());
          powers = sg.powersLine(deps.home, perm.preset, egressStatus(deps.home, { now: now() }).until !== null, { noTools: localOnlyTurn });
        } catch { /* 读不到就不加这一槽 */ }
        const selfState = advance(deps.db, { turns: 1, silenceDays: last ? (now().getTime() - new Date(last.ts).getTime()) / 86400000 : 0 }, now());
        // 缺口：一天最多问一次（冷却写 meta，免得她每轮查户口）
        let gapAsk: string | null = null;
        try {
          const { nextAsk, markAsked } = await import("../profile.ts");
          const g = nextAsk(deps.db, now());
          if (g) { gapAsk = g.question; markAsked(deps.db, now()); }
        } catch { /* 没有缺口就算了 */ }

        const brief = buildBrief({
          now: now(), persona: loadPersona(deps.home), contracts, recalled,
          lastSeenAt: last ? new Date(last.ts) : null,
          outage: pending,
          state: { energy: selfState.energy, closeness: selfState.closeness, mood: selfState.mood ?? undefined },
          agenda: agendaLines,
          interpretations: interpLines,
          skills: skillIdx,
          powers,
          capacity,
          plugins: pluginState,
          mode,
          ...(history ? { history } : {}),
          ...(gapAsk ? { gapAsk } : {}),
          ...(rc.rerankNone ? { rerankNone: true } : {}),
          user: (() => { const note = omissionNote(omitted, rc.omittedDocs); return note ? note + String.fromCharCode(10) : ""; })() + text,
        });

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store", connection: "keep-alive",
        });
        const send = (o: unknown) => { try { res.write(`data: ${JSON.stringify(o)}` + String.fromCharCode(10, 10)); } catch { /* 已断开 */ } };
        // 当场记住的要说出来（否则"记住了"和"没听见"在界面上一样）
        for (const m of memos) send({ type: "memo", text: "已记下：" + m });
        // 用户点“停止”/关页面时浏览器会断开；服务端必须跟着停，否则只是“看不见”，token 照烧
        let aborted = false;
        res.on("close", () => { aborted = true; });
        // 会话可被打断：登记一个停止函数，POST /api/sessions/:id/interrupt 调它
        if (sess.id) {
          activeSays.set(sess.id, () => { aborted = true; try { res.end(); } catch { /* 已断开 */ } });
          res.on("close", () => { activeSays.delete(sess.id); });
        }
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
        // 这一轮判成了哪档（auto 时 chip 的后半截跟着它）
        try { send({ type: "mode", mode: modePick.mode, why: modePick.why, auto: modePick.auto }); } catch { /* 已断开 */ }

        let full = "";
        // 真正的回答字数（delta 总量 - 被判为过程的量）。为 0 说明这一轮只说了过程、没结论，
        // 典型场景：工具被授权闸门拦下，她说完"我要去查"就停了（用户看到的就是回答不完整）。
        let answerChars = 0;
        let curStep = -1;
        // 换步时不要无条件丢掉前面的正文（会把完整答案扔掉，用户看到的就是「答一半」）。
        // 记下**最长的一段**，最后哪段长用哪段。
        let bestFull = "";
        let hitCap = false;
        // 推理是**逐 token** 流进来的：以前每个 token 都 push 一条 trace，
        // 存下来就是几百条「想 我 / 想 搜 / 想 一下 …」—— 面板上根本没法读（用户截图就是这个）。
        // 现在先把它们攒起来，遇到动手/结果/报错/收尾再落成一条。
        let thinkBuf = "";
        const flushThink = () => {
          const t = thinkBuf.trim();
          thinkBuf = "";
          if (t) trace.push({ k: "think", t: t.slice(0, 2000) });
        };
        // 最后一次工具调用时的正文长度。done 时若正文没再增长 → 她做完/卡住，但没给结论。
        let lastToolAt = 0;
        const used: ToolUse[] = [];
        // 这一轮的过程（思考/工具/结果/错误）。必须落盘：右栏的 tracebox 只显示当前这一轮，
        // 新一轮一开始就被清空 —— 用户原话「一轮对话完成后直接把上一轮的对话进程覆盖了」。
        const trace: Array<{ k: "think" | "tool" | "res" | "err"; t: string; ms?: number }> = [];
        try {
          // getChat 必须在 try 里面：routerFrom 会对空 model 报 E_CONFIG，
          // 而它以前在 try 外面 —— 一抛就穿透到外层 catch，SSE 已经开始，
          // 于是 json(500) 抛 ERR_HTTP_HEADERS_SENT，整个面板进程被打死。
          const chat = deps.getChat && deps.tools ? deps.getChat() : null;
          if (chat) {
            // 6 步做不完「读文件→改→跑测试→看结果」；super 开着时再宽一点
            let supOn = false;
            try { supOn = (await import("../supergrant.ts")).superEnabled(deps.home); } catch { /* 当作没开 */ }
            // 工作模式：步数与单轮输出都放宽（连着干活要能多走几步、少被截断）
            // 步数是**预算**不是墙：20 步做不完多仓库调研（实测就在第 20 步被砍）。
            // 真要防的只有两件事：无限循环和无限花钱 —— 所以保留上限、但放宽，并允许 env 覆盖。
            const envSteps = Number(process.env.JJ_MAX_STEPS ?? 0);
            const steps = envSteps > 0 ? Math.min(120, envSteps) : (mode === "work" ? (supOn ? 60 : 45) : (supOn ? 30 : 24));
            const agent = runAgent({ chat, tools: deps.tools!, maxSteps: steps, noTools: localOnlyTurn }, brief.text, text);
            for await (const ev of agent) {
              if (aborted) break;
              if (ev.type === "delta") {
                // 换步了：模型常常「先给一段，再推翻重说」。以前两段会拼在一起，
                // 用户看到的就是同一句话出现两遍。现在新步开口就把旧的这段丢掉，并让面板清屏。
                if (typeof ev.step === "number" && ev.step !== curStep && answerChars > 0) {
                  if (full.length > bestFull.length) bestFull = full;
                  full = ""; answerChars = 0;
                  send({ type: "reset", step: ev.step });
                  if (bestFull) send({ type: "delta", text: bestFull, step: ev.step });
                }
                if (typeof ev.step === "number") curStep = ev.step;
                full += ev.text; answerChars += ev.text.length; send({ type: "delta", text: ev.text, step: ev.step });
              }
              else if (ev.type === "notice") {
                trace.push({ k: "think", t: ev.text });
                send({ type: "notice", text: ev.text });
                // 记下「现在在兜底」：面板顶栏要常驻显示，而不是只闪一句（2026-11-07）
                if (String(ev.text).includes("本地模式")) {
                  try {
                    const loc = String((readFileConfig(deps.home) as { local?: { default?: string } }).local?.default ?? "");
                    deps.db.prepare("INSERT INTO meta(key,value) VALUES('express_fallback',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ at: now().toISOString(), model: loc }));
                  } catch { /* 记不下不影响回答 */ }
                }
              }
              else if (ev.type === "think") { answerChars -= ev.text.length; thinkBuf += ev.text; send({ type: "think", text: ev.text }); }
              else if (ev.type === "tool") {
                flushThink();
                // 参数不原文上屏：翻译成一句人话（学自 Coopanion 的 pet-status）。
                // 路径只留文件名、正文/密钥/笔记一个字都不显示。
                const h = toolHuman(ev.name, ev.args);
                trace.push({ k: "tool", t: h });
                send({ type: "tool", id: ev.id, name: ev.name, args: h });
              }
              else if (ev.type === "tool_result") {
                flushThink();
                used.push({ name: ev.name, args: "", result: ev.result, ms: ev.ms });
                trace.push({ k: "res", t: ev.result.slice(0, 1200), ms: ev.ms });
                send({ type: "tool_result", id: ev.id, name: ev.name, result: ev.result.slice(0, 1500), ms: ev.ms });
                lastToolAt = full.length;
              }
              else if (ev.type === "error") {
                flushThink();
                if (String(ev.message).includes("E_MAX_STEPS")) {
                  hitCap = true;
                  trace.push({ k: "err", t: ev.message });
                  send({ type: "notice", text: "步数预算用完了 —— 我先把手上的结果收成结论，不再继续查。" });
                } else {
                  trace.push({ k: "err", t: ev.message });
                  send({ type: "error", message: ev.message });
                }
              }
              else if (ev.type === "done") {
                flushThink();
                // 一点结论都没有：要么工具被拦、要么光想了没做、要么到步数上限。
                // 静默结束是这里最糟的选项 —— 用户看到的是「说了一句就没了」。
                if (used.length > 0 && full.length === lastToolAt) {
                  send({ type: "notice", text: "这一轮她动过手（" + used.length + " 次工具），但最后没有给结论 —— 多半是卡在等确认（看右栏最后一条）。" });
                }
                if (answerChars <= 0) {
                  const lastErr = (() => {
                    for (let i = trace.length - 1; i >= 0; i--) {
                      const t = trace[i]!;
                      if (t.k === "err") return t.t.slice(0, 120);
                      if (t.k === "res") return null;   // 有过结果就不算"被拦住"
                    }
                    return null;
                  })();
                  send({ type: "notice", text: lastErr
                    ? "这一轮没有结论：上一步被挡住了（" + lastErr + "）。需要你在面板上放行，或换个说法。"
                    : "这一轮没有结论：她只说了要做什么，没真正动手。可以说「直接做」或「先别做，说说思路」。" });
                }
                // finish=length 说明不是「说完了」，是「到上限了」。不说出来，看着就像回答不完整。
                if (ev.finish === "length") send({ type: "notice", text: "这次回答到长度上限被截断了 —— 说「继续」我接着往下说。" });
                send({ type: "done", steps: ev.steps });
              }
            }
          } else if (deps.reply) {
            for await (const d of deps.reply(brief.text, text)) { if (aborted) break; full += d; send({ type: "delta", text: d }); }
            send({ type: "done", steps: 1 });
          } else {
            const gen = deps.getTransport().completeStream("express",
              [{ role: "system", content: brief.text }, { role: "user", content: text }],
              { containsMemory: false, purpose: "express", maxTokens: 3000 });
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
        // 撞上限时：先用手上的结果收尾，别让用户看到半句话。
        if (hitCap) {
          try {
            const digest = trace.slice(-40).map((t) => (t.k === "res" ? "结果：" : t.k === "tool" ? "动作：" : t.k === "err" ? "报错：" : "想：") + String(t.t).slice(0, 200)).join(String.fromCharCode(10));
            const wrapPrompt = [
              "你刚才在替用户干活，但步数预算用完了，不能再调工具。",
              "下面是你已经做过/查到的事。用 3–5 句给出**现在的结论**：查到了什么、还差什么、下一步该做什么。",
              "不要道歉，不要重复过程，不要编没有的数据。",
              "",
              digest.slice(0, 4000),
            ].join(String.fromCharCode(10));
            let wrap = "";
            for await (const d of deps.getTransport().completeStream("express",
              [{ role: "system", content: wrapPrompt }, { role: "user", content: text }],
              { containsMemory: false, purpose: "wrap-up", maxTokens: 700, temperature: 0.3 })) {
              if (aborted) break;
              wrap += d;
            }
            wrap = wrap.trim();
            if (wrap) {
              if (full.trim()) full = full.trim() + String.fromCharCode(10, 10);
              full += wrap;
              answerChars += wrap.length;
              send({ type: "reset" });
              send({ type: "delta", text: full });
              trace.push({ k: "think", t: "步数用完，做了收尾总结" });
            }
          } catch { /* 收尾失败就保持原样，至少不丢已经说出的部分 */ }
        }
        // 哪段长用哪段：最后一步往往只是「以上」这种碎片，丢掉完整的那段才是问题。
        if (bestFull.length > full.length) full = bestFull;

        // 正文只留结论：<think> 之类明写的推理拆到过程里（面板右栏第四个签）
        if (full) {
          const sp = splitThink(full);
          if (sp.thinks.length) for (const t of sp.thinks) trace.push({ k: "think", t });
          if (sp.text) full = sp.text;
        }
        if (full) {
          appendEvent(deps.inboxDir, {
            v: 1, id: newEventId(), ts: now().toISOString(), kind: "agent_reply", actor: "agent",
            payload: {
              text: full, session: sess.id, tools: used,
              ...(trace.length ? { trace } : {}),
              ...(recalled.length ? { cites: recalled.map((r) => r.id) } : {}),
              ...(omitted ? { omitted } : {}),
              ...(rc.omittedDocs ? { omittedDocs: rc.omittedDocs } : {}),
            },
          });
          try { touchSession(deps.db, sess.id, { status: "idle", bump: true }); touchSession(deps.db, sess.id, { bump: true }); } catch { /* ignore */ }
        }
        // 再巩固（J-1）：只有**真的进了装配块**的才算"被想起"（不是被检索到）。
        // 之前 reconsolidate() 全库零调用 → recall_count 永远 0 → "想一次就更牢"从没生效。
        try {
          const ids = recalled.filter((r) => r.source === "memory" && !r.viaLink)
            .map((r) => Number(String(r.id).replace("mem:", "")))
            .filter((n) => Number.isFinite(n));
          if (ids.length) reinforce(deps.db, ids, now());
        } catch { /* 加固失败不影响回答 */ }

        // 钩子：一轮结束（after_turn）。失败只记错误 —— 不许影响刚才那句回答。
        try {
          const hk = await import("../hooks.ts");
          if (hk.loadHooks(deps.home).some((h) => h.event === "after_turn" && h.enabled !== false)) {
            const pol2 = deps.policy ?? await loadPolicy(deps.home);
            const fired = await hk.fireHooks(deps.home, "after_turn", { db: deps.db, policy: pol2, ctx: { home: deps.home, now } });
            if (fired.errors.length) console.error("[hooks] " + fired.errors.join(" | "));
          }
        } catch (e) { console.error("[hooks] " + String(e).slice(0, 120)); }

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
