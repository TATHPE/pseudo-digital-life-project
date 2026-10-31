/**
 * 人格访谈（H-4 第 ⑥ 步）。
 *
 * 为什么不是"让人直填 6 块"：`07` 说人格的关键是 voice 样本、立场带代价、不谄媚 ——
 * 这些下拉框采不到；但让普通用户写 6 个文件也太重。
 * 所以路径是：**5 个问题 → 模型代写 6 块草稿 → 逐块确认 → 封存**。
 *
 * 一条死约束，而且是**代码校验**不是提示词：
 *   模型写的每一行，要么能在用户的回答里**逐字找到**（→ 标「你原话」），
 *   要么就必须标成「模型补的（请确认）」。
 * 模型不能自己声明"这是用户说的" —— 那是最坏的一种伪造。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { noteFileWillChange } from "./setup.ts";
import { join } from "node:path";
import { PERSONA_FILES, personaDir, savePersonaFile, type PersonaFile } from "./persona.ts";
import { bumpGenerationIfChanged } from "./generation.ts";
import type { DatabaseSync } from "node:sqlite";

export interface Question {
  id: string;
  q: string;
  /** 这个问题主要喂给哪一块 */
  feeds: PersonaFile[];
  /** 不答时的兜底（不是"跳过"，是"用中立模板"） */
  fallback: string;
}

/** 5 个问题：一次点击就能答，不用写作文 */
export const QUESTIONS: Question[] = [
  { id: "name", q: "它叫你什么？你又怎么称呼它？", feeds: ["core", "tools"], fallback: "我还没给它起名字；它叫我「你」。" },
  { id: "never", q: "有三件事它绝对不能做？", feeds: ["boundaries"], fallback: "不替我确认、不假装记得、不刷屏。" },
  { id: "hate", q: "你最烦被怎么对待？", feeds: ["values", "voice"], fallback: "最烦被敷衍、被套话、被当成客服工单。" },
  { id: "voice", q: "用一句话写下它该有的说话样子（原话最好）", feeds: ["voice"], fallback: "短句，陈述，不解释自己。" },
  { id: "initiative", q: "它该不该主动说话？什么时候？", feeds: ["core", "values"], fallback: "可以主动，但一天最多两次；没有由头就别开口。" },
];

export interface DraftLine {
  text: string;
  /** "你原话" = 能在回答里逐字找到；"模型补的（请确认）" = 模型加的理解 */
  source: "你原话" | "模型补的（请确认）";
}

export interface Draft {
  blocks: Record<PersonaFile, DraftLine[]>;
  createdAt: string;
  /** 用的是哪条路：模型 / 模板（没 key 或模型挂了） */
  via: "model" | "template";
  note?: string;
}

export const draftDir = (home: string): string => join(home, "persona.draft");
const draftPath = (home: string): string => join(draftDir(home), "draft.json");

const norm = (s: string): string => String(s ?? "").replace(/\s+/g, "").toLowerCase();

/**
 * **闸门**：把模型输出拆成行，并判定每一行的来源。
 * 判据只有一条：这一行的核心片段（去空白后 ≥8 字）能否在用户回答里找到。
 * 找不到就一律降级为「模型补的」—— 哪怕模型自己写了"你原话"。
 */
export function classifyLines(raw: string, answers: Record<string, string>): DraftLine[] {
  const corpus = norm(Object.values(answers).join(""));
  const out: DraftLine[] = [];
  for (const line0 of String(raw ?? "").split(String.fromCharCode(10))) {
    const line = line0.replace(/^\s*[-*・]\s*/, "").trim();
    if (!line) continue;
    // 去掉模型可能加的标记，按内容重判
    const text = line.replace(/^\[(你原话|模型补的（请确认）)\]\s*/, "").trim();
    if (!text) continue;
    const probe = norm(text);
    // 阈值取 4：中文四五个字就能是一句完整的话（"不替我确认"），6 会把它误判成模型编的
    const quoted = probe.length >= 4 && corpus.includes(probe);
    // 逐字（子串）命中才算原话；更长的行允许"大部分片段命中"
    const partial = !quoted && probe.length >= 12
      ? (() => {
        const step = Math.max(6, Math.floor(probe.length / 3));
        let hit = 0, total = 0;
        for (let i = 0; i + step <= probe.length; i += step, total++) if (corpus.includes(probe.slice(i, i + step))) hit++;
        return total > 0 && hit / total >= 0.6;
      })()
      : false;
    if (out.some((x) => x.text === text)) continue;
    out.push({ text, source: quoted || partial ? "你原话" : "模型补的（请确认）" });
    if (out.length >= 8) break;
  }
  return out;
}

/** 没模型时的兜底：直接用回答 + 中立模板拼，绝不编造 */
export function templateDraft(answers: Record<string, string>, now = new Date()): Draft {
  const a = (id: string) => String(answers[id] ?? "").trim() || (QUESTIONS.find((q) => q.id === id)?.fallback ?? "");
  const blocks = {
    core: [{ text: a("name"), source: "你原话" as const }, { text: a("initiative"), source: "你原话" as const }],
    boundaries: a("never").split(/[。；;\n]/).map((t) => t.trim()).filter(Boolean)
      .map((t) => ({ text: t, source: "你原话" as const })),
    values: [{ text: a("hate"), source: "你原话" as const }],
    voice: [{ text: a("voice"), source: "你原话" as const }],
    evidence: [{ text: "原话优先；没有原话就说不知道。", source: "模型补的（请确认）" as const }],
    tools: [{ text: "只能在 workspace/ 里写；读项目要人批。", source: "模型补的（请确认）" as const }],
  } satisfies Record<PersonaFile, DraftLine[]>;
  return { blocks, createdAt: now.toISOString(), via: "template", note: "没有可用模型，用你的原话 + 中立模板拼的" };
}

/** 把模型输出解析成 6 块（模型必须按 `## 块名` 分段） */
export function parseDraft(raw: string, answers: Record<string, string>, now = new Date()): Draft {
  const blocks = {} as Record<PersonaFile, DraftLine[]>;
  for (const f of PERSONA_FILES) blocks[f] = [];
  let cur: PersonaFile | null = null;
  for (const line of String(raw ?? "").split(String.fromCharCode(10))) {
    const head = line.match(/^#{1,3}\s*(core|boundaries|values|voice|evidence|tools)\b/i);
    if (head) { cur = head[1]!.toLowerCase() as PersonaFile; continue; }
    if (!cur) continue;
    const t = line.trim();
    if (!t) continue;
    blocks[cur]!.push(...classifyLines(t, answers));
  }
  // 一块都没解析出来 → 当成整体交给 core，仍然过闸
  const empty = PERSONA_FILES.every((f) => blocks[f].length === 0);
  if (empty) blocks.core = classifyLines(raw, answers);
  return { blocks, createdAt: now.toISOString(), via: "model" };
}

export function saveDraft(home: string, d: Draft): void {
  const dir = draftDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(draftPath(home), JSON.stringify(d, null, 2), "utf8");
}

export function readDraft(home: string): Draft | null {
  try {
    if (!existsSync(draftPath(home))) return null;
    return JSON.parse(readFileSync(draftPath(home), "utf8")) as Draft;
  } catch { return null; }
}

export function discardDraft(home: string): void {
  try { rmSync(draftDir(home), { recursive: true, force: true }); } catch { /* 没有就算了 */ }
}

/** 草稿渲染成每块的 markdown（`你原话` 带着，`模型补的` 标着） */
export function renderBlock(lines: DraftLine[]): string {
  return lines.map((l) => (l.source === "你原话" ? `- ${l.text}（你原话）` : `- ${l.text}（模型补的，请确认）`)).join(String.fromCharCode(10));
}

/**
 * 封存（第 ⑦ 步的终点）：草稿 → 真正的 persona 文件，并**开第 1 代**。
 * 封存前随便改（免费）；封存后要改就是开新一代（H-5）。
 */
export function sealDraft(
  db: DatabaseSync, home: string, opts: { because?: string; now?: Date } = {},
): { ok: true; gen: number; files: PersonaFile[] } | { ok: false; code: string; why: string } {
  const d = readDraft(home);
  if (!d) return { ok: false, code: "E_NO_DRAFT", why: "还没有草稿；先做访谈" };
  const now = opts.now ?? new Date();
  const reason = String(opts.because ?? "").trim() || "首次封存（访谈草稿）";
  const wrote: PersonaFile[] = [];
  for (const f of PERSONA_FILES) {
    const body = renderBlock(d.blocks[f] ?? []);
    if (!body) continue;
    // 先记账：撤销安装时要能把这些文件恢复/删掉
    noteFileWillChange(home, join(personaDir(home), f + ".md"));
    savePersonaFile(home, f, `# ${f}${String.fromCharCode(10)}${String.fromCharCode(10)}${body}`, now, reason);
    wrote.push(f);
  }
  const g = bumpGenerationIfChanged(db, home, reason, now);
  discardDraft(home);                       // 封存后草稿不再留（它的内容已经在 persona 里）
  return { ok: true, gen: g.generation.gen, files: wrote };
}

/** 统计：这一步里有多少行是"模型补的"（要人扫一眼的那些） */
export function countModelAdded(d: Draft): number {
  return PERSONA_FILES.reduce((n, f) => n + (d.blocks[f] ?? []).filter((l) => l.source !== "你原话").length, 0);
}
