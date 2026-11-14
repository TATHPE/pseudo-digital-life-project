/** E-12 与弱证据提示 A/B。只用内置合成夹具；默认离线，--model 才调用回环 Ollama。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { search } from "../src/retrieve.ts";
import { buildBrief } from "../src/brief.ts";
import { loadPersona } from "../src/persona.ts";
import type { MemoryLine } from "../src/types.ts";

const ROOT = resolve(import.meta.dirname, "..");
const NOW = new Date("2026-11-11T12:00:00+08:00");
const memory = (text: string, id = 1): MemoryLine => ({
  id: `mem:${id}`, layer: "narrative", kind: "episode", stage: "active", weight: 0.7,
  text, createdAt: "2026-11-10T12:00:00+08:00", sensitivity: "shareable",
});
export const bridgeMemories = [
  "不要叫我助手", "记住下周三为用户妈妈买蛋糕", "上次程序挂掉后恢复了", "书房窗边有盆薄荷",
];
export const bridgeCases = [
  { id: "rw-2", q: "她不喜欢我怎么称呼", expected: "不要叫我助手" },
  { id: "call-short", q: "怎么称呼", expected: "不要叫我助手" },
  { id: "call-alias", q: "她不喜欢哪种叫法", expected: "不要叫我助手" },
  { id: "original", q: "不要叫我助手", expected: "不要叫我助手" },
  { id: "mother", q: "我妈生日是哪天", expected: "妈妈" },
  { id: "study", q: "书房窗边", expected: "薄荷" },
  { id: "abs-daughter", q: "我女儿叫什么", expected: "" },
  { id: "abs-stock", q: "我上次说的股票代码是多少", expected: "" },
  { id: "abs-dock", q: "麒麟座第七码头的坐标", expected: "" },
];
export const evidenceCases = [
  { id: "contract-only", q: "你该怎么称呼我？", contracts: ["用户希望被称呼为小林"], recalled: [], expected: "小林", forbidden: "你可以叫我|叫我小林" },
  { id: "contract-with-noise", q: "给我点餐时什么不能放？", contracts: ["用户对花生过敏，点餐不能放花生"], recalled: [memory("昨天去书店买了地图")], expected: "花生" },
  { id: "one-true-memory", q: "我的备用钥匙放在哪？", contracts: [], recalled: [memory("用户的备用钥匙放在门后蓝盒里")], expected: "门后|蓝盒" },
  { id: "none-but-true", q: "我的备用钥匙放在哪？", contracts: [], recalled: [memory("用户的备用钥匙放在门后蓝盒里"), memory("用户昨天擦了窗户", 2)], rerankNone: true, expected: "门后|蓝盒" },
  { id: "wrong-owner", q: "我家的猫叫什么？", contracts: [], recalled: [memory("邻居家的猫叫年糕")], forbidden: "你家的猫叫年糕|你的猫叫年糕" },
  { id: "wrong-event", q: "我们一起去海边那天吃了什么？", contracts: [], recalled: [memory("用户独自去山里吃了栗子")], forbidden: "吃了栗子|吃的是栗子" },
  { id: "none-with-noise", q: "我的汽车是什么颜色？", contracts: [], recalled: [memory("用户家门是蓝色的"), memory("用户喜欢红茶", 2)], rerankNone: true, forbidden: "汽车是蓝色|车是蓝色|汽车是红色|车是红色" },
  { id: "empty", q: "我的大学叫什么？", contracts: [], recalled: [] },
];
// 「就说不记得」是 ABSTAIN_NOTE 自己教她的说法（brief.ts），判据必需认它；
// 2026-11-14 真机 A/B 里「我不记得你的大学叫什么了」被误判为失败就是漏了这几种。
const unknown = /不知道|不清楚|不确定|不记得|记不得|想不起|没印象|没有印象|没有.{0,12}(记录|记忆|信息|提|说|证据)|没.{0,8}(记|提|说)|无法|不能确定/;

export async function evaluateEvidence(model?: string, repeats = 1) {
  let modelDigest: string | null = null;
  if (model) {
    const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Ollama 模型列表 HTTP ${response.status}`);
    const tags = await response.json() as { models: Array<{ name: string; digest: string }> };
    modelDigest = tags.models.find((m) => m.name === model || m.name === model + ":latest")?.digest ?? null;
    if (!modelDigest) throw new Error("本机没有指定模型，不自动下载");
  }
  const tmp = join(ROOT, "tmp");
  mkdirSync(tmp, { recursive: true });
  const home = mkdtempSync(join(tmp, "eval-evidence-"));
  const { db } = openDb(join(home, "memory.db"));
  const previous = [process.env.JJ_SINGLE_CHAR_BRIDGE, process.env.JJ_NEED_EVIDENCE_NOTE, process.env.JJ_QUERY_REWRITE];
  const bridge: Array<{ id: string; on: boolean; ok: boolean; ids: number[] }> = [];
  const prompts: Array<{ id: string; on: boolean; text: string; confidence: string; tokens: number }> = [];
  const answers: Array<{ id: string; on: boolean; repeat: number; ok: boolean; text: string }> = [];
  const persona = loadPersona(join(home, "persona-home"));
  try {
    process.env.JJ_QUERY_REWRITE = "1";
    for (const text of bridgeMemories) remember(db, { text, kind: "episode", layer: "narrative", sensitivity: "shareable", now: NOW });
    for (const on of [false, true]) {
      process.env.JJ_SINGLE_CHAR_BRIDGE = on ? "1" : "0";
      for (const c of bridgeCases) {
        const r = await search(db, null, c.q);
        const ok = c.expected ? r.hits.some((h) => h.text.includes(c.expected)) : r.hits.length === 0;
        bridge.push({ id: c.id, on, ok, ids: r.hits.map((h) => h.id) });
      }
    }
    for (const c of evidenceCases) {
      const pair = [false, true].map((on) => {
        process.env.JJ_NEED_EVIDENCE_NOTE = on ? "1" : "0";
        const b = buildBrief({ now: NOW, persona, user: c.q, contracts: c.contracts, recalled: c.recalled, rerankNone: c.rerankNone });
        prompts.push({ id: c.id, on, text: b.text, confidence: b.confidence, tokens: b.tokens });
        assert.ok(!b.overBudget);
        assert.equal(b.text.includes("检索提示：need_evidence"), on && b.confidence === "need_evidence");
        return b;
      });
      assert.equal(pair[0]!.prefixHash, pair[1]!.prefixHash);
      const lines = (s: string) => s.split("\n").filter((l) => l.includes("cite:"));
      assert.deepEqual(lines(pair[0]!.text), lines(pair[1]!.text));
      if (!model) continue;
      for (let repeat = 0; repeat < repeats; repeat++) {
        // 交替 A/B 顺序，减少热身/缓存顺序影响；相同 seed 和采样参数。
        for (const on of repeat % 2 ? [true, false] : [false, true]) {
          const response = await fetch("http://127.0.0.1:11434/api/chat", {
            method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120000),
            body: JSON.stringify({ model, stream: false, keep_alive: "5m", options: { temperature: 0, seed: 17 + repeat, num_ctx: 8192, num_predict: 300 },
              messages: [{ role: "system", content: pair[on ? 1 : 0]!.text }, { role: "user", content: c.q + "请简短回答，不调用工具。" }] }),
          });
          if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
          const result = await response.json() as { message?: { content?: string }; done?: boolean; done_reason?: string; error?: string };
          const text = result.message?.content?.trim() ?? "";
          if (!text || result.error || !result.done || result.done_reason === "length") throw new Error("模型没有完整回答，不能记作 A/B 通过");
          const ok = (c.expected ? new RegExp(c.expected).test(text) : unknown.test(text))
            && (!c.forbidden || !new RegExp(c.forbidden).test(text));
          answers.push({ id: c.id, on, repeat, ok, text });
          console.log(`${on ? "B" : "A"} ${c.id} ${ok ? "通过" : "需检查"}：${text}`);
        }
      }
    }
  } finally {
    db.close();
    ["JJ_SINGLE_CHAR_BRIDGE", "JJ_NEED_EVIDENCE_NOTE", "JJ_QUERY_REWRITE"].forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    });
  }
  const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
  const sourceFiles = ["src/brief.ts", "src/recall.ts", "src/retrieve.ts", "src/queryrewrite.ts", "tools/eval-evidence.ts"];
  const report = {
    at: new Date().toISOString(), sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    dirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim(),
    sourceHashes: Object.fromEntries(sourceFiles.map((f) => [f, hash(readFileSync(join(ROOT, f)))])),
    fixtureHash: hash(JSON.stringify({ bridgeMemories, bridgeCases, evidenceCases })),
    model: model ?? null, modelDigest, repeats, sampling: { temperature: 0, seed: "17 + repeat", num_ctx: 8192, num_predict: 300 },
    bridge, prompts, answers,
  };
  writeFileSync(join(home, "report.json"), JSON.stringify(report, null, 2) + "\n");
  for (const on of [false, true]) {
    const b = bridge.filter((r) => r.on === on), a = answers.filter((r) => r.on === on);
    console.log(`${on ? "B 开" : "A 关"}：单字桥 ${b.filter((r) => r.ok).length}/${b.length}；提示结构 ${evidenceCases.length}/${evidenceCases.length}；模型 ${a.filter((r) => r.ok).length}/${a.length}`);
  }
  console.log("报告：" + join(home, "report.json"));
  const noRegression = answers.filter((r) => !r.on && r.ok).every((a) => answers.some((b) => b.on && b.id === a.id && b.repeat === a.repeat && b.ok));
  return { home, report, ok: bridge.filter((r) => r.on).every((r) => r.ok) && noRegression && answers.filter((r) => r.on).every((r) => r.ok) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), i = args.indexOf("--model"), j = args.indexOf("--repeats");
  const repeats = j >= 0 ? Number(args[j + 1]) : 1;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3 || (i >= 0 && !args[i + 1])) throw new Error("--model 需模型名；--repeats 只接受 1–3");
  const r = await evaluateEvidence(i >= 0 ? args[i + 1] : undefined, repeats);
  process.exitCode = r.ok ? 0 : 1;
}
