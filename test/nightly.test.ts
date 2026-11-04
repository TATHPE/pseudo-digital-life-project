import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { appendEvent, newEventId } from "../src/journal.ts";
import { runNightly, parseCandidates } from "../src/nightly.ts";
import { createEmbedder } from "../src/embed.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-night-"));
const emb = createEmbedder("fake");

function seed(home: string, lines: string[], hour = 21) {
  const inbox = join(home, "inbox");
  lines.forEach((text, i) => appendEvent(inbox, {
    v: 1, id: newEventId(), ts: new Date(Date.UTC(2026, 9, 28, hour, i)).toISOString(),
    kind: i % 2 === 0 ? "utterance" : "agent_reply", actor: i % 2 === 0 ? "user" : "agent",
    payload: { text },
  }));
  return inbox;
}

const reply = (arr: unknown) => async () => "```json\n" + JSON.stringify(arr) + "\n```";

test("parseCandidates：容忍围栏/前后废话/单对象/脏字段", () => {
  assert.equal(parseCandidates("好的：\n```json\n[{\"text\":\"甲\",\"layer\":\"contract\"}]\n```").length, 1);
  assert.equal(parseCandidates('{"text":"乙"}').length, 1);
  assert.equal(parseCandidates("没有值得记的 []").length, 0);
  assert.equal(parseCandidates("乱码").length, 0);
  const c = parseCandidates('[{"text":"丙","salience":9,"layer":"x","subject":"主题很长很长很长很长很长"}]')[0]!;
  assert.equal(c.salience, 1, "salience 要夹到 [0,1]");
  assert.equal(c.layer, "narrative", "非法 layer 归叙事层");
  assert.ok(c.subject.length <= 16);
});

test("整夜：抽取 2 条 → 入 narrative；承诺进 contract", async () => {
  const home = H();
  const inbox = seed(home, ["我住在杭州", "记住了。"]);
  const d = openDb(join(home, "m.db"));
  const r = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: reply([
      { kind: "fact_hard", layer: "contract", subject: "居住地", text: "住在杭州", salience: 0.9, reason: "硬事实" },
      { kind: "episode", layer: "narrative", subject: "闲聊", text: "今天聊到杭州天气", salience: 0.2, reason: "日常" },
    ]),
    now: new Date("2026-10-28T23:00:00Z"),
  });
  assert.equal(r.scanned, 2);
  assert.equal(r.added, 2);
  const rows = d.db.prepare("SELECT layer,kind,subject,importance FROM memories ORDER BY id").all() as any[];
  assert.equal(rows[0].layer, "contract");
  assert.equal(rows[0].importance, 5, "契约层重要度拉满");
  assert.equal(rows[1].layer, "narrative");
  assert.equal(rows[1].subject, "闲聊");
});

test("幂等：游标推进后重跑不重复消化，也不重复写入", async () => {
  const home = H();
  const inbox = seed(home, ["我养了一只猫"]);
  const d = openDb(join(home, "m.db"));
  const deps = {
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: reply([{ kind: "episode", layer: "narrative", subject: "宠物", text: "养了一只猫", salience: 0.6 }]),
    now: new Date("2026-10-28T23:00:00Z"),
  };
  const a = await runNightly(deps);
  const b = await runNightly(deps);
  assert.equal(a.added, 1);
  assert.equal(b.scanned, 0, "游标之后没有新事件");
  assert.equal(b.added, 0);
  assert.equal((d.db.prepare("SELECT count(*) c FROM memories WHERE source_kind='extract'").get() as any).c, 1);
});

test("去重前先补向量：没有向量的旧记忆不能对去重隐形（2026-11-04）", async () => {
  const home = H();
  const inbox = seed(home, ["我住在杭州", "记住了。"]);
  const d = openDb(join(home, "m.db"));
  // 手工塞一条**没有向量**的旧记忆：模拟索引覆盖率不足时的历史数据
  d.db.prepare(`INSERT INTO memories(layer,kind,text,text_bigram,last_decay_at,created_at,updated_at)
    VALUES('narrative','episode','不要叫我助手，叫名字','不要 叫我','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z')`).run();

  let sawVector = false;
  const r = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: async () => {
      // 抽取**发生时**，那条旧记忆必须已经补上向量 —— 否则 findSameThing 扫不到它
      const row = d.db.prepare("SELECT embedding FROM memories WHERE text='不要叫我助手，叫名字'").get() as { embedding: unknown };
      sawVector = !!row.embedding;
      return "[]";
    },
    now: new Date("2026-10-28T23:00:00Z"),
  });
  assert.equal(sawVector, true, "去重之前必须先补向量");
  assert.ok(r.notes.some((n) => n.startsWith("VEC-BACKFILL:")), "补了多少要留痕：" + r.notes.join(" | "));
});

test("contract 同槽位：0.85–0.92 的新说法取代旧的，不是两份都留（2026-11-04）", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  // 受控向量：两种「不要叫助手」的说法，cos = 0.90（实测真值 0.930）
  const near = {
    name: "stub", dim: 2,
    async embed(texts: string[]) {
      return texts.map((t) => t.includes("叫我") ? new Float32Array([1, 0])
        : t.includes("叫他") ? new Float32Array([0.9, 0.43588989])
          : new Float32Array([0, 1]));
    },
  };
  const inbox = seed(home, ["以后不要叫我助手", "好。"]);
  const a = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: near as never,
    extract: reply([{ kind: "boundary", layer: "contract", subject: "称呼", text: "不要叫我助手，叫名字", salience: 0.9 }]),
    now: new Date("2026-10-28T22:00:00Z"),
  });
  assert.equal(a.added, 1);
  seed(home, ["别叫助手，叫名字", "记住了。"], 22);
  const b = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: near as never,
    extract: reply([{ kind: "boundary", layer: "contract", subject: "称呼", text: "不要叫他助手，直接叫名字", salience: 0.9 }]),
    now: new Date("2026-10-28T23:00:00Z"),
  });
  assert.equal(b.superseded, 1, JSON.stringify(b));
  const active = (d.db.prepare("SELECT count(*) c FROM memories WHERE status='active'").get() as any).c;
  assert.equal(active, 1, "同一个槽位只该留一条活的");
  const all = (d.db.prepare("SELECT count(*) c FROM memories").get() as any).c;
  assert.equal(all, 2, "旧的归档不删：历史要留");
});

test("冲突：同主题同文本 → NOOP（只抬 confidence）", async () => {  const home = H();
  const inbox = seed(home, ["我住在杭州"]);
  const d = openDb(join(home, "m.db"));
  const cand = [{ kind: "fact_hard", layer: "contract", subject: "居住地", text: "住在杭州", salience: 0.9 }];
  await runNightly({ db: d.db, inboxDir: inbox, home, embedder: emb, extract: reply(cand), now: new Date("2026-10-28T22:00:00Z") });
  // 又来一条同样的话
  seed(home, ["我还是住在杭州"], 22);
  const r = await runNightly({ db: d.db, inboxDir: inbox, home, embedder: emb, extract: reply(cand), now: new Date("2026-10-28T23:00:00Z") });
  assert.equal(r.noop, 1, JSON.stringify(r));
  assert.equal(r.added, 0);
  assert.equal((d.db.prepare("SELECT count(*) c FROM memories").get() as any).c, 1);
});

test("冲突：同主题不同说法且向量接近 → supersede（旧条归档 + 建边）", async () => {
  const home = H();
  const inbox = seed(home, ["我住在杭州"]);
  const d = openDb(join(home, "m.db"));
  await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb, now: new Date("2026-10-28T22:00:00Z"),
    extract: reply([{ kind: "fact_hard", layer: "contract", subject: "居住地", text: "住在杭州", salience: 0.9 }]),
  });
  seed(home, ["我搬到上海了"], 22);
  const r = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb, now: new Date("2026-10-28T23:00:00Z"),
    extract: reply([{ kind: "fact_hard", layer: "contract", subject: "居住地", text: "住在上海", salience: 0.9 }]),
    fuzzyThreshold: 0.0,   // 强制走"接近"分支（fake 向量无意义，这里只为测流程）
  });
  assert.equal(r.superseded, 1, JSON.stringify(r));
  const old = d.db.prepare("SELECT status,superseded_by FROM memories WHERE text='住在杭州'").get() as any;
  assert.equal(old.status, "archived");
  assert.ok(old.superseded_by);
  const link = d.db.prepare("SELECT rel FROM memory_links").get() as any;
  assert.equal(link.rel, "supersedes");
});

// 这条以前断言「失败也推进游标」，理由是“不然每晚卡在同一批”。
// 实测发现那是**数据丢失**：模型不支持 chat 时 38 条对话被一次跳过。
// 现在改为失败不推进 —— 没有循环、只有每天一次，重试是正确的；/health 会报 nightly-skipped。
test("抽取失败：不炸、留 note、游标**不**推进（丢了就找不回来）", async () => {
  const home = H();
  const inbox = seed(home, ["说了点什么"]);
  const d = openDb(join(home, "m.db"));
  const r = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: async () => { throw new Error("E_MODEL_DOWN"); },
    now: new Date("2026-10-28T23:00:00Z"),
  });
  assert.equal(r.added, 0);
  assert.ok(r.notes.some((n) => n.includes("E_EXTRACT")));
  assert.equal(r.cursorTo, null, "失败必须留在原地，下轮重试");
});

test("夜间也会衰减：老记忆权重要被重算", async () => {
  const home = H();
  const inbox = seed(home, ["一句"]);
  const d = openDb(join(home, "m.db"));
  d.db.prepare(`INSERT INTO memories(layer,kind,text,text_bigram,last_decay_at,created_at,updated_at,weight)
    VALUES('narrative','episode','很旧的事','很 旧 的 事','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z',0.9)`).run();
  const r = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: reply([]), now: new Date("2026-10-28T23:00:00Z"),
  });
  assert.ok(r.decayed >= 1);
  const w = (d.db.prepare("SELECT weight FROM memories WHERE text='很旧的事'").get() as any).weight;
  assert.ok(w < 0.35, "应跌出 active：" + w);
});

// ── 自传（01 §9.1）：没有引用就拒写，宁可留白 ────────────────────
import { writeAutobiography, extractCited, memoriesOfDay } from "../src/autobio.ts";
import { remember } from "../src/store.ts";

test("自传：模型编了一段没有引用的话 → 不采信，退化为摘录式（mode=digest）", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const id = remember(d.db, { layer: "narrative", kind: "episode", text: "你提到衰减公式", now: new Date() });
  const r = await writeAutobiography({
    db: d.db, home, now: new Date(), stateText: "今天一般",
    complete: async () => "今天我去了健身房，处理了几封邮件，晚上和朋友聚餐。MEMORY: -",
  });
  assert.ok(r.path, "仍应留一条记录（摘录式）");
  const txt = readFileSync(r.path!, "utf8");
  assert.match(txt, /MODE: digest/);
  assert.match(txt, /摘录/);
  assert.ok(!/健身房/.test(txt), "编造内容一点都不能进文件");
  assert.deepEqual(r.cited, [id]);
});

test("自传：有引用时写盘，并剥掉正文里的编号与回忆列表", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const id = remember(d.db, { layer: "narrative", kind: "episode", text: "你提到衰减公式", now: new Date() });
  const r = await writeAutobiography({
    db: d.db, home, now: new Date(), stateText: "今天一般",
    complete: async () => "今天你提了衰减公式，我想了很久。\n今天的记忆：\n- (1) 你提到衰减公式\nMEMORY: " + id,
  });
  assert.ok(r.path, "应写盘");
  const txt = readFileSync(r.path!, "utf8");
  assert.match(txt, /衰减公式/);
  assert.ok(!/今天的记忆：/.test(txt), "不该把记忆列表抄进自传");
  assert.match(txt, new RegExp("MEMORY: " + id));
  assert.deepEqual(r.cited, [id]);
});

test("extractCited：只保留当天存在的 id", () => {
  assert.deepEqual(extractCited("……MEMORY: 3, 7", [3, 5]), [3]);
  assert.deepEqual(extractCited("没有这一行", [1]), []);
  assert.deepEqual(extractCited("MEMORY: -", [1]), []);
});

test("memoriesOfDay：只取当天", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  remember(d.db, { layer: "narrative", kind: "episode", text: "今天的", now: new Date("2026-10-28T10:00:00") });
  remember(d.db, { layer: "narrative", kind: "episode", text: "昨天的", now: new Date("2026-10-27T10:00:00") });
  const got = memoriesOfDay(d.db, new Date("2026-10-28T23:00:00")).map((m) => m.text);
  assert.deepEqual(got, ["今天的"]);
});

// ── 人格变更的"理由链"（18 §4.4 / L3 判据）──────────────────────
import { savePersonaFile } from "../src/persona.ts";

test("保存人格：because 写进 versions 文件，将来能回答为什么变成这样", () => {
  const home = H();
  const r = savePersonaFile(home, "values", "# values" + String.fromCharCode(10) + "1. 不假装", new Date("2026-10-28T12:00:00Z"), "连续两周被说啰嗦，把简洁提前");
  const v = readFileSync(r.versionFile, "utf8");
  assert.match(v, /为什么改/);
  assert.match(v, /被说啰嗦/);
});

test("保存人格：没填理由也要留痕，不伪造", () => {
  const home = H();
  const r = savePersonaFile(home, "values", "# values", new Date("2026-10-28T12:00:00Z"));
  assert.match(readFileSync(r.versionFile, "utf8"), /未填写/);
});

// ── E-6：缺模型时降级，不许整体停摆 ──────────────────────────
test("E-6 缺模型：衰减照算、游标不动、/health 能看见 nightly-skipped", async () => {
  const home = H();
  const inbox = seed(home, ["我说了一件值得记的事", "嗯。"]);
  const d = openDb(join(home, "m.db"));

  const report = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: async () => { throw new Error("不该被调用"); },
    skipExtract: "缺本地模型：qwen2.5:7b-instruct",
    now: new Date(Date.UTC(2026, 9, 29, 3)),
  });

  assert.equal(report.scanned, 2, "扫到几件事要说清楚");
  assert.equal(report.added, 0, "没模型就不该写记忆");
  assert.equal(report.cursorTo, null, "游标必须不动，否则这轮对话永久丢了");
  assert.ok(report.notes.some((n) => n.startsWith("SKIPPED")));

  const skip = d.db.prepare("SELECT value FROM meta WHERE key='nightly_skipped'").get() as { value: string };
  assert.ok(skip?.value.includes("缺本地模型"), "skipped 要落进 meta，/health 才读得到");

  // 成功跑一轮（没有新事件）→ skipped 被清掉
  await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: async () => "[]",
    now: new Date(Date.UTC(2026, 9, 30, 3)),
  });
  const after = d.db.prepare("SELECT value FROM meta WHERE key='nightly_skipped'").get();
  assert.equal(after, undefined, "恢复后不能还挂着 degraded");
});

test("E-6 降级不能挡住 energy 恢复：advance({night:true}) 仍然有效", async () => {
  const { DEFAULTS, step } = await import("../src/state.ts");
  const tired = step({ ...DEFAULTS, energy: 0.1 }, { night: true, silenceDays: 1 });
  assert.ok(tired.energy > 0.3, "夜间必须回能，否则 ENERGY 只会一路滑到 0");
});

// ── P0-2：整条夜间链路接上工具循环（用假 chat，不需要模型）──────
test("P0-2 整轮：模型先查库再交 JSON，记忆真的落库（不需要真模型）", async () => {
  const home = H();
  const inbox = seed(home, ["提醒我晚上八点吃药", "好，记下了。"]);
  const d = openDb(join(home, "m.db"));
  const { makeToolExtractor } = await import("../src/nightagent.ts");
  const { createToolRegistry } = await import("../src/tools.ts");

  const asked: string[] = [];
  const registry = createToolRegistry({
    db: d.db,
    policy: { authorize: async () => ({ allow: true, reason: "test" }) } as never,
    ctx: { home, now: () => new Date(), db: d.db, embedder: emb },
    allow: (n) => n === "memory.search",
  });

  let round = 0;
  const chat = async function* () {
    if (round++ === 0) {
      yield { type: "tool_calls" as const, calls: [{ id: "c1", name: "memory_search", args: JSON.stringify({ query: "吃药" }) }] };
      yield { type: "done" as const, finish: "tool_calls" };
      return;
    }
    yield { type: "delta" as const, text: '[{"kind":"promise","layer":"contract","subject":"吃药","text":"提醒他晚上八点吃药","salience":0.9,"reason":"承诺"}]' };
    yield { type: "done" as const, finish: "stop" };
  };

  const report = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: makeToolExtractor({ chat: chat as never, tools: registry, onTool: (t) => asked.push(t.name) }),
    now: new Date(Date.UTC(2026, 9, 29, 3)),
  });

  assert.deepEqual(asked, ["memory_search"], "抽取前必须真的去查了一次已有记忆（trace 记的是模型看到的名字）");
  assert.equal(report.added, 1, "JSON 要真的落库");
  assert.ok(report.cursorTo, "成功跑完游标才推进");
  const row = d.db.prepare("SELECT layer, text FROM memories WHERE status='active'").get() as { layer: string; text: string };
  assert.equal(row.layer, "contract");
  assert.match(row.text, /吃药/);
});

test("P0-2 抽取失败时游标不推进（否则这批对话永久丢失）", async () => {
  const home = H();
  const inbox = seed(home, ["这句很重要", "嗯。"]);
  const d = openDb(join(home, "m.db"));
  const report = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: async () => { throw new Error("E_EXTRACT: 模型挂了"); },
    now: new Date(Date.UTC(2026, 9, 29, 3)),
  });
  assert.equal(report.cursorTo, null, "失败必须留在原地");
  const row = d.db.prepare("SELECT value FROM meta WHERE key='nightly_cursor_ts'").get();
  assert.equal(row, undefined, "游标不许落库");
  assert.ok(report.notes.some((n) => n.startsWith("E_EXTRACT")));
  // 失败也要让 /health 看得见
  const skip = d.db.prepare("SELECT value FROM meta WHERE key='nightly_skipped'").get() as { value: string } | undefined;
  assert.ok(skip?.value.includes("抽取失败"));
  // 重试成功后游标才推进
  const ok = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: async () => "[]",
    now: new Date(Date.UTC(2026, 9, 29, 4)),
  });
  assert.ok(ok.cursorTo, "成功才推进");
});

// ── P1-1a：噪声过滤 + 分段 + 少样本提示 ──────────────────────
test("P1-1a 噪声判定：短句/测试句/断电提示被剔，短但完整的句子保留", async () => {
  const { isNoise } = await import("../src/nightly.ts");
  assert.equal(isNoise("在。"), true);
  assert.equal(isNoise("行"), true);
  assert.equal(isNoise("用三个字回答：在吗"), true);
  assert.equal(isNoise("进程被杀 12 分钟，其间无经历"), true);
  // 关键反例：4–5 字的完整信息不能被误杀（6 字阈值实测会杀它）
  assert.equal(isNoise("我住在杭州"), false);
  assert.equal(isNoise("我妈下周三生日，记得提醒我买蛋糕"), false);
});

test("P1-1a 分段：88 条按 20 切成 5 段，且不丢不重", async () => {
  const { segmentEvents } = await import("../src/nightly.ts");
  const items = Array.from({ length: 88 }, (_, i) => i);
  const w = segmentEvents(items, 20);
  assert.equal(w.length, 5);
  assert.deepEqual(w.flat(), items);
});

test("P1-1a 整轮：噪声被跳过、真内容按窗口抽取、跨窗口去重", async () => {
  const home = H();
  const inbox = seed(home, [
    "在。",                                   // 噪声
    "用三个字回答：在吗",                       // 噪声
    "我妈下周三生日，记得提醒我买蛋糕",           // 真内容
    "记住了。",                                // 噪声
  ]);
  const d = openDb(join(home, "m.db"));
  let calls = 0;
  const report = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: async (prompt: string) => {
      calls++;
      // 断言：噪声行**不该**出现在给模型的 prompt 里
      assert.ok(!prompt.includes("用三个字回答"), "噪声行不能进 prompt");
      return '[{"kind":"promise","layer":"contract","subject":"生日","text":"下周三提醒买生日蛋糕","salience":0.9}]';
    },
    now: new Date(Date.UTC(2026, 9, 31, 3)),
  });
  assert.equal(calls, 1, "过滤后只剩 2 条可用事件 → 只问一次");
  assert.equal(report.added, 1);
  assert.ok(report.notes.some((n) => n.startsWith("NOISE:")));
  assert.ok(report.notes.some((n) => n.startsWith("WINDOW 1/1")));
});

test("P1-1a 原话阈值：0.30 的重合也要带上（0.34 会漏掉真实的边界记忆）", async () => {
  const { pickQuote } = await import("../src/nightly.ts");
  const ev = (text: string) => ({ v: 1, id: "e" + text.length, ts: new Date().toISOString(), kind: "utterance", actor: "user", payload: { text } });
  const events = [ev("以后别叫我「助手」，叫名字就行"), ev("今天天气不错，出去走了走")];
  const q = pickQuote(events as never, "不要叫他助手，直接叫名字");
  assert.equal(q, "以后别叫我「助手」，叫名字就行", "真实原话要能贴上，哪怕字面只重合三成");
});

test("isMetaFact：系统读数/此刻时间/文件名 都不算「关于人」的事实", async () => {
  const { isMetaFact } = await import("../src/nightly.ts");
  const bad = [
    "库里有 185 条记忆",
    "记忆库有185条记忆、1篇文档（7块）",
    "现在是2026年11月2日周一晚上23:44",
    "posture.ts是启动时设定默认姿态的模块，决定初始权限档",
    "对 memory.db 的写操作被护栏拒绝",
    "插件在 7700 端口上重启了一次",
    "红队 21 例全部拦住",
  ];
  const good = [
    "不要叫他助手，直接叫名字",
    "她妈妈下周三生日，要提前买蛋糕",
    "她对花生过敏，不能吃",
    "她住在杭州",
    "她不喜欢别人在早上给她打电话",
  ];
  for (const t of bad) assert.equal(isMetaFact(t), true, "应判为系统陈述：" + t);
  for (const t of good) assert.equal(isMetaFact(t), false, "不该误杀：" + t);
});

test("整夜：关于系统/此刻的候选不入库，关于人的照旧入（2026-11-04 闸门）", async () => {
  const home = H();
  const inbox = seed(home, ["我住在杭州", "记住了。"]);
  const d = openDb(join(home, "m.db"));
  const r = await runNightly({
    db: d.db, inboxDir: inbox, home, embedder: emb,
    extract: reply([
      { kind: "fact_hard", layer: "contract", subject: "居住地", text: "住在杭州", salience: 0.9, reason: "硬事实" },
      { kind: "fact_hard", layer: "contract", subject: "库", text: "库里有 185 条记忆", salience: 0.9, reason: "读数" },
      { kind: "boundary", layer: "contract", subject: "此刻", text: "现在是 2026 年 11 月 2 日 23:44", salience: 0.9, reason: "时间" },
      { kind: "fact_hard", layer: "contract", subject: "模块", text: "posture.ts 是设定默认姿态的模块", salience: 0.9, reason: "代码" },
    ]),
    now: new Date("2026-10-28T23:00:00Z"),
  });
  const texts = (d.db.prepare("SELECT text FROM memories ORDER BY id").all() as any[]).map((x) => x.text);
  assert.deepEqual(texts, ["住在杭州"], "只有关于人的那条该留下：" + texts.join(" / "));
  assert.equal(r.added, 1);
  assert.ok(r.notes.some((n) => n.startsWith("META:")), "跳过的条数要留痕：" + r.notes.join(" | "));
});
