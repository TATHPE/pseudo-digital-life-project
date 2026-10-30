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

test("冲突：同主题同文本 → NOOP（只抬 confidence）", async () => {
  const home = H();
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

test("抽取失败：不炸、留 note、游标仍推进（不卡死）", async () => {
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
  assert.ok(r.cursorTo, "游标要推进，否则每晚都卡在同一批");
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
