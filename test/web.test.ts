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
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
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

test("PWA：manifest / 图标 / sw.js 都能取到，且 manifest 里的图标路径真的存在", async () => {
  const { srv, base } = await start();
  try {
    const m = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(m.status, 200);
    assert.match(String(m.headers.get("content-type")), /manifest\+json/);
    const man = await m.json() as any;
    assert.equal(man.name, "鲸鲸");
    assert.equal(man.display, "standalone");
    assert.equal(man.start_url, "/");
    assert.equal(man.theme_color, "#0b0e0b");
    assert.ok(Array.isArray(man.icons) && man.icons.length >= 2);

    // manifest 里写的每个图标必须真能取到 PNG（否则装到桌面是个空白图）
    for (const icon of man.icons) {
      const r = await fetch(base + icon.src);
      assert.equal(r.status, 200, icon.src);
      assert.equal(r.headers.get("content-type"), "image/png");
      const buf = new Uint8Array(await r.arrayBuffer());
      assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${icon.src} 不是 PNG`);
      assert.ok(buf.length > 500, `${icon.src} 太小`);
    }

    // 不存在的尺寸 → 404（别把任意文件名映射到同一张图）
    assert.equal((await fetch(`${base}/icon-999.png`)).status, 404);

    const sw = await (await fetch(`${base}/sw.js`)).text();
    assert.match(sw, /jj-shell-v1/, "缓存名要对得上");
    assert.ok(sw.includes("'/api/'"), "API 不该被缓存");
    assert.ok(sw.includes("caches.match('/')"), "离线时至少要把壳打开");
  } finally { srv.close(); }
});

test("页面 head：PWA 元信息齐（manifest / theme-color / apple-touch-icon / 安全区）", () => {
  assert.ok(PAGE.includes('rel="manifest" href="/manifest.webmanifest"'));
  assert.ok(PAGE.includes('name="theme-color"'));
  assert.ok(PAGE.includes('rel="apple-touch-icon"'));
  assert.ok(PAGE.includes("viewport-fit=cover"), "刘海屏要自己控制安全区");
  assert.ok(PAGE.includes("env(safe-area-inset-bottom)"), "手势条会压住输入框");
  assert.ok(PAGE.includes('navigator.serviceWorker.register("/sw.js")'));
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

test("面板 UX 契约：P0/P1 的入口都在页面里（防止以后被改没）", () => {
  // P0：证据链 / 审计 / 版本 / 工具默认折叠
  assert.ok(PAGE.includes('data-cite'), "引用要变成可点元素");
  assert.ok(PAGE.includes("recallHtml"), "召回行渲染函数要在");
  assert.ok(PAGE.includes('id="auditlist"') && PAGE.includes('id="auditview"'), "动作审计入口");
  assert.ok(PAGE.includes('id="metachip"'), "版本/冻结状态 chip");
  assert.ok(!PAGE.includes("details class='tool' open"), "工具卡不该默认展开");
  // P1：摄入 / 停止 / 搜索 / 记忆纠错 / 角标 / 测连接 / 用量
  assert.ok(PAGE.includes('id="dlg-path"') && PAGE.includes('id="dlg-go"'), "面板内摄入");
  assert.ok(PAGE.includes('id="stop"') && PAGE.includes("AbortController"), "能停止生成");
  assert.ok(PAGE.includes('id="q"') && PAGE.includes("/api/search"), "搜索");
  assert.ok(PAGE.includes('id="mv-edit"') && PAGE.includes('id="mv-save"'), "记忆可纠错");
  assert.ok(PAGE.includes('id="pendbadge"'), "待确认角标");
  assert.ok(PAGE.includes('id="c-test"'), "测试连接");
  assert.ok(PAGE.includes('id="c-usage"') && PAGE.includes("/api/usage"), "今日花费");
  // P2：多行输入 / 回到最新 / 快捷键 / 时间戳无秒
  assert.match(PAGE, /<textarea id="m"/, "输入框应可多行");
  assert.ok(PAGE.includes('id="jump"'), "回到最新");
  assert.ok(PAGE.includes('e.key.toLowerCase() === "k"'), "Ctrl+K 搜索");
  assert.ok(!PAGE.includes("p(d.getSeconds())"), "时间戳不该带秒");
  // [hidden] 必须压过类里的 display（角标曾经因此永远显示）
  assert.ok(PAGE.includes("[hidden] { display:none !important; }"));
});

test("接口：/api/audit 只回字段不泄漏，/api/search 空查询直接返回", async () => {
  const { srv, base } = await start();
  try {
    const a = await (await fetch(`${base}/api/audit?limit=5`)).json() as any[];
    assert.ok(Array.isArray(a));
    if (a.length) {
      assert.ok("verb" in a[0] && "decision" in a[0] && "ts" in a[0]);
      assert.ok(!("argv_json" in a[0]), "审计列表不要回原始 argv 全文");
    }
    const s = await (await fetch(`${base}/api/search?q=`)).json() as any;
    assert.deepEqual(s, { mem: [], docs: [] });
    const u = await (await fetch(`${base}/api/usage`)).json() as any;
    assert.equal(typeof u.todayUsd, "number");
    assert.ok(u.budgetUsd > 0);
  } finally { srv.close(); }
});

test("favicon：静态 /icon.svg 里的 viewBox 必须是符号自己的（之前写死 24×24 导致标签页空白）", async () => {
  const { srv, base } = await start();
  try {
    const svg = await (await fetch(`${base}/icon.svg`)).text();
    assert.match(svg, /viewBox="0 0 512 512"/, "viewBox 必须和 symbol 一致");
    assert.ok(svg.includes("M453.004"), "要真的是那条鲸尾路径");
    assert.match(svg, /color="#000"/, "currentColor 需要 color 才有颜色（标签页用黑色）");
    assert.match(svg, /^<svg xmlns=/, "必须是独立 SVG 文档");
    assert.ok(PAGE.includes('rel="icon" type="image/svg+xml" href="/icon.svg"'), "head 里要有静态图标链接");
    assert.ok(!PAGE.includes("function favicon()"), "不要再靠运行时拼 data URI");
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
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
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

test("面板：头像可换 / 三个分区可折叠 / 气泡两侧不同", () => {
  assert.ok(PAGE.includes('id="up-agent"') && PAGE.includes('id="up-user"'), "两侧头像都要能换");
  assert.ok(PAGE.includes('id="rm-agent"'), "要能恢复默认");
  assert.ok(PAGE.includes("/api/avatar"), "走头像接口");
  for (const k of ["mem", "docs", "actions"]) {
    assert.ok(PAGE.includes(`data-sec="${k}"`), `${k} 分区要可折叠`);
    assert.ok(PAGE.includes(`data-tog="${k}"`));
  }
  // 两侧气泡底色不同（不然长消息看着像没有气泡）
  assert.ok(PAGE.includes(".row.user .body { background:rgba(38,28,14,.92)"), "用户气泡要有自己的底色");
  // 只写 margin-left:auto 是空操作（inline-block 不吃 auto 边距）—— 必须配 width:fit-content
  const userBody = PAGE.slice(PAGE.indexOf(".row.user .body {"), PAGE.indexOf(".row.user .body {") + 260);
  assert.ok(userBody.includes("margin-left:auto"), "用户气泡要 auto 左边距");
  assert.ok(userBody.includes("width:fit-content"), "否则 auto 边距不起作用，气泡会贴在左边");
  assert.ok(userBody.includes("display:block"), "inline-block 上的 auto 边距无效");
});
