import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { createWebServer, looksMojibake } from "../src/web/server.ts";
import { execute } from "../src/execute.ts";
import { loadPolicy } from "../src/policy.ts";
import { PAGE } from "../src/web/page.ts";
import { AVATAR_FRAMES } from "../src/web/avatar.ts";
import { groupTimeline, gapLabel } from "../src/web/timeline.ts";
import { expenseLine } from "../src/web/state.ts";
import type { AddressInfo } from "node:net";

const tmp = () => mkdtempSync(join(tmpdir(), "jj-web-"));

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
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  return { srv, port, base: `http://127.0.0.1:${port}`, dir };
}

test("页面里没有「新对话」——重置人格的入口不该存在", () => {
  assert.ok(!PAGE.includes("新对话"));
  assert.ok(PAGE.includes("记忆"));
});

test("GET / 返回单页；/api/state 给出一句话状态", async () => {
  const { srv, base } = await start();
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<title>鲸鲸/);
    // FUI 视觉：黑底 + 采样得到的青色 + 角标面板（不是站酷的亮橙站皮肤）
    assert.ok(html.includes("--void:#0b0e0b"), "底色应是参考图采样的 #0b0e0b");
    assert.ok(html.includes("--cyan:#0f97a4"), "主色应是采样得到的 #0f97a4");
    assert.ok(html.includes(".panelbox::before"), "面板要有角标");
    assert.ok(html.includes("var(--mono)"), "标签用等宽字体");
    assert.ok(!html.includes("--accent:#ff5a2c"), "不要站酷的橙色主色");
    // 布局：侧栏 + 主列（对齐 pi-web 的排列）
    assert.ok(html.includes("grid-template-areas"), "应有侧栏布局");
    assert.ok(html.includes('id="side"') && html.includes("SESSIONS") && html.includes("TOOLS"), "侧栏要有会话/工具");
    // 可视化：markdown 渲染 + 工具卡
    assert.ok(html.includes("details.tool"), "工具调用要能展开");
    assert.ok(html.includes("pre.code"), "代码块要有样式");
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

test("GET /api/memories：无 embedder 时退化为按权重列，不报错", async () => {
  const { srv, base } = await start();
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

test("页面脚本能通过语法检查（模板字符串里的 \n 会被展开成真换行 → 整页 JS 挂掉）", async () => {
  const m = PAGE.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "页面里应有 <script>");
  const js = m![1]!;
  const dir = mkdtempSync(join(tmpdir(), "jj-js-"));
  const f = join(dir, "page.js");
  writeFileSync(f, js, "utf8");
  execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  // 额外断言：字符串字面量里不能出现裸换行（上面 --check 会抓，这里给个更直白的提示）
  assert.ok(!/buf\.split\("[^"]*\n[^"]*"\)/.test(js), "split 参数里出现了真换行");
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

test("图标：鲸鱼 symbol 在页面里，品牌不再用「鲸鲸」文字，也不再有 JJ-OS", () => {
  assert.ok(PAGE.includes('<symbol id="whale"'), "要有一个可复用的鲸鱼 symbol");
  assert.ok(!PAGE.includes("JJ-OS"), "JJ-OS 这个文字要删掉（标题/角标/品牌）");
  assert.ok(!PAGE.includes('<span class="brand">鲸鲸'), "品牌位应该是图标，不是文字");
  assert.ok(PAGE.includes("aria-label=\"鲸鲸\""), "图标要有可读名字");
  // 消息行头像：鲸鱼图标 + USER，不再出现「鲸」字头像
  assert.ok(!PAGE.includes("\"<div class='av'>鲸</div>"), "头像框里的「鲸」字要被图标替掉");
  assert.ok(PAGE.includes("href='#whale'"), "消息行头像用同一个 symbol");
});

test("头像框：可换的五种帧与共用的白名单一致（防两处生成代码漂移）", () => {
  for (const f of AVATAR_FRAMES) {
    assert.ok(PAGE.includes(`body[data-av="${f}"]`), `缺 ${f} 的 CSS`);
    assert.ok(PAGE.includes(`<option value="${f}">`), `缺 ${f} 的选项`);
  }
  // 选项数量必须等于白名单（多一个没 CSS、少一个选不到）
  const opts = PAGE.match(/<option value="(plain|bare|ring|cut|glow)">/g) ?? [];
  assert.equal(opts.length, AVATAR_FRAMES.length);
});

test("GET/PUT /api/ui：默认 plain，存得住，白名单外拒绝，无 CSRF 头 403", async () => {
  const { srv, base, dir } = await start();
  try {
    const a = await (await fetch(`${base}/api/ui`)).json() as any;
    assert.equal(a.avatar, "plain");
    assert.deepEqual(a.frames, [...AVATAR_FRAMES]);

    const ok = await fetch(`${base}/api/ui`, {
      method: "PUT",
      headers: { "x-jj": "1", "content-type": "application/json" },
      body: JSON.stringify({ avatar: "ring" }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await (await fetch(`${base}/api/ui`)).json() as any).avatar, "ring");
    // 落盘在 config.json 的 ui.avatar（换浏览器也跟着走）
    assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).ui.avatar, "ring");

    const bad = await fetch(`${base}/api/ui`, {
      method: "PUT",
      headers: { "x-jj": "1", "content-type": "application/json" },
      body: JSON.stringify({ avatar: "<script>" }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as any).error, "E_BAD_FRAME");

    const noCsrf = await fetch(`${base}/api/ui`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ avatar: "cut" }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await (await fetch(`${base}/api/ui`)).json() as any).avatar, "ring", "被拒的写不能生效");
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

test("待确认：确认后执行、写回结果、并在时间轴里说出来", async () => {
  const dir = tmp();
  const d = openDb(join(dir, "m.db"));
  mkdirSync(join(dir, "workspace"), { recursive: true });
  writeFileSync(join(dir, "workspace", "p.mjs"), "console.log('confirmed-ok')");
  const policy = await loadPolicy(dir);
  const srv = createWebServer({
    db: d.db, inboxDir: join(dir, "inbox"), home: dir, policy,
    getTransport: () => { throw new Error("测试不该真调模型"); },
    getEmbedder: () => null,
    getConfig: () => ({ ollama: "", roles: { express: { provider: "deepseek", model: "x", embed: { provider: "ollama", model: "bge-m3" } } } }),
    now: () => new Date(),
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    // 直接调 execute 产生待确认卡（绕过模型，逻辑一样）
    const r1 = await execute({ db: d.db, policy, ctx: { home: dir, now: () => new Date() } },
      "shell.run", { template: "node.run_script", slots: { script: "p.mjs" } });
    assert.equal(r1.code, "E_NEEDS_CONFIRM");

    const list = await (await fetch(`${base}/api/pending`)).json() as any[];
    assert.equal(list.length, 1, JSON.stringify(list));
    assert.deepEqual(list[0].argv, ["node", "p.mjs"]);
    assert.equal(list[0].status, "pending");

    const ok = await fetch(`${base}/api/pending/${list[0].id}`, {
      method: "POST", headers: { "x-jj": "1", "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm" }),
    });
    const j = await ok.json() as any;
    assert.equal(ok.status, 200, JSON.stringify(j));
    assert.equal(j.ok, true, j.output);
    assert.match(String(j.output), /confirmed-ok/);
    assert.match(String(j.capability), /^cap_/);

    // 卡变成 done，且有结果
    const after = await (await fetch(`${base}/api/pending`)).json() as any[];
    assert.equal(after[0].status, "done");
    assert.match(String(after[0].result), /confirmed-ok/);

    // 再说一次“确认” → 409（不能重复执行）
    const again = await fetch(`${base}/api/pending/${list[0].id}`, {
      method: "POST", headers: { "x-jj": "1", "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm" }),
    });
    assert.equal(again.status, 409);

    // 时间轴里有一条“已按你的确认执行”
    const tl = await (await fetch(`${base}/api/timeline`)).json() as any[];
    const said = tl.filter((b) => b.type === "msg").map((b) => b.text).join("\n");
    assert.match(said, /已按你的确认执行/);
    assert.match(said, /confirmed-ok/);
  } finally { srv.close(); }
});

test("待确认：拒绝就是不执行，且之后不能再确认", async () => {
  const dir = tmp();
  const d = openDb(join(dir, "m.db"));
  mkdirSync(join(dir, "workspace"), { recursive: true });
  writeFileSync(join(dir, "workspace", "q.mjs"), "console.log('SHOULD-NOT-RUN')");
  const policy = await loadPolicy(dir);
  const srv = createWebServer({
    db: d.db, inboxDir: join(dir, "inbox"), home: dir, policy,
    getTransport: () => { throw new Error("no model"); },
    getEmbedder: () => null,
    getConfig: () => ({ ollama: "", roles: { express: { provider: "deepseek", model: "x", embed: { provider: "ollama", model: "bge-m3" } } } }),
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await execute({ db: d.db, policy, ctx: { home: dir, now: () => new Date() } },
      "shell.run", { template: "node.run_script", slots: { script: "q.mjs" } });
    const list = await (await fetch(`${base}/api/pending`)).json() as any[];
    const id = list[0].id;

    const no = await fetch(`${base}/api/pending/${id}`, {
      method: "POST", headers: { "x-jj": "1", "content-type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
    assert.equal(no.status, 200);
    const after = await (await fetch(`${base}/api/pending`)).json() as any[];
    assert.equal(after[0].status, "rejected");

    const late = await fetch(`${base}/api/pending/${id}`, {
      method: "POST", headers: { "x-jj": "1", "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm" }),
    });
    assert.equal(late.status, 409);

    // 没跑：审计里没有 allowed 的 shell.run，时间轴里也没有那句话
    const rows = d.db.prepare("SELECT decision FROM exec_audit WHERE verb='shell.run'").all() as any[];
    assert.ok(!rows.some((r) => r.decision === "allowed"), "被拒绝的提案不该执行");
    const tl = await (await fetch(`${base}/api/timeline`)).json() as any[];
    assert.ok(!tl.some((b) => b.type === "msg" && String(b.text).includes("SHOULD-NOT-RUN")));
  } finally { srv.close(); }
});
