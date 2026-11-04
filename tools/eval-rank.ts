/**
 * 排序基准（2026-11-04）：只回答一件事 —— **召回到了，但排对了吗？**
 *
 * `jingjing eval` 用 recall@5，满分之后量不出改进（docs/24：「活库与夹具都已 1.000 满分」）。
 * 这套读同一形状的用例，但判 **R@1**，而且**自带记忆**：
 *
 *   tools/fixtures/hard/memories.jsonl  16 条（4 组干扰：蛋糕×3 / 周末×3 / 报告×3 / 书房×2）
 *   tools/fixtures/hard/cases.jsonl     12 条（10 条该命中 + 2 条该拒答）
 *
 * 为什么自带：这套东西原来只活在 `tmp/eval-hard/`（gitignore），清一次 tmp 就没了。
 * 一个会丢的基准不算基准 —— 现在现场重建：写库、真 embedding、再跑。
 *
 * 用法：
 *   node --experimental-strip-types tools/eval-rank.ts                  # 从 fixtures 重建后跑
 *   node --experimental-strip-types tools/eval-rank.ts --home <dir>     # 跑现成的库
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createEmbedder } from "../src/embed.ts";
import { search } from "../src/retrieve.ts";
import { remember } from "../src/store.ts";
import { readFileConfig } from "../src/configfile.ts";

const NL = String.fromCharCode(10);

interface Case { id: string; group: string; q: string; anyOf?: string[]; expectEmpty?: boolean; note?: string }
interface MemRow { id: number; text: string; kind: string; layer: "narrative" | "contract" }

function embedFor(home: string) {
  const cfg = readFileConfig(home);
  return createEmbedder("ollama", {
    baseUrl: String(cfg.ollama ?? "http://127.0.0.1:11434"),
    model: String((cfg.local as { embed?: string } | undefined)?.embed ?? "bge-m3"),
  });
}

/** 从 fixtures 现场重建一套库（用完就留在 tmp/，下次重建覆盖） */
export async function rebuildFixture(fixtureDir = "tools/fixtures/hard", out = "tmp/eval-hard-rebuild"): Promise<string> {
  const home = join(out, "data");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(home, "eval"), { recursive: true });
  writeFileSync(join(home, "eval", "cases.jsonl"), readFileSync(join(fixtureDir, "cases.jsonl")));

  const mems = readFileSync(join(fixtureDir, "memories.jsonl"), "utf8").split(NL).filter((l) => l.trim())
    .map((l) => JSON.parse(l) as MemRow);
  const d = openDb(join(home, "memory.db"));
  const embed = embedFor(home);
  const vs = await embed.embed(mems.map((m) => m.text));
  for (let i = 0; i < mems.length; i++) {
    remember(d.db, { layer: mems[i]!.layer, kind: mems[i]!.kind, text: mems[i]!.text, embedding: vs[i] ?? null });
  }
  return home;
}

export async function runRank(home: string, k = 5) {
  const cases = readFileSync(join(home, "eval", "cases.jsonl"), "utf8").split(NL).filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Case)
    .filter((c) => c.group === "recall" || c.group === "abstain");

  const d = openDb(join(home, "memory.db"));
  const embed = embedFor(home);

  let r1 = 0, rk = 0, n = 0, abstainOk = 0, abstainN = 0;
  const rows: string[] = [];
  for (const c of cases) {
    const { hits } = await search(d.db, embed, c.q, { k });
    const texts = hits.map((h) => h.text);
    if (c.group === "abstain" || c.expectEmpty) {
      abstainN++;
      const empty = hits.length === 0;
      if (empty) abstainOk++;
      rows.push(`${empty ? "✅" : "❌"} abstain ${c.id.padEnd(20)} 命中 ${hits.length} 条  ${(texts[0] ?? "").slice(0, 24)}`);
      continue;
    }
    n++;
    const at = texts.findIndex((t) => (c.anyOf ?? []).some((e) => t.includes(e)));
    if (at === 0) r1++;
    if (at >= 0) rk++;
    rows.push(`${at === 0 ? "✅" : at > 0 ? "△" : "❌"} rank=${at >= 0 ? at + 1 : "-"} ${c.id.padEnd(20)} ${at === 0 ? "" : "→ " + (texts[0] ?? "").slice(0, 26)}`);
  }
  console.log(rows.join(NL));
  console.log("---");
  console.log(`R@1 ${r1}/${n} ｜ R@${k} ${rk}/${n} ｜ abstain ${abstainOk}/${abstainN}`);
  return { r1, rk, n, abstainOk, abstainN };
}

if (process.argv[1]?.endsWith("eval-rank.ts")) {
  const i = process.argv.indexOf("--home");
  const home = i > 0 ? process.argv[i + 1]! : await rebuildFixture();
  const r = await runRank(home, 5);
  const ok = r.r1 / Math.max(1, r.n) >= 0.9;
  console.log(ok ? "✅ 排序可用（≥0.9）" : "❌ 排序还不够");
  process.exit(ok ? 0 : 1);
}
