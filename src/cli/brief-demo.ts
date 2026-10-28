/**
 * M1 第一个可执行产物：渲染第 1 轮与第 100 轮的简报，打印槽位与 token 预算。
 * 用法：node src/cli/brief-demo.ts [--full]
 */
import { buildBrief } from "../brief.ts";
import { loadPersona } from "../persona.ts";
import type { BriefInput, MemoryLine } from "../types.ts";

const persona = loadPersona();
const full = process.argv.includes("--full");

const contracts = [
  "称呼「鲸鲸」", "工作时段 9:00–18:30 不主动打扰", "不确定就说不确定",
  "住在杭州（10-02）", "不用 Postgres（10-14 取代 09-28 那条）",
  "开发在 Windows + 3070", "讨厌客套，喜欢先给结论",
];

const recalled: MemoryLine[] = Array.from({ length: 8 }, (_, i) => ({
  id: `mem_01H8${(i + 1).toString().padStart(4, "0")}`,
  layer: "narrative" as const,
  kind: "episode",
  stage: "active" as const,
  weight: 0.72 - i * 0.03,
  text: "你提到 importance 应该影响衰减速率，而不是初始权重",
  sensitivity: "local_only" as const,
}));

const turn1: BriefInput = {
  now: new Date("2026-10-27T18:40:00"),
  lastSeenAt: null,
  persona, contracts: [], threads: [], recalled: [],
  user: "你还记得我上次说的那个衰减公式吗？",
};

const turn100: BriefInput = {
  now: new Date("2026-11-03T21:10:00"),
  lastSeenAt: new Date("2026-10-31T17:00:00"),
  persona, contracts,
  state: { energy: 0.62, closeness: 0.41, mood: "有点沉" },
  lastName: "停在「先写 decay.ts」上，没动手。",
  threads: ["论文还剩 15 篇没读", "断电方案待验收"],
  delta: "你昨天提过一次「论文太多来不及读」。",
  recalled,
  user: "你还记得我上次说的那个衰减公式吗？",
};

for (const [name, input] of [["第 1 轮", turn1], ["第 100 轮", turn100]] as const) {
  const r = buildBrief(input);
  console.log(`\n===== ${name} =====`);
  for (const s of r.slots) {
    console.log(`  ${s.id.padEnd(4)} ${s.label.padEnd(6)} ${String(s.tokens).padStart(5)} tok${s.stable ? "  [稳定前缀]" : ""}`);
  }
  console.log(`  ${"合计".padEnd(10)} ${String(r.tokens).padStart(5)} tok` +
    `  | prefix=${r.prefixHash} | confidence=${r.confidence}`);
  console.log(`  丢弃: 召回 ${r.dropped.recalled} / 契约 ${r.dropped.contracts} / 线头 ${r.dropped.threads}`);
  if (full) console.log("\n" + r.text + "\n");
}
