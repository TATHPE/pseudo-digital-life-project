/**
 * CLI：eval —— 跑评估（19 §0.1 W-B）。
 *   eval --seed          从现有记忆自动生成一批用例
 *   eval                 跑用例（检索层）
 *   eval --model         额外跑模型层"编造共同回忆"检查（会产生 API 费用）
 */
import { openDb } from "../db.ts";
import { loadCases, runEval, saveCases, seedCases, GATES } from "../eval.ts";
import { createEmbedder } from "../embed.ts";
import { resolveConfig } from "../configfile.ts";
import { createChatTransport, createTransport, routerFrom } from "../transport.ts";
import { createStore, type Provider } from "../auth.ts";
import { join } from "node:path";

export interface EvalOptions {
  home: string;
  dbFile: string;
  k?: number;
  useModel?: boolean;
  json?: boolean;
}

export async function runEvalCli(opts: EvalOptions): Promise<number> {
  const cfg = resolveConfig(opts.home);
  const d = openDb(opts.dbFile);
  const embedder = createEmbedder("ollama", { baseUrl: cfg.ollama, model: cfg.roles["embed"]!.model });

  let cases = loadCases(opts.home);
  if (!cases.length) {
    cases = seedCases(d.db);
    saveCases(opts.home, cases);
    console.log(`（没有用例，已从现有记忆自动生成 ${cases.length} 条 → data/eval/cases.jsonl）`);
  }

  let ask: ((brief: string, user: string) => Promise<string>) | undefined;
  if (opts.useModel) {
    const store = createStore(join(opts.home, "secrets"));
    const keys: Record<string, string> = {};
    for (const p of ["deepseek", "anthropic", "openai"] as Provider[]) { const k = store.get(p); if (k) keys[p] = k; }
    const chat = createChatTransport(routerFrom(cfg.roles as never), { apiKeys: keys });
    ask = async (brief, user) => {
      let out = "";
      for await (const ev of chat.chat("express", [{ role: "system", content: brief }, { role: "user", content: user }], {
        containsMemory: false, purpose: "eval-trap", maxTokens: 200,
      })) if (ev.type === "delta") out += ev.text;
      return out;
    };
  }

  const report = await runEval({ db: d.db, home: opts.home, embedder, k: opts.k, cases, ask });

  if (opts.json) { console.log(JSON.stringify(report, null, 2)); return report.pass ? 0 : 1; }

  const bar = (ok: boolean) => (ok ? "✅" : "❌");
  console.log(`\n用例 ${report.cases} 条 ｜ recall@${opts.k ?? 5} ｜ abstain F1 ｜ 编造率 ｜ 契约`);
  for (const g of report.gates) {
    console.log(`${bar(g.pass)} ${g.name.padEnd(10)} ${String(g.value).padStart(6)}  (目标 ${g.name === "trapRate" ? "≤" : "≥"} ${g.target})`);
  }
  console.log(`\n分组：` + Object.entries(report.byGroup).map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(" ｜ "));
  console.log(`延迟：p50 ${report.latency.p50}ms · p95 ${report.latency.p95}ms`);

  const bad = report.results.filter((r) => !r.ok);
  if (bad.length) {
    console.log(`\n失败用例（${bad.length}）：`);
    for (const b of bad.slice(0, 12)) console.log(`  ${bar(false)} ${b.id.padEnd(16)} ${b.group.padEnd(9)} ${b.detail ?? ""}`);
  }
  console.log(report.pass ? "\n✅ 全部门通过" : "\n❌ 有门未通过");
  return report.pass ? 0 : 1;
}

export const EVAL_TARGETS = GATES;
