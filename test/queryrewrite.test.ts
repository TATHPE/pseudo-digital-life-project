import { readFileSync } from "node:fs";
/**
 * 查询改写（E-10）：别名归一 + 多路补召回。
 *
 * 这里钉三件事：
 *  1. 改写是**别名/近义**，不是联想（生造词一个变体都不加）
 *  2. 改写**有界**（最多 3 条变体、长度封顶）
 *  3. 改写**真的接上了检索**（同一份数据，开关一关就搜不到 —— 这是"写了不等于接上了"的反证）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALIASES, MAX_VARIANTS, normalizeQuery, queryVariants, singleCharBridges } from "../src/queryrewrite.ts";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { search } from "../src/retrieve.ts";
import { evaluateEvidence } from "../tools/eval-evidence.ts";

test("别名归一：口语换成库里更可能的写法", () => {
  assert.equal(normalizeQuery("我妈生日是哪天"), "妈妈生日是哪天");
  assert.equal(normalizeQuery("我老婆生日几号"), "妻子生日几号");
  // 长别名优先：「怎么称呼」不该被「称呼」先吃掉一半
  assert.equal(normalizeQuery("她不喜欢我怎么称呼"), "她不喜欢我怎么叫");
  // 没有别名 → 原样返回（不猜）
  assert.equal(normalizeQuery("bge-m3 维度"), "bge-m3 维度");
});

test("变体有界：原句第一，最多 3 条，生造词不加", () => {
  const v = queryVariants("停电或程序挂掉的那几次");
  assert.equal(v[0], "停电或程序挂掉的那几次", "原句永远是第一位（改写只是补充）");
  assert.ok(v.length <= MAX_VARIANTS, "最多 " + MAX_VARIANTS + " 条");
  assert.ok(v.includes("信号中断或进程被杀的那几次"), "长别名整体归一");

  // abstain 用例的典型形态：库里没有的生造话题，一个变体都不该多出来
  assert.deepEqual(queryVariants("麒麟座第七码头的坐标"), ["麒麟座第七码头的坐标"]);
  assert.deepEqual(queryVariants("我上次说的那个股票代码是多少"), ["我上次说的那个股票代码是多少"]);
  assert.deepEqual(queryVariants("   "), []);
});

test("别名表本身不许自我循环（A→B 之后不该再被 B→C 改一遍）", () => {
  const left = new Set(ALIASES.map(([a]) => a));
  for (const [from, to] of ALIASES) {
    assert.notEqual(from, to, "自己替换自己没有意义：" + from);
    // 右值不该是一个会继续被替换的左值（除了「叫」这种单字终点）
    if (left.has(to)) assert.equal(normalizeQuery(to), to, "链式替换失控：" + from + " → " + to);
  }
});

test("接上了检索：同一份数据，改写一关就搜不到（我妈 vs 妈妈）", async () => {
  const home = mkdtempSync(join(tmpdir(), "jj-rw-"));
  try {
    mkdirSync(join(home, "eval"), { recursive: true });
    const { db } = openDb(join(home, "memory.db"));
    remember(db, { text: "记住下周三为用户妈妈买蛋糕，她喜欢栗子味的", kind: "episode", layer: "narrative", importance: 4, sensitivity: "shareable" });
    remember(db, { text: "每周日晚上整理一次本周的记忆", kind: "episode", layer: "narrative", importance: 3, sensitivity: "shareable" });

    const q = "我妈生日是哪天";

    const on = await search(db, null, q, { k: 5 });
    assert.ok(on.hits.some((h) => h.text.includes("妈妈")), "开着改写得能找到：「我妈」→「妈妈」");

    const prev = process.env.JJ_QUERY_REWRITE;
    process.env.JJ_QUERY_REWRITE = "0";
    try {
      const off = await search(db, null, q, { k: 5 });
      assert.ok(!off.hits.some((h) => h.text.includes("妈妈")), "关掉改写就找不到（证明收益来自这一层）");
    } finally {
      if (prev === undefined) delete process.env.JJ_QUERY_REWRITE;
      else process.env.JJ_QUERY_REWRITE = prev;
    }
  } finally {
    // Windows 上 sqlite 句柄没释放时删目录会 EPERM —— 清理失败不该让测试变红
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("改写默认总是跑（用难用例量出来的：R@1 7/10 → 8/10）", () => {
  const src = readFileSync(join(process.cwd(), "src/retrieve.ts"), "utf8");
  assert.ok(src.includes("process.env.JJ_REWRITE_MIN_CANDS ?? 999"), "默认不再等「候选<2」");
  assert.ok(src.includes("JJ_QUERY_REWRITE"), "仍可用环境变量关掉");
});

test("E-12 单字桥只收已知别名终点，不做任意单字联想", () => {
  assert.deepEqual(singleCharBridges("她不喜欢我怎么称呼"), ["叫"]);
  assert.deepEqual(singleCharBridges("称呼和叫法"), ["叫"]);
  for (const q of ["我女儿叫什么", "我上次说的股票代码", "麒麟座第七码头", "的我你", "称呼".repeat(20)]) {
    assert.deepEqual(singleCharBridges(q), [], q);
  }
});

test("E-12 A/B：没有向量时称呼能跨到叫我；关桥即消失，虚词仍拒", async (t) => {
  const { db } = openDb(join(mkdtempSync(join(tmpdir(), "jj-bridge-")), "memory.db"));
  t.after(() => db.close());
  const id = remember(db, { text: "不要叫我助手", kind: "boundary", layer: "contract", sensitivity: "shareable" });
  remember(db, { text: "上次程序挂掉后恢复了", kind: "episode", layer: "narrative" });
  const old = process.env.JJ_SINGLE_CHAR_BRIDGE;
  t.after(() => { if (old === undefined) delete process.env.JJ_SINGLE_CHAR_BRIDGE; else process.env.JJ_SINGLE_CHAR_BRIDGE = old; });
  process.env.JJ_SINGLE_CHAR_BRIDGE = "0";
  assert.equal((await search(db, null, "她不喜欢我怎么称呼")).hits.length, 0);
  process.env.JJ_SINGLE_CHAR_BRIDGE = "1";
  const on = await search(db, null, "她不喜欢我怎么称呼");
  assert.equal(on.hits[0]?.id, id);
  assert.ok(on.meta.degraded.includes("single_char_bridge"));
  for (const q of ["我女儿叫什么", "我上次说的股票代码是多少", "麒麟座第七码头的坐标"]) {
    assert.equal((await search(db, null, q)).hits.length, 0, q);
  }
  db.prepare("UPDATE memories SET status='archived' WHERE id=?").run(id);
  assert.equal((await search(db, null, "怎么称呼")).hits.length, 0, "归档仍不召回");
});

test("E-12：正常命中时不扩前缀，不让弱候选抢位", async (t) => {
  const { db } = openDb(join(mkdtempSync(join(tmpdir(), "jj-bridge-")), "memory.db"));
  t.after(() => db.close());
  const direct = remember(db, { text: "称呼用小林", kind: "fact_hard", layer: "narrative" });
  remember(db, { text: "不要叫我助手", kind: "boundary", layer: "contract" });
  const r = await search(db, null, "怎么称呼");
  assert.equal(r.hits[0]?.id, direct);
  assert.ok(!r.meta.degraded.includes("single_char_bridge"));
});

test("E-12 与弱证据离线 A/B 自带夹具，报告只计已运行的模型回答", async () => {
  const { report, ok } = await evaluateEvidence();
  assert.ok(ok);
  assert.equal(report.bridge.filter((r) => !r.on && r.ok).length, 6);
  assert.equal(report.bridge.filter((r) => r.on && r.ok).length, 9);
  assert.equal(report.prompts.length, 16);
  assert.equal(report.answers.length, 0);
  assert.equal(report.model, null);
  assert.equal(report.modelDigest, null);
  assert.ok(report.fixtureHash);
});

test("覆盖率加权默认 0.5；硬门槛默认关（它会误杀纯语义的真命中）", () => {
  const src = readFileSync(join(process.cwd(), "src/retrieve.ts"), "utf8");
  assert.ok(src.includes("process.env.JJ_COVER_MIX ?? 0.5"), "覆盖率加权默认开");
  assert.ok(src.includes("process.env.JJ_COVER_MIN ?? 0"), "硬门槛默认关");
  assert.ok(src.includes("这个矛盾留给 reranker"), "把矛盾写在代码里，别让它变成谜");
});
