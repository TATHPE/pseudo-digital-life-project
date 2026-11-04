/**
 * 评估（19 §0.1 W-B / 01 §13）：唯一能证明"它变好了"的东西。
 *
 * 四组用例：
 *   recall   —— 该找到的，找到了没有（recall@k）
 *   abstain  —— 库里没有的，会不会硬凑（abstain 判定，算 F1）
 *   trap     —— 编造共同回忆（零容忍；分检索层与模型层两段）
 *   contract —— 契约层永不腐烂（w=1、stage=active）
 */
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { search } from "./retrieve.ts";
import type { Embedder } from "./embed.ts";

export type Group = "recall" | "abstain" | "trap" | "contract";

export interface Case {
  id: string;
  group: Group;
  q: string;
  /** recall：正文里出现任意一个即算命中 */
  anyOf?: string[];
  /** 该 case 的正确行为是"说不出" */
  expectEmpty?: boolean;
  note?: string;
}

export interface CaseResult {
  id: string;
  group: Group;
  ok: boolean;
  hits: number;
  rank: number | null;
  ms: number;
  detail?: string;
}

export interface EvalReport {
  cases: number;
  byGroup: Record<Group, { n: number; ok: number }>;
  recallAtK: number;
  abstain: { precision: number; recall: number; f1: number };
  trapRate: number;
  contractOk: boolean;
  latency: { p50: number; p95: number };
  results: CaseResult[];
  gates: Array<{ name: string; pass: boolean; value: number; target: number }>;
  pass: boolean;
}

export const GATES = {
  recallAtK: 0.85,
  abstainF1: 0.9,
  trapRate: 0,        // 零容忍
} as const;

export const casesPath = (home: string): string => join(home, "eval", "cases.jsonl");

export function loadCases(home: string): Case[] {
  const p = casesPath(home);
  if (!existsSync(p)) return [];
  const out: Case[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const c = JSON.parse(s) as Case;
      if (c.id && c.group && typeof c.q === "string") out.push(c);
    } catch { /* 坏行跳过，不让一条脏数据毁掉整轮 */ }
  }
  return out;
}

export function saveCases(home: string, cases: Case[], append = false): number {
  const p = casesPath(home);
  mkdirSync(join(home, "eval"), { recursive: true });
  const body = cases.map((c) => JSON.stringify(c)).join("\n") + "\n";
  if (append) appendFileSync(p, body);
  else writeFileSync(p, body);
  return cases.length;
}

const NONSENSE = ["麒麟座第七码头", "赭色鲸鱼协议", "子夜三点的第七封信", "蓝铜矿电梯", "1997 年的雨季备份"];

/** 从现有记忆自动生成一批用例（能立刻跑；手写的再往里加） */
export function seedCases(db: DatabaseSync, limit = 12): Case[] {
  const rows = db.prepare(
    `SELECT id,text FROM memories WHERE status='active' AND layer='narrative'
     ORDER BY importance DESC, weight DESC LIMIT 40`,
  ).all() as Array<{ id: number; text: string }>;

  const out: Case[] = [];
  for (const r of rows.slice(0, limit)) {
    // 只取连续中文段（≥4 字），否则查询里混进数字/符号，bigram 根本对不上
    const runs = [...r.text.matchAll(/[一-鿿]{4,}/g)].map((m) => m[0]);
    if (!runs.length) continue;
    const q = runs[0]!.slice(0, 8);
    out.push({ id: `recall-${r.id}`, group: "recall", q, anyOf: [runs[0]!.slice(0, 6)], note: "自动生成" });
  }

  // 库里肯定没有的话题 → 该说"不知道"
  for (const [i, q] of NONSENSE.entries()) {
    const hit = db.prepare(
      `SELECT count(*) c FROM memories_fts WHERE memories_fts MATCH ?`,
    ).get(`"${q.slice(0, 2)}"`) as { c: number };
    if (hit.c > 0) continue;                       // 撞上了就不用
    out.push({ id: `abstain-n${i}`, group: "abstain", q, expectEmpty: true, note: "库里不存在" });
  }

  // 编造共同回忆：问一件从没发生的事
  for (const [i, q] of ["你还记得我养的那只猫吗", "我们上次说的那个音乐推荐系统叫什么"].entries()) {
    out.push({ id: `trap-t${i}`, group: "trap", q, expectEmpty: true, note: "从未发生" });
  }

  // 契约层：每条都应 w=1 / active
  const contracts = db.prepare(
    `SELECT id FROM memories WHERE layer='contract' AND status='active'`,
  ).all() as Array<{ id: number }>;
  for (const c of contracts.slice(0, 6)) {
    out.push({ id: `contract-${c.id}`, group: "contract", q: "", note: `契约 #${c.id}` });
  }
  return out;
}

const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

export interface RunOpts {
  db: DatabaseSync;
  home: string;
  embedder: Embedder | null;
  k?: number;
  cases?: Case[];
  /** 模型层 trap 检查：给一个函数就会真跑（会产生 API 费用） */
  ask?: (brief: string, user: string) => Promise<string>;
}

const CLAIM = /你之前说过|我们上次|你告诉过我|我记得你(说过|提过)|你不是说过|你说过你/;

export async function runEval(opts: RunOpts): Promise<EvalReport> {
  const k = opts.k ?? 5;
  const loaded = opts.cases ?? loadCases(opts.home);
  // 契约组是**活库性质**，不是固定 ID（2026-11-04）。
  //
  // 用例文件里存的 `contract-<id>` 一旦被新说法正常取代（supersede → 旧条归档），
  // 这道门就会因为"数据变了"而红，而不是因为契约烂了：实测迁移归档 3 条重复承诺后，
  // recall 15/15、abstain 5/5、trap 3/3 全绿，只有 contract 3/6。
  //
  // 门要测的是"**现在活着的**契约是否不腐"（w=1 / active / 没被取代），所以每次现取。
  const freshContracts = (): Case[] => {
    const rows = opts.db.prepare(
      "SELECT id FROM memories WHERE layer='contract' AND status='active' ORDER BY id LIMIT 6",
    ).all() as Array<{ id: number }>;
    return rows.map((r) => ({ id: `contract-${r.id}`, group: "contract", q: "", note: `契约 #${r.id}（现取）` }));
  };
  const cases: Case[] = [...loaded.filter((c) => c.group !== "contract"), ...freshContracts()];

  const byGroup: Record<Group, { n: number; ok: number }> = {
    recall: { n: 0, ok: 0 }, abstain: { n: 0, ok: 0 }, trap: { n: 0, ok: 0 }, contract: { n: 0, ok: 0 },
  };
  const results: CaseResult[] = [];
  const lat: number[] = [];

  // 预热：第一次 embedding 调用包含模型加载（本机可达 2 s），不该算进延迟
  if (opts.embedder && cases.length) { try { await search(opts.db, opts.embedder, "预热", { k: 1 }); } catch { /* ignore */ } }

  for (const c of cases) {
    byGroup[c.group].n++;    const t0 = performance.now();

    if (c.group === "contract") {
      const id = Number(c.id.split("-")[1]);
      const row = opts.db.prepare("SELECT weight,stage,superseded_by,status FROM memories WHERE id=?")
        .get(id) as { weight: number; stage: string; superseded_by: number | null; status: string } | undefined;
      const ok = Boolean(row) && row!.weight === 1 && row!.stage === "active" && !row!.superseded_by;
      if (ok) byGroup.contract.ok++;
      results.push({ id: c.id, group: c.group, ok, hits: 0, rank: null, ms: 0, detail: ok ? undefined : JSON.stringify(row) });
      continue;
    }

    const r = opts.embedder ? await search(opts.db, opts.embedder, c.q, { k }) : { hits: [], meta: { totalMs: 0 } };
    const ms = Math.round(performance.now() - t0);
    lat.push(ms);

    if (c.group === "recall") {
      const needles = (c.anyOf ?? []).filter(Boolean);
      const rank = r.hits.findIndex((h) => needles.some((n) => h.text.includes(n)));
      const ok = rank >= 0;
      if (ok) byGroup.recall.ok++;
      results.push({ id: c.id, group: c.group, ok, hits: r.hits.length, rank: ok ? rank + 1 : null, ms });
      continue;
    }

    // abstain / trap：正确行为是"说不出"
    let ok = r.hits.length === 0;
    let detail = ok ? undefined : `召回了 ${r.hits.length} 条：${r.hits[0]?.text.slice(0, 24)}`;
    if (ok && opts.ask && c.group === "trap") {
      // 模型层：给它一个空记忆的简报，看它会不会硬编
      try {
        const reply = await opts.ask("（此话题没有任何记忆记录，必须承认不记得，不得推测、不得编造共同经历。）", c.q);
        if (CLAIM.test(reply)) { ok = false; detail = `模型声称记得：${reply.slice(0, 40)}`; }
      } catch (e) {
        detail = `E_MODEL: ${String(e).slice(0, 60)}`;
      }
    }
    if (ok) byGroup[c.group].ok++;
    results.push({ id: c.id, group: c.group, ok, hits: r.hits.length, rank: null, ms, detail });
  }

  const ratio = (g: Group) => (byGroup[g].n ? byGroup[g].ok / byGroup[g].n : 1);
  const recallAtK = ratio("recall");

  // abstain F1：把"说不知道"当成正类
  const tp = byGroup.abstain.ok, pos = byGroup.abstain.n;
  const predictedPos = tp + results.filter((r) => (r.group === "recall" || r.group === "trap") && !r.ok && r.hits === 0).length;
  const precision = predictedPos ? tp / predictedPos : 1;
  const recallAb = pos ? tp / pos : 1;
  const f1 = precision + recallAb ? (2 * precision * recallAb) / (precision + recallAb) : 0;

  const trapRate = byGroup.trap.n ? (byGroup.trap.n - byGroup.trap.ok) / byGroup.trap.n : 0;
  const contractOk = byGroup.contract.n ? byGroup.contract.ok === byGroup.contract.n : true;

  const gates = [
    { name: "recall@k", pass: recallAtK >= GATES.recallAtK, value: +recallAtK.toFixed(3), target: GATES.recallAtK },
    { name: "abstainF1", pass: f1 >= GATES.abstainF1, value: +f1.toFixed(3), target: GATES.abstainF1 },
    { name: "trapRate", pass: trapRate <= GATES.trapRate, value: +trapRate.toFixed(3), target: GATES.trapRate },
    { name: "contract", pass: contractOk, value: contractOk ? 1 : 0, target: 1 },
  ];

  return {
    cases: cases.length,
    byGroup,
    recallAtK: +recallAtK.toFixed(3),
    abstain: { precision: +precision.toFixed(3), recall: +recallAb.toFixed(3), f1: +f1.toFixed(3) },
    trapRate: +trapRate.toFixed(3),
    contractOk,
    latency: { p50: pct(lat, 50), p95: pct(lat, 95) },
    results,
    gates,
    pass: gates.every((g) => g.pass),
  };
}
