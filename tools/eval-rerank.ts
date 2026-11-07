/**
 * 重排实验（2026-11-05）：用本地 7B 当列表重排器，量两列 —— R@1 和 abstain。
 *
 * 为什么用本地模型而不是 cross-encoder：Ollama 没有 rerank 接口，
 * 引 Python/ONNX 会打破「零构建、两个依赖」。本地 7B 是现成的，代价是慢。
 *
 * 口径（docs/ops/24 定的，不改）：**R@1 和 abstain 必须同时变好**才算可用。
 *
 * 用法：node --experimental-strip-types tools/eval-rerank.ts [--model qwen2.5:7b-instruct]
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { openDb } from "../src/db.ts";
import { search } from "../src/retrieve.ts";
import { readFileConfig } from "../src/configfile.ts";
import { rebuildFixture } from "./eval-rank.ts";

const NL = String.fromCharCode(10);
interface Case { id: string; group: string; q: string; anyOf?: string[]; expectEmpty?: boolean; note?: string }

const MODEL = (() => {
  const i = process.argv.indexOf("--model");
  return i > 0 ? process.argv[i + 1]! : "qwen2.5:7b-instruct";
})();

async function ask(question: string, cands: string[]): Promise<number | "NONE" | "?"> {
  const cfg = readFileConfig(process.env.JJ_HOME ?? "data");
  const base = String(cfg.ollama ?? "http://127.0.0.1:11434");
  const list = cands.map((t, i) => (i + 1) + ". " + t).join(NL);
  const prompt = [
    "你是检索重排器。下面是问题与候选记忆。",
    "只输出一个编号（1 到 " + cands.length + "）；如果候选里没有能回答这条问题的，只输出 NONE。",
    "不要解释，不要标点，不要别的话。",
    "",
    "问题：" + question,
    "候选：",
    list,
  ].join(NL);
  try {
    const r = await fetch(base + "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { temperature: 0, num_predict: 8 } }),
    });
    if (!r.ok) return "?";
    const j = (await r.json()) as { response?: string };
    const txt = String(j.response ?? "").toUpperCase();
    if (txt.includes("NONE")) return "NONE";
    const m = txt.match(/[1-9]/);
    return m ? Number(m[0]) : "?";
  } catch { return "?"; }
}

const home = await rebuildFixture();
const d = openDb(join(home, "memory.db"));
const cfg = readFileConfig(home);
const embed = (await import("../src/embed.ts")).createEmbedder("ollama", {
  baseUrl: String(cfg.ollama ?? "http://127.0.0.1:11434"),
  model: String((cfg.local as { embed?: string } | undefined)?.embed ?? "bge-m3"),
});

const cases = readFileSync(join(home, "eval", "cases.jsonl"), "utf8").split(NL).filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Case);

let baseR1 = 0, baseAb = 0, reR1 = 0, reAb = 0, n = 0, abN = 0;
const rows: string[] = [];
for (const c of cases) {
  const { hits } = await search(d.db, embed, c.q, { k: 5 });
  const texts = hits.map((h) => h.text);
  if (!texts.length) { rows.push("（空） " + c.id); continue; }
  const pick = await ask(c.q, texts);
  const baseTop = texts[0] ?? "";
  const isAb = c.group === "abstain" || c.expectEmpty;
  if (isAb) {
    abN++;
    if (!baseTop) baseAb++;                    // 基线只有"没召回"才算拒答
    if (pick === "NONE") reAb++;
  } else {
    n++;
    if ((c.anyOf ?? []).some((e) => baseTop.includes(e))) baseR1++;
    if (typeof pick === "number") {
      const t = texts[pick - 1] ?? "";
      if ((c.anyOf ?? []).some((e) => t.includes(e))) reR1++;
    }
  }
  const pickLabel = pick === "NONE" ? "NONE" : pick === "?" ? "?" : String(pick) + ":" + (texts[pick - 1] ?? "").slice(0, 20);
  rows.push((isAb ? "· " : "") + c.id.padEnd(20) + " 基线=" + (baseTop.slice(0, 18) || "（空）") + "  →  重排=" + pickLabel);
}

console.log(rows.join(NL));
console.log("---");
console.log("基线   R@1 " + baseR1 + "/" + n + " ｜ abstain " + baseAb + "/" + abN);
console.log("重排   R@1 " + reR1 + "/" + n + " ｜ abstain " + reAb + "/" + abN + "   （模型 " + MODEL + "）");
const better = reR1 > baseR1 && reAb > baseAb;
const worse = reR1 < baseR1 || reAb < baseAb;
console.log(better ? "✅ 两列同时变好 —— 可以落地（选择性重排）" : worse ? "❌ 至少一列变差 —— 不落地" : "△ 有一列没变 —— 按 docs/ops/24 不算达标");
