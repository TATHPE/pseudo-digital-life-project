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
  /** 解析后一块都没有（模型没给出可用内容） */
  emptyAll?: boolean;
}

export const draftDir = (home: string): string => join(home, "persona.draft");
const draftPath = (home: string): string => join(draftDir(home), "draft.json");

const norm = (s: string): string => String(s ?? "").replace(/\s+/g, "").toLowerCase();

/**
 * **闸门**：把模型输出拆成行，并判定每一行的来源。
 * 判据只有一条：这一行的核心片段（去空白后 ≥8 字）能否在用户回答里找到。
 * 找不到就一律降级为「模型补的」—— 哪怕模型自己写了"你原话"。
 */
/**
 * 模型的**自述/借口**，不是内容：
 *   "name: 未提供具体内容（仅出现字段名）" / "用户没有回答这一项" / "N/A"
 * 这些行是它在说"我不知道"，把它封存进人格就是往记忆里塞垃圾 —— 直接丢。
 * 顺带剥掉 `name:` / `never:` 这类字段名前缀：那是我在提示词里给的格式，不是内容。
 */
const FIELD_PREFIX = /^\s*(name|initiative|never|hate|voice|core|boundaries|values|evidence|tools|description)\s*[:：]\s*/i;
const META_TALK = /(未提供|未说明|没有提供|没有说明|仅出现字段|字段名|无具体内容|用户没有|无法确定|无法推断|not provided|no information|n\/a|none)/i;

export function classifyLines(raw: string, answers: Record<string, string>): DraftLine[] {
  const corpus = norm(Object.values(answers).join(""));
  const out: DraftLine[] = [];
  for (const line0 of String(raw ?? "").split(String.fromCharCode(10))) {
    const line = line0.replace(/^\s*[-*・]\s*/, "").trim();
    if (!line) continue;
    // 去掉模型可能加的标记，按内容重判
    let text = line.replace(/^\[(你原话|模型补的（请确认）)\]\s*/, "").trim();
    // 行尾的「（你原话）」「（模型补的，请确认）」是模型自己的声明，不算数 —— 剥掉再判
    text = text.replace(/[（(]\s*(你原话|模型补的\s*[，,]?\s*请确认)\s*[)）]\s*$/g, "").trim();
    text = text.replace(FIELD_PREFIX, "").trim();
    if (!text) continue;
    // 太短或只是它在说"我不知道" → 不是内容，丢掉（否则会被封存进 persona）
    if (META_TALK.test(text)) continue;
    if (text.replace(/[\s\p{P}]/gu, "").length < 2) continue;
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
/** 块名别名：模型爱把标题本地化（实测会写「## 核心」），认不出就等于整块丢了 */
export const BLOCK_ALIAS: Record<string, PersonaFile> = {
  core: "core", boundaries: "boundaries", values: "values", voice: "voice", evidence: "evidence", tools: "tools",
  核心: "core", 禁区: "boundaries", 边界: "boundaries", 立场: "values", 价值观: "values",
  语气: "voice", 说话: "voice", 证据: "evidence", 工具: "tools",
};

export function parseDraft(raw: string, answers: Record<string, string>, now = new Date()): Draft {
  const blocks = {} as Record<PersonaFile, DraftLine[]>;
  for (const f of PERSONA_FILES) blocks[f] = [];
  // 跨块去重：同一句话只留第一次出现的那一块（模型爱把一句塞进好几个块）
  const seen = new Set<string>();
  let cur: PersonaFile | null = null;
  for (const line of String(raw ?? "").split(String.fromCharCode(10))) {
    // 分段识别放宽：#/##/**bold**/【】 都认（deepseek 实测会写 **core**）。
    // 故意**不**认纯裸的 core：两个字（不带 # / ** / 【）: 正文里提到这个词就会被当成分段。
    const head = line.match(/^\s*(?:#{1,4}\s*|\*\*\s*|【\s*)([a-z\u4e00-\u9fa5]{2,10})\s*(?:\*\*|】)?\s*[:：]?\s*$/i);
    if (head) {
      const key = head[1]!.toLowerCase();
      const mapped = (BLOCK_ALIAS as Record<string, PersonaFile | undefined>)[key];
      // 认不出这块就**保留上一个 cur**，别把内容静默丢掉
      if (mapped) cur = mapped;
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    if (!t) continue;
    for (const line2 of classifyLines(t, answers)) {
      const key = line2.text.replace(/\s+/g, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      blocks[cur]!.push(line2);
    }
  }
  // 一块都没解析出来时**不要**把原始输出硬塞进 core：
  // 那条路的实际后果是把模型的一句"未提供具体内容"封存成 core.md（踩过）。
  // 交给调用方判断：emptyAll 为 true 就别存草稿，直接把原因说给人。
  const emptyAll = PERSONA_FILES.every((f) => blocks[f].length === 0);
  return { blocks, createdAt: now.toISOString(), via: "model", ...(emptyAll ? { emptyAll: true } : {}) } as Draft;
}

export function saveDraft(home: string, d: Draft): void {
  const dir = draftDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(draftPath(home), JSON.stringify(d, null, 2), "utf8");
}

export function readDraft(home: string): Draft | null {
  try {
    if (!existsSync(draftPath(home))) return null;
    const d = JSON.parse(readFileSync(draftPath(home), "utf8")) as Draft;
    // 清洗：旧版本把「name: 未提供具体内容（仅出现字段名）」这种借口行写进了草稿文件。
    // 光修闸门不够 —— 已经落盘的要在**读的时候**再过一遍，否则旧草稿会一直脏下去。
    const blocks = {} as Record<PersonaFile, DraftLine[]>;
    for (const f of PERSONA_FILES) {
      blocks[f] = (d.blocks?.[f] ?? []).filter((l) => {
        const t = String(l?.text ?? "").replace(FIELD_PREFIX, "").trim();
        return t.length > 0 && !META_TALK.test(t);
      }).map((l) => ({ ...l, text: String(l.text).replace(FIELD_PREFIX, "").trim() }));
    }
    const empty = PERSONA_FILES.every((f) => blocks[f].length === 0);
    if (empty) return null;   // 全被滤掉 = 等于没有草稿，别让一屏垃圾挡住人
    return { ...d, blocks };
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
): { ok: true; gen: number; files: PersonaFile[]; missing: PersonaFile[] } | { ok: false; code: string; why: string } {
  const d = readDraft(home);
  if (!d) return { ok: false, code: "E_NO_DRAFT", why: "还没有草稿；先做访谈" };
  const now = opts.now ?? new Date();
  const reason = String(opts.because ?? "").trim() || "首次封存（访谈草稿）";
  const wrote: PersonaFile[] = [];
  // 没写到的块**保持原样**（首次安装 = 出厂默认）。这不该偷偷发生：
  // 「已封存」如果其实是 2 块访谈 + 4 块出厂默认，人有权知道是哪 4 块。
  const missing: PersonaFile[] = [];
  for (const f of PERSONA_FILES) {
    const body = renderBlock(d.blocks[f] ?? []);
    if (!body) { missing.push(f); continue; }
    // 先记账：撤销安装时要能把这些文件恢复/删掉
    noteFileWillChange(home, join(personaDir(home), f + ".md"));
    savePersonaFile(home, f, `# ${f}${String.fromCharCode(10)}${String.fromCharCode(10)}${body}`, now, reason);
    wrote.push(f);
  }
  const g = bumpGenerationIfChanged(db, home, reason, now);
  discardDraft(home);                       // 封存后草稿不再留（它的内容已经在 persona 里）
  return { ok: true, gen: g.generation.gen, files: wrote, missing };
}

/** 统计：这一步里有多少行是"模型补的"（要人扫一眼的那些） */
export function countModelAdded(d: Draft): number {
  return PERSONA_FILES.reduce((n, f) => n + (d.blocks[f] ?? []).filter((l) => l.source !== "你原话").length, 0);
}
