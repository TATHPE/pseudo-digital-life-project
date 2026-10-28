#!/usr/bin/env node
/** jingjing CLI（M0）：migrate | remember | search | verify | outage | decay | bench */
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, selfCheck, meta, setMeta } from "../db.ts";
import { remember, tickDecay, getRow } from "../store.ts";
import { search } from "../retrieve.ts";
import { at } from "../assert.ts";
import { createEmbedder, fakeEmbed } from "../embed.ts";
import { appendEvent, readEvents, newEventId, lastEvent } from "../journal.ts";
import { markStart, markCleanShutdown, detectOutage } from "../boot.ts";
import { defaultConfig } from "../config.ts";
import { routerFrom, createTransport, assertAllLoopback } from "../transport.ts";
import { validateRouter, PrivacyError } from "../provider.ts";
import { createStore, fingerprint, type Provider } from "../auth.ts";
import { record, checkBudget, estimateCost, spentToday } from "../budget.ts";
import { createWebServer } from "../web/server.ts";
import { execute } from "../execute.ts";
import { createStreamTransport, createChatTransport } from "../transport.ts";
import { createToolRegistry } from "../tools.ts";
import { attachMcp, loadMcpConfig } from "../mcp.ts";
import { startup } from "../startup.ts";
import { applyRelease, hasRelease, readStateSafe } from "../deploy/slot.ts";
import { bootAttempt, markHealthy } from "../deploy/watchdog.ts";
import { createStore as createSecretStore } from "../auth.ts";
import { resolveConfig } from "../configfile.ts";

const HOME = process.env.JJ_HOME ?? join(process.cwd(), "data");
const dbFile = join(HOME, "memory.db");
const inbox = join(HOME, "inbox");
const ensureHome = () => { mkdirSync(HOME, { recursive: true }); mkdirSync(inbox, { recursive: true }); };

/**
 * 语料生成：模拟"真实记忆库"（每条都不同）与"最坏情况"（大量重复）
 * 现实语料：2000 个词随机组合 → 一个查询只命中约几百条
 * 最坏语料：10 个模板重复 → 一个查询命中 8000 条（排序成本最大）
 */
const VOCAB: string[] = (() => {
  const out: string[] = [];
  const han = "记忆衰减权重检索向量索引契约叙事人格时间断电恢复工具权限审计心跳自传领地"
    + "咖啡杭州论文向量模型本地云端抽取归并冲突唤醒休眠边界快照备份迁移容器镜像";
  for (let i = 0; i < han.length; i++)
    for (let j = 0; j < han.length; j++) out.push((han[i] ?? "") + (han[j] ?? ""));
  return out;
})();

function realCorpus(i: number): string {
  const rnd = (k: number) => at(VOCAB, (i * 7919 + k * 104729) % VOCAB.length);
  return [rnd(1), rnd(2), rnd(3), rnd(4), rnd(5), rnd(6)].join("") + ` #${i}`;
}

const TEMPLATES = [
  "重要性应该影响衰减速率而不是初始权重",
  "两阶段检索先出候选再算向量再 MMR",
  "断电之后要补算衰减并写一条 outage 记忆",
  "契约层记忆永不衰减只能显式变更",
  "深夜只说一句在就好",
  "论文里的拉伸指数比纯指数更接近真实遗忘",
  "杭州三月的天气适合搬家",
  "记忆面板要能一键纠错而不是让用户改配置文件",
  "本地模型负责抽取与归并，云端只负责表达",
  "dormant 记忆不该物理删除，它还能被强线索唤醒",
];

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return at(s, Math.min(s.length - 1, Math.floor((p / 100) * s.length)));
}

async function bench(rows: number, mode: "real" | "worst"): Promise<void> {
  const file = join(tmpdir(), `jj-bench-${Date.now()}.db`);
  const d = openDb(file);
  const text = (i: number) => (mode === "real" ? realCorpus(i) : `${at(TEMPLATES, i % TEMPLATES.length)} #${i}`);

  const t0 = performance.now();
  d.db.exec("BEGIN");
  for (let i = 0; i < rows; i++) remember(d.db, { layer: "narrative", kind: "episode", text: text(i), embedding: fakeEmbed(text(i)) });
  d.db.exec("COMMIT");
  const insertMs = Math.round(performance.now() - t0);

  const emb = createEmbedder("fake");
  const vecRows = (d.db.prepare("SELECT count(*) c FROM vec_memories").get() as { c: number }).c;

  // 查询：现实语料取某条记忆里的词；最坏语料取模板前缀
  const queries = Array.from({ length: 5 }, (_, i) =>
    mode === "real" ? realCorpus(i * 977).replace(/ #.*$/, "").slice(0, 6) : at(TEMPLATES, i).slice(0, 6));

  // ① 暴力向量扫描（对照，不用它）
  const qv = at(await emb.embed([at(queries, 0)]), 0);
  const tb = performance.now();
  d.db.prepare("SELECT memory_id FROM vec_memories WHERE embedding MATCH ? ORDER BY distance LIMIT 8")
    .all(new Uint8Array(qv.buffer));
  const bruteMs = +(performance.now() - tb).toFixed(1);

  // ② 两阶段（先预热 2 轮：JIT + 页缓存，正式基准的常规做法）
  for (let w = 0; w < 2; w++) await search(d.db, emb, at(queries, w % queries.length), { k: 8 });
  const totals: number[] = [], s1: number[] = [], s2: number[] = [];
  for (const q of queries) for (let r = 0; r < 4; r++) {
    const { meta: m } = await search(d.db, emb, q, { k: 8 });
    totals.push(m.totalMs); s1.push(m.stage1Ms); s2.push(m.stage2Ms);
  }
  const out = {
    rows, mode, vecRows, insertMs, bruteForceKnnMs: bruteMs,
    twoStage: {
      stage1P50: pct(s1, 50), stage1P95: pct(s1, 95),
      stage2P50: pct(s2, 50), stage2P95: pct(s2, 95),
      totalP50: pct(totals, 50), totalP95: pct(totals, 95), samples: totals.length,
    },
    gate: { target: 20, pass: pct(totals, 95) <= 20, appliesTo: "real only" },
  };
  console.log(JSON.stringify(out, null, 2));
  d.db.close();
  try { rmSync(file, { force: true }); rmSync(file + "-wal", { force: true }); rmSync(file + "-shm", { force: true }); } catch { /* ignore */ }
  process.exitCode = mode === "real" && !out.gate.pass ? 1 : 0;
}

async function main(): Promise<void> {
  ensureHome();
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "migrate": {
      const d = openDb(dbFile);
      console.log(JSON.stringify({ db: dbFile, vec: d.vecLoaded, schema: meta(d.db, "schema_version"), check: selfCheck(d) }, null, 2));
      return;
    }
    case "remember": {
      const text = rest.join(" ") || "（空）";
      const d = openDb(dbFile);
      const v = at(await createEmbedder("fake").embed([text]), 0);
      const id = remember(d.db, { layer: "narrative", kind: "episode", text, embedding: v });
      appendEvent(inbox, { v: 1, id: newEventId(), ts: new Date().toISOString(), kind: "memory_write", actor: "user", payload: { id, text } });
      console.log(JSON.stringify({ id, weight: getRow(d.db, id)?.weight }));
      return;
    }
    case "search": {
      const q = rest.join(" ");
      const d = openDb(dbFile);
      const r = await search(d.db, createEmbedder("fake"), q, { k: 5 });
      console.log(JSON.stringify({ meta: r.meta, hits: r.hits.map(({ id, text, score, stage, weight }) => ({ id, text, score: +score.toFixed(5), stage, weight })) }, null, 2));
      return;
    }
    case "verify": {
      const d = openDb(dbFile);
      const boot = markStart(HOME);
      const { events, quarantined, corrupted } = readEvents(inbox, { quarantine: true });
      const last = lastEvent(events);
      const outage = detectOutage(HOME, last ? new Date(last.ts) : null, new Date(), boot.clean);
      const check = selfCheck(d);
      console.log(JSON.stringify({
        ok: check.ok && corrupted === 0, vec: d.vecLoaded, schema: meta(d.db, "schema_version"),
        inbox: { events: events.length, quarantined, corrupted }, outage, notes: check.notes,
      }, null, 2));
      markCleanShutdown(HOME);
      return;
    }
    case "outage": {
      const times = Number(rest[0] ?? 3);
      let failed = 0;
      for (let i = 0; i < times; i++) {
        appendEvent(inbox, { v: 1, id: newEventId(), ts: new Date().toISOString(), kind: "utterance", actor: "user", payload: { text: `断电前第 ${i} 句` } });
        const f = join(inbox, `${new Date().toISOString().slice(0, 10)}.jsonl`);
        appendFileSync(f, '{"v":1,"id":"trunc","ts":"2026-10-27T10:0');
        const r = readEvents(inbox, { quarantine: true });
        if (!(r.quarantined >= 1 && r.corrupted === 0 && r.events.length >= i + 1)) {
          failed++; console.log("FAIL", { i, events: r.events.length, q: r.quarantined, c: r.corrupted });
        }
        const raw = readFileSync(f, "utf8");
        writeFileSync(f, raw.slice(0, raw.lastIndexOf('{"v":1,"id":"trunc"')));
      }
      console.log(JSON.stringify({ times, failed, pass: failed === 0 }));
      process.exitCode = failed ? 1 : 0;
      return;
    }
    case "serve": {
      const port = Number(rest[0] ?? 7700);
      const cfg = defaultConfig();
      const d = openDb(dbFile);
      const boot = markStart(HOME);
      // A/B 双槽（18 §4.3）：先应用 active 版本的载荷，再记一次「我要启动了」。
      // listen 成功之后上报健康——看门狗就靠这两条标记判断这次启动到底成没成。
      const dep = readStateSafe(HOME);
      const release = dep.corrupt ? null : dep.state.active;
      if (dep.corrupt) console.log("⚠ deploy/state.json 损坏：本次不做回滚保护（版本事实源读不到）");
      if (release && hasRelease(HOME, release)) {
        if (!dep.corrupt && dep.state.applied !== release) {
          try {
            const w = applyRelease(HOME, release);
            console.log(`版本 ${release}：应用 ${w.written.length} 个文件`);
          } catch (e) {
            console.log(`⚠ 版本 ${release} 无法应用（${String(e).slice(0, 100)}）→ 保持上一版载荷`);
          }
        }
        try { bootAttempt(HOME, release); } catch { /* 版本目录被删 → 退化为单槽 */ }
      }
      const boot1 = startup({ db: d.db, inboxDir: inbox, home: HOME, cleanLastShutdown: boot.clean });
      if (boot1.outage) {
        console.log(`断电/停机：${boot1.outage.kind} ${boot1.outage.from.toISOString().slice(0, 16)} → ${boot1.outage.to.toISOString().slice(0, 16)}（已记一笔）`);
      }
      console.log(`补算衰减 ${boot1.decayed} 条 · inbox ${boot1.inbox.events} 事件（隔离 ${boot1.inbox.quarantined}）`);
      // embedding 指纹（02 §6 / 18 §1.3）：换模型或换量化都会让它变，
      // 变了就说明「检索结果和以前不可比」。不是装饰字段。
      try {
        const e = defaultConfig().roles.embed;
        if (e) setMeta(d.db, "embed_model", `${e.provider}:${e.model}`);
      } catch { /* 记录失败不影响启动 */ }
      const store = createSecretStore(join(HOME, "secrets"));
      const keys: Record<string, string> = {};
      for (const p of ["deepseek", "anthropic", "openai"] as Provider[]) {
        const k = store.get(p); if (k) keys[p] = k;
      }
      // 面板可以改 API 配置 → 每次现取（配置文件的 mtime 有缓存，开销可忽略）
      const getConfig = () => {
        const c = resolveConfig(HOME);
        return c;
      };
      const getTransport = () => {
        const c = getConfig();
        const ks: Record<string, string> = {};
        for (const p of ["deepseek", "anthropic", "openai"] as Provider[]) {
          const k = store.get(p); if (k) ks[p] = k;
        }
        return createStreamTransport(routerFrom(c.roles as any), { apiKeys: ks });
      };
      const getEmbedder = () => {
        const c = getConfig();
        return createEmbedder("ollama", { baseUrl: c.ollama, model: c.roles.embed!.model });
      };
      // 工具面：verb 目录 + MCP 外部工具，全部走同一条 execute 路径
      const policy = await import("../policy.ts").then((m) => m.loadPolicy(HOME));
      const externals: Array<{ name: string; description: string; parameters: Record<string, unknown>; tier: string; call(a: Record<string, unknown>): Promise<string> }> = [];
      const mcpCfg = loadMcpConfig(HOME);
      const mcp = await attachMcp(mcpCfg, (t) => externals.push({
        name: t.name, description: t.description, tier: "T2",
        parameters: t.parameters as Record<string, unknown>,
        call: (a) => t.call(a),
      }));
      if (mcp.tools.length) console.log(`MCP 工具: ${mcp.tools.join(", ")}`);
      if (mcp.errors.length) console.log(`MCP 未连上: ${mcp.errors.join(" | ")}`);

      const getChat = () => {
        const c = getConfig();
        const ks: Record<string, string> = {};
        for (const p of ["deepseek", "anthropic", "openai"] as Provider[]) { const k = store.get(p); if (k) ks[p] = k; }
        const t = createChatTransport(routerFrom(c.roles as any), { apiKeys: ks });
        return (messages: unknown[], tools: any) => t.chat("express", messages, {
          containsMemory: false, purpose: "agent", maxTokens: 1200, tools,
        });
      };
      const toolCtx = () => ({ db: d.db, embedder: getEmbedder(), home: HOME, now: () => new Date() });
      const registry = createToolRegistry({ db: d.db, policy, ctx: toolCtx(), external: externals });
      const srv = createWebServer({
        db: d.db, inboxDir: inbox, home: HOME, getTransport, getEmbedder, getConfig,
        tools: registry, getChat, pendingOutage: boot1.outage,
      });
      srv.listen(port, "127.0.0.1", () => {
        console.log(`鲸鲸面板: http://127.0.0.1:${port}  (store=${store.kind}, express=${cfg.roles.express!.provider}/${cfg.roles.express!.model})`);
        if (release) { try { markHealthy(HOME, release); } catch { /* 单槽模式 */ } }
      });

      // 可选：心跳（01 §10）。默认不开——没有主动性的需求时，安静就是最好的行为。
      if (rest.includes("--beat")) {
        const { beat } = await import("../heartbeat.ts");
        const draft = async (r: { kind: string; text: string }) => {
          let out = "";
          const prompt = "把下面这条主动开口的理由，写成一句自然的中文（≤40字，不要解释，不要客套）：" + String.fromCharCode(10) + r.text;
          for await (const ev of createChatTransport(routerFrom(getConfig().roles as any), { apiKeys: keys })
            .chat("express", [{ role: "user", content: prompt }], { containsMemory: false, purpose: "beat-draft", maxTokens: 120 })) {
            if (ev.type === "delta") out += ev.text;
          }
          return out;
        };
        console.log("心跳已启动：每 60s 判定一次（静音 23:30–08:00，每日 ≤3 次）");
        setInterval(() => {
          void beat({ db: d.db, inboxDir: inbox, draft }).then((r) => {
            const tag = r.decision.send ? "SEND" : `DROP(${r.decision.gate})`;
            console.log(`[beat] ${new Date().toISOString().slice(11, 19)} ${tag} ${r.decision.reason.kind}` +
              (r.message ? ` → ${r.message.slice(0, 40)}` : ""));
          }).catch((e) => console.log("[beat] error", String(e).slice(0, 120)));
        }, 60_000);
      }
      return;
    }
    case "config": {
      const cfg = defaultConfig();
      const problems = validateRouter(cfg.roles as any);
      console.log(JSON.stringify({ ollama: cfg.ollama, roles: cfg.roles, problems, ok: problems.length === 0 }, null, 2));
      process.exitCode = problems.length ? 1 : 0;
      return;
    }
    case "auth": {
      const store = createStore(join(HOME, "secrets"));
      const [op, provider] = [rest[0], rest[1] as Provider | undefined];
      if (op === "set" && provider) {
        const chunks: Buffer[] = [];
        await new Promise<void>((res) => {
          process.stdin.on("data", (c) => chunks.push(c as Buffer));
          process.stdin.on("end", () => res());
        });
        const key = Buffer.concat(chunks).toString("utf8").trim();
        if (!key) { console.error("用法: echo <KEY> | jingjing auth set <provider>"); process.exitCode = 1; return; }
        store.set(provider, key);
        console.log(JSON.stringify({ ok: true, store: store.kind, provider, fingerprint: fingerprint(key) }));
        return;
      }
      if (op === "list") {
        console.log(JSON.stringify({ store: store.kind, keys: store.list() }, null, 2));
        return;
      }
      console.error("用法: jingjing auth <set|list> [provider]");
      process.exitCode = 1;
      return;
    }
    case "usage": {
      const d = openDb(dbFile);
      const spent = spentToday(d.db);
      const rows = d.db.prepare("SELECT role,provider,model,count(*) n,sum(in_tokens) i,sum(cached_tokens) c,sum(out_tokens) o,round(sum(usd),6) usd FROM usage GROUP BY role,provider,model ORDER BY usd DESC").all();
      console.log(JSON.stringify({ spentTodayUsd: +spent.toFixed(6), rows }, null, 2));
      return;
    }
    case "test": {
      const what = rest[0] ?? "all";
      if (what === "leak" || what === "all") {
        // 用"会成功"的假 fetch：断言守卫在 fetch 之前就拦住了
        let calls = 0;
        const stub = (async () => { calls++; return { ok: true, status: 200, json: async () => ({ content: [{ text: "x" }] }), text: async () => "" } as any; }) as any;
        const t = createTransport(routerFrom(defaultConfig().roles as any), { fetchImpl: stub });
        let blocked = false;
        try {
          await t.complete("express", [{ role: "user", content: "你还记得吗" }], { containsMemory: true, purpose: "leak-test" });
        } catch (e) {
          blocked = e instanceof PrivacyError;
        }
        const pass = blocked && calls === 0 && t.spans().length === 0;
        console.log(JSON.stringify({ test: "leak", blocked, outboundCalls: calls, pass }));
        if (!pass) process.exitCode = 1;
      }
      if (what === "cloud" || what === "all") {
        const cfg = defaultConfig();
        const store = createStore(join(HOME, "secrets"));
        const keys: Record<string, string> = {};
        for (const p of ["deepseek", "anthropic", "openai"] as Provider[]) {
          const k = store.get(p); if (k) keys[p] = k;
        }
        const express = cfg.roles.express!;
        const out: any = { test: "cloud", provider: express.provider, model: express.model, store: store.kind, hasKey: Boolean(keys[express.provider]) };
        if (!keys[express.provider]) {
          out.pass = false; out.hint = `缺 ${express.provider} 的 key：echo <KEY> | node src/cli/jingjing.ts auth set ${express.provider}`;
          console.log(JSON.stringify(out, null, 2)); process.exitCode = 1; return;
        }
        const t = createTransport(routerFrom(cfg.roles as any), { apiKeys: keys });
        try {
          const r = await t.complete("express", [
            { role: "system", content: "只回答一个字，不要标点。" },
            { role: "user", content: "回复：好" },
          ], { containsMemory: false, maxTokens: 16, purpose: "cloud-smoke" });
          out.reply = r.text.slice(0, 40);
          out.usage = r.usage;
          out.usd = +estimateCost(express.provider, express.model, { inTokens: r.usage?.inTokens, outTokens: r.usage?.outTokens }).toFixed(6);
          out.spans = t.spans().map((s) => `${s.role}→${s.host}${s.path} ${s.ms}ms ${s.ok ? "ok" : "fail"}`);
          // 记一笔账（同时也是 usage 表的第一条真实数据）
          const d = openDb(dbFile);
          record(d.db, { ts: new Date().toISOString(), role: "express", provider: express.provider, model: express.model,
            inTokens: r.usage?.inTokens ?? 0, cachedTokens: r.usage?.cachedTokens ?? 0, outTokens: r.usage?.outTokens ?? 0, usd: out.usd });
          out.budget = checkBudget(d.db, 2.0, "degrade_local");
          out.pass = true;
        } catch (e) {
          out.error = String(e).slice(0, 300);
          out.pass = false;
        }
        console.log(JSON.stringify(out, null, 2));
        if (!out.pass) process.exitCode = 1;
      }
      if (what === "offline" || what === "all") {
        const cfg = defaultConfig();
        const t = createTransport(routerFrom(cfg.roles as any));
        const out: any = { test: "offline", ollama: cfg.ollama };
        try {
          const vs = await t.embed("embed", ["记忆衰减"], { containsMemory: true, purpose: "offline-embed" });
          out.embedDim = at(vs, 0).length;
          const r = await t.complete("route", [{ role: "user", content: "说一个字：好" }], { containsMemory: false, maxTokens: 8, purpose: "offline-chat" });
          out.reply = r.text.slice(0, 40);
          out.spans = t.spans().map((s) => `${s.role}→${s.host}${s.path} ${s.ms}ms`);
          const escapees = assertAllLoopback(t.spans());
          out.escapees = escapees;
          out.pass = escapees.length === 0;
        } catch (e) {
          out.error = String(e).slice(0, 200);
          out.pass = false;
          out.hint = "确认 ollama 在跑且已 pull 模型（ollama pull bge-m3 / qwen2.5:1.5b-instruct）";
        }
        console.log(JSON.stringify(out, null, 2));
        if (!out.pass) process.exitCode = 1;
      }
      return;
    }
    case "night": {
      const { runNightCli } = await import("./night.ts");
      const code = await runNightCli({
        home: HOME, dbFile, inbox,
        skipAutobio: rest.includes("--no-autobio"),
        dryRun: rest.includes("--dry-run"),
      });
      process.exitCode = code;
      return;
    }
    case "redteam": {
      const { runRedteam } = await import("./redteam.ts");
      const r = await runRedteam(HOME);
      for (const [id, name, ok, detail] of r.rows) {
        console.log(`${ok ? "✅" : "❌"} #${String(id).padStart(2)} ${name.padEnd(34)} ${detail}`);
      }
      console.log(`
${r.pass}/${r.total} 拦截/放行符合预期`);
      process.exitCode = r.pass === r.total ? 0 : 1;
      return;
    }
    case "verb": {
      const name = rest[0];
      if (!name) { console.log("用法: jingjing verb <name> [jsonArgs]"); process.exitCode = 1; return; }
      const d = openDb(dbFile);
      const policy = await import("../policy.ts").then((m) => m.loadPolicy(HOME));
      const args = rest[1] ? JSON.parse(rest[1]) : {};
      const r = await execute({ db: d.db, policy, ctx: { home: HOME, now: () => new Date() } }, name, args, { approved: rest.includes("--yes") });
      console.log(JSON.stringify(r, null, 2));
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case "beat": {
      const { beat, recentIntents } = await import("../heartbeat.ts");
      const d = openDb(dbFile);
      const cfg = resolveConfig(HOME);
      const store = createSecretStore(join(HOME, "secrets"));
      const keys: Record<string, string> = {};
      for (const p of ["deepseek", "anthropic", "openai"] as Provider[]) { const k = store.get(p); if (k) keys[p] = k; }
      const chat = createChatTransport(routerFrom(cfg.roles as any), { apiKeys: keys });
      const draft = async (r: { kind: string; text: string }) => {
        let out = "";
        const prompt = "把下面这条主动开口的理由，写成一句自然的中文（≤40字，不要解释，不要客套）：" + String.fromCharCode(10) + r.text;
        for await (const ev of chat.chat("express", [{ role: "user", content: prompt }], {
          containsMemory: false, purpose: "beat-draft", maxTokens: 120,
        })) if (ev.type === "delta") out += ev.text;
        return out;
      };
      const dry = rest.includes("--dry-run");
      const res = await beat({ db: d.db, inboxDir: inbox, draft: dry ? undefined : draft, dryRun: dry });
      console.log(JSON.stringify({
        send: res.decision.send,
        gate: res.decision.gate ?? null,
        reason: res.decision.reason,
        ctx: res.decision.ctx,
        message: res.message,
        draftError: res.draftError ?? null,
        intentId: res.intentId,
        recent: recentIntents(d.db, 5),
      }, null, 2));
      return;
    }
    case "eval": {
      const { runEvalCli } = await import("./eval.ts");
      if (rest.includes("--seed")) {
        const d = openDb(dbFile);
        const { seedCases, saveCases, casesPath } = await import("../eval.ts");
        const cs = seedCases(d.db);
        saveCases(HOME, cs);
        console.log(JSON.stringify({ seeded: cs.length, path: casesPath(HOME) }));
        return;
      }
      process.exitCode = await runEvalCli({
        home: HOME, dbFile,
        k: Number((rest.find((r) => r.startsWith("--k=")) ?? "--k=5").split("=")[1]),
        useModel: rest.includes("--model"),
        json: rest.includes("--json"),
      });
      return;
    }
    case "decay": {
      const d = openDb(dbFile);
      console.log(JSON.stringify({ recomputed: tickDecay(d.db), paramsVersion: 1 }));
      return;
    }
    case "bench": {
      await bench(Number(rest[0] ?? 40000), (rest[1] as "real" | "worst") ?? "real");
      return;
    }
    default:
      console.log("用法: node src/cli/jingjing.ts <migrate|remember|search|verify|outage|decay|bench> [args]");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
