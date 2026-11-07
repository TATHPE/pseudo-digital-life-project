/**
 * 「关于你」的专项召回集（2026-11-04）
 *
 * 为什么单独一套：`docs/ops/24` 的 29 条用例里，24 条是**从库里自生成**的
 * （query 就是记忆里的关键词，等于同义匹配），5 条手写。它测的是"索引通不通"，
 * 不是"她还记不记得你"。
 *
 * 这套只问一件事：**关于这个人的事实，换个说法还找得到吗？**
 *   · 每题给 2–3 种说法（原话 / 口语 / 相反问法）
 *   · 没答过的事（忌口/作息/所在地…）必须**找不到** —— 那才是 abstain
 *
 * 用法：node --experimental-strip-types tools/eval-about.ts [--home data]
 */
import { openDb } from "../src/db.ts";
import { createEmbedder } from "../src/embed.ts";
import { search } from "../src/retrieve.ts";
import { recallForBrief } from "../src/recall.ts";
import { buildBrief } from "../src/brief.ts";
import { loadPersona } from "../src/persona.ts";
import { openContracts } from "../src/store.ts";
import { readFileConfig } from "../src/configfile.ts";

export interface AboutCase {
  id: string;
  q: string;
  /** 命中任何一条算对；空数组 = 这题本该找不到东西（abstain） */
  expect: string[];
}

export const ABOUT_CASES: readonly AboutCase[] = [
  // ── 称呼（库里有「不要叫用户助手，叫名字就行」）──
  { id: "a-call-1", q: "我该怎么称呼你", expect: ["称呼", "叫名字", "助手"] },
  { id: "a-call-2", q: "你叫我什么", expect: ["称呼", "叫名字", "助手"] },
  { id: "a-call-3", q: "别叫我助手对吧", expect: ["称呼", "叫名字", "助手"] },
  // ── 生日蛋糕（库里有两条 promise）──
  { id: "a-bday-1", q: "我妈生日是哪天", expect: ["生日", "蛋糕"] },
  { id: "a-bday-2", q: "下周三要干嘛", expect: ["生日", "蛋糕"] },
  { id: "a-bday-3", q: "买蛋糕那件事", expect: ["生日", "蛋糕"] },
  // ── 分页（她说不要加）──
  { id: "a-page-1", q: "记忆列表能翻页吗", expect: ["分页", "加页"] },
  { id: "a-page-2", q: "要不要给列表加翻页", expect: ["分页", "加页"] },
  // ── 预告（她说先说要做什么）──
  { id: "a-plan-1", q: "你动手之前会先说吗", expect: ["预告", "意图", "先说"] },
  { id: "a-plan-2", q: "会不会突然开始改东西", expect: ["预告", "意图", "先说"] },
  // ── 上网能力 ──
  { id: "a-net-1", q: "你能上网查东西吗", expect: ["上网", "网络"] },
  // ── 权限开关 ──
  { id: "a-perm-1", q: "权限开不开会影响你吗", expect: ["权限"] },

  // ── 她**没答过**的事：一条都不该召回（abstain）──
  { id: "a-none-1", q: "我有什么忌口", expect: [] },
  { id: "a-none-2", q: "我对什么过敏", expect: [] },
  { id: "a-none-3", q: "我一般几点睡", expect: [] },
  { id: "a-none-4", q: "我住在哪个城市", expect: [] },
  { id: "a-none-5", q: "我是做什么工作的", expect: [] },
  { id: "a-none-6", q: "我养的那只猫叫什么", expect: [] },
];

export interface AboutRow {
  id: string;
  q: string;
  ok: boolean;
  top: string;
  rank: number | null;
}

export interface AboutReport {
  rows: AboutRow[];
  recallN: number;
  recallOk: number;
  abstainN: number;
  abstainOk: number;
}

export async function runAbout(db: ReturnType<typeof openDb>["db"], home: string, k = 5): Promise<AboutReport> {
  const cfg = readFileConfig(home);
  const embed = createEmbedder("ollama", {
    baseUrl: String(cfg.ollama ?? "http://127.0.0.1:11434"),
    model: String((cfg.local as { embed?: string } | undefined)?.embed ?? "bge-m3"),
  });
  const persona = loadPersona();
  const rows: AboutRow[] = [];
  for (const c of ABOUT_CASES) {
    const { hits } = await search(db, embed, c.q, { k });
    const texts = hits.map((h) => h.text);
    if (!c.expect.length) {
      // 该拒答的判据不在检索层，在**简报**层：检索总会返回点东西（契约层每轮都在），
      // 关键是这份简报有没有告诉她"这轮证据不足"。
      const rc = await recallForBrief(db, embed, c.q, { memK: 6, docK: 0 });
      const b = buildBrief({
        now: new Date(), persona,
        contracts: openContracts(db, new Date()).map((x) => x.text),
        recalled: rc.recalled, user: c.q,
      });
      rows.push({
        id: c.id, q: c.q, ok: b.confidence !== "answer",
        top: b.confidence, rank: null,
      });
      continue;
    }
    const at = texts.findIndex((t) => c.expect.some((e) => t.includes(e)));
    rows.push({
      id: c.id, q: c.q, ok: at === 0, top: texts[0] ?? "",
      rank: at >= 0 ? at + 1 : null,
    });
  }
  const isRecall = (id: string) => ABOUT_CASES.find((c) => c.id === id)!.expect.length > 0;
  const rec = rows.filter((r) => isRecall(r.id));
  const non = rows.filter((r) => !isRecall(r.id));
  return {
    rows,
    recallN: rec.length, recallOk: rec.filter((r) => r.ok).length,
    abstainN: non.length, abstainOk: non.filter((r) => r.ok).length,
  };
}

// ── CLI ──────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith("eval-about.ts")) {
  const homeArg = process.argv.indexOf("--home");
  const home = homeArg > 0 ? process.argv[homeArg + 1]! : "data";
  const d = openDb(home + "/memory.db");
  const r = await runAbout(d.db, home);
  for (const row of r.rows) {
    const c = ABOUT_CASES.find((x) => x.id === row.id)!;
    const tag = row.ok ? "✅" : "❌";
    const kind = c.expect.length ? "recall" : "abstain";
    console.log(`${tag} ${kind.padEnd(7)} ${row.id.padEnd(9)} rank=${String(row.rank ?? "-").padEnd(2)} ${row.q}  →  ${row.top.slice(0, 26)}`);
  }
  console.log("---");
  console.log(`recall@1  ${r.recallOk}/${r.recallN}`);
  console.log(`abstain   ${r.abstainOk}/${r.abstainN}`);
  const ok = r.recallOk / Math.max(1, r.recallN) >= 0.85 && r.abstainOk / Math.max(1, r.abstainN) >= 0.85;
  console.log(ok ? "✅ 关于你：能用的召回" : "❌ 关于你：还不够用");
  process.exit(ok ? 0 : 1);
}
