/**
 * 技能（SKILL.md）—— docs/runtime/11 的第二优先。
 *
 * 为什么是"目录 + 一段 markdown"而不是插件：
 *   插件（MCP）给的是**工具**（一个有入参的函数）；技能给的是**做法**（一段说明书）。
 *   模型需要两样不同的东西：能调用的手，和"遇到这类事该怎么做"的记录。
 *
 * 三条纪律（和记忆核心一致）：
 *   1. **只读**：技能是资料，读完改不了任务、权限、时限、凭据（taint=external 同款处理）。
 *   2. **按需加载**：简报里只放 `name + description`（各截断），正文要模型自己用
 *      `skill.read` 去取 —— 否则每轮上下文中都要塞几千字说明书。
 *   3. **不开第二条路**：调用走 verbs → execute → policy → audit，和别的能力一样。
 *
 * 目录（先到先用，同名只取第一个）：
 *   <home>/skills/<name>/SKILL.md         ← 我们自己的
 *   ~/.agents/skills/<name>/SKILL.md      ← 和 pi / Claude Code 共用（只读兼容）
 *   $JJ_SKILLS_DIR/<name>/SKILL.md        ← 想指别处时用
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Skill {
  /** 目录名（唯一标识；调用时用它） */
  id: string;
  /** SKILL.md 里写的名字（没有就同 id） */
  name: string;
  description: string;
  /** 从哪来的：home / agents / env */
  source: "home" | "agents" | "env";
  /** 绝对路径（面板上显示用；不带进简报） */
  file: string;
  bytes: number;
  /** 有没有 frontmatter —— 没有也能用，只是 description 是猜的 */
  parsed: boolean;
}

/** 单个 SKILL.md 最多读这么多；正文进上下文前再截一次 */
export const MAX_SKILL_BYTES = 64 * 1024;
/** 简报里每条描述最多这么多字 */
export const MAX_DESC_CHARS = 160;
/** skill.read 最多返回这么多字 */
export const MAX_READ_CHARS = 12_000;

function skillDirs(home: string, env: Record<string, string | undefined>): Array<{ dir: string; source: Skill["source"] }> {
  const out: Array<{ dir: string; source: Skill["source"] }> = [];
  const envDir = env.JJ_SKILLS_DIR;
  if (envDir) out.push({ dir: envDir, source: "env" });
  out.push({ dir: join(home, "skills"), source: "home" });
  // 兼容 pi / Claude Code 的全局目录（只读；我们不往那儿写）
  out.push({ dir: join(env.AGENTS_HOME ?? join(homedir(), ".agents"), "skills"), source: "agents" });
  return out;
}

/** 去掉 frontmatter，返回 { meta, body } */
export function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const NL = String.fromCharCode(10);
  const text = raw.replace(/\r\n/g, NL);
  if (!text.startsWith("---" + NL)) return { meta: {}, body: text };
  const end = text.indexOf(NL + "---", 3);
  if (end < 0) return { meta: {}, body: text };
  const head = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^-+/, "");
  const meta: Record<string, string> = {};
  const lines = head.split(NL);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]!.trim());
    if (!m) continue;
    const k = m[1]!.toLowerCase();
    let v = (m[2] ?? "").trim();
    // YAML 块标量（> 折行 / | 保留换行）：内容在下面缩进的行里
    if (v === ">" || v === "|" || v === ">-" || v === "|-") {
      const buf: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!;
        if (l.trim() && !/^\s/.test(l)) break;
        buf.push(l.trim());
        i = j;
      }
      v = buf.filter(Boolean).join(" ").trim();
    }
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && v) meta[k] = v;
  }
  return { meta, body };
}

/** 没写 description 时的兜底：第一个标题，或第一行非空正文 */
export function guessDescription(body: string): string {
  const NL = String.fromCharCode(10);
  const lines = body.split(NL).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (l.startsWith("#")) continue;
    if (l.startsWith("```")) break;
    return l.replace(/^[-*]\s*/, "").slice(0, MAX_DESC_CHARS);
  }
  const h = lines.find((l) => l.startsWith("#"));
  return h ? h.replace(/^#+\s*/, "").slice(0, MAX_DESC_CHARS) : "";
}

/** 扫一遍所有目录（同步；目录通常只有几十个文件） */
export function scanSkills(home: string, opts: { env?: Record<string, string | undefined> } = {}): Skill[] {
  const env = opts.env ?? process.env;
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const { dir, source } of skillDirs(home, env)) {
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const id of names.sort()) {
      const file = join(dir, id, "SKILL.md");
      if (!existsSync(file)) continue;
      let st;
      try { st = statSync(file); } catch { continue; }
      if (!st.isFile() || st.size > MAX_SKILL_BYTES) continue;
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let raw = "";
      try { raw = readFileSync(file, "utf8"); } catch { continue; }
      const { meta, body } = splitFrontmatter(raw);
      const parsed = Object.keys(meta).length > 0;
      const name = (meta.name ?? "").trim() || id;
      const description = ((meta.description ?? "").trim() || guessDescription(body)).slice(0, MAX_DESC_CHARS);
      out.push({ id, name, description, source, file, bytes: st.size, parsed });
    }
  }
  return out;
}

/**
 * 读某个技能的正文。
 * `name` 只作**标识**用：先按 id 精确匹配，再按 name 模糊匹配，**绝不拼路径**。
 */
export function readSkill(home: string, name: string, opts: { env?: Record<string, string | undefined> } = {}):
  { ok: true; skill: Skill; text: string; truncated: boolean } | { ok: false; code: string; why: string } {
  const want = String(name ?? "").trim().toLowerCase();
  if (!want) return { ok: false, code: "E_SKILL_NAME", why: "要指定技能名（先 skill.list 看一眼）" };
  const all = scanSkills(home, opts);
  const hit = all.find((s) => s.id.toLowerCase() === want)
    ?? all.find((s) => s.name.toLowerCase() === want)
    ?? all.find((s) => s.id.toLowerCase().includes(want));
  if (!hit) {
    return {
      ok: false, code: "E_NO_SKILL",
      why: `没有这个技能：${name}（装了 ${all.length} 个；放 ~/.agents/skills/<名字>/SKILL.md 也能被认到）`,
    };
  }
  let raw = "";
  try { raw = readFileSync(hit.file, "utf8"); } catch (e) {
    return { ok: false, code: "E_SKILL_READ", why: String(e).slice(0, 120) };
  }
  const body = splitFrontmatter(raw).body;
  const truncated = body.length > MAX_READ_CHARS;
  return { ok: true, skill: hit, text: truncated ? body.slice(0, MAX_READ_CHARS) : body, truncated };
}

/**
 * 简报用的一段：只放 name + 一句描述。
 * 模型看到这个才知道"有这么个说明书"，正文靠 skill.read 现取。
 */
/**
 * 哪些技能该进简报：默认只放她自己的（home / env）。
 * 使用者的 ~/.agents/skills 是开发技能（code-review、impeccable…），
 * 每轮都塞进去等于让她以为自己会做代码审查 —— 要看就 skill.list，别默认喂。
 * 想索引全部：JJ_SKILLS_INDEX_AGENTS=1。
 */
export function indexableSkills(skills: Skill[], env: Record<string, string | undefined> = process.env): Skill[] {
  if (env.JJ_SKILLS_INDEX_AGENTS === "1") return skills;
  return skills.filter((s) => s.source !== "agents");
}

export function skillsIndexText(skills: Skill[], limit = 12): string {
  if (!skills.length) return "";
  const rows = skills.slice(0, limit).map((s) => `${s.id}（${(s.description || "无描述").slice(0, 80)}）`);
  const more = skills.length > limit ? ` …还有 ${skills.length - limit} 个` : "";
  return `【可用的说明书】${rows.join(" ／ ")}${more}。要看某一份的正文，用 skill_read。`;
}
