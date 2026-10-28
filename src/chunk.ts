/**
 * 分块（02 §5.2）——**召回上限在这一步就定了**，后面怎么调都补不回来。
 *
 * 四条写死的规则（都是从文档里抄下来的，不是拍脑袋）：
 *  ① 目标 400–800 token；< 80 向后合并（目录、页眉碎片不该单独成块）
 *  ② 边界优先级：标题 > 空行段落 > 表格/代码块 > 句子
 *     **表格与代码块永不切开**（切开就是一堆无法理解的残片）
 *  ③ 重叠 15%（约 80–120 token），缓解切点信息丢失
 *  ④ `heading_path` 拼进 embedding 输入，**不拼进 text 字段**
 *     —— 检索能命中章节语义，返回时正文干净
 *
 * 这个模块是纯函数（字符串进、数组出），不碰文件也不碰库：
 * 分块算法是整个摄入里最难调、最该被单测盯死的一段。
 */
import { createHash } from "node:crypto";
import { estimateTokens } from "./tokens.ts";

export interface ChunkOpts {
  /** 目标块大小（token） */
  target?: number;
  /** 硬上限：超过就切（代码/表格除外） */
  max?: number;
  /** 小于它的块向后合并 */
  min?: number;
  /** 重叠比例 */
  overlap?: number;
}

export type BlockKind = "text" | "code" | "table" | "heading";

export interface Block {
  kind: BlockKind;
  text: string;
  /** 标题块专用：级别与文本 */
  level?: number;
  headingPath: string;
}

export interface Chunk {
  ord: number;
  headingPath: string;
  text: string;
  nTokens: number;
  sha256: string;
}

const D = { target: 600, max: 800, min: 80, overlap: 0.15 };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** 把 markdown 拆成块：标题 / 代码围栏 / 表格 / 段落。headingPath 在校验时就跟着标题栈走 */
export function parseBlocks(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  const stack: string[] = [];
  const path = () => stack.filter(Boolean).join(" > ");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // ① 空行
    if (!line.trim()) { i++; continue; }

    // ② 标题
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const level = h[1]!.length;
      stack.length = Math.max(0, level - 1);
      stack[level - 1] = h[2]!.trim();
      blocks.push({ kind: "heading", text: h[2]!.trim(), level, headingPath: path() });
      i++;
      continue;
    }

    // ③ 代码围栏：整块吞掉，直到闭合（没闭合就到文末——宁可留下，也不要静默丢弃）
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const mark = fence[1]!;
      const buf: string[] = [line];
      i++;
      while (i < lines.length) {
        buf.push(lines[i]!);
        if (lines[i]!.trim().startsWith(mark[0]!.repeat(3))) { i++; break; }
        i++;
      }
      blocks.push({ kind: "code", text: buf.join("\n"), headingPath: path() });
      continue;
    }

    // ④ 表格：连续的 | 行算一张表
    if (/^\s*\|/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) { buf.push(lines[i]!); i++; }
      blocks.push({ kind: "table", text: buf.join("\n"), headingPath: path() });
      continue;
    }

    // ⑤ 段落：到空行或下一个块边界为止
    const buf: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim()) break;
      if (/^(#{1,6})\s+/.test(l) || /^\s*(```+|~~~+)/.test(l) || /^\s*\|/.test(l)) break;
      buf.push(l);
      i++;
    }
    if (buf.length) blocks.push({ kind: "text", text: buf.join("\n"), headingPath: path() });
    else i++;   // 兜底：绝不死循环
  }
  return blocks;
}

/** 超长段落按句子切（句末标点后断开），只对 text 用 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    cur += ch;
    if ("。！？；!?;".includes(ch)) { out.push(cur); cur = ""; }
    else if (ch === "\n") { out.push(cur); cur = ""; }
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 按目标大小把句子打包成若干段 */
function packSentences(sentences: string[], target: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    const t = cur ? estimateTokens(cur + "\n" + s) : estimateTokens(s);
    if (cur && t > target) { out.push(cur); cur = s; }
    else cur = cur ? cur + "\n" + s : s;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** 取上一块尾部 15% 作为重叠（尽量落在句末，避免从半句开始） */
export function overlapTail(text: string, ratio = D.overlap): string {
  if (!text) return "";
  const n = Math.max(1, Math.ceil(text.length * ratio));
  let tail = text.slice(-n);
  const cut = tail.search(/[。！？；!?;\n]/);
  if (cut >= 0 && cut < tail.length - 1) tail = tail.slice(cut + 1);
  return tail.trim();
}

export interface Chunked {
  chunks: Chunk[];
  dropped: number;      // 同文档内 sha256 重复被丢掉的
  stats: { blocks: number; sections: number; avgTokens: number };
}

export function chunkMarkdown(md: string, o: ChunkOpts = {}): Chunked {
  const opt = { ...D, ...o };
  const blocks = parseBlocks(md);
  const raw: Array<{ headingPath: string; text: string; joinable: boolean }> = [];

  let cur = "";
  let curPath = "";
  let lastJoinable = false;

  const flush = () => {
    if (cur.trim()) raw.push({ headingPath: curPath, text: cur.trim(), joinable: lastJoinable });
    cur = "";
    lastJoinable = false;
  };

  for (const b of blocks) {
    if (b.kind === "heading") {
      // 标题本身不单独成块：它只决定后续块的 headingPath
      if (cur.trim()) flush();
      curPath = b.headingPath;
      continue;
    }
    // 换章节 → 先收块（重叠只在同一章节内做：跨章节重叠会把上一章的尾巴混进新章节）
    if (cur.trim() && b.headingPath !== curPath) flush();
    curPath = b.headingPath;

    const t = estimateTokens(b.text);
    const atomic = b.kind === "code" || b.kind === "table";   // 永不切开

    if (t > opt.max && !atomic && b.kind === "text") {
      // 超长段落：按句子重新打包，**同样带重叠**（否则一条长段落切出来就是硬边界）
      if (cur.trim()) flush();
      let prevPiece = "";
      for (const piece of packSentences(splitSentences(b.text), opt.target)) {
        const tail = prevPiece ? overlapTail(prevPiece, opt.overlap) : "";
        raw.push({ headingPath: curPath, text: tail ? tail + "\n\n" + piece : piece, joinable: true });
        prevPiece = piece;
      }
      continue;
    }

    const withCur = cur ? estimateTokens(cur + "\n\n" + b.text) : t;
    if (cur.trim() && withCur > opt.max) {
      flush();
      // 重叠：从上一块尾部拿一段（只对纯文本，且上一块也是纯文本）
      const prev = raw[raw.length - 1];
      const tail = prev && prev.joinable && !atomic ? overlapTail(prev.text, opt.overlap) : "";
      cur = tail ? tail + "\n\n" + b.text : b.text;
      lastJoinable = !atomic;
      continue;
    }
    if (!cur.trim()) { cur = b.text; lastJoinable = !atomic; }
    else { cur = cur + "\n\n" + b.text; lastJoinable = lastJoinable && !atomic; }
  }
  flush();

  // 合并过小的块（02 §5.2：< 80 token 向后合并）
  //
  // 但有个度：一条 30 token 的短章节（比如只有一句话的小节）**不该**被并掉——
  // 它的 heading_path 本身就有检索价值。真正要清掉的是**开头的目录/页眉碎片**：
  // 它们不属于任何有内容的章节，留在索引里只是噪声。
  // 所以规则是：
  //   (a) 同一章节内的小尾巴 → 向后合；
  //   (b) 文档开头“不像句子”的小碎片（目录/标题串/页眉）→ 向后合；
  //   (c) 其余小章节 → 保留（宁可多一块，也不要把章节边界丢掉）
  const SENTENCE_END = /[。！？；.!?;]/;
  const merged = raw.map((c) => ({ ...c }));
  for (let i = 0; i < merged.length; i++) {
    const c = merged[i]!;
    if (estimateTokens(c.text) >= opt.min) continue;
    const next = merged[i + 1];
    const sameSection = next !== undefined && next.headingPath === c.headingPath;
    // 开头碎片：没有句末标点且很短（目录、章节标题串、页眉）
    const headingFragment = i === 0 && next !== undefined && !SENTENCE_END.test(c.text) && estimateTokens(c.text) < 40;
    if (next && (sameSection || headingFragment)) {
      next.text = c.text + "\n\n" + next.text;
      next.joinable = false;
      merged.splice(i, 1);
      i--;
    } else if (!next && i > 0 && merged[i - 1]!.headingPath === c.headingPath) {
      merged[i - 1]!.text = merged[i - 1]!.text + "\n\n" + c.text;
      merged.splice(i, 1);
      i--;
    }
  }

  // 块级去重（同文档内 sha256 重复 → 保留首个）
  const seen = new Set<string>();
  const chunks: Chunk[] = [];
  let dropped = 0;
  for (const c of merged) {
    const text = c.text.trim();
    if (!text) continue;
    const hash = sha256(text);
    if (seen.has(hash)) { dropped++; continue; }
    seen.add(hash);
    chunks.push({
      ord: chunks.length, headingPath: c.headingPath, text,
      nTokens: estimateTokens(text), sha256: hash,
    });
  }

  const total = chunks.reduce((n, c) => n + c.nTokens, 0);
  return {
    chunks, dropped,
    stats: {
      blocks: blocks.length,
      sections: new Set(chunks.map((c) => c.headingPath)).size,
      avgTokens: chunks.length ? Math.round(total / chunks.length) : 0,
    },
  };
}

/** embedding 输入（02 §5.2）：章节路径进向量，正文单独存 */
export function embedInput(input: { scope?: string; title: string; headingPath: string; text: string }): string {
  const scope = input.scope ?? "global";
  // H1 往往就是文档标题：重复一遍只是浪费 token（实测同一段话会多出 8–12 tok）
  const path = dedupeTitle(input.headingPath, input.title);
  const head = `${scope}/${input.title}${path ? " › " + path : ""}`;
  return `${head}\n---\n${input.text}`;
}

/** `记忆动力学 > 再巩固` + title `记忆动力学` → `再巩固` */
export function dedupeTitle(headingPath: string, title: string): string {
  const parts = headingPath.split(" > ").filter(Boolean);
  if (parts.length && parts[0]!.trim() === title.trim()) parts.shift();
  return parts.join(" > ");
}
