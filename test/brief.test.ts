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
  const b = buildBrief(base({ persona: { ...persona, core: persona.core + "\n新增一句。" } }));  assert.notEqual(a.prefixHash, b.prefixHash);
});

// 这两条是「夹具刚好没超」的历史断言，守的是不随轮数增长这一半；
// 「总量 ≤ budget.total」真正由下面 2026-11-09 的两条用例守（会构造真超预算的输入）。
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
  // P12「我惦记的」/ P13「我怎么理解你」是 H-a/H-b 加的两层；P14「可用技能」是 docs/runtime/11 的第二优先
  // 都在召回之后、用户输入之前；全都是易变槽（装了技能不该让 prefixHash 变）
  // P16「我能看到多少」：她自己的容量，同样放易变区
  // P19「我还不知道的」：记忆缺口，一天最多一次（2026-11-04）
  // P20「怎么说」：正文只放结论，过程别混进来（2026-11-05，稳定槽）
  assert.deepEqual(r.slots.map((s) => s.id),
    ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P12", "P13", "P14", "P15", "P16", "P17", "P18", "P19", "P20", "P11"]);
  assert.deepEqual(r.slots.filter((s) => s.stable).map((s) => s.id), ["P1", "P2", "P3", "P4", "P20"]);
});

test("confidence 四态（01 §6.2）", () => {
  assert.equal(buildBrief(base()).confidence, "abstain");
  assert.equal(buildBrief(base({ recalled: mkRecall(1) })).confidence, "need_evidence");
  assert.equal(buildBrief(base({ recalled: mkRecall(3) })).confidence, "answer");
});

test("弱证据 A/B：只动 P10 提示，真记忆、契约与稳定前缀不变", (t) => {
  const old = process.env.JJ_NEED_EVIDENCE_NOTE;
  t.after(() => { if (old === undefined) delete process.env.JJ_NEED_EVIDENCE_NOTE; else process.env.JJ_NEED_EVIDENCE_NOTE = old; });
  const input = base({ contracts: ["称呼小林"], recalled: mkRecall(1) });
  process.env.JJ_NEED_EVIDENCE_NOTE = "0";
  const off = buildBrief(input);
  process.env.JJ_NEED_EVIDENCE_NOTE = "1";
  const on = buildBrief(input);
  assert.ok(!off.text.includes("检索提示：need_evidence"));
  assert.ok(on.text.includes("检索提示：need_evidence"));
  assert.ok(on.text.includes("不等于没有记录"));
  assert.ok(on.text.includes("契约里写着的也照答"));
  assert.ok(on.text.includes("称呼小林"));
  assert.equal(on.prefixHash, off.prefixHash);
  assert.equal(on.confidence, off.confidence);
  const lines = (s: string) => s.split("\n").filter((l) => l.includes("cite:"));
  assert.deepEqual(lines(on.text), lines(off.text));
  assert.ok(!on.overBudget);
});

test("弱证据：重排 NONE 进提示；answer 与真空召回不额外念提示", () => {
  const input = base({ recalled: mkRecall(3) });
  assert.ok(!buildBrief(input).text.includes("检索提示：need_evidence"));
  const none = buildBrief({ ...input, rerankNone: true });
  assert.equal(none.confidence, "need_evidence");
  assert.ok(none.text.includes("检索提示：need_evidence"));
  assert.ok(!buildBrief(base()).text.includes("检索提示：need_evidence"));
});

test("弱证据：置信度只看预算内证据；零召回不因 P6 有契约就升级（2026-11-14 收紧）", () => {
  const cut = buildBrief(base({ recalled: mkRecall(3), budget: { recalled: 0 } }));
  assert.equal(cut.confidence, "abstain");
  assert.ok(cut.text.includes("这一轮没有与你问的这件事相关的记忆"));
  // P6 契约层每轮都在，它不能替本轮「什么都没召回」背书。收紧后走硬拒答，
  // 但契约里写着的称呼仍要照答（11-04 修复不回退）。
  const p6 = buildBrief(base({ contracts: ["称呼小林"], recalled: [] }));
  assert.equal(p6.confidence, "abstain");
  assert.ok(p6.text.includes("这一轮没有与你问的这件事相关的记忆"));
  assert.ok(p6.text.includes("契约层 P6 里明确写着的"), "仍允许照答契约里的称呼");
  assert.ok(!p6.text.includes("契约里写着的，就照着答"), "不该叠加 CONTRACT_ONLY_NOTE");
  assert.ok(!p6.text.includes("检索提示：need_evidence"), "零召回不注入弱证据提示");
  // 防回退：旧版会把 CONTRACT_ONLY_NOTE + evidenceNote 一起塞进 P10（+217 token）。
  const bare = buildBrief(base());
  assert.ok(p6.tokens - bare.tokens < 120, `零召回不该因契约多塞两段提示（+${p6.tokens - bare.tokens}）`);
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

  // 只召回到契约条目（2026-11-04 改）：以前这里念的是「没有相关记忆」——
  // 那是假话。她的称呼/生日/边界全在 P6，而 P6 每轮都在。
  // 实测「我该叫你什么」被这句打成"没证据"，正好压在她最该答得上的问题上。
  const onlyContract = buildBrief(base({
    recalled: [{ id: 1, text: "不确定就说不知道", score: 1, stage: "active", weight: 1, cite: "mem:1", relevance: 1, via: "active", layer: "contract" }],
  } as never));
  assert.ok(onlyContract.text.includes("只有契约层"), "要说清楚证据在哪一层");
  assert.ok(onlyContract.text.includes("契约里写着的，就照着答"), "契约里有的不许装不知道");
  assert.ok(!onlyContract.text.includes("这一轮没有与你问的这件事相关的记忆"), "别再说假话");
  assert.equal(onlyContract.confidence, "need_evidence", "不是没证据，是证据不在叙事层");

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

test("两档都带最近几轮：聊天窄而近，工作宽而远（2026-11-06 改）", () => {
  // 以前聊天模式故意不带历史 —— 结果连「刚才那条」都接不住，那不叫聊天。
  const hist = [
    { role: "user" as const, text: "先把 docs/ops/24 的数字对一遍" },
    { role: "agent" as const, text: "对好了，recall 1.000，abstainF1 1.000。" },
    { role: "user" as const, text: "那第二条呢" },
  ];
  const chat = buildBrief(base({ mode: "chat", history: hist }));
  assert.ok(chat.text.includes("【最近几轮】"), "聊天模式也要带历史");
  assert.ok(chat.text.includes("那第二条呢"), "最近一条必须在");

  const work = buildBrief(base({ mode: "work", history: hist }));
  assert.ok(work.text.includes("【最近几轮】"), "工作模式要带");
  assert.ok(work.text.includes("你：") && work.text.includes("我："), "用户与她的话都要能区分");
  // 预算差在「记得多少轮」上：给一长串历史，工作模式留得更多
  const many = Array.from({ length: 30 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "agent") as "user" | "agent",
    text: `第 ${i + 1} 句：这句话有点长度，用来占预算。`,
  }));
  const chatMany = buildBrief(base({ mode: "chat", history: many }));
  const workMany = buildBrief(base({ mode: "work", history: many }));
  const countTurns = (t: string) => (t.match(/你：|我：/g) ?? []).length;
  assert.ok(countTurns(workMany.text) > countTurns(chatMany.text),
    `工作模式该留更多轮：work=${countTurns(workMany.text)} chat=${countTurns(chatMany.text)}`);

  // 聊天模式的预算要装得下它那几轮（以前 2000，加了历史会溢出）
  assert.ok(chat.tokens <= 2600, `chat=${chat.tokens}`);
});


test("P19 我还不知道的：有缺口才出现，且明说「没聊到别硬问」（2026-11-04）", () => {
  const none = buildBrief(base());
  assert.ok(!none.text.includes("【我还不知道的】"), "没缺口时不能凭空问");

  const ask = buildBrief(base({ gapAsk: "你一般几点之后不想被打扰？" }));
  assert.ok(ask.text.includes("【我还不知道的】"));
  assert.ok(ask.text.includes("几点之后不想被打扰"));
  assert.ok(ask.text.includes("没聊到别硬问"), "要压住查户口感");
  assert.ok(ask.tokens <= 2000, "加了这一槽也不能破预算");
});

/** 一大堆易变槽都塞满，用来把总预算真的顶到上限（不是靠夹具刚好没超） */
const fatVolatile: Partial<BriefInput> = {
  history: Array.from({ length: 30 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "agent") as "user" | "agent",
    text: `第 ${i + 1} 句：这句话有点长度，用来占预算，也用来验证最近几轮会被优先让位。`,
  })),
  skills: "【可用的说明书】deploy（上线跑一遍）／note（写周报）／abc／def。要看正文用 skill_read。",
  powers: "完全权限窗口：可以跑命令，但记忆核心与回收站仍拒",
  plugins: { running: ["markitdown"], errors: ["firecrawl: connect ECONNREFUSED"], pending: true },
  gapAsk: "你一般几点之后不想被打扰？",
  capacity: { memories: 162, docs: 1, chunks: 7, recallMax: 8, searchMax: 20 },
  agenda: ["先把 docs/ops/24 的数字对一遍", "看看夜间整理的游标"],
  interpretations: ["她对数字很敏感", "她不喜欢被追问"],
  delta: "你昨天提过论文太多，今天想先看代码",
  lastName: "停在「先写 decay.ts」上",
  state: { energy: 0.62, closeness: 0.41, mood: "有点沉" },
  threads: ["1", "2", "3", "4", "5"],
};

test("总预算 2026-11-09：收紧到 1300 时逐槽让位，必留内容一个不丢", () => {
  const plain = buildBrief(base());
  const tight = buildBrief(base({ budget: { total: 1300 }, ...fatVolatile }));
  assert.ok(tight.tokens <= 1300, `tight=${tight.tokens}`);
  assert.ok(tight.dropped.slots.length > 0, "必须真的丢掉一些易变槽，而不是假装达标");
  assert.equal(tight.overBudget, false);
  assert.equal(tight.prefixHash, plain.prefixHash, "P1–P4 稳定前缀不许动");
  assert.ok(tight.text.includes("在吗"), "P11 用户输入不许动");
  assert.ok(tight.text.includes("已按你的确认执行"), "NO_FAKE_ACK 硬规矩不许动");
  assert.ok(tight.text.includes("这一轮没有与你问的这件事相关的记忆"), "P10 反编造硬提示不许动");
  assert.ok(tight.text.includes("【现在】"), "P5 时刻不许动（相对日期推理靠它）");
});

test("总预算 2026-11-09：聊天档 2600 / 工作档 5200 各自收口，再收紧就继续让位", () => {
  const chat = buildBrief(base({ mode: "chat", ...fatVolatile }));
  const work = buildBrief(base({ mode: "work", ...fatVolatile }));
  assert.ok(chat.tokens <= 2600, `chat=${chat.tokens}`);
  assert.ok(work.tokens <= 5200, `work=${work.tokens}`);
  assert.equal(chat.overBudget, false);
  assert.equal(work.overBudget, false);

  // 同一个肥输入，把聊天档 total 硬压到 1100：应该丢更多槽，且不假装达标
  const capped = buildBrief(base({ mode: "chat", budget: { total: 1100 }, ...fatVolatile }));
  assert.ok(capped.tokens <= 1100, `capped=${capped.tokens}`);
  assert.ok(capped.dropped.slots.length > chat.dropped.slots.length,
    `预算更紧就该丢更多槽：capped=${capped.dropped.slots.length} chat=${chat.dropped.slots.length}`);
  assert.ok(capped.text.includes("在吗"), "再紧也不能把用户输入丢了");
});

test("P4 的工具清单来自能力表：真实名字都在，过时的四个不许再出现（2026-11-06）", async () => {
  const { loadPersona } = await import("../src/persona.ts");
  const p = loadPersona("data");
  const t = String(p.toolSchemas);
  // 真实存在的（下划线形式）
  for (const real of ["memory_search(T0)", "fs_read(T0)", "shell_run(T3)", "memory_remember(T1)"]) {
    assert.ok(t.includes(real), "清单缺 " + real);
  }
  // 以前手写的那几个：能力表里没有，不许再冒出来
  for (const ghost of ["cite(", "act(", "net.fetch", "calendar.add", "doc.tables"]) {
    assert.ok(!t.includes(ghost), "过时的工具名还在：" + ghost);
  }
});

test("P10 带上「多久以前」：权重不是时间（2026-11-09）", () => {
  const day = 86400000;
  const mk = (createdAt?: string): MemoryLine[] => [{
    id: "mem:1", layer: "contract", kind: "promise", stage: "active",
    weight: 1, text: "交班前把值班表拍照发到群里", ...(createdAt ? { createdAt } : {}),
  }];
  const threeDaysAgo = new Date(NOW.getTime() - 3 * day).toISOString();
  const lines = (l: MemoryLine[]) => buildBrief(base({ recalled: l })).text
    .split(String.fromCharCode(10)).filter((x) => x.includes("cite:"));

  const one = (l: MemoryLine[]) => lines(l)[0] ?? "";
  assert.ok(one(mk(threeDaysAgo)).includes("3 天前"), one(mk(threeDaysAgo)));
  assert.ok(one(mk(NOW.toISOString())).includes("今天"), one(mk(NOW.toISOString())));
  // 45 天前 → 粗到「1 个月前」：太精确反而像在假装记得清楚
  const old = new Date(NOW.getTime() - 45 * day).toISOString();
  assert.ok(one(mk(old)).includes("1 个月前"), one(mk(old)));
  // 没有 created_at 的旧数据不许多出一个空标签
  assert.ok(!one(mk()).includes("·  ·"), "不许渲染空的时间段");
  assert.ok(!/\d+ 天前|今天|个月前/.test(lines(mk())[0]!), "没有时间就不写");
});

// 追加式状态快照（2026-11-14，学自 dsh-world 的 mood 快照）
test("P7 变化行只追加不替换，稳定前缀逐字不变", () => {
  const state = { energy: 0.7, closeness: 0.3 };
  const plain = buildBrief(base({ state }));
  const note = "【状态变化】energy 0.700 → 0.680（以最新一条为准，之前那条不再算数）";
  const withNote = buildBrief(base({ state, stateNote: note }));
  assert.equal(withNote.prefixHash, plain.prefixHash, "P1–P4 稳定前缀不许动");
  assert.ok(!plain.text.includes("【状态变化】"), "没变化就不该有快照行");
  assert.ok(withNote.text.includes(note), "变化行要真的进正文");
  assert.ok(withNote.text.includes("【状态】energy 0.70"), "当前值还在：追加不是替换");
  assert.ok(withNote.tokens >= plain.tokens);
});

// coverage: partial（2026-11-14，学自 dsh-world）：没读到的来源 ≠ 事情没发生过
test("P10 检索不完整提示：只在有缺口时出现，稳定前缀不变", () => {
  const plain = buildBrief(base());
  const partial = buildBrief(base({ retrievalIncomplete: ["向量检索不可用（缺 embedder，本轮只有字面检索）"] }));
  assert.equal(partial.prefixHash, plain.prefixHash, "P1–P4 稳定前缀不许动");
  assert.ok(!plain.text.includes("检索不完整"), "完整检索时不该多这句");
  assert.ok(partial.text.includes("检索不完整"));
  assert.ok(partial.text.includes("零命中不等于没发生过"));
  assert.ok(partial.tokens > plain.tokens);
});
