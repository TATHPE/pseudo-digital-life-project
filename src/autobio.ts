/**
 * 自传（01 §9.1）：一天一条，第一人称，只能引用当日记忆 id。
 * 硬规则：写作时上下文只有当日记忆 + 当前状态 → 这是防编造的关键。
 */
import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import { territoryRoot, ensureTerritory } from "./territory.ts";
import type { DatabaseSync } from "node:sqlite";

export interface DayMemory { id: number; kind: string; text: string; weight: number }

export function dayRange(now: Date): { from: string; to: string } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  return { from, to };
}

export function memoriesOfDay(db: DatabaseSync, now: Date): DayMemory[] {
  const { from, to } = dayRange(now);
  return db.prepare(
    `SELECT id,kind,text,weight FROM memories
     WHERE status='active' AND created_at >= ? AND created_at < ?
     ORDER BY importance DESC, weight DESC LIMIT 12`,
  ).all(from, to) as unknown as DayMemory[];
}

/**
 * 提示词刻意写死三件事：
 *  ① 只许用下面这些记忆（1.5B 小模型极易写出一篇“健身房/邮件/客户合同”的通用日记）
 *  ② 不许照抄原句，也不许把列表抄回正文
 *  ③ 凑不出来就写一句实话，不要凑字数
 */
const PROMPT = (date: string, mems: DayMemory[], stateText: string, strict: boolean): string => [
  "你要写今天的自传。**只能用下面列出的事实**，禁止添加任何一条没列出的事（不写天气、健身房、邮件、客户、朋友聚餐之类）。",
  "写法：第一人称、过去时、不超过 200 字、像日记不像报告；不要编号、不要小标题、不要照抄原句。",
  "如果这些事凑不出一段自然的叙述，就只写一句实话（例如「今天没发生什么值得记的事」）。",
  "",
  "日期：" + date + "　此刻：" + stateText,
  "可用事实（括号里是编号，写完后只把这些编号填在最后一行）：",
  ...mems.map((m) => `- (${m.id}) ${m.text}`),
  "",
  "不要照抄上面的句子，用自己的话把它们串起来。",
  ...(strict ? ["注意：上一版没有引用任何编号，被视为无效。这次必须从上面挑出至少一个编号。"] : []),
].join("\n");

/**
 * 由正文反推引用：不信模型写的 MEMORY 行，只在正文里找证据。
 * 规则：一条记忆的 bigram 有 ≥half 出现在输出里 → 视为引用到（宁可少算，不可多算）。
 */
export function matchCited(output: string, mems: DayMemory[]): number[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/[一-鿿]{2}/g)) out.add(m[0]);
  const hit: number[] = [];
  for (const m of mems) {
    const grams = [...new Set([...m.text.matchAll(/[一-鿿]{2}/g)].map((x) => x[0]))];
    if (!grams.length) continue;
    const found = grams.filter((g) => out.has(g)).length;
    if (found / grams.length >= 0.5) hit.push(m.id);
  }
  return hit;
}

/** 只保留确实引用到的 id，防止模型乱列 */
export function extractCited(text: string, allowed: number[]): number[] {
  const m = text.match(/MEMORY:\s*([0-9,\s]+)/);
  if (!m) return [];
  const ids = (m[1] ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  return [...new Set(ids.filter((n) => allowed.includes(n)))];
}

export interface AutobioResult {
  path: string | null;
  bytes: number;
  cited: number[];
  skipped?: string;
}

export async function writeAutobiography(deps: {
  db: DatabaseSync;
  home: string;
  now: Date;
  complete: (prompt: string) => Promise<string>;
  stateText: string;
}): Promise<AutobioResult> {
  const { db, home, now, complete, stateText } = deps;
  ensureTerritory(home);
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const mems = memoriesOfDay(db, now);
  if (!mems.length) return { path: null, bytes: 0, cited: [], skipped: "今天没有记忆，留白" };

  const allowed = mems.map((m) => m.id);
  const clean = (raw: string): string => raw
    .replace(/MEMORY:.*$/m, "")
    .replace(/^\s*[-*]?\s*\(?\d+\)?\s*/gm, "")   // 模型常把编号抄回正文
    .replace(/^\s*今天的记忆[:：].*$/m, "")
    .trim();

  let body = "", cited: number[] = [], text = "";
  for (const strict of [false, true]) {
    try { body = await complete(PROMPT(date, mems, stateText, strict)); }
    catch (e) { return { path: null, bytes: 0, cited: [], skipped: `E_MODEL: ${String(e).slice(0, 100)}` }; }
    text = clean(body);
    cited = matchCited(text, mems);
    if (cited.length && text) break;
  }

  // 没有引用 = 模型在编（01 §9.1：文末无引用的段落视为无效）。
  // 不写编的，也不留空：退化成"摘录式"，并在文件头标 mode=digest（可区分、可重跑）。
  let mode: "model" | "digest" = "model";
  if (!cited.length || !text) {
    mode = "digest";
    cited = mems.slice(0, 3).map((m) => m.id);
    text = renderDigest(mems);
  }

  const dir = join(territoryRoot(home), "autobiography");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  const content = [
    `# ${date}`,
    "",
    text,
    "",
    `MEMORY: ${cited.join(", ")}`,
    `MODE: ${mode}`,
    "",
  ].join("\n");
  atomicWriteFile(path, content);
  return { path, bytes: Buffer.byteLength(content), cited };
}

/**
 * 摘录式自传：只用当日记忆的字面内容组织成一段，不加任何推断。
 * 它不如模型写得好，但它**不可能编**——这是留白之外的次优解。
 */
export function renderDigest(mems: DayMemory[]): string {
  const parts = mems.slice(0, 3).map((m) => m.text.replace(/[。.]$/, ""));
  const head = parts.length === 1 ? parts[0] : parts.slice(0, -1).join("；") + "；还有 " + parts[parts.length - 1];
  return `今天记下的几件事：${head}。
这条是摘录，不是叙述——今天没什么可写的。`;
}

export function listAutobiography(home: string): Array<{ date: string; bytes: number; cited: number }> {
  const dir = join(territoryRoot(home), "autobiography");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse().slice(0, 30).map((f) => {
    const raw = readFileSync(join(dir, f), "utf8");
    const m = raw.match(/MEMORY:\s*([0-9,\s]+)/);
    return {
      date: f.replace(/\.md$/, ""),
      bytes: Buffer.byteLength(raw),
      cited: m ? (m[1] ?? "").split(",").filter(Boolean).length : 0,
    };
  });
}
