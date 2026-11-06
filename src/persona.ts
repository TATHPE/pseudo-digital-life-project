import { readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import type { PersonaFiles } from "./types.ts";
import { verbCatalog } from "./verbs.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** 可编辑的人格文件（面板里能改的六个） */
export const PERSONA_FILES = ["core", "boundaries", "evidence", "tools", "values", "voice"] as const;
export type PersonaFile = (typeof PERSONA_FILES)[number];

export const bundledDir = () => join(ROOT, "persona");

export function personaDir(home?: string): string {
  return home ? join(home, "persona") : join(ROOT, "persona");
}

/**
 * 读：home 里有就用 home 的，没有就**回落 bundled**。
 * 这一条很关键：面板第一次保存 voice 后，core/boundaries/evidence/tools 不能因此变空——
 * 否则简报的 P1–P4 会整块消失（踩过）。
 */
const read = (dir: string, f: string) => {
  for (const d of [dir, bundledDir()]) {
    const p = join(d, f + ".md");
    if (existsSync(p)) return readFileSync(p, "utf8").trimEnd();
  }
  return "";
};

/** 首次写入前把 bundled 的整套 seed 到 home，保证"六个文件齐全" */
export function seedPersona(home: string): void {
  const dir = personaDir(home);
  mkdirSync(dir, { recursive: true });
  for (const f of PERSONA_FILES) {
    const dest = join(dir, f + ".md");
    if (existsSync(dest)) continue;
    const src = join(bundledDir(), f + ".md");
    if (existsSync(src)) atomicWriteFile(dest, readFileSync(src, "utf8"));
  }
}

/**
 * P4 的工具清单：**从 verbs 生成**，不再手写。
 *
 * 2026-11-06：persona/tools.md 里那句「常驻 4 个：search / remember / cite / act」
 * 和目录里的 doc.read / net.fetch / calendar.add 全是过时的 —— 那些函数根本不存在，
 * 模型照着去调只会先失败再改。清单必须从唯一的能力表来，才不会漂。
 */
export function toolCatalogText(): string {
  const list = verbCatalog();
  const apiName = (n: string) => n.replace(/\./g, "_");
  const byTier = new Map<string, string[]>();
  for (const v of list) {
    const arr = byTier.get(v.tier) ?? [];
    // 只写「名字(档)」：描述在 API 的 functions 参数里已经有一份，这里再抄一遍就是白烧 P4 预算
    arr.push(apiName(v.name) + "(" + v.tier + ")");
    byTier.set(v.tier, arr);
  }
  const order = ["T0", "T1", "T2", "T3"];
  const lines = order.filter((t) => byTier.has(t)).map((t) => t + "：" + (byTier.get(t) ?? []).join(" · "));
  return ["工具（真实可调用的就是这些；名字是下划线形式）：", ...lines].join(String.fromCharCode(10));
}
export function loadPersona(home?: string): PersonaFiles {
  const dir = personaDir(home);
  return {
    core: read(dir, "core"),
    boundaries: read(dir, "boundaries"),
    evidenceOrder: read(dir, "evidence"),
    // 清单从能力表生成；tools.md 第一段只当「怎么用」的前言（可以为空）
    toolSchemas: [read(dir, "tools").split("\n\n")[0] ?? "", toolCatalogText()].filter(Boolean).join("\n"),
    toolDirectory: read(dir, "tools").split("\n\n").slice(1).join("\n\n"),
  };
}

export function loadPersonaText(home?: string): Record<PersonaFile, string> {
  const dir = personaDir(home);
  const out = {} as Record<PersonaFile, string>;
  for (const f of PERSONA_FILES) out[f] = read(dir, f);
  return out;
}

export interface SaveResult {
  file: PersonaFile; bytes: number; versionFile: string; changed: boolean;
}

const MAX_BYTES = 16 * 1024;

/**
 * 写一个人格文件 + 留"我变了"的记录（18 §4.4）。
 * 校验：大小上限、禁止控制字符（除换行/制表）、禁止 U+FFFD（编码闸）。
 */
export function savePersonaFile(
  home: string, file: PersonaFile, content: string, now = new Date(), because = "",
): SaveResult {
  if (!PERSONA_FILES.includes(file)) throw new Error(`E_PERSONA_FILE: ${file}`);
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) throw new Error("E_PERSONA_TOO_BIG");
  if (content.includes("\uFFFD")) throw new Error("E_ENCODING");
  for (const ch of content) {
    if (ch === "\n" || ch === "\t" || ch === "\r") continue;
    if (ch.charCodeAt(0) < 32) throw new Error("E_CONTROL_CHAR");
  }

  seedPersona(home);
  const dir = personaDir(home);
  const before = read(dir, file);
  const changed = before !== content.trimEnd();
  const path = join(dir, file + ".md");
  atomicWriteFile(path, content.trimEnd() + "\n");

  // versions/：append-only，记"改了什么 + 因为什么"
  const vdir = join(dir, "versions");
  mkdirSync(vdir, { recursive: true });
  const n = readdirSync(vdir).filter((f) => f.startsWith(now.toISOString().slice(0, 10))).length + 1;
  const vfile = join(vdir, `${now.toISOString().slice(0, 10)}-${n}.md`);
  const diff = summarize(before, content);
  atomicWriteFile(vfile, [
    `# ${now.toISOString()} · persona/${file}.md`,
    "",
    changed ? "## 改了什么" : "## 无实际变化（重复保存）",
    "",
    changed ? diff : "内容与上一版一致。",
    "",
    "## 为什么改（作者填写，L3 判据的原始素材）",
    "",
    because.trim() || "（未填写）",
    "",
    "## 回滚",
    "",
    `把 persona/${file}.md 还原为上一版，或删掉本记录。`,
    "",
  ].join("\n"));

  return { file, bytes: Buffer.byteLength(content, "utf8"), versionFile: vfile, changed };
}

/** 极简 diff：只报"行数变化 + 前几行新增/删除"，不做逐字 */
export function summarize(before: string, after: string): string {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  const added = b.filter((l) => l.trim() && !a.includes(l));
  const removed = a.filter((l) => l.trim() && !b.includes(l));
  const lines: string[] = [`行数：${a.length} → ${b.length}`];
  if (added.length) lines.push("", "新增：", ...added.slice(0, 8).map((l) => `+ ${l}`));
  if (removed.length) lines.push("", "删除：", ...removed.slice(0, 8).map((l) => `- ${l}`));
  return lines.join("\n");
}
