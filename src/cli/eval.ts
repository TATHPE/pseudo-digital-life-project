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
  const autoSeeded = !cases.length;
  if (!cases.length) {
    cases = seedCases(d.db);
    saveCases(opts.home, cases);
    console.log(`（没有用例，已从现有记忆自动生成 ${cases.length} 条 → data/eval/cases.jsonl）`);
  }
  // 空库的真相：seedCases 是从**现有记忆**生成 recall 用例的，库空了就是一条也生不出来。
  // 那时 recall 组等于**没测**，不能跟“全部门通过”摆在一起（和 ui:test 空库假红是同一类问题）。
  const memCount = Number((d.db.prepare("SELECT count(*) c FROM memories WHERE status='active'").get() as { c?: number })?.c ?? 0);
  const recallCases = cases.filter((c) => c.group === "recall").length;
  const recallUntested = recallCases === 0;

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
  if (recallUntested) {
    console.log(`⏭  recall 组未测：库里只有 ${memCount} 条记忆，而 recall 用例是从记忆自动生成的。`);
    console.log(`   先 ` + "`jingjing remember \"…\"`" + ` 造几条（或跑一轮 night），再 ` + "`jingjing eval --seed`" + `。`);
  } else if (autoSeeded) {
    console.log(`ℹ  recall 用例本次自动生成（库里有 ${memCount} 条记忆）；写死用例请自行补到 data/eval/cases.jsonl`);
  }
  console.log(`延迟：p50 ${report.latency.p50}ms · p95 ${report.latency.p95}ms`);

  const bad = report.results.filter((r) => !r.ok);
  if (bad.length) {
    console.log(`\n失败用例（${bad.length}）：`);
    for (const b of bad.slice(0, 12)) console.log(`  ${bar(false)} ${b.id.padEnd(16)} ${b.group.padEnd(9)} ${b.detail ?? ""}`);
  }
  console.log(report.pass ? (recallUntested ? "\n⚠ 其余门通过；recall 组未覆盖（不算全绿）" : "\n✅ 全部门通过") : "\n❌ 有门未通过");
  return report.pass && !recallUntested ? 0 : 1;
}

export const EVAL_TARGETS = GATES;
