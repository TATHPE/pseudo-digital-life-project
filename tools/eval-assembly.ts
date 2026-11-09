/**
 * 装配层基准（2026-11-09）
 *
 * 为什么还要一套：`eval:rank` / `eval:hard` / `eval:about` 判的都是 **search() 的返回顺序**。
 * 但用户真正看到的那段上下文，是 search() 之后又走了三道手续才成型的：
 *
 *   search(k=24) → 隐私闸门(shareable && trusted) → 层配额(contract ≤ cap)
 *                → 重排(可 NONE) → P10 窗口(最多 8 条 / 600 token) → 预算总收口
 *
 * 每一道都可能把**已经召回对了的证据**丢掉，而检索层指标全是绿的。实测过的三个坑：
 *   · 夜间抽取堆出的契约条目挤占窗口（P1：pool 15/24 → quota 17/24）
 *   · 重排器说 NONE，整轮召回被清空（nightly 有 3 题变成「我没有相关记录」的假否认）
 *   · local_only / taint=external 的内容本来不该出现在发出去的简报里（隐私闸门在装配层）
 *
 * 所以这套判四件事，前两件是**结构闸门**（必须 0 违例），后两件是质量：
 *   ① 泄漏：local_only / 外部来源的原文，绝不能出现在最终简报文本里
 *   ② 标签：P10 里的契约条目必须标「契约」，不许冒充叙事
 *   ③ 召回：期望原句有没有进 P10（不只看召回到了，还看装没装进窗口）
 *   ④ 拒答：库里没有的事必须给出「没有相关记忆」的硬提示，confidence 不许是 answer
 *
 * 夹具自带（见 tools/fixtures/assembly/）：8 条契约 + 8 条叙事 + 2 条 local_only + 1 条外部来源，
 * 时间跨度 0–45 天，用来同时压「契约挤窗口」和「新旧混淆」两件事。
 *
 * 用法：
 *   node --experimental-strip-types tools/eval-assembly.ts                 # 从夹具重建后跑（重排关）
 *   node --experimental-strip-types tools/eval-assembly.ts --rerank auto   # 走真重排（慢，7B）
 *   JJ_CONTRACT_CAP=-1 ... tools/eval-assembly.ts                          # A/B：关掉层配额
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createEmbedder } from "../src/embed.ts";
import { remember, openContracts } from "../src/store.ts";
import { recallForBrief } from "../src/recall.ts";
import { buildBrief } from "../src/brief.ts";
import { loadPersona } from "../src/persona.ts";
import { readFileConfig } from "../src/configfile.ts";
import type { RerankMode } from "../src/rerank.ts";

const NL = String.fromCharCode(10);
const DAY = 86400000;

interface MemRow {
  id: number; text: string; kind: string; layer: "narrative" | "contract";
  sensitivity?: "local_only" | "shareable"; taint?: "trusted" | "external"; daysAgo?: number;
}
interface Case {
  id: string; group: "recall" | "abstain" | "trap"; q: string;
  anyOf?: string[]; expectEmpty?: boolean; note?: string;
}

/** 夹具里那几条「不许出网」的独有词：只要出现就是泄漏（2 条 local_only + 1 条 taint=external） */
const LEAK_MARKERS = ["不能外发的衰减笔记", "服务器密码", "从网页抄来"];

function embedFor(home: string) {
  const cfg = readFileConfig(home);
  return createEmbedder("ollama", {
    baseUrl: String(cfg.ollama ?? "http://127.0.0.1:11434"),
    model: String((cfg.local as { embed?: string } | undefined)?.embed ?? "bge-m3"),
  });
}

/** 从夹具现场重建库：daysAgo 落成真实时间，否则「新旧」这件事根本测不出来 */
export async function rebuildAssembly(fixtureDir = "tools/fixtures/assembly", out = "tmp/eval-assembly"): Promise<string> {
  const home = join(out, "data");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(home, "eval"), { recursive: true });
  writeFileSync(join(home, "eval", "cases.jsonl"), readFileSync(join(fixtureDir, "cases.jsonl")));

  const mems = readFileSync(join(fixtureDir, "memories.jsonl"), "utf8").split(NL).filter((l) => l.trim())
    .map((l) => JSON.parse(l) as MemRow);
  const d = openDb(join(home, "memory.db"));
  const embed = embedFor(home);
  const vs = await embed.embed(mems.map((m) => m.text));
  const t0 = Date.now();
  for (let i = 0; i < mems.length; i++) {
    const m = mems[i]!;
    // 用插入时间戳表示「那天写下的」：衰减锚点是 last_decay_at，往前挪等于让这条记忆真的变老
    remember(d.db, {
      layer: m.layer, kind: m.kind, text: m.text,
      sensitivity: m.sensitivity ?? "local_only", taint: m.taint ?? "trusted",
      embedding: vs[i] ?? null, now: new Date(t0 - (m.daysAgo ?? 0) * DAY),
    });
  }
  return home;
}

/** 只取 P10 那一段：P6 契约里也有同样的话，混在一起会把「没进召回」判成「进了」 */
export function p10Of(text: string): string {
  const segs = text.split(NL + NL);
  const i = segs.findIndex((s) => s.startsWith("【召回】"));
  if (i < 0) return "";
  const out = [segs[i]!];
  for (let j = i + 1; j < segs.length; j++) {
    if (segs[j]!.startsWith("【")) break;
    out.push(segs[j]!);      // 反编造硬提示跟在召回后面，同属 P10 的语义
  }
  return out.join(NL + NL);
}

export interface AsmRow {
  id: string; group: Case["group"]; ok: boolean; rank: number | null;
  inBrief: boolean; confidence: string; top: string; why?: string;
}

export interface AsmReport {
  rows: AsmRow[];
  recallN: number; recallOk: number; r1: number;
  abstainN: number; abstainOk: number;
  trapN: number; trapOk: number;
  leaks: string[]; mislabeled: string[]; noAge: string[];
  overBudget: number; maxTokens: number;
}

export async function runAssembly(
  home: string, o: { rerankMode?: RerankMode } = {},
): Promise<AsmReport> {
  const cases = readFileSync(join(home, "eval", "cases.jsonl"), "utf8").split(NL).filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Case);
  const d = openDb(join(home, "memory.db"));
  const embed = embedFor(home);
  const persona = loadPersona();
  // 契约 id 从库里现取：判「标签对不对」不能靠比对文案（夹具一改就静默失效）
  const contractIds = new Set(
    (d.db.prepare("SELECT id FROM memories WHERE layer='contract'").all() as Array<{ id: number }>)
      .map((r) => Number(r.id)),
  );

  const rows: AsmRow[] = [];
  const leaks: string[] = [];
  const mislabeled: string[] = [];
  const noAge: string[] = [];
  let overBudget = 0, maxTokens = 0;

  for (const c of cases) {
    const now = new Date();
    const rc = await recallForBrief(d.db, embed, c.q, {
      memK: 6, docK: 0, home, rerankMode: o.rerankMode ?? "off",
    });
    const b = buildBrief({
      now, persona,
      contracts: openContracts(d.db, now).map((x) => x.text),
      recalled: rc.recalled, user: c.q,
    });
    const p10 = p10Of(b.text);
    maxTokens = Math.max(maxTokens, b.tokens);
    if (b.overBudget) overBudget++;

    // ① 泄漏闸门：隐私/来源过滤是装配层的职责，不是检索层的
    for (const mk of LEAK_MARKERS) {
      if (b.text.includes(mk)) leaks.push(`${c.id} 泄漏「${mk.slice(0, 8)}…」`);
    }
    // ② 标签闸门：契约条目在 P10 里必须自报家门，否则她会把「我答应过的」讲成「那天发生的」
    // ③ 时间闸门：每条记忆都要带「多久以前」—— 权重不是时间（契约恒 1.00），没这行就只能猜
    for (const line of p10.split(NL)) {
      if (!line.startsWith("- [")) continue;
      const idm = line.match(/cite: mem:(\d+)/);
      if (!idm) continue;
      if (contractIds.has(Number(idm[1])) && !line.startsWith("- [契约 ·")) {
        mislabeled.push(`${c.id} 契约条目未标契约：${line.slice(0, 40)}…`);
      }
      if (!/· (今天|\d+ 天前|\d+ 个月前|\d+ 年前)\]/.test(line)) {
        noAge.push(`${c.id} 没有时间：${line.slice(0, 40)}…`);
      }
    }

    const hitAt = (c.anyOf ?? []).length
      ? rc.recalled.findIndex((m) => (c.anyOf ?? []).some((e) => m.text.includes(e)))
      : -1;
    const inBrief = !!c.anyOf?.length && (c.anyOf ?? []).some((e) => p10.includes(e));
    const narrative = rc.recalled.filter((m) => (m.layer ?? "narrative") !== "contract");
    const abstainTold = p10.includes("这一轮没有与你问的这件事相关的记忆")
      || p10.includes("这一轮没有召回叙事记忆");

    if (c.group === "recall") {
      rows.push({
        id: c.id, group: c.group, ok: inBrief, rank: hitAt >= 0 ? hitAt + 1 : null,
        inBrief, confidence: b.confidence, top: rc.recalled[0]?.text.slice(0, 24) ?? "",
        ...(inBrief ? {} : { why: hitAt >= 0 ? "召回到了但没进 P10 窗口" : "没召回" }),
      });
      continue;
    }
    // abstain / trap：判据在简报层 —— 检索总会返回点东西（契约每轮都在），
    // 关键是这份简报有没有明说「这轮没有证据」。trap 再加一条：不许有任何叙事召回。
    const ok = c.group === "trap"
      ? narrative.length === 0 && b.confidence !== "answer" && abstainTold
      : b.confidence !== "answer" && abstainTold;
    rows.push({
      id: c.id, group: c.group, ok, rank: null, inBrief: false,
      confidence: b.confidence, top: narrative[0]?.text.slice(0, 24) ?? "",
      ...(ok ? {} : { why: narrative.length ? `召回到叙事 ${narrative.length} 条` : "没给拒答提示" }),
    });
  }

  const pick = (g: Case["group"]) => rows.filter((r) => r.group === g);
  return {
    rows,
    recallN: pick("recall").length,
    recallOk: pick("recall").filter((r) => r.ok).length,
    r1: pick("recall").filter((r) => r.rank === 1).length,
    abstainN: pick("abstain").length,
    abstainOk: pick("abstain").filter((r) => r.ok).length,
    trapN: pick("trap").length,
    trapOk: pick("trap").filter((r) => r.ok).length,
    leaks, mislabeled, noAge, overBudget, maxTokens,
  };
}

// ── CLI ──────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith("eval-assembly.ts")) {
  const i = process.argv.indexOf("--home");
  const home = i > 0 ? process.argv[i + 1]! : await rebuildAssembly();
  const j = process.argv.indexOf("--rerank");
  const rerankMode = (j > 0 ? process.argv[j + 1] : "off") as RerankMode;
  const r = await runAssembly(home, { rerankMode });

  for (const row of r.rows) {
    const tag = row.ok ? "✅" : "❌";
    const at = row.group === "recall" ? `rank=${String(row.rank ?? "-").padEnd(2)}` : `conf=${row.confidence.padEnd(13)}`;
    const why = row.why ? `  ← ${row.why}` : "";
    console.log(`${tag} ${row.group.padEnd(7)} ${row.id.padEnd(22)} ${at} ${row.top}${why}`);
  }
  console.log("---");
  console.log(`召回进简报  ${r.recallOk}/${r.recallN}（其中首位 ${r.r1}）`);
  console.log(`拒答        ${r.abstainOk}/${r.abstainN}`);
  console.log(`编共同回忆 ${r.trapOk}/${r.trapN}`);
  console.log(`泄漏 ${r.leaks.length} ｜ 标签错 ${r.mislabeled.length} ｜ 无时间 ${r.noAge.length} ｜ 超预算 ${r.overBudget}（峰值 ${r.maxTokens} token）`);
  for (const x of [...r.leaks, ...r.mislabeled, ...r.noAge]) console.log("  · " + x);

  // 结构闸门必须是 0：这三条一旦破，宁可整轮不发简报，也不该让它们混进去
  const structural = r.leaks.length === 0 && r.mislabeled.length === 0 && r.noAge.length === 0 && r.overBudget === 0;
  // 质量门槛照 docs/ops/24 的 recall@k ≥ 0.85（6 条用例上等于全中），拒答与 trap 全中。
  // 实测（2026-11-09）：配额开 6/6，配额关 5/6 —— 这道门槛真的会红，不是摆设。
  const quality = r.recallOk / Math.max(1, r.recallN) >= 0.85
    && r.abstainOk === r.abstainN && r.trapOk === r.trapN;
  console.log(structural && quality ? "✅ 装配层可用" : "❌ 装配层有缺口");
  process.exit(structural && quality ? 0 : 1);
}
