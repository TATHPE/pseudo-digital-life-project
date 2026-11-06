/**
 * 难用例集（hard2，2026-11-06）：专门测「换个说法还找得到吗」。
 *
 * 为什么另开一套：现有的两套都太软 ——
 *   · `jingjing eval` 的用例是从库里自动生成的（query 就是原词，等于同义匹配）；
 *   · `eval:rank` 的 12 条偏"排序，不是改写"。
 * 这套 20 条**手写**，分四类，每一类都能独立看：
 *   rewrite   换个说法（我妈生日 → 蛋糕）
 *   negation  否定/相反问法（我不吃什么 → 花生）
 *   abstain   库里根本没有的（我多高）—— 必须返回空，编了就算错
 *   mixed     术语/中英混（OneBot、Ollama、零构建）
 *   time      时间挪位（上周说的那个…）
 *
 * 用法：node tools/eval-hard2.ts [--home <dir>]   # 不带 --home 就从 fixtures 现场重建
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createEmbedder } from "../src/embed.ts";
import { search } from "../src/retrieve.ts";
import { remember } from "../src/store.ts";
import { readFileConfig } from "../src/configfile.ts";
import { rerank } from "../src/rerank.ts";

const NL = String.fromCharCode(10);
const FIXTURE = "tools/fixtures/hard2";
const OUT = "tmp/eval-hard2";

interface Case { id: string; group: "rewrite" | "negation" | "abstain" | "mixed" | "time"; q: string; anyOf?: string[]; expectEmpty?: boolean }
interface MemRow { id: number; text: string; kind: string; layer: "narrative" | "contract" }

function embedFor(home: string) {
  const cfg = readFileConfig(home);
  return createEmbedder("ollama", {
    baseUrl: String(cfg.ollama ?? "http://127.0.0.1:11434"),
    model: String((cfg.local as { embed?: string } | undefined)?.embed ?? "bge-m3"),
  });
}

async function rebuild(): Promise<string> {
  const home = join(OUT, "data");
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(home, "eval"), { recursive: true });
  writeFileSync(join(home, "eval", "cases.jsonl"), readFileSync(join(FIXTURE, "cases.jsonl")));

  const mems = readFileSync(join(FIXTURE, "memories.jsonl"), "utf8").split(NL).filter((l) => l.trim())
    .map((l) => JSON.parse(l) as MemRow);
  const d = openDb(join(home, "memory.db"));
  const embed = embedFor(home);
  const vs = await embed.embed(mems.map((m) => m.text));
  for (let i = 0; i < mems.length; i++) {
    remember(d.db, { layer: mems[i]!.layer, kind: mems[i]!.kind, text: mems[i]!.text, embedding: vs[i] ?? null });
  }
  return home;
}

const args = process.argv.slice(2);
/** --rerank：候选交给本地 7B 挑一条（或说 NONE）——用来量 rerank 到底有没有用 */
const USE_RERANK = args.includes("--rerank");
const hi = args.indexOf("--home");
const home = hi >= 0 ? args[hi + 1]! : await rebuild();

const cases = readFileSync(join(home, "eval", "cases.jsonl"), "utf8").split(NL).filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Case);

const d = openDb(join(home, "memory.db"));
const embed = embedFor(home);

const byGroup = new Map<string, { ok: number; n: number }>();
let rows: string[] = [];

for (const c of cases) {
  let { hits } = await search(d.db, embed, c.q, { k: 5 });
  if (USE_RERANK) {
    const r = await rerank(home, c.q, hits.map((h) => ({ id: h.id, text: h.text, score: h.score })), { mode: (args.includes("--rerank-always") ? "always" : "auto") as "auto" | "always" });
    hits = r.none ? [] : (r.order as typeof hits);
  }
  const texts = hits.map((h) => String(h.text));
  const g = byGroup.get(c.group) ?? { ok: 0, n: 0 };
  g.n++;
  if (c.expectEmpty) {
    const ok = hits.length === 0;
    if (ok) g.ok++;
    rows.push(`${ok ? "✅" : "❌"} ${c.group.padEnd(9)} ${c.id.padEnd(14)} 空? ${ok ? "是" : "否：" + (texts[0] ?? "").slice(0, 22)}`);
  } else {
    const at = texts.findIndex((t) => (c.anyOf ?? []).some((w) => t.includes(w)));
    const ok = at === 0;
    if (ok) g.ok++;
    rows.push(`${ok ? "✅" : at > 0 ? "△ " : "❌"} ${c.group.padEnd(9)} ${c.id.padEnd(14)} ${ok ? "" : "→ " + (texts[0] ?? "空").slice(0, 24)}`);
  }
  byGroup.set(c.group, g);
}

console.log(rows.join(NL));
console.log("");
let ok = 0, n = 0;
for (const [k, v] of byGroup) {
  console.log(`${k.padEnd(9)} ${v.ok}/${v.n}`);
  ok += v.ok; n += v.n;
}
console.log(`—`.repeat(20));
console.log(`合计 ${ok}/${n}`);
process.exitCode = ok === n ? 0 : 1;
