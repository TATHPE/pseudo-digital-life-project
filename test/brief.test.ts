import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, timeLine } from "../src/brief.ts";
import { loadPersona } from "../src/persona.ts";
import type { BriefInput, MemoryLine } from "../src/types.ts";

const persona = loadPersona();
const NOW = new Date("2026-11-03T21:10:00");

const mkRecall = (n: number): MemoryLine[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `mem_${i}`, layer: "narrative", kind: "episode", stage: "active",
    weight: 0.7, text: "你提到 importance 影响衰减速率而不是初始权重",
  }));

const base = (over: Partial<BriefInput> = {}): BriefInput => ({
  now: NOW, persona, contracts: [], threads: [], recalled: [],
  user: "在吗", ...over,
});

test("不变量 1：P1–P4 逐字不变 → prefixHash 跨轮稳定", () => {
  const a = buildBrief(base());
  const b = buildBrief(base({ contracts: ["称呼「鲸鲸」"], recalled: mkRecall(5) }));
  assert.equal(a.prefixHash, b.prefixHash);
});

test("不变量 1b：人格变了 → prefixHash 必须变", () => {
  const a = buildBrief(base());
  const b = buildBrief(base({ persona: { ...persona, core: persona.core + "\n新增一句。" } }));
  assert.notEqual(a.prefixHash, b.prefixHash);
});

test("不变量 2：总量 ≤2000，且第 1 轮 ≤ 第 100 轮（不随轮数增长）", () => {
  const t1 = buildBrief(base());
  const t100 = buildBrief(base({
    lastSeenAt: new Date("2026-10-31T17:00:00"),
    contracts: Array.from({ length: 15 }, (_, i) => `契约 ${i}`),
    state: { energy: 0.62, closeness: 0.41, mood: "有点沉" },
    threads: ["a", "b", "c"],
    lastName: "停在「先写 decay.ts」上",
    delta: "你昨天提过论文太多",
    recalled: mkRecall(8),
  }));
  assert.ok(t1.tokens <= 2000, `turn1=${t1.tokens}`);
  assert.ok(t100.tokens <= 2000, `turn100=${t100.tokens}`);
  assert.ok(t1.tokens <= t100.tokens);
});

test("不变量 2b：超长输入被封顶（丢弃而不是溢出）", () => {
  const heavy = buildBrief(base({
    contracts: Array.from({ length: 60 }, (_, i) => `第 ${i} 条契约，内容写得很长很长很长很长很长很长`),
    recalled: Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`, layer: "narrative", kind: "episode", stage: "active",
      weight: 0.7, text: "很长的一段叙事".repeat(12),
    })),
    threads: ["1", "2", "3", "4", "5"],
  }));
  assert.ok(heavy.tokens <= 2000, `heavy=${heavy.tokens}`);
  assert.ok(heavy.dropped.recalled >= 40 - 8, `dropped=${heavy.dropped.recalled}`); // 上限 8 或预算先到
  assert.equal(heavy.dropped.threads, 2);            // 线头上限 3
});

test("不变量 3：槽位固定且有序（P1–P11 + 她自己的 P12/P13），空内容也占位", () => {
  const r = buildBrief(base());
  // P12「我惦记的」/ P13「我怎么理解你」是 H-a/H-b 加的两层；P14「可用技能」是 docs/11 的第二优先
  // 都在召回之后、用户输入之前；全都是易变槽（装了技能不该让 prefixHash 变）
  // P16「我能看到多少」：她自己的容量，同样放易变区
  assert.deepEqual(r.slots.map((s) => s.id),
    ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P12", "P13", "P14", "P15", "P16", "P17", "P11"]);
  assert.deepEqual(r.slots.filter((s) => s.stable).map((s) => s.id), ["P1", "P2", "P3", "P4"]);
});

test("confidence 四态（01 §6.2）", () => {
  assert.equal(buildBrief(base()).confidence, "abstain");
  assert.equal(buildBrief(base({ recalled: mkRecall(1) })).confidence, "need_evidence");
  assert.equal(buildBrief(base({ recalled: mkRecall(3) })).confidence, "answer");
});

test("时间措辞三态（18 §2.3）：断片 / 间隔 / 首次", () => {
  const outage = timeLine(base({
    outage: { from: new Date("2026-10-28T02:14:00"), to: new Date("2026-10-28T07:30:00"), kind: "power" },
  }));
  assert.match(outage, /断电/);
  assert.match(outage, /什么都不经历|什么都没经历/);

  const gap = timeLine(base({ lastSeenAt: new Date("2026-10-31T17:00:00") }));
  assert.match(gap, /距上次对话 3 天 4 小时/);

  const first = timeLine(base());
  assert.ok(!/距上次|断电/.test(first));
});

test("P14 技能索引：进了正文，但不改稳定前缀（装了技能不该动 prefixHash）", () => {
  const idx = "【可用的说明书】deploy（上线跑一遍）／note（写周报）。要看某一份的正文，用 skill_read。";
  const withSk = buildBrief({ ...base(), skills: idx });
  const without = buildBrief(base());
  assert.ok(withSk.text.includes("deploy（上线跑一遍）"), "索引要进正文，模型才知道有这份说明书");
  assert.ok(withSk.slots.some((x) => x.id === "P14"), "P14 槽要在（空内容也占位）");
  assert.equal(withSk.prefixHash, without.prefixHash, "prefixHash 只能由 P1–P4 决定");
  assert.ok(withSk.tokens > without.tokens, "多一句话，token 应该多一点");
});

test("没召回时把话说死：P10 里紧跟硬提示 + 把契约第一条再念一遍（她的第 3 条自检）", () => {
  // 为什么是机制不是叮嘱：她自己说「靠自律挡不住，因为它不像越权那样会立刻报错」。
  // 所以提示要出现在**她犯错的那个位置**（P10），不能只靠最前面那条契约。
  const none = buildBrief(base({ recalled: [] }));
  assert.ok(none.text.includes("这一轮没有与你问的这件事相关的记忆"), "空召回要有硬提示");
  assert.ok(none.text.includes("不要说「上次"), "要说清哪些话是高危");
  assert.ok(none.text.includes("上次你说过"), "点名那句最容易脱口而出的");
  assert.ok(none.text.includes("我觉得应该记得"), "把契约第一条再念一遍（用她自己的说法）");
  assert.equal(none.confidence, "abstain");

  // 只召回到契约条目 = 没有"关于这件事"的证据（她说搜「需要完善」回来只有契约条目）
  const onlyContract = buildBrief(base({
    recalled: [{ id: 1, text: "不确定就说不知道", score: 1, stage: "active", weight: 1, cite: "mem:1", relevance: 1, via: "active", layer: "contract" }],
  } as never));
  assert.ok(onlyContract.text.includes("这一轮没有与你问的这件事相关的记忆"), "只有契约条目也算没召回");
  assert.equal(onlyContract.confidence, "abstain");

  // 有真的叙事召回 → 一个字都不许念（否则每轮都在念经，她很快就学会无视）
  const yes = buildBrief(base({ recalled: mkRecall(3) }));
  assert.ok(!yes.text.includes("这一轮没有与你问的这件事相关的记忆"), "有召回就不该念");
  assert.equal(yes.confidence, "answer");
});

test("P16 我能看到多少：问「你能读多少记忆」时她应该直接答，而不是去查磁盘（实测踩过两次）", () => {
  const b = buildBrief(base({
    capacity: { memories: 162, docs: 1, chunks: 7, recallMax: 8, searchMax: 20 },
  }));
  assert.ok(b.text.includes("库里 162 条记忆"), "条数要在简报里");
  assert.ok(b.text.includes("1 篇文档（7 块）"), "文档/分块也要有");
  assert.ok(b.text.includes("每轮自动带进来的最多 8 条"), "召回上限");
  assert.ok(b.text.includes("主动搜一次最多 20 条"), "搜索上限");
  assert.ok(b.text.includes("不用去查磁盘或跑命令"), "要明说可以直接答");

  // 没传就不写这一槽（不编数字）
  const noCap = buildBrief(base({}));
  assert.ok(!noCap.text.includes("我这一轮能看到多少"), "没有数据就不要硬写");
});

test("不许编「你说过 / 你确认过」这条规矩要一直在", () => {
  // 实测：用户只问「你能读多少记忆」，她开口就是「已按你的确认执行：…」
  const b = buildBrief(base({ recalled: mkRecall(3) }));
  assert.ok(b.text.includes("已按你的确认执行"), "要点名那句最容易脱口而出的话");
  assert.ok(b.text.includes("先在对话里找到那句确认"), "给判据，不只是禁止");
});

test("P17 工具现状：插件挂了/待生效，她自己必须知道（别假装有那件工具）", () => {
  // 学自 Coopanion 的 onWorldLifecycle：「failed to start and is not running this time」
  const dead = buildBrief(base({
    plugins: { running: ["markitdown"], errors: ["firecrawl: connect ECONNREFUSED"], pending: false },
  }));
  assert.ok(dead.text.includes("【我的工具现状】"), "要有一块说工具现状");
  assert.ok(dead.text.includes("插件在跑：markitdown"), "在跑的要说");
  assert.ok(dead.text.includes("连不上"), "连不上的要说");
  assert.ok(dead.text.includes("别假装有"), "而且要明说这层后果");

  const pending = buildBrief(base({ plugins: { running: [], errors: [], pending: true } }));
  assert.ok(pending.text.includes("还没生效"), "改了没重启也要说");
  assert.ok(pending.text.includes("没有插件在跑"));

  // 没传就不写这一槽（不编）
  assert.ok(!buildBrief(base({})).text.includes("【我的工具现状】"));
});
