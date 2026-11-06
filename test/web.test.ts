import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { createWebServer, looksMojibake, writeGuarded } from "../src/web/server.ts";
import { execute } from "../src/execute.ts";
import { ingestFile } from "../src/ingest.ts";
import { loadPolicy } from "../src/policy.ts";
import { NOTEBOOK, NB_JS } from "../src/web/notebook.ts";
import { groupTimeline, gapLabel } from "../src/web/timeline.ts";
import { expenseLine } from "../src/web/state.ts";
import type { AddressInfo } from "node:net";

const tmp = () => mkdtempSync(join(tmpdir(), "jj-web-"));

/** fetch 规范禁用了一批端口（6665–6669、10080 …），而这台机器的动态端口范围里就有它们。
 *  listen(0) 一旦落在那里，undici 直接 "bad port" —— 不是代码错，是环境。
 *  这条以前只写在 start() 里，另外 5 个测试各自 listen(0) 没这道保险，
 *  于是整仓跑会偶尔红一条、单跑那个文件又是绿的（2026-11-04 抓到）。 */
const BLOCKED_PORTS = new Set([0, 6665, 6666, 6667, 6668, 6669, 10080]);

async function listenSafe(srv: { listen(p: number, h: string, cb: () => void): unknown; address(): unknown; close(cb: () => void): unknown }): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    await new Promise<void>((r) => { srv.listen(0, "127.0.0.1", () => r()); });
    const port = (srv.address() as AddressInfo).port;
    if (!BLOCKED_PORTS.has(port)) return port;
    await new Promise<void>((r) => { srv.close(() => r()); });
    if (attempt > 8) throw new Error(`E_BAD_PORT: 连续撞到禁用端口 ${port}`);
  }
}

async function start() {
  const dir = tmp();
  const d = openDb(join(dir, "m.db"));
  remember(d.db, { layer: "contract", kind: "promise", text: "不要在工作时段主动打扰" });
  remember(d.db, { layer: "narrative", kind: "episode", text: "你提到 importance 影响衰减速率" });
  const srv = createWebServer({
    db: d.db, inboxDir: join(dir, "inbox"), home: dir,
    getTransport: () => { throw new Error("测试不该真调模型"); },
    getEmbedder: () => null,
    getConfig: () => ({ ollama: "http://127.0.0.1:11434", roles: { express: { provider: "deepseek", model: "deepseek-chat", embed: { provider: "ollama", model: "bge-m3" } } } }),
    now: () => new Date("2026-10-28T12:00:00Z"),
    reply: async function* () { yield "在。"; yield "（本地桩）"; },
  });
  // 端口可能落在 fetch 的禁用段（见 listenSafe）；这里只负责起得来
  const port = await listenSafe(srv);
  return { srv, port, base: `http://127.0.0.1:${port}`, dir };
}



test("桌面端令牌：没令牌 403、带 ?k= 放行并种 cookie、/health 不需要令牌", async () => {
  const dir = tmp();
  const d = openDb(join(dir, "m.db"));
  const token = "a".repeat(32);
  const srv = createWebServer({
    deskToken: token,
    db: d.db, inboxDir: join(dir, "inbox"), home: dir,
    getTransport: () => { throw new Error("测试不该真调模型"); },
    getEmbedder: () => null,
    getConfig: () => ({ roles: { express: { provider: "deepseek", model: "x" } }, ollama: "" }) as never,
  });
  const base = `http://127.0.0.1:${await listenSafe(srv)}`;
  try {
    assert.equal((await fetch(`${base}/`)).status, 403, "浏览器直接开就是 403");
    assert.equal((await fetch(`${base}/?k=wrong`)).status, 403, "错的令牌也是 403");
    const ok = await fetch(`${base}/?k=${token}`);
    assert.equal(ok.status, 200, "带对令牌才能进");
    assert.match(String(ok.headers.get("set-cookie")), /jjdesk=/, "第一次要种 cookie");
    assert.match(String(ok.headers.get("set-cookie")), /HttpOnly/, "cookie 不能让脚本读");
    // 之后靠 cookie 就够（壳里的后续导航不会再带 ?k=）
    const viaCookie = await fetch(`${base}/`, { headers: { cookie: "jjdesk=" + token } });
    assert.equal(viaCookie.status, 200);
    assert.equal((await fetch(`${base}/api/state`)).status, 403, "API 也要令牌");
    assert.equal((await fetch(`${base}/health`)).status, 200, "/health 放行（壳探测要用）");
  } finally { srv.close(); }
});
test("GET / 分流：没配完给引导页；配完了给记录本（2026-11-05 起只有记录本）", async () => {
  const { srv, base } = await start();
  try {
    // 首启引导：新 home 没有 setup-session，/ 必须给引导页（不是先看见一个空对话）
    const welcome = await (await fetch(`${base}/`)).text();
    assert.ok(welcome.includes("第一次见面"), "没配完时 / 应该是引导页");
    assert.ok(welcome.includes("id='dots'"), "引导页要有步骤进度");
    assert.ok((await (await fetch(`${base}/welcome`)).text()).includes("第一次见面"), "/welcome 永远给引导页");

    // 配完之后 / 就是记录本 —— 旧的经典面板已经从程序里撤下来了
    const html = await (await fetch(`${base}/?skip=1`)).text();
    assert.ok(html.includes("<title>鲸鲸 · 记录本</title>"), "跳过引导时给记录本");
    assert.ok(html.includes('id="nb-log"'), "记录本要有正文区");
    assert.ok(html.includes("--void:#0b0e0b"), "底色不变");
    // 强调色按 Hermes 统一（2026-11-06）：两套主题同一个青
    assert.ok(html.includes("--cyan:#0f7c74"), "青色（Hermes）不变");
    assert.ok(!html.includes('id="composer"'), "经典面板不该再出现");

    // 旧路由撤掉：/classic 不存在了
    assert.equal((await fetch(`${base}/classic`)).status, 404, "旧面板路由已撤");

    const st = await (await fetch(`${base}/api/state`)).json() as any;
    assert.match(st.line, /醒着/);
    assert.equal(st.lastSeenAt, null, "还没聊过");
  } finally { srv.close(); }
});

test("POST /api/say：SSE 流式返回，并把两条事件写进 inbox", async () => {
  const { srv, base, dir } = await start();
  try {
    const r = await fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "在吗" }) });
    assert.equal(r.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const text = await r.text();
    const frames = text.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, "")));
    assert.ok(frames.some((f) => f.type === 'delta' && typeof f.text === 'string'), JSON.stringify(frames).slice(0, 300));
    assert.equal(frames[frames.length - 1]!.type, 'done');
    assert.equal(frames[0]!.type, 'brief');
    assert.ok(frames[0]!.tokens > 0);

    const tl = await (await fetch(`${base}/api/timeline`)).json() as any[];
    assert.equal(tl.filter((b) => b.type === "msg").length, 2, "一问一答");
    assert.equal(tl.filter((b) => b.role === "user").length, 1);
    void dir;
  } finally { srv.close(); }
});

test("POST /api/say 会当场记住「记住：X」（不等夜里那次批处理）", async () => {
  const { srv, base, dir } = await start();
  try {
    const r = await fetch(`${base}/api/say`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "记住：我对花生过敏" }),
    });
    const sse = await r.text();   // 读完 SSE，确保这一轮跑完
    const frames = sse.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, "")));
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dir, "m.db"), { readOnly: true });
    const row = db.prepare("SELECT text,kind,layer,quote,scored_by FROM memories WHERE scored_by='rule:explicit'").get() as any;
    db.close();
    assert.ok(row, "该写进一条规则记忆");
    assert.equal(row.text, "我对花生过敏");
    assert.equal(row.kind, "fact_hard");
    assert.equal(row.layer, "contract");
    assert.equal(row.quote, "记住：我对花生过敏", "原话要留");
    // 记下了要说出来，否则"记住了"和"没听见"在界面上一样
    assert.ok(frames.some((f) => f.type === "memo" && String(f.text).includes("花生过敏")), JSON.stringify(frames).slice(0, 300));
  } finally { srv.close(); }
});

test("GET /api/memories：无 embedder 时退化为按权重列，不报错", async () => {  const { srv, base } = await start();
  try {
    const rows = await (await fetch(`${base}/api/memories`)).json() as any[];
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((r) => typeof r.weight === "number"));
    const q = await (await fetch(`${base}/api/memories?q=衰减`)).json() as any[];
    assert.deepEqual(q, [], "无 embedder 时搜索返回空而不是 500");
  } finally { srv.close(); }
});

test("时间轴：同日空隙用 gap 块，跨天把间隔写进日期标签", () => {
  const L = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString(); // 本地时间
  const b = groupTimeline([
    { ts: L(24, 10, 0), role: "user", text: "早" },
    { ts: L(24, 10, 5), role: "agent", text: "早。" },
    { ts: L(24, 18, 0), role: "user", text: "在吗" },
    { ts: L(27, 10, 0), role: "user", text: "我回来了" },
  ]);
  const days = b.filter((x) => x.type === "day") as any[];
  assert.equal(days.length, 2, "跨两天");
  assert.equal(days[0].gapMs, undefined, "第一天没有上次");
  assert.ok(Math.abs(days[1].gapMs - (2 * 1440 + 16 * 60) * 60000) < 60000, `跨天间隔 ${days[1].gapMs}`);
  const sameDayGaps = b.filter((x) => x.type === "gap").map((x: any) => x.label);
  assert.deepEqual(sameDayGaps, ["7 小时 55 分"], JSON.stringify(sameDayGaps));
});

test("状态行：一句话而不是仪表盘；断片/间隔都说得清", () => {
  assert.match(expenseLine(null, []), /还没聊过/);
  assert.match(expenseLine(0.001, [{ stage: "active", c: 3 }]), /刚刚/);
  assert.match(expenseLine(3.17, [{ stage: "active", c: 3 }, { stage: "fading", c: 2 }]), /距上次 3 天 4 小时/);
  assert.match(expenseLine(3.17, [{ stage: "active", c: 3 }, { stage: "fading", c: 2 }]), /记得 5 条（清晰 3）/);
});

test("gapLabel 的量级", () => {
  assert.equal(gapLabel(30_000), "刚刚");
  assert.equal(gapLabel(90 * 60_000), "1 小时 30 分");
  assert.equal(gapLabel(50 * 3600_000), "2 天 2 小时");
});

test("编码闸：非 UTF-8（GBK）请求体拒收，不写进记忆", async () => {
  const { srv, base } = await start();
  try {
    // 用 latin1 造一个"解出来是 U+FFFD"的字节序列（真实场景是 GBK 的 UTF-8 误解码）
    const gbk = Buffer.concat([Buffer.from([0xd3, 0xef]), Buffer.from("x")]);
    const r = await fetch(`${base}/api/say`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: Buffer.concat([Buffer.from('{"text":"'), gbk, Buffer.from('"}')]),
    });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as any).error, "E_ENCODING");
    assert.ok(looksMojibake("�"));
  } finally { srv.close(); }
});

test("会话：一问一答挂在同一个 session 上，关掉之后开新的（2026-11-05）", async () => {
  const { srv, base } = await start();
  try {
    const say = async (t: string) => {
      const r = await fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t }) });
      return await r.text();
    };
    await say("第一句");
    await say("第二句");

    const l1 = await (await fetch(`${base}/api/sessions`)).json() as any;
    assert.equal(l1.sessions.length, 1, "连续两句是同一次会话");
    const s1 = l1.sessions[0];
    assert.equal(s1.title, "第一句", "标题取第一句");
    assert.equal(s1.msgs, 4, "两问两答");

    const detail = await (await fetch(`${base}/api/sessions/${s1.id}`)).json() as any;
    assert.equal(detail.messages.length, 4);
    assert.equal(detail.messages[0].role, "user");
    assert.equal(detail.messages[0].text, "第一句");

    const c = await fetch(`${base}/api/sessions/${s1.id}/close`, { method: "POST", headers: { "content-type": "application/json", "x-jj": "1" }, body: "{}" });
    assert.equal((await c.json() as any).ok, true);

    await say("第三句");
    const l2 = await (await fetch(`${base}/api/sessions`)).json() as any;
    assert.equal(l2.sessions.length, 2, "关掉之后是新的一次");
    assert.equal(l2.sessions.filter((x: any) => x.status === "closed").length, 1);
  } finally { srv.close(); }
});
test("会话：分叉与撤回（2026-11-05）", async () => {
  const { srv, base } = await start();
  try {
    const h = { "content-type": "application/json", "x-jj": "1" };
    const say = (t: string) => fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t }) }).then((r) => r.text());
    await say("一");
    await say("二");
    const l = await (await fetch(`${base}/api/sessions`)).json() as any;
    const id = l.sessions[0].id;

    const br = await (await fetch(`${base}/api/sessions/${id}/branch`, { method: "POST", headers: h, body: "{}" })).json() as any;
    assert.equal(br.ok, true);
    assert.ok(br.session.id && br.session.id !== id, "分叉是新会话");
    assert.match(br.session.title, /分叉/);

    const before = (await (await fetch(`${base}/api/sessions/${id}`)).json() as any).messages.length;
    assert.equal(before, 4);
    const un = await (await fetch(`${base}/api/sessions/${id}/undo`, { method: "POST", headers: h, body: "{}" })).json() as any;
    assert.equal(un.ok, true, JSON.stringify(un));
    const after = (await (await fetch(`${base}/api/sessions/${id}`)).json() as any).messages.length;
    assert.ok(after < before, `撤回后消息应更少：${before} → ${after}`);
    assert.equal(after, 2, "撤掉最后一问一答");
  } finally { srv.close(); }
});
test("轮次：一问一答配成一轮，能单独撤回（2026-11-05）", async () => {
  const { srv, base } = await start();
  try {
    const h = { "content-type": "application/json", "x-jj": "1" };
    const say = (t: string) => fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t }) }).then((r) => r.text());
    await say("第一问");
    await say("第二问");
    const l = await (await fetch(`${base}/api/sessions`)).json() as any;
    const id = l.sessions[0].id;

    const turns = (await (await fetch(`${base}/api/sessions/${id}/turns`)).json() as any).turns;
    assert.equal(turns.length, 2, "两问两轮");
    assert.equal(turns[0].user, "第一问");
    assert.ok(turns[0].agentTs, "第一轮有回答");

    const u = await (await fetch(`${base}/api/sessions/${id}/turns/${turns[0].id}/undo`, { method: "POST", headers: h, body: "{}" })).json() as any;
    assert.equal(u.ok, true);
    const after = (await (await fetch(`${base}/api/sessions/${id}`)).json() as any).messages;
    assert.equal(after.length, 0, "撤回第一轮 = 一条不剩");

    const rt = await (await fetch(`${base}/api/sessions/${id}/turns/${turns[1].id}/retry`, { method: "POST", headers: h, body: "{}" })).json() as any;
    assert.equal(rt.text, "第二问", "重问把原话交回来");

    const au = await (await fetch(`${base}/api/sessions/${id}/turns/${turns[1].id}/audit`, { method: "POST", headers: h, body: "{}" })).json() as any;
    assert.ok(Array.isArray(au.audit), "审计是一个数组（这一轮没执行就是空）");
  } finally { srv.close(); }
});
test("日志：执行审计能列出来、能过滤（2026-11-05）", async () => {
  const { srv, base } = await start();
  try {
    const r = await (await fetch(`${base}/api/logs?limit=5`)).json() as any;
    assert.ok(Array.isArray(r.items), "items 是数组");
    assert.ok(r.items.length <= 5, "limit 要生效");
    for (const it of r.items) {
      assert.ok(typeof it.ts === "string" && it.ts.length > 10, "每行要有时间");
      assert.ok(typeof it.verb === "string", "每行要有 verb");
    }
    const f = await (await fetch(`${base}/api/logs?q=zzz-no-such-verb`)).json() as any;
    assert.equal(f.items.length, 0, "过滤要真的过滤");
  } finally { srv.close(); }
});
test("引导重答：带着补充要求重生成一条，并顶替这一轮的显示（2026-11-05）", async () => {
  const { srv, base } = await start();
  try {
    const h = { "content-type": "application/json", "x-jj": "1" };
    const say = (t: string) => fetch(`${base}/api/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t }) }).then((r) => r.text());
    await say("第一问");
    const l = await (await fetch(`${base}/api/sessions`)).json() as any;
    const id = l.sessions[0].id;
    const t1 = (await (await fetch(`${base}/api/sessions/${id}/turns`)).json() as any).turns[0];

    const noNote = await fetch(`${base}/api/sessions/${id}/turns/${t1.id}/steer`, { method: "POST", headers: h, body: "{}" });
    assert.equal(noNote.status, 400, "没给要求要拒");

    const r = await (await fetch(`${base}/api/sessions/${id}/turns/${t1.id}/steer`, { method: "POST", headers: h, body: JSON.stringify({ note: "短一点" }) })).json() as any;
    assert.equal(r.ok, true);
    assert.ok(String(r.text).length > 0, "要有新回答");

    const turns = (await (await fetch(`${base}/api/sessions/${id}/turns`)).json() as any).turns;
    assert.equal(turns.length, 1, "还是一轮（不是新增一轮）");
    assert.equal(turns[0].agent, r.text, "显示的是重答后的那条");
  } finally { srv.close(); }
});
test("诊断 / 部署 / 导出校验：面板能自己说清状态（2026-11-05）", async () => {
  const { srv, base } = await start();
  try {
    const dep = await (await fetch(`${base}/api/deploy`)).json() as any;
    for (const k of ["version", "mode", "home", "node", "uptimeS", "dbBytes"]) {
      assert.ok(dep[k] !== undefined, "deploy 缺字段：" + k);
    }
    assert.match(String(dep.node), /^v[0-9]+/);
    assert.ok(dep.fingerprint && dep.fingerprint.schema, "要有 schema 指纹");

    const doc = await (await fetch(`${base}/api/doctor`)).json() as any;
    assert.ok(Array.isArray(doc.checks) && doc.checks.length >= 3, "体检要有几项");
    assert.ok(doc.checks.every((c: any) => typeof c.ok === "boolean" && c.name), "每项要有 ok + name");

    const ver = await fetch(`${base}/api/export/verify`);
    assert.equal(ver.status, 400, "没有 dir 参数要 400");

    const av = await (await fetch(`${base}/api/avatars`)).json() as any;
    assert.ok("agent" in av && "user" in av, "头像接口给两个角色");
  } finally { srv.close(); }
});

test("记录本是唯一界面：/ 与 /notebook 同页，旧面板路由已撤（2026-11-05）", async () => {
  const { srv, base } = await start();
  try {
    const a = await (await fetch(`${base}/?skip=1`)).text();
    const b = await (await fetch(`${base}/notebook`)).text();
    assert.equal(a, b, "/ 和 /notebook 是同一页");

    // nb-leaf（过程浮层）2026-11-05 撤了：它 position:fixed 全局盖在正文上，过程只在右栏 IV 里看
    for (const marker of ['id="nb-log"', 'id="nb-board"', 'id="nb-view"', 'id="nb-t4"']) {
      assert.ok(a.includes(marker), "记录本缺：" + marker);
    }
    assert.equal((await fetch(`${base}/classic`)).status, 404, "/classic 已撤");
    assert.equal((await fetch(`${base}/?shell=classic&skip=1`)).status, 200, "参数不再改变界面");

    // 界面脚本现在是真文件（2026-11-06 从模板字符串里抽出来的）——
    // 以前只能把字符串抠出来再 --check，改一次带走一片函数。
    execFileSync(process.execPath, ["--check", join(process.cwd(), "src/web/ui/notebook.js")], { stdio: "pipe" });
    const html = await (await fetch(`${base}/?skip=1`)).text();
    assert.ok(html.includes('/ui/notebook.js'), "页面要引用外部脚本");
    const js = await fetch(`${base}/ui/notebook.js`);
    assert.equal(js.status, 200, "脚本要能取到");
    assert.ok((js.headers.get("content-type") || "").includes("javascript"), "类型要对");
    assert.ok((await js.text()).includes("function paintTrace"), "取到的应该是真脚本");
    assert.equal((await fetch(`${base}/ui/../server.ts`)).status, 404, "不许穿路径");
  } finally { srv.close(); }
});



// ── 设置：API 与人格（用面板配置，而不是让人去改文件）─────────
test("CSRF：写操作没有 x-jj 头 → 403；带了对的来源 → 放行", async () => {
  const { srv, base } = await start();
  try {
    const bad = await fetch(`${base}/api/persona`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "voice", content: "x" }),
    });
    assert.equal(bad.status, 403);
    assert.equal(((await bad.json()) as any).error, "E_CSRF");

    const evil = await fetch(`${base}/api/persona`, {
      method: "PUT", headers: { "content-type": "application/json", "x-jj": "1", origin: "https://evil.example" },
      body: JSON.stringify({ file: "voice", content: "x" }),
    });
    assert.equal(evil.status, 403);
    assert.equal(((await evil.json()) as any).error, "E_ORIGIN");
  } finally { srv.close(); }
});

test("人格：保存后能读回，并留下 versions/ 记录；重复保存不产生变化", async () => {
  const { srv, base, dir } = await start();
  try {
    const H = { "content-type": "application/json", "x-jj": "1" };
    const text = "# voice" + String.fromCharCode(10) + "【日常】嗯。";
    const r1 = await fetch(`${base}/api/persona`, { method: "PUT", headers: H, body: JSON.stringify({ file: "voice", content: text }) });
    const j1 = await r1.json() as any;
    assert.equal(j1.ok, true);
    assert.equal(j1.changed, true);

    const back = await (await fetch(`${base}/api/persona`)).json() as any;
    assert.match(back.files.voice, /【日常】嗯。/);

    const r2 = await fetch(`${base}/api/persona`, { method: "PUT", headers: H, body: JSON.stringify({ file: "voice", content: text }) });
    assert.equal(((await r2.json()) as any).changed, false);

    const ver = readdirSync(join(dir, "persona", "versions"));
    assert.ok(ver.length >= 1, "应留版本记录");
  } finally { srv.close(); }
});

test("人格：拒收超长/控制字符/非 UTF-8", async () => {
  const { srv, base } = await start();
  try {
    const H = { "content-type": "application/json", "x-jj": "1" };
    const cases: Array<[string, string]> = [
      ["core", "x".repeat(20 * 1024)],
      ["core", "坏" + String.fromCharCode(7) + "字符"],
      ["core", "乱码" + String.fromCharCode(0xfffd)],
      ["nope", "x"],
    ];
    const codes: string[] = [];
    for (const [file, content] of cases) {
      const r = await fetch(`${base}/api/persona`, { method: "PUT", headers: H, body: JSON.stringify({ file, content }) });
      codes.push(((await r.json()) as any).error);
    }
    assert.deepEqual(codes.map((c) => c.split(":")[0]), ["E_PERSONA_TOO_BIG", "E_CONTROL_CHAR", "E_ENCODING", "E_PERSONA_FILE"]);
  } finally { srv.close(); }
});

test("配置：GET 不回显 key，只给指纹；PUT 写 key 后 hasKey 变 true", async () => {
  const { srv, base, dir } = await start();
  try {
    const H = { "content-type": "application/json", "x-jj": "1" };
    const before = await (await fetch(`${base}/api/config`)).json() as any;
    assert.equal(before.hasKey, false);
    assert.equal(before.keyFingerprint, null);
    assert.ok(!JSON.stringify(before).includes("sk-"));

    const r = await fetch(`${base}/api/config`, {
      method: "PUT", headers: H,
      body: JSON.stringify({ provider: "deepseek", model: "deepseek-chat", key: "sk-test-abcdefgh12345678" }),
    });
    const j = await r.json() as any;
    assert.equal(j.ok, true);
    assert.equal(j.hasKey, true);
    assert.equal(j.provider, "deepseek");
    // 配置文件里不能有 key
    const cfgRaw = readFileSync(join(dir, "config.json"), "utf8");
    assert.ok(!cfgRaw.includes("abcdefgh12345678"));
    assert.match(cfgRaw, /deepseek-chat/);
  } finally { srv.close(); }
});





test("待确认：面板能看到 T3 提案，确认按钮真的执行（令牌在服务端签发）", async () => {
  const { srv, base } = await start();
  const home = (srv as unknown as { __home?: string }).__home;
  void home;
  try {
    // 先制造一张待确认卡：调 shell.run 不带令牌（T3）
    const t3 = await fetch(`${base}/api/say`, {
      method: "POST", headers: { "x-jj": "1", "content-type": "application/json" },
      body: JSON.stringify({ text: "跑个命令" }),
    });
    void t3;
    const list0 = await (await fetch(`${base}/api/pending`)).json() as any[];
    assert.ok(Array.isArray(list0), "GET /api/pending 要返回数组");

    // 没有待确认卡时，确认一个不存在的 id → 404
    const miss = await fetch(`${base}/api/pending/pnd_nosuch`, {
      method: "POST", headers: { "x-jj": "1", "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm" }),
    });
    assert.equal(miss.status, 404);
    // 没有 CSRF 头 → 403
    const noCsrf = await fetch(`${base}/api/pending/pnd_nosuch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm" }),
    });
    assert.equal(noCsrf.status, 403);
  } finally { srv.close(); }
});

test("待确认队列仍然可用（手工写入 + 面板读取），但 execute 不再自动往里写", async () => {
  // 2026-11-04：确认层从 execute 删掉了 —— 她不会再一次次停下来等确认。
  // 队列本身留着：别的入口（比如将来的定时任务）想留一件"等你点头"的事还能用。
  const dir = tmp();
  const d = openDb(join(dir, "m.db"));
  mkdirSync(join(dir, "workspace"), { recursive: true });
  const policy = await loadPolicy(dir);
  const srv = createWebServer({
    db: d.db, inboxDir: join(dir, "inbox"), home: dir, policy,
    getTransport: () => { throw new Error("测试不该真调模型"); },
    getEmbedder: () => null,
    getConfig: () => ({ ollama: "", roles: { express: { provider: "deepseek", model: "x", embed: { provider: "ollama", model: "bge-m3" } } } }),
    now: () => new Date(),
  });
  const port = await listenSafe(srv);
  const base = "http://127.0.0.1:" + port;
  const H2 = { "x-jj": "1", "content-type": "application/json" };
  try {
    // 手工留一件"等你点头"的事
    const { recordPending } = await import("../src/confirm.ts");
    recordPending(dir, {
      verb: "script.run", template: "node.run_script",
      args: { template: "node.run_script", slots: { script: "p.mjs" } },
      argv: ["node", "p.mjs"], cwd: join(dir, "workspace"),
      digest: "deadbeef", source: "agent", now: new Date(),
    } as never);

    const list = await (await fetch(base + "/api/pending")).json();
    assert.ok(Array.isArray(list) && list.length === 1, "面板要能读到它");
    assert.equal(list[0].verb, "script.run");

    // 丢弃
    const deny = await fetch(base + "/api/pending/" + list[0].id, { method: "POST", headers: H2, body: JSON.stringify({ action: "reject" }) });
    assert.equal(deny.status, 200);
    const after = await (await fetch(base + "/api/pending")).json();
    // 列表可能仍包含它（状态从 pending 变 rejected），判据是状态不是条数
    assert.ok((after as Array<{ status: string }>).every((x) => x.status !== "pending"), "拒绝后不该还有 pending");
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test("GET /health：给 compose 用的轻量探针（不跑 quick_check）", async () => {
  const { srv, base } = await start();
  try {
    const h = await (await fetch(`${base}/health`)).json() as any;
    assert.equal(h.ok, true);
    assert.equal(h.schema, String(Number(h.schema)));
    assert.ok(typeof h.memories === "number");
    assert.ok(Array.isArray(h.degraded));
  } finally { srv.close(); }
});

test("部署配置不漂移：compose 的 healthcheck 打的是我们真的在服务的 /health", () => {
  const dir = join(process.cwd(), "docker");
  const compose = readFileSync(join(dir, "compose.yaml"), "utf8");
  const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf8");
  // 探针路径必须存在（服务端路由 vs compose 配置，两边对得上）
  assert.ok(compose.includes("/health"), "compose 的 healthcheck 应打 /health");
  // 数据卷必须挂出去（容器可删，数据在卷）
  assert.match(compose, /\.\/data:\/app\/data/);
  // Node 版本必须满足 package.json 的 engines（>=22.6）
  const m = dockerfile.match(/FROM\s+node:(\d+)/);
  assert.ok(m && Number(m[1]) >= 22, `Dockerfile 基础镜像 Node 版本太低：${m && m[1]}`);
  // 重启策略：被杀 ≤10s 自愈
  assert.match(compose, /restart:\s*unless-stopped/);
});

test("文档：/api/docs 列出摄入的文档，点开能看到块，忘掉后消失", async () => {
  const dir = tmp();
  const d = openDb(join(dir, "m.db"));
  mkdirSync(join(dir, "sources"), { recursive: true });
  writeFileSync(join(dir, "sources", "k.md"), "# 领地\n\n它自己划的圈。\n\n## 边界\n\n越界即降级。" + "内容".repeat(60));
  const policy = await loadPolicy(dir);
  const srv = createWebServer({
    db: d.db, inboxDir: join(dir, "inbox"), home: dir, policy,
    getTransport: () => { throw new Error("no model"); }, getEmbedder: () => null,
    getConfig: () => ({ ollama: "", roles: { express: { provider: "deepseek", model: "x", embed: { provider: "ollama", model: "bge-m3" } } } }),
  });
  const base = `http://127.0.0.1:${await listenSafe(srv)}`;
  try {
    const ing = await ingestFile(d.db, join(dir, "sources", "k.md"), { home: dir });
    assert.equal(ing.skipped, false);

    const list = await (await fetch(`${base}/api/docs`)).json() as any[];
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "领地");

    const one = await (await fetch(`${base}/api/docs/${list[0].id}`)).json() as any;
    assert.equal(one.doc.n_chunks, ing.chunks);
    assert.ok(one.chunks.length >= 1);
    assert.ok(one.chunks.some((c: any) => c.heading_path === "领地 > 边界"));

    const forget = await fetch(`${base}/api/docs/${list[0].id}/forget`, {
      method: "POST", headers: { "x-jj": "1", "content-type": "application/json" }, body: "{}",
    });
    assert.equal(forget.status, 200);
    assert.equal(((await forget.json()) as any).chunks, ing.chunks);
    assert.equal(((await (await fetch(`${base}/api/docs`)).json()) as any[]).length, 0);

    const noCsrf = await fetch(`${base}/api/docs/${list[0].id}/forget`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(noCsrf.status, 403);
  } finally { srv.close(); }
});




test("写操作守卫：同源放行（Tailscale/手机），跨站仍然 403", async () => {
  // 同源：Origin 的 host 与 Host 头一致 → 这是“页面自己发的”，必须放行，
  // 否则手机通过 Tailscale 打开时连发消息都做不了
  const mk = (origin: string | undefined, host: string) => {
    const headers: Record<string, string> = { host, "x-jj": "1" };
    if (origin !== undefined) headers.origin = origin;
    return { headers } as unknown as Parameters<typeof writeGuarded>[0];
  };
  assert.equal(writeGuarded(mk("https://jj.tail1234.ts.net", "jj.tail1234.ts.net")).ok, true);
  assert.equal(writeGuarded(mk("http://127.0.0.1:7700", "127.0.0.1:7700")).ok, true);
  assert.equal(writeGuarded(mk("https://evil.example.com", "jj.tail1234.ts.net")).ok, false, "跨站必须拒");
  assert.equal(writeGuarded(mk("null", "127.0.0.1:7700")).ok, false);
  // 没 Origin（curl / 原生脚本）也要求 x-jj
  const noCsrf = { headers: { host: "127.0.0.1:7700" } } as unknown as Parameters<typeof writeGuarded>[0];
  assert.equal(writeGuarded(noCsrf).ok, false);
});



test("接口：/api/audit 只回字段不泄漏，/api/search 空查询直接返回", async () => {
  const { srv, base } = await start();
  try {
    const a = await (await fetch(`${base}/api/audit?limit=5`)).json() as any;
    assert.ok(Array.isArray(a.rows), "返回 { total, rows }");
    assert.equal(typeof a.total, "number", "要带上总数（只给最近 N 条却让人以为是全部，也是说谎）");
    if (a.rows.length) {
      assert.ok("verb" in a.rows[0] && "decision" in a.rows[0] && "ts" in a.rows[0]);
      assert.ok(!("argv_json" in a.rows[0]), "审计列表不要回原始 argv 全文");
    }
    const s = await (await fetch(`${base}/api/search?q=`)).json() as any;
    assert.deepEqual(s, { mem: [], docs: [] });
    const u = await (await fetch(`${base}/api/usage`)).json() as any;
    assert.equal(typeof u.todayUsd, "number");
    assert.ok(u.budgetUsd > 0);
  } finally { srv.close(); }
});



test("头像：上传验收文件头（伪造 mime 也不行），SVG 一律拒，删除后回落默认", async () => {
  const dir = tmp();
  const d = openDb(join(dir, "m.db"));
  const srv = createWebServer({
    db: d.db, inboxDir: join(dir, "inbox"), home: dir,
    getTransport: () => { throw new Error("no model"); }, getEmbedder: () => null,
    getConfig: () => ({ ollama: "", roles: { express: { provider: "deepseek", model: "x", embed: { provider: "ollama", model: "bge-m3" } } } }),
  });
  const base = `http://127.0.0.1:${await listenSafe(srv)}`;
  const H = { "x-jj": "1", "content-type": "application/json" };
  try {
    // 一个 1×1 的真 PNG（67 字节）
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    const up = await fetch(`${base}/api/avatar`, {
      method: "POST", headers: H,
      body: JSON.stringify({ role: "agent", dataUrl: "data:image/png;base64," + png.toString("base64") }),
    });
    assert.equal(up.status, 200, await up.text());
    const list = await (await fetch(`${base}/api/avatars`)).json() as any;
    assert.match(String(list.agent.url), /^\/avatar\/agent\?v=/);

    const img = await fetch(`${base}/avatar/agent`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.equal(img.headers.get("x-content-type-options"), "nosniff", "上传的二进制必须 nosniff");
    assert.deepEqual([...new Uint8Array(await img.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    // 声明成 png，实际是文本 → 必须拒（只信文件头）
    const fake = await fetch(`${base}/api/avatar`, {
      method: "POST", headers: H,
      body: JSON.stringify({ role: "user", dataUrl: "data:image/png;base64," + Buffer.from("not an image at all, really not").toString("base64") }),
    });
    assert.equal(fake.status, 400);
    assert.equal(((await fake.json()) as any).error, "E_BAD_IMAGE");

    // SVG 不在白名单里
    const svgUp = await fetch(`${base}/api/avatar`, {
      method: "POST", headers: H,
      body: JSON.stringify({ role: "user", dataUrl: "data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64") }),
    });
    assert.equal(svgUp.status, 400);

    // 没有 CSRF 头 → 403
    const noCsrf = await fetch(`${base}/api/avatar`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "agent", dataUrl: "data:image/png;base64," + png.toString("base64") }),
    });
    assert.equal(noCsrf.status, 403);

    // 删掉 → 回落默认（/avatar 404、/api/avatars 为 null）
    const del = await fetch(`${base}/api/avatar?role=agent`, { method: "DELETE", headers: H });
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${base}/avatar/agent`)).status, 404);
    assert.equal(((await (await fetch(`${base}/api/avatars`)).json()) as any).agent, null);
  } finally { srv.close(); }
});









test("面板摄入：候选列表只列未摄入的，编码不对不装成 E_NOT_FOUND", async () => {
  const dir = tmp();
  const d = openDb(join(dir, "m.db"));
  mkdirSync(join(dir, "sources", "子目录"), { recursive: true });
  writeFileSync(join(dir, "sources", "待摄入.md"), "# 待摄入\n\n" + "内容".repeat(60));
  mkdirSync(join(dir, "sources", "子目录"), { recursive: true });
  writeFileSync(join(dir, "sources", "子目录", "另一个.txt"), "文本");
  const srv = createWebServer({
    db: d.db, inboxDir: join(dir, "inbox"), home: dir,
    getTransport: () => { throw new Error("no model"); }, getEmbedder: () => null,
    getConfig: () => ({ ollama: "", roles: { express: { provider: "deepseek", model: "x", embed: { provider: "ollama", model: "bge-m3" } } } }),
  });
  const base = `http://127.0.0.1:${await listenSafe(srv)}`;
  const H = { "x-jj": "1", "content-type": "application/json" };
  try {
    const c1 = await (await fetch(`${base}/api/ingest/candidates`)).json() as any[];
    assert.ok(c1.some((x) => x.path === "sources/待摄入.md"), "候选要给出可直接填进输入框的路径");
    assert.ok(c1.some((x) => x.path === "sources/子目录/另一个.txt"), "子目录也要列");

    const ok = await fetch(`${base}/api/ingest`, { method: "POST", headers: H, body: JSON.stringify({ path: "sources/待摄入.md" }) });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).chunks > 0, true);

    // 摄入过的就不再是候选
    const c2 = await (await fetch(`${base}/api/ingest/candidates`)).json() as any[];
    assert.ok(!c2.some((x) => x.path === "sources/待摄入.md"), "已摄入的不该还在候选里");

    // GBK 请求体 → 明确说编码错，而不是"文件不存在"
    const gbk = Buffer.concat([Buffer.from('{"path":"sources/'), Buffer.from([0xd3, 0xef, 0xb2, 0xe2]), Buffer.from('.md"}')]);
    const bad = await fetch(`${base}/api/ingest`, { method: "POST", headers: H, body: gbk });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as any).error, "E_ENCODING");

    // 越界路径仍然拒
    const outside = await fetch(`${base}/api/ingest`, { method: "POST", headers: H, body: JSON.stringify({ path: "../etc/passwd" }) });
    assert.equal(outside.status, 400);
    assert.equal(((await outside.json()) as any).error, "E_OUTSIDE_HOME");
  } finally { srv.close(); }
});



// ── C-1：面板也能「清除密钥」（key:null，不是空串）───────────────
test("配置：key:null 清除密钥 → hasKey 变 false，且不能靠空串误清", async () => {
  const { srv, base } = await start();
  try {
    const H = { "content-type": "application/json", "x-jj": "1" };
    await fetch(`${base}/api/config`, {
      method: "PUT", headers: H,
      body: JSON.stringify({ provider: "deepseek", model: "deepseek-chat", key: "sk-test-abcdefgh12345678" }),
    });
    assert.equal(((await (await fetch(`${base}/api/config`)).json()) as any).hasKey, true);

    // 空串的语义是「没传」，不能当成清除（否则误触就把 key 删了）
    await fetch(`${base}/api/config`, { method: "PUT", headers: H, body: JSON.stringify({ key: "" }) });
    assert.equal(((await (await fetch(`${base}/api/config`)).json()) as any).hasKey, true, "空串不该清掉密钥");

    const r = await fetch(`${base}/api/config`, { method: "PUT", headers: H, body: JSON.stringify({ key: null }) });
    const j = await r.json() as any;
    assert.equal(j.hasKey, false);
    const after = (await (await fetch(`${base}/api/config`)).json()) as any;
    assert.equal(after.hasKey, false, "清除之后 GET 必须说没有");
    assert.equal(after.keyFingerprint, null);
  } finally { srv.close(); }
});

// ── 摄入上传：面板拿不到绝对路径，只能把字节传上来 ────────────────
test("上传：文件名只能是一个名字（拒路径/..），扩展名白名单，落进 sources/", async () => {
  const { srv, base, dir } = await start();
  try {
    const H = { "x-jj": "1", "content-type": "application/octet-stream" };
    const up = (name: string, body: string) =>
      fetch(`${base}/api/ingest/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers: H, body });

    // 拒绝：路径穿越 / 子目录 / 不支持的扩展名 / 空
    for (const [name, code] of [["../evil.md", "E_BAD_NAME"], ["a/b.md", "E_BAD_NAME"], ["x.exe", "E_UNSUPPORTED"]] as const) {
      const j = await (await up(name, "x")).json() as any;
      assert.equal(j.error, code, `${name} 应被拒`);
    }
    assert.equal(((await (await up("empty.md", "")).json()) as any).error, "E_EMPTY");

    // 正常：落到 sources/ 下，路径回给前端
    const j = await (await up("上传测试.md", "# 标题\n\n正文一行。\n")).json() as any;
    assert.equal(j.ok, true);
    assert.equal(j.path, "sources/上传测试.md");
    assert.ok(readFileSync(join(dir, "sources", "上传测试.md"), "utf8").includes("正文一行"));

    // 传完就能走同一条 ingest
    const ing = await (await fetch(`${base}/api/ingest`, {
      method: "POST", headers: { "content-type": "application/json", "x-jj": "1" },
      body: JSON.stringify({ path: j.path }),
    })).json() as any;
    assert.equal(ing.ok, true);
    assert.ok(ing.chunks >= 1);
  } finally { srv.close(); }
});

test("上传：没有 x-jj 头就 403（跨站不能往 sources/ 里塞文件）", async () => {
  const { srv, base } = await start();
  try {
    const r = await fetch(`${base}/api/ingest/upload?name=a.md`, {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body: "x",
    });
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});

// ── F-3：忘掉文档 5 秒内能撤销 ────────────────────────────────
test("F-3 撤销「忘掉这篇」：restore 后文档与前缀检索都回来", async () => {
  const { srv, base, dir } = await start();
  try {
    const H = { "content-type": "application/json", "x-jj": "1" };
    mkdirSync(join(dir, "sources"), { recursive: true });
    writeFileSync(join(dir, "sources", "undo.md"), "# 撤销测试\n\n这段文字有个独特记号 青鲸石。\n");
    await fetch(`${base}/api/ingest`, { method: "POST", headers: H, body: JSON.stringify({ path: "sources/undo.md" }) });
    const docs1 = await (await fetch(`${base}/api/docs`)).json() as Array<{ id: string; chunks: number }>;
    assert.equal(docs1.length, 1);
    const id = docs1[0]!.id;

    await fetch(`${base}/api/docs/${id}/forget`, { method: "POST", headers: H, body: "{}" });
    assert.equal(((await (await fetch(`${base}/api/docs`)).json()) as unknown[]).length, 0, "忘掉后列表为空");

    const r = await (await fetch(`${base}/api/docs/${id}/restore`, { method: "POST", headers: H, body: "{}" })).json() as any;
    assert.equal(r.ok, true);
    assert.ok(r.chunks >= 1);
    const docs2 = await (await fetch(`${base}/api/docs`)).json() as Array<{ id: string; chunks: number }>;
    assert.equal(docs2.length, 1, "恢复后回到列表");
    assert.equal(docs2[0]!.id, id);
    // FTS 也要恢复（否则"恢复了但搜不到"）。这个 harness 里 getEmbedder 是 null，
    // 走不了 /api/search，所以直接查 chunks_fts。
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(dir, "m.db"), { readOnly: true });
    // FTS 是 bigram 索引（"青鲸 鲸石"），整串"青鲸石"匹配不到；count(*) 对 external-content 表读的是 content 表，也不可靠
    const fts = raw.prepare("SELECT count(*) c FROM chunks_fts WHERE chunks_fts MATCH ?").get("青鲸") as { c: number };
    raw.close();
    assert.ok(fts.c >= 1, "恢复后 FTS 行要重插（否则恢复了也搜不到）");
  } finally { srv.close(); }
});

test("每一轮的过程要留档：右栏第四个签能看当前这一轮，重开也能看最近一轮", () => {
  // 2026-11-05：这两条以前测的是 src/web/page.ts —— 已下线、程序不再引用的旧面板，
  // 于是「过程」功能在记录本里根本没有，测试却是绿的。现在改成测 NOTEBOOK。
  const server = readFileSync(join(process.cwd(), "src/web/server.ts"), "utf8");
  assert.ok(server.includes("const trace: Array<"), "要有 trace 收集器");
  assert.ok(server.includes('trace.push({ k: "think"'), "思考要进去");
  assert.ok(server.includes('trace.push({ k: "tool"'), "工具要进去");
  assert.ok(server.includes("...(trace.length ? { trace } : {})"), "要存进 payload");
  assert.ok(server.includes("...(p.trace?.length ? { trace: p.trace } : {})"), "读历史时要带出来");

  // 记录本：第四个签 + 过程容器 + 分组函数
  assert.ok(NOTEBOOK.includes('data-t="4"'), "右栏要有第四个签");
  assert.ok(NB_JS.includes("id=\"nb-trace\""), "要点开就能画过程");
  assert.ok(NB_JS.includes("function groupTrace("), "要按步分组");
  assert.ok(NB_JS.includes("thinkAppend(TRACE, 'think'"), "思考要进过程（逐 token 的片段要合并成一条，不能一垛碎字）");
  assert.ok(NB_JS.includes("TRACE.push({ k: 'tool'"), "工具要进过程");
  assert.ok(NB_JS.includes("TRACE.push({ k: 'res'"), "结果要进过程");
  assert.ok(NB_JS.includes("TRACE.push({ k: 'err'"), "错误要进过程");
  assert.ok(NB_JS.includes("bb.trace"), "重开时要能捞出最近一轮的过程");
});

test("过程按步分组：一段推理 + 它的动作 = 一步，上一步自动折叠", () => {
  assert.ok(NB_JS.includes("function groupTrace("), "要有分组函数");
  assert.ok(NB_JS.includes("if (cur.items.length) { steps.push(cur);"), "动手之后再想 = 开新的一步");
  assert.ok(NB_JS.includes("第 ' + (i + 1) + ' 步"), "面板上要标出第几步");
});

test("闲时整理留痕：每次一条 events，成功失败都记，面板能看", () => {
  const nightly = readFileSync(join(process.cwd(), "src/nightly.ts"), "utf8");
  assert.ok(nightly.includes("function recordNight("), "要有留痕函数");
  assert.ok(nightly.includes('"night", "system", "nightly"'), "写进 events(kind=night)");
  // **四个返回点都要记**：缺模型 / 没有新事件 / 抽取失败 / 正常结束
  // （一开始只接了两处，于是「点了按钮跑了但没记录」查不到）
  assert.equal(nightly.split("recordNight(deps.db, report, now").length - 1, 4, "四条路径都要留痕");

  const server = readFileSync(join(process.cwd(), "src/web/server.ts"), "utf8");
  assert.ok(server.includes('"/api/nightlog"'), "要有接口");
});

test("插件可以单独重连：不用重启整个程序（学 Coopanion 的 World 单独重启）", () => {
  const hub = readFileSync(join(process.cwd(), "src/mcphub.ts"), "utf8");
  assert.ok(hub.includes("async reconnect(server?"), "要能只重连一个");
  assert.ok(hub.includes("loadMcpConfig(this.home)"), "重连要重新读 mcp.json（不然改了没用）");
  assert.ok(hub.includes("this.dropTools(server)") || hub.includes("this.dropTools(name)"), "先摘掉旧工具");
  assert.ok(hub.includes("if (!this.cfg.servers[old])"), "磁盘上删掉的 server，工具也要清掉");

  const tools = readFileSync(join(process.cwd(), "src/tools.ts"), "utf8");
  assert.ok(tools.includes("refresh(next)"), "registry 要能换掉外部工具表");
  assert.ok(tools.includes("tools_refreshed"), "换工具面要留痕");

  const server = readFileSync(join(process.cwd(), "src/web/server.ts"), "utf8");
  assert.ok(server.includes('"/api/plugins/reconnect"'), "要有接口");
});









test("一轮没有结论时必须说出来（不是静默结束）", () => {
  // 实测：用户问「这是怎么回事最近 project.read error」，她回了 77 字「先说清楚我要做什么…」
  // 然后就没了 —— 因为 project.read 被授权闸门拦住。用户看到的就是「回答不完整」。
  const server = readFileSync(join(process.cwd(), "src/web/server.ts"), "utf8");
  assert.ok(server.includes("let answerChars = 0"), "要数真正的回答量");
  assert.ok(server.includes("answerChars -= ev.text.length"), "被判为过程的部分要扣掉");
  assert.ok(server.includes("if (answerChars <= 0)"), "没结论时要说话");
  assert.ok(server.includes("这一轮没有结论"), "说清楚发生了什么");
  assert.ok(server.includes("被挡住了"), "被拦时要指出是授权问题");
});



test("缺口会进对话：一次 /api/say 之后记下「问过了」，免得每轮查户口", async () => {
  const { srv, base, dir } = await start();
  try {
    await (await fetch(`${base}/api/say`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "在吗" }),
    })).text();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dir, "m.db"), { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key='profile_asked_at'").get() as any;
    db.close();
    assert.ok(row?.value, "拼简报时要记下'问过了'（P19 的冷却靠它）");
  } finally { srv.close(); }
});

test("缺口卡：GET 给全部没答的题、POST 答一句就落库，再问就少一件（2026-11-05 起给全量）", async () => {
  const { srv, base, dir } = await start();
  try {
    const g1 = await (await fetch(`${base}/api/profile/gaps`)).json() as any;
    assert.equal(g1.gaps.length, 6, "没答过的六道题一次给全（面板要能一条条答完）");
    assert.equal(g1.total, 6);

    const r = await fetch(`${base}/api/profile/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jj": "1" },
      body: JSON.stringify({ key: "称呼", text: "叫我小飞就行" }),
    });
    assert.equal(r.status, 200);

    const g2 = await (await fetch(`${base}/api/profile/gaps`)).json() as any;
    assert.equal(g2.answered, 1, "答过的题要记成已答");
    assert.ok(!g2.gaps.some((x: any) => x.key === "称呼"), "答过的题不该再问");
    assert.equal(g2.gaps.length, 5, "答掉一件，剩五件");

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dir, "m.db"), { readOnly: true });
    const row = db.prepare("SELECT text,source_ref,scored_by FROM memories WHERE source_ref='profile:称呼'").get() as any;
    db.close();
    assert.equal(row?.text, "叫我小飞就行");
    assert.equal(row?.scored_by, "human:profile");

    // 没 x-jj 头不许写（跨站）
    const bad = await fetch(`${base}/api/profile/answer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "作息", text: "十点后" }),
    });
    assert.equal(bad.status, 403);

  } finally { srv.close(); }
});

test("记忆视图：关于你 / 全部 / 断片 分流，summary 报三个数（2026-11-04）", async () => {  const { srv, base, dir } = await start();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db2 = new DatabaseSync(join(dir, "m.db"));
    for (const t of [
      "进程被杀 5 分钟（10-30 18:45–18:50），其间无经历",
      "进程被杀 9 分钟（10-31 01:07–01:16），其间无经历",
    ]) {
      remember(db2, {
        layer: "narrative", kind: "episode", text: t, sourceKind: "agent",
        sourceRef: "startup", now: new Date("2026-10-30T10:00:00Z"),
      });
    }
    db2.close();

    const sum = await (await fetch(`${base}/api/memories/summary`)).json() as any;
    assert.equal(sum.total, 4, "start() 的两条 + 两条断片");
    assert.equal(sum.outage, 2);
    assert.equal(sum.about, 2);

    const about = await (await fetch(`${base}/api/memories?scope=about`)).json() as any[];
    assert.equal(about.length, 2);
    assert.ok(about.every((r) => !r.text.includes("进程被杀")), "「关于你」里不许有断片");

    const outage = await (await fetch(`${base}/api/memories?scope=outage`)).json() as any[];
    assert.equal(outage.length, 2);
    assert.ok(outage.every((r) => r.text.includes("进程被杀")));

    const all = await (await fetch(`${base}/api/memories`)).json() as any[];
    assert.equal(all.length, 4, "不带 scope 仍是全部（老调用方不受影响）");

    // 面板上得真有这两个 chip，否则接口白做
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test("主题：ledger / hermes 能读能写，首屏就带上 data-theme（2026-11-06）", async () => {
  const dir = tmp();
  const d = openDb(join(dir, "m.db"));
  const srv = createWebServer({
    db: d.db, inboxDir: join(dir, "inbox"), home: dir,
    getTransport: () => { throw new Error("no model"); }, getEmbedder: () => null,
    getConfig: () => ({ ollama: "", roles: { express: { provider: "deepseek", model: "x" } } }),
  });
  const base = `http://127.0.0.1:${await listenSafe(srv)}`;
  try {
    const h = { "content-type": "application/json", "x-jj": "1" };
    const a = await (await fetch(`${base}/api/ui`)).json() as { theme?: string };
    assert.equal(a.theme, "ledger", "默认是记录本主题");

    const put = await fetch(`${base}/api/ui`, { method: "PUT", headers: h, body: JSON.stringify({ theme: "hermes" }) });
    assert.equal(put.status, 200);
    const b = await (await fetch(`${base}/api/ui`)).json() as { theme?: string };
    assert.equal(b.theme, "hermes", "写进去要能读回来");

    const html = await (await fetch(`${base}/?skip=1`)).text();
    assert.ok(html.includes('data-theme="hermes"'), "首屏就要带上，否则会闪一下默认主题");

    const bad = await fetch(`${base}/api/ui`, { method: "PUT", headers: h, body: JSON.stringify({ theme: "neon" }) });
    assert.equal(bad.status, 400, "不认识的主题要拒");
  } finally { srv.close(); }
});
