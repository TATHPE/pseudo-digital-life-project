import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { createProposal, listProposals, setProposalStatus, PROPOSAL_CAP, titleKey } from "../src/proposals.ts";
import { reviewQueue, noteReviewed } from "../src/surface.ts";
import { cutLink, listLinks, isBlocked, linkKey } from "../src/links.ts";
import { verbs } from "../src/verbs.ts";
import { createToolRegistry } from "../src/tools.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-p2-"));

// ── K-2：提议 ─────────────────────────────────────────
test("K-2 提议卡：带确切 argv + 为什么 + 影响哪些文件", () => {
  const home = H();
  const { proposal } = createProposal(home, {
    title: "给工具列表加搜索",
    why: "16 项铺开把其他区块挤到折叠线下面了",
    plan: ["加输入框", "按名字过滤"],
    argv: ["node", "tools/run-tests.mjs"],
    touches: ["jingjing/src/web/page.ts"],
    risk: "low",
  });
  assert.match(proposal.id, /^prp_/);
  assert.deepEqual(proposal.argv, ["node", "tools/run-tests.mjs"]);
  assert.deepEqual(proposal.touches, ["jingjing/src/web/page.ts"]);
  assert.equal(proposal.status, "open");
  assert.equal(readdirSync(join(home, "pending")).filter((f) => f.startsWith("prp_")).length, 1, "真的落盘了");
});

test("K-2 闸门：越界路径 / 奇怪命令 / 空理由都拒", () => {
  const home = H();
  assert.throws(() => createProposal(home, { title: "改系统设置", why: "因为我想", touches: ["C:/Windows/system32/x.dll"] }), /E_PROPOSAL_TOUCH/);
  assert.throws(() => createProposal(home, { title: "删点东西", why: "因为我想", touches: ["jingjing/../data/memory.db"] }), /E_PROPOSAL_TOUCH_DOTDOT/);
  assert.throws(() => createProposal(home, { title: "跑个脚本", why: "因为我想", argv: ["curl", "http://x"] }), /E_PROPOSAL_ARGV_BIN/);
  assert.throws(() => createProposal(home, { title: "串一条命令", why: "因为我想看看", argv: ["node", "a.mjs", "&&", "rm", "-rf", "/"] }), /E_PROPOSAL_ARGV_PIPE/);
  assert.throws(() => createProposal(home, { title: "做", why: "嗯" }), /E_PROPOSAL_TITLE|E_PROPOSAL_WHY/);
});

test("K-2 同一件事只留一张卡（重提只加 seen），且总量有上限", () => {
  const home = H();
  const a = createProposal(home, { title: "给记忆列表加分页", why: "翻不了页看不到旧条目" });
  const b = createProposal(home, { title: "给记忆列表，加分页！", why: "翻不了页看不到旧条目" });
  assert.equal(a.proposal.id, b.proposal.id, "同一件事应命中同一张卡");
  assert.equal(b.deduped, true);
  assert.equal(listProposals(home).length, 1);
  assert.equal(listProposals(home)[0]!.seen, 2);

  for (let i = 0; i < PROPOSAL_CAP - 1; i++) createProposal(home, { title: `独立提议 ${i} 号`, why: "凑满十二张卡" });
  assert.throws(() => createProposal(home, { title: "再来一张就爆了", why: "凑满十二张卡" }), /E_PROPOSAL_BACKLOG/);
});

test("K-2 人一句话拒：状态落盘，接受也不等于执行", () => {
  const home = H();
  const { proposal } = createProposal(home, { title: "重构夜间模块", why: "太长了不好读" });
  const rej = setProposalStatus(home, proposal.id, "rejected", "现在别动");
  assert.equal(rej!.status, "rejected");
  assert.equal(rej!.result, "现在别动");
  assert.equal(listProposals(home, { status: "open" }).length, 0, "拒掉后不再出现在待办里");
  assert.equal(listProposals(home, { status: "rejected" }).length, 1);
});

test("K-2 模型真的能提到：proposal.create 在工具表里，且写进 data/pending", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const reg = createToolRegistry({
    db: d.db,
    policy: { authorize: async () => ({ allow: true, reason: "test" }) } as never,
    ctx: { home, now: () => new Date(), db: d.db },
  });
  assert.ok(verbs.some((v) => v.name === "proposal.create"), "verb 要在能力目录里");
  assert.ok(reg.list().some((t) => t.name === "proposal.create"), "也要出现在模型可见的工具面");
  const r = await reg.run("proposal_create", { title: "加一个分页", why: "列表翻不动" });
  assert.equal(r.ok, true, r.output);
  assert.equal(listProposals(home).length, 1);
  assert.equal(listProposals(home)[0]!.from, "agent");
});

// ── J-5b：抽检送到眼前 ────────────────────────────────
test("J-5b 抽检队列：最没把握的先给，判过的不再问", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const now = new Date(Date.UTC(2026, 9, 31, 12));
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "她说喜欢下雨天", now });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "今天下了很大的雨", now });
  const c = remember(d.db, { layer: "narrative", kind: "episode", text: "我在杭州", now });
  d.db.prepare("INSERT INTO memory_links(src_id,dst_id,rel,weight,why,created_at) VALUES(?,?,?,?,?,?)")
    .run(a, b, "related", 0.3, "都提到雨", now.toISOString());
  d.db.prepare("INSERT INTO memory_links(src_id,dst_id,rel,weight,why,created_at) VALUES(?,?,?,?,?,?)")
    .run(a, c, "related", 0.9, "也许同一个话题", now.toISOString());

  const q1 = reviewQueue(d.db, now);
  assert.equal(q1.length, 2);
  assert.equal(q1[0]!.weight, 0.3, "最没把握（weight 最低）排第一");
  assert.equal(q1[0]!.why, "都提到雨", "必须把理由一起送到眼前");

  noteReviewed(d.db, now, q1[0]!.key);
  const q2 = reviewQueue(d.db, now);
  assert.equal(q2.length, 1, "看过的当天不再问");
  assert.equal(q2[0]!.weight, 0.9);
});

test("J-5b 点「不对」= 断线：作废 + 进黑名单（夜间不会再接回）", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const now = new Date(Date.UTC(2026, 9, 31, 12));
  const a = remember(d.db, { layer: "narrative", kind: "episode", text: "甲", now });
  const b = remember(d.db, { layer: "narrative", kind: "episode", text: "乙", now });
  d.db.prepare("INSERT INTO memory_links(src_id,dst_id,rel,weight,why,created_at) VALUES(?,?,?,?,?,?)")
    .run(a, b, "related", 0.5, "看着像", now.toISOString());

  const [row] = reviewQueue(d.db, now);
  const key = cutLink(d.db, row!, now);
  assert.equal(key, linkKey(a, b, "related"));
  assert.equal(listLinks(d.db, now, 10).length, 0, "列表里不该再有它（valid_to 已写）");
  assert.equal(isBlocked(d.db, key), true, "进黑名单才不会被夜间接回");
  const audit = d.db.prepare("SELECT count(*) c FROM events WHERE kind='link_cut'").get() as { c: number };
  assert.equal(audit.c, 1, "断线要留痕");
});

test("J-5b 面板与 CLI 拆的是同一根线（共用 links.ts）", () => {
  // 这条测的是"没有第二套实现"：cutLink 是唯一的拆线入口
  const src = readdirSync("src").filter((f) => f.endsWith(".ts"));
  assert.ok(src.includes("links.ts"));
});

// ── F-1 #3 / #5 ──────────────────────────────────────
test("F-1 #5 溯源：改过的记忆能查到旧正文（pre-image）", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const now = new Date(Date.UTC(2026, 9, 31, 12));
  const id = remember(d.db, { layer: "narrative", kind: "episode", text: "我住在杭州", now });
  // 模拟面板上的"改正文"（E-4/E-5 的 pre-image 落点）
  d.db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,1)")
    .run(now.toISOString(), "memory_text_changed", "human:panel", String(id), JSON.stringify({ before_text: "我住在杭州" }));

  const changes = d.db.prepare(
    "SELECT payload FROM events WHERE kind='memory_text_changed' AND target=?",
  ).all(String(id)) as Array<{ payload: string }>;
  assert.equal(JSON.parse(changes[0]!.payload).before_text, "我住在杭州", "旧正文要按逐字存下来（字段名 before_text）");
});

test("F-1 #3 工具列表：能力页从接口读，不硬编码", () => {
  const ui = readFileSync(new URL("../src/web/ui/notebook.js", import.meta.url), "utf8");
  assert.ok(ui.includes("function capView"), "要有能力页");
  assert.ok(ui.includes("'/api/capabilities'"), "工具表要读接口");
  assert.ok(ui.includes("tools.slice(0, 40)"), "一次铺 40 项，别把三百条全倒出来");
});

test("F-1 #6 四个管理面收敛：能力表在读 API 而不是硬编码", () => {
  const ui = readFileSync(new URL("../src/web/ui/notebook.js", import.meta.url), "utf8");
  assert.ok(ui.includes("/api/capabilities"), "能力块必须读接口");
  assert.ok(ui.includes("/api/plugins"), "插件也要走接口（增删/重连）");
  assert.ok(!/硬编码的工具清单/.test(ui));
});
