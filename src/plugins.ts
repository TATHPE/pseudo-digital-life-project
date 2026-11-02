/**
 * 插件（MCP）与技能的**增删**（2026-11-01，用户："现在只能看，等于借来的手脚是死数据"）。
 *
 * 边界：
 *   · 只写两个地方：`data/mcp.json`（插件）与 `data/skills/<id>/SKILL.md`（技能）。
 *   · 两个 id 都过白名单正则（`^[a-z0-9][a-z0-9_-]{0,39}$`）—— 路径由我们拼，绝不用人给的串。
 *   · 每次写都记 `exec_audit`（p.verb 用 `panel.mcp` / `panel.skill`）+ inbox 事件，谁删了什么留痕。
 *   · **不自动重启**：MCP 是启动时读的，所以加完要重启才生效；界面必须明说，不能假装已生效。
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
