/**
 * 扩展（MCP / 技能 / 市场浏览）。
 *
 * 本地扩展的边界：
 *   · 只写两个地方：`data/mcp.json`（插件）与 `data/skills/<id>/SKILL.md`（技能）。
 *   · 两个 id 都过白名单正则（`^[a-z0-9][a-z0-9_-]{0,39}$`）—— 路径由我们拼，绝不用人给的串。
 *   · 每次写都记 `exec_audit`（p.verb 用 `panel.mcp` / `panel.skill`）+ inbox 事件，谁删了什么留痕。
 *   · **不自动重启**：MCP 是启动时读的，所以加完要重启才生效；界面必须明说，不能假装已生效。
 *
 * 市场浏览（2026-11-17）：只读 AstrBot 插件市场 JSON，**不下载、不安装、不运行**。
 * AstrBot 插件是 Python 包，这里只按官方 schema 归一出可看的信息 + 仓库链接。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import { loadMcpConfig, type McpConfig } from "./mcp.ts";
import { MAX_SKILL_BYTES, scanSkills } from "./skills.ts";

/** id 只接受这一种形状；中文/空格/点号一律不行（路径要由我们拼） */
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const mcpConfigPath = (home: string): string => join(home, "mcp.json");

/**
 * mcp.json 的指纹（2026-11-03）：用来判断「磁盘上改了，但进程里还是旧的」。
 *
 * 学自 Coopanion 的「待生效」：它装完扩展先进【待生效】，重启进程才生效。
 * 我们之前只写了一句「不假装已生效」，但**怎么知道有没有生效**没人算过 ——
 * 于是用户改了 mcp.json、面板还显示旧工具，看起来像「插件坏了」。
 */
export function mcpFingerprint(home: string): string | null {
  try {
    const raw = readFileSync(mcpConfigPath(home), "utf8");
    let h = 2166136261;                                   // FNV-1a：够用且不用引 crypto
    for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  } catch { return null; }
}
export const skillsDir = (home: string): string => join(home, "skills");

export type WriteResult = { ok: true; note?: string } | { ok: false; code: string; why: string };

const bad = (code: string, why: string): WriteResult => ({ ok: false, code, why });

// ── 插件（MCP）───────────────────────────────────────────────
/**
 * 加一个 MCP server。command 允许绝对路径（本机程序），但要挡明显的注入形状：
 * 空串、含引号/换行、以 - 开头的参数名混进 command。
 */
export function addMcpServer(home: string, input: {
  name?: string; command?: string; args?: string[]; trust?: string; tools?: string[];
}): WriteResult {
  const name = String(input.name ?? "").trim();
  if (!ID_RE.test(name)) return bad("E_BAD_NAME", "名字只能是小写字母/数字/_/-（1–40 字符），例如 markitdown");
  const command = String(input.command ?? "").trim();
  if (!command) return bad("E_NO_COMMAND", "要填要启动的命令，例如 ollama 或 D:/tools/x.exe");
  if (/[\r\n"]/.test(command)) return bad("E_BAD_COMMAND", "命令里不能有引号或换行");
  const args = (input.args ?? []).map((a) => String(a));
  if (args.some((a) => /[\r\n\u0000]/.test(a))) return bad("E_BAD_ARG", "参数里不能有换行或 NUL");
  const trust = input.trust === "external" ? "external" : "local";
  const tools = (input.tools ?? []).map((t) => String(t)).filter(Boolean).slice(0, 200);

  const cfg: McpConfig = loadMcpConfig(home);
  const servers = { ...(cfg.servers ?? {}) };
  if (servers[name]) return bad("E_EXISTS", `已经有叫 ${name} 的插件了；要改先删掉`);
  servers[name] = { command, ...(args.length ? { args } : {}), trust, ...(tools.length ? { tools } : {}) };
  atomicWriteFile(mcpConfigPath(home), JSON.stringify({ ...cfg, servers }, null, 2) + String.fromCharCode(10));
  return { ok: true, note: "已写入 data/mcp.json —— **重启面板**之后这个插件才会被加载" };
}

export function removeMcpServer(home: string, name: string): WriteResult {
  const n = String(name ?? "").trim();
  if (!ID_RE.test(n)) return bad("E_BAD_NAME", "名字不合法");
  const cfg: McpConfig = loadMcpConfig(home);
  const servers = { ...(cfg.servers ?? {}) };
  if (!servers[n]) return bad("E_NOT_FOUND", `没有叫 ${n} 的插件`);
  delete servers[n];
  atomicWriteFile(mcpConfigPath(home), JSON.stringify({ ...cfg, servers }, null, 2) + String.fromCharCode(10));
  return { ok: true, note: "已删掉 —— 重启面板后生效" };
}

// ── 技能（SKILL.md）──────────────────────────────────────────
/**
 * 写一份技能。内容必须以 `---` 开头带 frontmatter 或直接正文都行，
 * 但**大小有上限**（64KB，和扫描时的上限一致，否则写了也扫不到）。
 */
export function writeSkill(home: string, input: { id?: string; content?: string }): WriteResult {
  const id = String(input.id ?? "").trim();
  if (!ID_RE.test(id)) return bad("E_BAD_NAME", "目录名只能是小写字母/数字/_/-（1–40 字符），例如 weekly-recap");
  const content = String(input.content ?? "");
  if (!content.trim()) return bad("E_EMPTY", "内容是空的");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_SKILL_BYTES) return bad("E_TOO_BIG", `超过 ${Math.round(MAX_SKILL_BYTES / 1024)}KB（扫描上限）`);
  const dir = join(skillsDir(home), id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  const existed = existsSync(file);
  // 写之前留一份旧的（同名覆盖时可回看）——不塞回收站，技能是纯文本，留 .bak 够了
  if (existed) {
    try { writeFileSync(file + ".bak", readFileSync(file)); } catch { /* 留不下就算了 */ }
  }
  atomicWriteFile(file, content);
  return { ok: true, note: existed ? "已覆盖（旧版留在 SKILL.md.bak）" : "已新建；下一轮对话它的名字就会进简报索引" };
}

export function removeSkill(home: string, id: string): WriteResult {
  const n = String(id ?? "").trim();
  if (!ID_RE.test(n)) return bad("E_BAD_NAME", "目录名不合法");
  const dir = join(skillsDir(home), n);
  if (!existsSync(join(dir, "SKILL.md"))) return bad("E_NOT_FOUND", `没有叫 ${n} 的技能`);
  rmSync(dir, { recursive: true, force: true });
  return { ok: true, note: "已删掉" };
}

/** 面板要看的：装了什么（含能否重启后加载的提示） */
export function installedPlugins(home: string): { servers: Array<{ name: string; command: string; args: string[]; trust: string; tools: number }>; skills: number } {
  const cfg = loadMcpConfig(home);
  return {
    servers: Object.entries(cfg.servers ?? {}).map(([name, v]) => ({
      name, command: v.command, args: v.args ?? [], trust: v.trust ?? "local", tools: (v.tools ?? []).length,
    })),
    skills: scanSkills(home).filter((s) => s.source !== "agents").length,
  };
}

// ── AstrBot 插件市场（只读浏览）──────────────────────────────
/**
 * 官方源会 301 到这个地址（2026-11-17 实测）。3445 条 / 3.2 MB。
 * 自定义源只在人显式配置时使用（写接口有 writeGuarded），模型不能自己改。
 */
export const OFFICIAL_MARKET = "https://cloud.astrbot.app/api/v1/market/plugins.json";
export const MARKET_TTL_MS = 15 * 60_000;
export const MARKET_MAX_BYTES = 12 * 1024 * 1024;

export interface MarketEntry {
  id: string; author: string; name: string; version: string;
  displayName: string; desc: string; shortDesc: string;
  repo: string | null; logo: string | null;
  tags: string[]; category: string; stars: number; downloads: number; updatedAt: string | null;
}
export interface MarketMeta {
  name: string | null; version: string | null; homepage: string | null;
  repository: string | null; updatedAt: string | null;
}
export interface MarketView {
  source: string; meta: MarketMeta | null; total: number; entries: MarketEntry[];
  fetchedAt: string; cached: boolean;
}
export interface MarketQuery {
  q?: string; limit?: number; sort?: "stars" | "downloads" | "updated" | "name";
  force?: boolean; timeoutMs?: number;
  /** 测试注入，避免打真网络 */
  fetch?: (url: string, signal: AbortSignal) => Promise<{ ok: boolean; status: number; headers: { get(k: string): string | null }; text(): Promise<string> }>;
}

const str = (x: unknown, max = 500): string => typeof x === "string" ? x.trim().slice(0, max) : "";
const nat = (x: unknown): number => typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;

/** 只放行 http(s) 和一个可打印的 URL；本地镜像用 http，所以不断私网，但地址只能由人写进来。 */
export function marketUrlError(input: unknown): string | null {
  const u = str(input, 500);
  if (!u) return "地址不能为空（留空表示用官方源）";
  if (/[\u0000-\u001f\u007f]/.test(u)) return "地址里有控制字符";
  try {
    const p = new URL(u);
    if (p.protocol !== "http:" && p.protocol !== "https:") return "只支持 http/https 地址";
    return null;
  } catch { return "这不是一个合法的地址"; }
}

function parseMarketRecords(source: string, raw: unknown): { source: string; meta: MarketMeta | null; all: MarketEntry[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("E_MARKET_SHAPE: 市场数据不是 JSON 对象");
  const obj = raw as Record<string, unknown>;
  const m0 = obj["$meta"];
  const mm = m0 && typeof m0 === "object" && !Array.isArray(m0) ? m0 as Record<string, unknown> : null;
  // 新源必须有 schema_version=1；旧源（官方早期格式）没有 $meta，按 wiki §15 兼容读取。
  if (mm && mm["schema_version"] !== 1) throw new Error("E_MARKET_SCHEMA: 不支持的市场 schema（需要 version 1）");
  const meta: MarketMeta | null = mm ? {
    name: str(mm["name"], 120) || null, version: str(mm["version"], 80) || null,
    homepage: str(mm["homepage"], 300) || null, repository: str(mm["repository"], 300) || null,
    updatedAt: str(mm["updated_at"], 40) || null,
  } : null;

  const seen = new Set<string>();
  const all: MarketEntry[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$meta" || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const rec = value as Record<string, unknown>;
    const author = str(rec["author"], 120);
    // name 可省略的兼容情形：根 key 就是 name（且不含 /）。
    const name = str(rec["name"], 160) || (key.includes("/") ? "" : key);
    if (!author || !name || author.includes("/") || name.includes("/")) continue;
    const id = `${author}/${name}`.toLowerCase();
    if (seen.has(id)) continue;                       // 身份小写归一后必须唯一
    seen.add(id);
    // 未知字段不用于身份/来源：repo 只认 https GitHub 形状，展示时才用。
    const repoRaw = str(rec["repo"], 300);
    const repo = /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\.git|\/tree\/[A-Za-z0-9_-]+)?$/.test(repoRaw) ? repoRaw : null;
    const logoRaw = str(rec["logo"], 300);
    const tags = Array.isArray(rec["tags"]) ? (rec["tags"] as unknown[]).slice(0, 12).map((t) => str(t, 40)).filter(Boolean) : [];
    all.push({
      id: `${author}/${name}`, author, name, version: str(rec["version"], 40),
      displayName: str(rec["display_name"], 120) || name,
      desc: str(rec["desc"] ?? rec["description"], 1200), shortDesc: str(rec["short_desc"], 300),
      repo, logo: /^https:\/\//.test(logoRaw) ? logoRaw : null,
      tags, category: str(rec["category"], 60), stars: nat(rec["stars"]), downloads: nat(rec["download_count"]),
      updatedAt: str(rec["updated_at"], 40) || null,
    });
  }

  return { source, meta, all };
}

/** 查询只作用于内存里的全量记录 —— 缓存必须缓存原始记录，不能缓存上一次的搜索结果。 */
function applyMarketQuery(
  parsed: { source: string; meta: MarketMeta | null; all: MarketEntry[] },
  q: MarketQuery, cached: boolean,
): MarketView {
  const { source, meta, all } = parsed;
  const term = str(q.q, 120).toLocaleLowerCase();
  const hits = term ? all.filter((e) =>
    [e.id, e.displayName, e.author, e.shortDesc, e.desc, e.category, ...e.tags]
      .some((s) => s.toLocaleLowerCase().includes(term))) : all;
  const sort = q.sort ?? "stars";
  const sorted = [...hits].sort((a, b) => {
    if (sort === "downloads") return b.downloads - a.downloads || a.id.localeCompare(b.id);
    if (sort === "updated") return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id);
    if (sort === "name") return a.displayName.localeCompare(b.displayName, "zh");
    return b.stars - a.stars || b.downloads - a.downloads || a.id.localeCompare(b.id);
  });
  const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 60)));
  return { source, meta, total: hits.length, entries: sorted.slice(0, limit), fetchedAt: new Date().toISOString(), cached };
}

interface CacheEntry { at: number; parsed: ReturnType<typeof parseMarketRecords> }
const marketCache = new Map<string, CacheEntry>();
const marketInflight = new Map<string, Promise<MarketView>>();
export function resetMarketCache(source?: string): void {
  if (source) marketCache.delete(source);
  else { marketCache.clear(); marketInflight.clear(); }
}

async function readLimited(res: {
  headers: { get(k: string): string | null };
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } };
  text(): Promise<string>;
}, max: number): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > max) throw new Error("E_MARKET_TOO_BIG: 源文件太大");
  const reader = res.body?.getReader();
  if (!reader) {
    const t = await res.text();
    if (Buffer.byteLength(t, "utf8") > max) throw new Error("E_MARKET_TOO_BIG: 源文件太大");
    return t;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength ?? 0;
    if (total > max) { await reader.cancel().catch(() => {}); throw new Error("E_MARKET_TOO_BIG: 源文件太大"); }
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 拉市场并按源缓存；force 强制重拉。失败不写缓存，下次还能重试。 */
export async function fetchMarket(source: string, q: MarketQuery = {}): Promise<MarketView> {
  const url = source.trim().replace(/\/+$/, "") || OFFICIAL_MARKET;
  const why = marketUrlError(url);
  if (why) throw new Error("E_MARKET_URL: " + why);
  if (!q.force) {
    const hit = marketCache.get(url);
    if (hit && Date.now() - hit.at < MARKET_TTL_MS) return applyMarketQuery(hit.parsed, q, true);
  }
  const busy = marketInflight.get(url);
  if (busy) return busy;

  const p = (async () => {
    const doFetch = q.fetch ?? ((u: string, signal: AbortSignal) => fetch(u, { signal }));
    const res = await doFetch(url, AbortSignal.timeout(q.timeoutMs ?? 30_000));
    if (!res.ok) throw new Error(`E_MARKET_HTTP: HTTP ${res.status}`);
    let raw: unknown;
    try { raw = JSON.parse(await readLimited(res as Parameters<typeof readLimited>[0], MARKET_MAX_BYTES)); }
    catch (e) { throw new Error("E_MARKET_PARSE: " + String((e as Error).message ?? e).slice(0, 120)); }
    const parsed = parseMarketRecords(url, raw);
    marketCache.set(url, { at: Date.now(), parsed });
    return applyMarketQuery(parsed, q, false);
  })();
  marketInflight.set(url, p);
  try { return await p; } finally { marketInflight.delete(url); }
}
