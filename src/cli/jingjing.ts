#!/usr/bin/env node
/** jingjing CLI（M0）：migrate | remember | search | verify | outage | decay | bench */
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
import { listLinks, cutLink } from "../links.ts";
import { listProposals, getProposal, setProposalStatus } from "../proposals.ts";
import { openThreads, closeThread } from "../threads.ts";
import { openGrant, listGrants, revokeGrant } from "../grant.ts";
import { addStanding, listStanding, disableStanding, runDue, parseWhen } from "../standing.ts";
import { listReceipts, markSeen, unseenCount } from "../notify.ts";
import { createWebServer } from "../web/server.ts";
import { execute } from "../execute.ts";
import { createStreamTransport, createChatTransport } from "../transport.ts";
import { withFallback } from "../agent.ts";
import { createToolRegistry } from "../tools.ts";
import { attachMcp, loadMcpConfig } from "../mcp.ts";
import { startup } from "../startup.ts";
import { applyRelease, hasRelease, readStateSafe } from "../deploy/slot.ts";
import { bootAttempt, markHealthy } from "../deploy/watchdog.ts";
import { createStore as createSecretStore } from "../auth.ts";
import { resolveConfig, configSources, readFileConfig, writeFileConfig } from "../configfile.ts";
import { probeChat, probeEmbed, isInstalled } from "../ollama.ts";
import { preflight, missingFrom } from "../preflight.ts";
import { indexState, ensureIndexModel } from "../embedindex.ts";
import { w0FromImportance, DECAY_PARAMS_VERSION, KIND_PARAMS, T, RECONSOLIDATION, ACCESS } from "../decay.ts";
import { modelKeyOf } from "../config.ts";
import { applyDecayConfig, effectiveParams, currentOverrides, decayVersion, setDecayParam, resetDecayParams, readAudit } from "../decayparams.ts";
import { reembed as reembedBuild } from "../reembed.ts";
import { capabilities, summarize } from "../capabilities.ts";
import { doctor, exportDiag } from "../doctor.ts";
import { checkConfig, describeProblems, EXIT_CONFIG } from "../startupcheck.ts";
import { CLI_COMMANDS } from "../commands.ts";
import { reset as coolReset } from "../cooldown.ts";

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
  try { await benchInner(rows, mode); } finally { /* cleanup 挂在 exit 上 */ }
}

async function benchInner(rows: number, mode: "real" | "worst"): Promise<void> {
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

/** 取 --name value 的值；没有就返回 undefined */
const flag = (rest: string[], name: string): string | undefined => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (rest: string[], name: string): boolean => rest.includes(name);

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
      const id = remember(d.db, { layer: "narrative", kind: "episode", text, embedding: v, scoredBy: "human:cli" });
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
      // 待确认卡 / 令牌都留一天就够；启动时清一次，避免目录无界增长
      try {
        const { sweepPending } = await import("../confirm.ts");
        const { sweepTokens } = await import("../shell.ts");
        sweepPending(HOME); sweepTokens(HOME);
      } catch { /* 清理失败不影响启动 */ }
      // embedding 指纹（02 §6 / 18 §1.3）：换模型或换量化都会让它变，
      // 变了就说明「检索结果和以前不可比」。不是装饰字段。
      try {
        // 必须用 resolveConfig：以前写的是 defaultConfig()（不读 config.json），
        // 于是用户在面板里换了 embedding，这里的“指纹”还是老的。
        const e = resolveConfig(HOME).roles.embed;
        if (e && e.model) {
          const cur = modelKeyOf(e)!;
          setMeta(d.db, "embed_model", cur);
          ensureIndexModel(d.db, cur);      // 空库直接盖戳，别让新装用户看到假 stale
        }
      } catch { /* 记录失败不影响启动 */ }
      // 启动时**火一下**端点探测（不等结果）：这样 /health 在几秒内就能说真话，
      // 而探针本身不必去敲端口（否则 healthcheck 会被 3 s 超时拖长）。
      void preflight(resolveConfig(HOME).ollama).catch(() => {});
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
      // 用 McpHub：能**单独重连**某个 server（学 Coopanion 的 World 可单独重启）
      const { McpHub } = await import("../mcphub.ts");
      const hub = new McpHub(HOME, externals);
      const mcp = await hub.startAll();
      if (mcp.tools.length) console.log(`MCP 工具: ${mcp.tools.join(", ")}`);
      if (mcp.errors.length) console.log(`MCP 未连上: ${mcp.errors.join(" | ")}`);

      const getChat = () => {
        const c = getConfig();
        const ks: Record<string, string> = {};
        for (const p of ["deepseek", "anthropic", "openai"] as Provider[]) { const k = store.get(p); if (k) ks[p] = k; }
        // 记账：流结束时 transport 会抛出真实 token 数（不估）。之前这里没接，
        // 所以「今日花费」几乎永远是 $0，预算闸也形同虚设。
        const t = createChatTransport(routerFrom(c.roles as any), { apiKeys: ks, onUsage: (u) => {
          try {
            record(d.db, {
              ts: new Date().toISOString(), role: u.role, provider: u.provider, model: u.model,
              inTokens: u.inTokens, cachedTokens: 0, outTokens: u.outTokens,
              usd: +estimateCost(u.provider, u.model, { inTokens: u.inTokens, outTokens: u.outTokens }).toFixed(6),
            });
          } catch { /* 记账失败不影响回答 */ }
        } });
        // 用户 2026-10-31 定的边界：**本地模型只负责管理记忆（夜间抽取），不参与对话**。
        // 所以这里不再挂本地兜底 —— 云端不可用就该**明说不可用**，而不是换一个 7B 装作是她。
        // （旧行为：withFallback 到本地 night/route 角色，用户根本分不清刚才是谁在答。）
        return (messages: unknown[], tools: any) => t.chat("express", messages, {
          // 1200 对中文长回答不够（≈800-1800 字），她经常在编号列表中间被切断。
          // 3000 是「一整轮说清楚」的量；再长的回答本来也该分轮。
          // 工作模式：单轮输出放宽到 6000（连着干活时 3000 常在编号列表中间截断）
          containsMemory: false, purpose: "agent",
          maxTokens: (() => { try { return resolveConfig(HOME).mode === "work" ? 6000 : 3000; } catch { return 3000; } })(), tools,
        });
      };
      const toolCtx = () => ({ db: d.db, embedder: getEmbedder(), home: HOME, now: () => new Date() });
      const registry = createToolRegistry({ db: d.db, policy, ctx: toolCtx(), external: externals });
      // 默认姿态：能干活（write）+ 会话内外发开放；JJ_PARANOID=1 回到「什么都问」
      {
        const { applyDefaultPosture } = await import("../posture.ts");
        const applied = applyDefaultPosture(d.db, HOME);
        if (applied.presetApplied) console.error("[posture] 权限档默认 = " + applied.preset + "（面板上可切）");
        if (applied.egressOpened) console.error("[posture] 代码外发：会话内开放（每次留 audit，面板可一键关）");
        if (applied.paranoid) console.error("[posture] JJ_PARANOID=1：逐次确认 + 外发关闭");
      }
      // 离线补账（学 whale-card）：睡了 ≥24 小时，醒来补一条真记忆。
      // 放在 serve 启动时跑一次：这是「她醒来」的那一刻。
      {
        try {
          const lastEv = d.db.prepare("SELECT max(ts) t FROM events").get() as { t?: string } | undefined;
          const { noteGap } = await import("../gapnote.ts");
          const g = noteGap(d.db, new Date(), lastEv?.t ? new Date(lastEv.t) : null);
          if (g.written) console.error("[gap] 补了一条离线记忆（" + Math.round((g.gapMs || 0) / 3600000) + " 小时）");
        } catch { /* 补账失败不该挡住启动 */ }
      }
      // 看门狗：桌面壳会传 JJ_PARENT_PID。壳没了（硬杀/崩溃）就自己退 ——
      // 否则 node 会变孤儿占着 7700，下次启动起不来（实测踩到）。
      {
        const parentPid = Number(process.env.JJ_PARENT_PID ?? "");
        if (Number.isFinite(parentPid) && parentPid > 0) {
          setInterval(() => {
            try { process.kill(parentPid, 0); } catch { console.error("[sidecar] 壳已退出，我也退"); process.exit(0); }
          }, 2000).unref?.();
        }
      }
      // 桌面端令牌：壳会读 data/.desk.json 拿到端口与令牌（2026-11-01：软件只有桌面端）
      const { newToken, writeDeskRuntime, clearDeskRuntime } = await import("../web/desk.ts");
      const deskToken = process.env.JJ_NO_DESK_TOKEN === "1" ? undefined : newToken();
      const srv = createWebServer({
        ...(deskToken ? { deskToken } : {}),
        db: d.db, inboxDir: inbox, home: HOME, getTransport, getEmbedder, getConfig,
        tools: registry, getChat, pendingOutage: boot1.outage,
        // running = 我这次启动实际加载的那份配置的指纹；磁盘后来改了就对不上
        mcpInfo: { servers: mcp.servers, tools: mcp.tools, errors: mcp.errors,
          running: (await import("../plugins.ts")).mcpFingerprint(HOME) },
        // 重连（面板按钮 / API 调用）。registry 同步换掉 MCP 那半。
        reconnectMcp: async (server?: string) => {
          const st = await hub.reconnect(server);
          registry.refresh(externals);
          return st;
        },
      });
      // 绑哪里：默认只绑回环。容器里必须绑 0.0.0.0（否则宿主通过端口映射也访问不到，
      // 因为容器的 127.0.0.1 不是宿主的 127.0.0.1）；而 compose 只把 0.0.0.0 映射到
      // **宿主回环** 127.0.0.1:7700，所以对外仍然进不来。两步一起才是安全的。
      const bind = process.env.JJ_BIND ?? "127.0.0.1";
      srv.listen(port, bind, () => {
        // 端口可能是 0（OS 分配）：从 server.address() 取真实端口，再写 .desk.json
        try {
          const addr = srv.address();
          const real = typeof addr === "object" && addr ? addr.port : port;
          if (deskToken) writeDeskRuntime(HOME, { port: real, token: deskToken, pid: process.pid });
        } catch { /* 写不了就只在日志里说 */ }
        console.log(`鲸鲸面板: http://${bind === "0.0.0.0" ? "127.0.0.1" : bind}:${port}  (store=${store.kind}, express=${cfg.roles.express!.provider}/${cfg.roles.express!.model})`);
        if (release) { try { markHealthy(HOME, release); } catch { /* 单槽模式 */ } }
        const cleanup = () => { if (deskToken) clearDeskRuntime(HOME); };
        process.once("exit", cleanup);
        process.once("SIGINT", () => { cleanup(); process.exit(0); });
        process.once("SIGTERM", () => { cleanup(); process.exit(0); });
      });

      // 可选：心跳（01 §10）。默认不开——没有主动性的需求时，安静就是最好的行为。
      if (rest.includes("--beat")) {
        const { beat } = await import("../heartbeat.ts");
        const draft = async (r: { kind: string; text: string }) => {
          let out = "";
          const prompt = "把下面这条主动开口的理由，写成一句自然的中文（≤40字，不要解释，不要客套）：" + String.fromCharCode(10) + r.text;
          const bt = createChatTransport(routerFrom(getConfig().roles as any), { apiKeys: keys, onUsage: (u) => {
            try {
              record(d.db, { ts: new Date().toISOString(), role: u.role, provider: u.provider, model: u.model,
                inTokens: u.inTokens, cachedTokens: 0, outTokens: u.outTokens,
                usd: +estimateCost(u.provider, u.model, { inTokens: u.inTokens, outTokens: u.outTokens }).toFixed(6) });
            } catch { /* ignore */ }
          } });
          for await (const ev of bt.chat("express", [{ role: "user", content: prompt }], { containsMemory: false, purpose: "beat-draft", maxTokens: 120 })) {
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
      // 显示**生效值**与**来源**：以前这里打的是 defaultConfig()（不读 config.json），
      // 于是一个叫 config 的命令显示的不是配置 —— “看着有其实没有”的老毛病。
      const cfg = resolveConfig(HOME);
      const src = configSources(HOME);
      const problems = validateRouter(cfg.roles as any);
      const rows = Object.entries(cfg.roles).map(([role, c]) => ({
        role, kind: c.kind, provider: c.provider, model: c.model || null, source: src[role] ?? "default",
      }));
      console.log(JSON.stringify({ ollama: cfg.ollama, roles: rows, problems, ok: problems.length === 0 }, null, 2));
      if (problems.length) {
        console.error("\n⚠ 上面这些不是“模型坏了”，是“还没配”。装好之后：");
        console.error("   ollama pull qwen2.5:7b-instruct");
        console.error("   node src/cli/jingjing.ts models use qwen2.5:7b-instruct");
      }
      process.exitCode = problems.length ? 1 : 0;
      return;
    }
    case "models": {
      const op = rest[0] ?? "list";
      const cfg = resolveConfig(HOME);
      const src = configSources(HOME);
      const probe = await preflight(cfg.ollama);       // C-3：统一前置检查（5 分钟缓存）

      if (op === "list" || op === "ls") {
        const rows = Object.entries(cfg.roles).map(([role, c]) => ({
          role, model: c.model || null, source: src[role] ?? "default",
          installed: c.kind === "local" && c.model ? isInstalled(probe.names, c.model) : null,
        }));
        console.log(JSON.stringify({
          endpoint: cfg.ollama, online: probe.online, error: probe.error ?? null,
          installed: probe.names, roles: rows,
        }, null, 2));
        if (!probe.online) console.error("⚠ Ollama 没在跑（" + cfg.ollama + "）：拉模型/查已装都要它。");
        process.exitCode = probe.online ? 0 : 1;
        return;
      }

      if (op === "use") {
        const name = rest[1];
        const roleArg = rest.includes("--role") ? rest[rest.indexOf("--role") + 1] : undefined;
        if (!name) { console.error("用法: jingjing models use <模型名> [--role night|embed|default]"); process.exitCode = 2; return; }
        const role = roleArg ?? "default";
        if (!["default", "night", "embed"].includes(role)) {
          console.error("E_BAD_ROLE: --role 只收 default / night / embed（共享默认 + 单个例外，不是每角色一个）");
          process.exitCode = 2; return;
        }
        if (probe.online && missingFrom(probe, [name]).length) {
          console.error(`⚠ Ollama 里没有 ${name}。先 ollama pull ${name}（现在有：${probe.names.join(", ") || "（空）"}）`);
          process.exitCode = 1; return;
        }
        writeFileConfig(HOME, { local: { [role]: name } });
        const after = resolveConfig(HOME);
        console.log(JSON.stringify({
          ok: true, wrote: `config.json local.${role} = ${name}`,
          now: Object.fromEntries(Object.entries(after.roles).map(([r, c]) => [r, c.model || null])),
          note: role === "embed"
            ? "换了 embedding 必须重建索引，否则新旧向量不可比（检索会悄悄变差）—— 详见 jingjing reembed"
            : undefined,
        }, null, 2));
        return;
      }

      if (op === "doctor") {
        const out: Array<{ role: string; model: string | null; ok: boolean; ms?: number; detail?: string }> = [];
        for (const [role, c] of Object.entries(cfg.roles)) {
          if (c.kind !== "local" || c.provider !== "ollama") continue;
          if (!c.model) { out.push({ role, model: null, ok: false, detail: "未配置模型" }); continue; }
          const t0 = Date.now();
          const r = role === "embed" ? await probeEmbed(cfg.ollama, c.model) : await probeChat(cfg.ollama, c.model);
          out.push({ role, model: c.model, ok: r.ok, ms: Date.now() - t0, ...(r.detail ? { detail: r.detail } : {}) });
        }
        const d = openDb(dbFile);
        const ix = indexState(d.db, `${cfg.roles["embed"]?.provider ?? "ollama"}:${cfg.roles["embed"]?.model ?? ""}`);
        console.log(JSON.stringify({
          endpoint: cfg.ollama, online: probe.online,
          index: { ...ix, ok: !ix.stale, hint: ix.stale ? "索引过期：jingjing reembed" : undefined },
          results: out,
        }, null, 2));
        process.exitCode = out.every((o) => o.ok) ? 0 : 1;
        return;
      }

      console.error("用法: jingjing models [list | use <名> [--role X] | doctor]");
      process.exitCode = 2;
      return;
    }
    case "standing": {
      // D-3：常驻指令 —— 只收模板、必须指定通知通道、每次触发自己开 60 秒窗口
      const op = rest[0] ?? "list";
      const arg = (n: string) => {
        const i = rest.indexOf("--" + n);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      if (op === "add") {
        const r = addStanding(HOME, {
          id: arg("id"), when: arg("when"), template: arg("run"),
          because: arg("because"), notify: arg("notify") ?? "panel",
          slots: (() => { try { return JSON.parse(String(arg("slots") ?? "{}")); } catch { return {}; } })(),
          ttlDays: arg("ttl-days"), maxPerDay: arg("max-per-day"),
        });
        console.log(JSON.stringify(r, null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (op === "list") {
        const rows = listStanding(HOME);
        if (!rows.length) { console.log("（没有常驻指令）"); return; }
        rows.forEach((o) => {
          const w = parseWhen(o.when);
          console.log(`${o.id}  ${o.when}  ${o.template}  ${o.enabled ? "启用" : "已停用"}`);
          console.log(`    为什么：${o.because}`);
          console.log(`    到期：${o.expiresAt.slice(0, 16)}  今天已跑 ${o.lastDay === new Date().toISOString().slice(0, 10) ? 0 : (o.countToday ?? 0)} 次` +
            (o.disabledReason ? `  停用原因：${o.disabledReason}` : ""));
          void w;
        });
        console.log(String.fromCharCode(10) + `没读的回执：${unseenCount(HOME)} 条（jingjing standing inbox）`);
        return;
      }
      if (op === "disable") {
        const id = String(rest[1] ?? "");
        const o = disableStanding(HOME, id, rest.slice(2).join(" ") || "人手动停用");
        console.log(JSON.stringify(o ? { ok: true, id, enabled: o.enabled } : { ok: false, error: "E_STANDING_NOT_FOUND" }, null, 2));
        if (!o) process.exitCode = 1;
        return;
      }
      if (op === "inbox") {
        const rows = listReceipts(HOME, { unseenOnly: rest.includes("--all") ? false : true, limit: 20 });
        if (!rows.length) { console.log("（没有待读回执）"); return; }
        rows.forEach((r) => {
          console.log(`[${r.id}] ${r.at.slice(0, 16)} ${r.ok ? "✓" : "✗"} ${r.title}`);
          if (r.body) console.log("    " + r.body.split(String.fromCharCode(10)).slice(0, 3).join(" ").slice(0, 200));
        });
        console.log(String.fromCharCode(10) + "标记已读：jingjing standing seen <id>");
        return;
      }
      if (op === "seen") {
        const id = String(rest[1] ?? "");
        const r = markSeen(HOME, id);
        console.log(JSON.stringify(r ? { ok: true, id, seen: true } : { ok: false, error: "E_RECEIPT_NOT_FOUND" }, null, 2));
        if (!r) process.exitCode = 1;
        return;
      }
      if (op === "tick") {
        // 由外部调度（任务计划 / 面板定时器）调用：跑掉到点的那些，写完回执就退
        const d = openDb(dbFile);
        const policy = await import("../policy.ts").then((m) => m.loadPolicy(HOME));
        const embedder = createEmbedder("ollama", { baseUrl: resolveConfig(HOME).ollama, model: resolveConfig(HOME).roles["embed"]!.model });
        const report = await runDue({
          home: HOME,
          async run(o) {
            // ④ 每次触发**自己开一个 60 秒窗口**，跑完立刻收回 —— 常驻 ≠ 永久授权
            const sh = await import("../shell.ts");
            const t = sh.templateById(o.template);
            if (!t) return { ok: false, output: `E_STANDING_TEMPLATE: ${o.template}` };
            // 窗口的白名单要的是**二进制名**（node），不是模板 id（node.run_script）
            let bin = "";
            try {
              const rendered = sh.renderTemplate(HOME, o.template, o.slots);
              bin = String(sh.planRun(rendered).argv[0] ?? "").split(/[\\/]/).pop()!.replace(/\.(exe|cmd)$/i, "").toLowerCase();
            } catch { /* 渲染不出来就让后面报错 */ }
            const g = openGrant(HOME, {
              commands: [bin], scope: "workspace", ttlMs: 60_000,
              because: `standing:${o.id} — ${o.because}`,
            });
            try {
              if (!t) return { ok: false, output: `E_STANDING_TEMPLATE: ${o.template}` };
              const r = await execute(
                { db: d.db, policy, ctx: { home: HOME, now: () => new Date(), db: d.db, embedder } },
                "shell.run", { template: o.template, slots: o.slots },
              );
              return { ok: r.ok, output: String(r.output).slice(0, 1500) };
            } finally {
              if (g.ok) revokeGrant(HOME, g.grant.id);
            }
          },
        });
        console.log(JSON.stringify(report, null, 2));
        if (report.disabled.length) process.exitCode = 1;
        return;
      }
      console.error("用法: jingjing standing add --id x --when \"workdays 09:00\" --run node.run_script --because \"...\" | list | disable <id> | inbox | seen <id> | tick");
      process.exitCode = 2;
      return;
    }
    case "setup": {
      // H-4：首次配置 = **可暂停、可终止、终止自动回滚**的事务
      const { readSession, startSetup, pauseSetup, resumeSetup, undoSetup, detect, SETUP_STEPS } =
        await import("../setup.ts");
      const { runStep } = await import("../setupsteps.ts");
      const { execFileSync } = await import("node:child_process");
      const op = rest[0] ?? "status";
      const arg = (n: string) => {
        const i = rest.indexOf("--" + n);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      if (op === "status") {
        const s = readSession(HOME);
        if (!s) { console.log(JSON.stringify({ status: "idle", steps: SETUP_STEPS }, null, 2)); return; }
        console.log(JSON.stringify({ ...s, steps: SETUP_STEPS }, null, 2));
        return;
      }
      if (op === "start") {
        startSetup(HOME);
        console.log(JSON.stringify({ ok: true, step: "detect", note: "现在可以: jingjing setup detect | run <step> | pause | abort" }, null, 2));
        return;
      }
      if (op === "detect") {
        const d = await detect(HOME);
        console.log(JSON.stringify(d, null, 2));
        return;
      }
      if (op === "run") {
        const step = String(rest[1] ?? "") as (typeof SETUP_STEPS)[number];
        if (!SETUP_STEPS.includes(step)) { console.error("步骤只能是: " + SETUP_STEPS.join(" / ")); process.exitCode = 2; return; }
        const runner = {
          run(cmd: string, args: string[], o?: { timeoutMs?: number }) {
            try {
              const out = execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: o?.timeoutMs ?? 600_000 });
              return { ok: true, out: String(out) };
            } catch (e) { return { ok: false, out: String((e as Error).message).slice(0, 200) }; }
          },
          stream(cmd: string, args: string[], onLine: (l: string) => void) {
            try {
              const out = execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 60 * 60_000, stdio: ["ignore", "pipe", "pipe"] });
              onLine(String(out).split(String.fromCharCode(10)).slice(-1)[0] ?? "");
              return { ok: true };
            } catch (e) { onLine(String((e as Error).message).slice(0, 120)); return { ok: false }; }
          },
        };
        const model = arg("embed") ?? "bge-m3";
        const chat = arg("chat") ?? "";
        const r = runStep(HOME, step, runner, { model, ...(chat ? { chat } : {}) });
        console.log(JSON.stringify({ step, ...r }, null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (op === "pause") {
        const s = pauseSetup(HOME);
        console.log(JSON.stringify({ ok: true, status: s.status, step: s.step, note: "已暂停；账本还在，接着跑用 jingjing setup resume" }, null, 2));
        return;
      }
      if (op === "resume") {
        const s = resumeSetup(HOME);
        console.log(JSON.stringify({ ok: true, status: s.status, step: s.step }, null, 2));
        return;
      }
      if (op === "abort") {
        // 终止 = 按账回滚（删我们拉的模型、恢复写过的配置、停我们起的进程）
        const report = undoSetup(HOME);
        console.log(JSON.stringify({ ok: true, ...report }, null, 2));
        if (report.failed.length) {
          console.error("有没清掉的：\n" + report.failed.join("；"));
          process.exitCode = 1;
        }
        return;
      }
      console.error("用法: jingjing setup status|start|detect|run <step>|pause|resume|abort");
      process.exitCode = 2;
      return;
    }
    case "persona": {
      // H-5：设定封存 = 分代（改动只向前生效；追溯要显式 + 带理由）
      const d = openDb(dbFile);
      const op = rest[0] ?? "gen";
      const { currentGeneration, generationLog, migrateToCurrentGen, personaFingerprint } =
        await import("../generation.ts");
      if (op === "gen") {
        const g = currentGeneration(d.db, HOME);
        const fp = personaFingerprint(HOME);
        const n = (d.db.prepare("SELECT count(*) c FROM memories WHERE created_under_gen=?").get(g.gen) as { c: number }).c;
        console.log(JSON.stringify({
          gen: g.gen,
          fingerprint: g.fingerprint,
          drift: fp !== g.fingerprint ? "人格文件已改但还没封存（下次在面板保存时会开新一代）" : null,
          createdAt: g.createdAt,
          because: g.because,
          memories: n,
        }, null, 2));
        return;
      }
      if (op === "log") {
        const list = generationLog(d.db);
        if (!list.length) { console.log("（还没有封存过任何一代）"); return; }
        list.forEach((g) => {
          const n = (d.db.prepare("SELECT count(*) c FROM memories WHERE created_under_gen=?").get(g.gen) as { c: number }).c;
          console.log(`第 ${g.gen} 代  ${g.createdAt.slice(0, 16)}  ${g.fingerprint}  ${n} 条记忆`);
          console.log(`    为什么：${g.because}`);
        });
        return;
      }
      if (op === "migrate") {
        // 唯一允许"改写旧记忆解释"的通道：**必须带理由**，并留事件
        const ri = rest.indexOf("--reason");
        const reason = ri >= 0 ? rest[ri + 1] : "";
        const fi = rest.indexOf("--from");
        const fromGen = fi >= 0 ? Number(rest[fi + 1]) : undefined;
        try {
          const r = migrateToCurrentGen(d.db, HOME, { reason, ...(Number.isFinite(fromGen) ? { fromGen } : {}) });
          console.log(JSON.stringify({ ok: true, ...r, note: "已追溯迁移；事件里留了理由" }, null, 2));
        } catch (e) {
          console.error(String((e as Error).message));
          process.exitCode = 1;
        }
        return;
      }
      console.error("用法: jingjing persona gen | log | migrate --reason \"...\" [--from N]");
      process.exitCode = 2;
      return;
    }
    case "grant": {
      // K-3：会话级授权窗口（**活在当前进程里**，进程一退就没了）
      const op = rest[0] ?? "list";
      if (op === "list") {
        const rows = listGrants(HOME);
        if (!rows.length) { console.log("（没有打开的授权窗口）"); return; }
        rows.forEach((g) => {
          console.log(`${g.id}  [${g.commands.join(",")}]  目录 ${g.scope}  剩 ${g.remainingS}s`);
          console.log(`    为什么：${g.because}`);
        });
        console.log(String.fromCharCode(10) + "收回：jingjing grant revoke <id>");
        return;
      }
      if (op === "open") {
        const arg = (n: string) => {
          const i = rest.indexOf("--" + n);
          return i >= 0 ? rest[i + 1] : undefined;
        };
        const ttlRaw = String(arg("ttl") ?? "30m");
        const m = ttlRaw.match(/^(\d+)([mh])?$/);
        const ttlMs = m ? Number(m[1]) * (m[2] === "h" ? 3600_000 : 60_000) : 30 * 60_000;
        const r = openGrant(HOME, {
          full: rest.includes("--full"),
          commands: String(arg("commands") ?? "node").split(","),
          scope: String(arg("scope") ?? "workspace"),
          ttlMs,
          because: arg("because") ?? "",
        });
        console.log(JSON.stringify(r, null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (op === "revoke") {
        const id = String(rest[1] ?? "");
        const ok = revokeGrant(HOME, id);
        console.log(JSON.stringify({ ok, id, note: ok ? "已收回" : "没有这个窗口（或已经过期）" }, null, 2));
        if (!ok) process.exitCode = 1;
        return;
      }
      console.error("用法: jingjing grant open [--full] [--commands node,git] [--scope workspace] [--ttl 30m] --because \"...\" | list | revoke <id>");
      process.exitCode = 2;
      return;
    }
    case "threads": {
      // 线索层：答应过、还没了结的事
      const d = openDb(dbFile);
      const op = rest[0] ?? "list";
      if (op === "list") {
        const rows = openThreads(d.db, new Date(), 50);
        if (!rows.length) { console.log("（没有未闭合的事）"); return; }
        rows.forEach((t, i) => {
          console.log("T" + (i + 1) + "  #" + t.id + "  " + t.text);
          console.log("     " + (t.ageDays > 0 ? "立下 " + t.ageDays + " 天" : "今天立的") +
            (t.aging ? "（拖太久了）" : "") + (t.quote ? "  ／ 原话「" + t.quote.slice(0, 30) + "」" : ""));
        });
        console.log(String.fromCharCode(10) + "了结：jingjing threads close <id>");
        return;
      }
      if (op === "close") {
        const id = Number(rest[1] ?? "");
        if (!Number.isFinite(id)) { console.error("用法: jingjing threads close <id>"); process.exitCode = 2; return; }
        const ok = closeThread(d.db, id, rest.slice(2).join(" ") || "人说了结了");
        console.log(JSON.stringify(ok ? { ok: true, id, note: "写了止期（不删，历史仍查得到）" } : { ok: false, error: "E_THREAD_CLOSED" }, null, 2));
        if (!ok) process.exitCode = 1;
        return;
      }
      console.error("用法: jingjing threads list|close <id>");
      process.exitCode = 2;
      return;
    }
    case "proposal": {
      // K-2：它提的要求就在 data/pending 里；人一句话就能拒
      const op = rest[0] ?? "list";
      if (op === "list") {
        const st = (rest[1] as "open" | "all" | "accepted" | "rejected") ?? "open";
        const rows = listProposals(HOME, { status: st });
        if (!rows.length) { console.log("（没有等回应的提议）"); return; }
        rows.forEach((x, i) => {
          console.log(`P${i + 1}  [${x.id}] ${x.title}  （${x.risk} 风险 · 提到过 ${x.seen} 次）`);
          console.log(`    为什么：${x.why}`);
          if (x.touches.length) console.log(`    会动：${x.touches.join(", ")}`);
          if (x.argv.length) console.log(`    命令：${x.argv.join(" ")}（只是展示，不会自动跑）`);
          x.plan.forEach((step, j) => console.log(`      ${j + 1}. ${step}`));
        });
        console.log(String.fromCharCode(10) + "接受 / 拒绝：jingjing proposal accept|reject <id> [理由]");
        return;
      }
      if (op === "accept" || op === "reject") {
        const id = String(rest[1] ?? "").trim();
        if (!getProposal(HOME, id)) { console.error("E_PROPOSAL_NOT_FOUND: " + id); process.exitCode = 1; return; }
        const reason = rest.slice(2).join(" ") || (op === "accept" ? "我同意，你来做" : "不做");
        const next = setProposalStatus(HOME, id, op === "accept" ? "accepted" : "rejected", reason);
        console.log(JSON.stringify({
          ok: true, id, status: next?.status,
          note: op === "accept" ? "已同意 —— 具体执行仍要授权（K-3）或你自己跑" : "已拒绝",
        }, null, 2));
        return;
      }
      console.error("用法: jingjing proposal list|accept|reject <id>");
      process.exitCode = 2;
      return;
    }
    case "links": {
      // J-5：抽检与一句话拆线。关系必须"送到眼前"，而且**当场能断**。
      const d = openDb(dbFile);
      const op = rest[0] ?? "list";
      const now = new Date();
      if (op === "list") {
        const rows = d.db.prepare(`
          SELECT l.src_id, l.dst_id, l.rel, l.weight, l.why, l.created_at, l.valid_to,
                 a.text AS a_text, b.text AS b_text
          FROM memory_links l
          JOIN memories a ON a.id = l.src_id
          JOIN memories b ON b.id = l.dst_id
          WHERE l.valid_to IS NULL OR julianday(l.valid_to) > julianday(?)
          ORDER BY l.created_at DESC LIMIT ?`).all(now.toISOString(), Number(rest[1] ?? 10)) as Array<{
            src_id: number; dst_id: number; rel: string; weight: number; why?: string | null;
            created_at: string; a_text: string; b_text: string;
          }>;
        if (!rows.length) { console.log("（还没有任何线）"); return; }
        rows.forEach((r, i) => {
          console.log(`L${i + 1}  #${r.src_id} ←→ #${r.dst_id}  [${r.rel}]`);
          console.log(`    为什么连：${r.why || "（没有理由 —— 这种线本该不存在）"}`);
          console.log(`    ${r.a_text.slice(0, 40)}  ／  ${r.b_text.slice(0, 40)}`);
        });
        console.log(String.fromCharCode(10) + "拆掉哪根：jingjing links cut L<n>");
        return;
      }
      if (op === "cut") {
        const arg = String(rest[1] ?? "").trim();
        const idx = Number(arg.replace(/^L/i, ""));
        if (!Number.isFinite(idx) || idx < 1) { console.error("用法: jingjing links cut L<编号>（编号来自 jingjing links）"); process.exitCode = 2; return; }
        const rows = listLinks(d.db, now, idx);
        const t = rows[idx - 1];
        if (!t) { console.error("E_NO_LINK: 没有这个编号（先跑 jingjing links 看当前列表）"); process.exitCode = 1; return; }
        const key = cutLink(d.db, t, now);
        console.log(JSON.stringify({ ok: true, cut: key, note: "作废写止期 + 进黑名单，夜间不会再自动接回" }, null, 2));
        return;
      }
      console.error("用法: jingjing links [list [n] | cut L<n>]");
      process.exitCode = 2;
      return;
    }

    case "doctor": {
      // D-6：体检。默认只做结构检查；--full 才跑四条完整自检；--export 出脱敏诊断包。
      const d = openDb(dbFile);
      const rep = await doctor({ db: d.db, home: HOME, ...(has(rest, "--no-net") ? { skipPreflight: true } : {}) });
      if (has(rest, "--export")) {
        const ex = exportDiag(rep, HOME, d.db, { release: readStateSafe(HOME).state.active ?? null });
        console.log(JSON.stringify({ exported: ex.dir.replace(HOME, "<home>"), files: ex.files, bytes: ex.bytes }, null, 2));
      }
      if (has(rest, "--json")) { console.log(JSON.stringify(rep, null, 2)); }
      else {
        for (const c of rep.checks) console.log((c.ok ? "✅" : "❌") + " " + c.name.padEnd(9) + " " + c.detail);
        console.log(rep.degraded.length ? "⚠ 降级 " + rep.degraded.length + " 项：" + rep.degraded.join(", ") : "✅ 无降级");
        console.log(rep.ok ? String.fromCharCode(10) + "✅ 体检通过" : String.fromCharCode(10) + "❌ 有项目不通过");
      }
      process.exitCode = (!rep.ok || (has(rest, "--strict") && rep.degraded.length > 0)) ? 1 : 0;
      return;
    }

    case "selfupdate": {
      // 自我更新三件套（docs/18 §4.3）：草稿 → 冒烟 → A/B 槽 → 回滚/冻结
      const su = await import("../selfupdate.ts");
      const d2 = openDb(dbFile);
      const sub = rest[0] ?? "list";
      if (sub === "list") {
        const drafts = su.listDrafts(HOME);
        console.log(JSON.stringify({
          frozenUntil: su.frozenUntil(d2.db),
          drafts: drafts.map((x) => ({ id: x.id, bytes: x.bytes, because: x.because, evidence: x.evidence, at: x.at })),
          versions: su.recentVersions(HOME, 5).map((v) => ({ file: v.file, head: v.text.split(String.fromCharCode(10)).slice(2, 4).join(" · ") })),
        }, null, 2));
        return;
      }
      if (sub === "new") {
        // selfupdate new <id> <file.md> --because "…"   （内容从文件读，避免命令行转义）
        const id = rest[1]; const file = rest[2];
        const bi = rest.indexOf("--because");
        const because = bi > 0 ? String(rest[bi + 1] ?? "") : "";
        if (!id || !file) { console.error("用法: selfupdate new <id> <文件.md> --because 为什么"); process.exitCode = 2; return; }
        const r = su.proposeSkill(HOME, { id, content: readFileSync(file, "utf8"), because });
        console.log(JSON.stringify(r, null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (sub === "smoke") {
        console.log(JSON.stringify(su.smokeDraft(HOME, String(rest[1] ?? "")), null, 2));
        return;
      }
      if (sub === "promote") {
        const r = su.promoteDraft(HOME, d2.db, String(rest[1] ?? ""));
        console.log(JSON.stringify(r, null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (sub === "revert") {
        const r = su.revertSkill(HOME, d2.db, String(rest[1] ?? ""), String(rest[2] ?? ""));
        console.log(JSON.stringify(r, null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (sub === "drop") {
        console.log(JSON.stringify(su.dropDraft(HOME, String(rest[1] ?? "")), null, 2));
        return;
      }
      console.error("用法: selfupdate list | new <id> <文件> --because … | smoke <id> | promote <id> | revert <id> [理由] | drop <id>");
      process.exitCode = 2;
      return;
    }
    case "capabilities": {
      // B-0：每一行都能追到代码（工具来自 verbs，provider 来自配置，degraded 来自真探测）
      const d = openDb(dbFile);
      const cfg = resolveConfig(HOME);
      const pf = await preflight(cfg.ollama);
      const mcpCfg = await loadMcpConfig(HOME);
      const cap = await capabilities({
        db: d.db, home: HOME, cfg,
        ollama: { base: pf.base, online: pf.online, names: pf.names, ...(pf.error ? { error: pf.error } : {}) },
        mcp: { servers: Object.keys(mcpCfg.servers ?? {}), tools: [], errors: [] },
        commands: CLI_COMMANDS,
        panel: false,
      });
      if (has(rest, "--json")) { console.log(JSON.stringify(cap, null, 2)); return; }
      console.log(summarize(cap));
      if (cap.notes.length) for (const n of cap.notes) console.log("  · " + n);
      return;
    }

    case "reembed": {
      // 换了 embedding 模型之后重建索引（C-2）。不动正文，只重算向量。
      const cfg = resolveConfig(HOME);
      const model = cfg.roles["embed"]?.model;
      if (!model) { console.error("E_NO_EMBED_MODEL: 先配 embedding 模型（jingjing models use <名> --role embed）"); process.exitCode = 2; return; }
      const cur = modelKeyOf(cfg.roles["embed"])!;
      const d = openDb(dbFile);
      const st = indexState(d.db, cur);
      const force = has(rest, "--force");
      if (!st.stale && !force) {
        console.log(JSON.stringify({ ok: true, rebuilt: false, why: "索引已是最新", index: st, tip: "要强制重建加 --force" }, null, 2));
        return;
      }
      const embedder = createEmbedder("ollama", { baseUrl: cfg.ollama, model });
      console.log(JSON.stringify({
        rebuilding: true, to: cur, from: st.built, vectors: st.vectors,
        note: "只重算向量，不动正文；失败会整体回滚并保留旧索引",
      }, null, 2));
      const r = await reembedBuild({ db: d.db, embedder, model: cur });
      console.log(JSON.stringify(r, null, 2));
      if (!r.ok) console.error("重建失败：旧索引保持不变（meta.reembed_error 有原因）");
      process.exitCode = r.ok ? 0 : 1;
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
        coolReset(provider);           // 换 key 立刻解冷却
        console.log(JSON.stringify({ ok: true, store: store.kind, provider, fingerprint: fingerprint(key) }));
        return;
      }
      if (op === "list") {
        console.log(JSON.stringify({ store: store.kind, keys: store.list() }, null, 2));
        return;
      }
      if ((op === "remove" || op === "clear") && provider) {
        const had = store.clear(provider);
        // “清引用”：OpenClaw 的教训是删了凭据却留下空引用，反而把整家 provider 禁了。
        // 我们的对应物是 config.json.express。**默认一并清掉**（docs/22 C-1 要求"含清引用"）：
        // 只删密钥却留着 provider 指向，就成了"有配置、没凭据"的半截状态，排障时最容易误判。
        // 想留配置（比如只想临时断云端）用 --keep-config。
        let purged = false;
        if (rest[2] !== "--keep-config") {
          const cur = readFileConfig(HOME);
          if (cur.express) {
            writeFileConfig(HOME, { express: { provider: "", model: "", baseUrl: "" } });
            purged = true;
          }
        }
        console.log(JSON.stringify({ ok: true, provider, removed: had, purged, store: store.kind }));
        if (!had) console.error("提示：本来就没有这个 provider 的密钥（幂等）");
        return;
      }
      console.error("用法: jingjing auth <set|list|remove> [provider] [--purge]");
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
      // E-7：--rounds N 对同一批事件重复巩固，看是否收敛（默认 1 轮）
      const ri = rest.indexOf("--rounds");
      const rounds = ri >= 0 ? Number(rest[ri + 1]) : undefined;
      const code = await runNightCli({
        home: HOME, dbFile, inbox,
        skipAutobio: rest.includes("--no-autobio"),
        dryRun: rest.includes("--dry-run"),
        ...(Number.isFinite(rounds) && rounds && rounds > 1 ? { rounds } : {}),
      });
      process.exitCode = code;
      return;
    }
    case "shell": {
      // jingjing shell                          → 列模板
      // jingjing shell git.status               → T0/T1 直接跑（只读）
      // jingjing shell node.run_script --slots '{"script":"a.mjs"}'          → 只预览（T3 不执行）
      // jingjing shell node.run_script --slots '…' --yes                     → 签发一次性令牌并执行
      // jingjing shell … --token cap_xxx                                      → 用已有令牌执行
      const { renderTemplate, templateCatalog } = await import("../shell.ts");
      const flags = new Set(rest.filter((r) => r.startsWith("--")));
      const slotsArg = rest[rest.indexOf("--slots") + 1];
      const tokenArg = rest.indexOf("--token") >= 0 ? rest[rest.indexOf("--token") + 1] : undefined;
      // 模板 id = 第一个「既不是 --flag，也不是某个 flag 的值」的参数
      const takesValue = new Set(["--slots", "--token"]);
      const templateId = rest.find((r, i) => !r.startsWith("--") && !takesValue.has(rest[i - 1] ?? ""));
      if (!templateId) {
        for (const t of templateCatalog()) {
          console.log(`${t.id.padEnd(20)} [${t.tier}] ${t.description}`);
        }
        console.log("用法: jingjing shell <template> [--slots '<json>'] [--yes] [--token cap_…]");
        return;
      }
      let slots: Record<string, unknown> = {};
      if (typeof slotsArg === "string" && slotsArg.startsWith("{")) slots = JSON.parse(slotsArg);
      const preview = renderTemplate(HOME, templateId, slots);
      const show = preview.argv.map((x) => (x.includes(" ") ? JSON.stringify(x) : x)).join(" ");
      console.log(`模板 ${preview.template} [${preview.tier}]`);
      console.log(`将执行：${show}`);
      console.log(`目录：${preview.cwd}`);
      console.log(`指纹：${preview.digest}`);
      if (preview.tier === "T3" && !flags.has("--yes") && !tokenArg) {
        console.log("（T3 不执行——确认没问题后加 --yes）");
        return;
      }
      const d = openDb(dbFile);
      const policy = await import("../policy.ts").then((m) => m.loadPolicy(HOME));
      const r = await execute({ db: d.db, policy, ctx: { home: HOME, now: () => new Date() } },
        "shell.run", { template: templateId, slots }, { approved: flags.has("--yes"), token: tokenArg });
      if (r.capability) console.log(`令牌：${r.capability}`);
      console.log(r.output);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case "ingest": {
      // jingjing ingest <路径> [--scope x] [--no-embed] [--rebuild]
      const target = rest.find((x) => !x.startsWith("--"));
      if (!target) { console.log("用法: jingjing ingest <文件或目录> [--scope x] [--no-embed]"); process.exitCode = 1; return; }
      const { ingestPath, sourcesDir } = await import("../ingest.ts");
      const d = openDb(dbFile);
      const cfg = resolveConfig(HOME);
      const useEmbed = !rest.includes("--no-embed");
      const embedder = useEmbed ? createEmbedder("ollama", { baseUrl: cfg.ollama, model: cfg.roles.embed!.model }) : null;
      const scopeArg = rest.indexOf("--scope");
      const scope = scopeArg >= 0 ? rest[scopeArg + 1] : undefined;
      const r = await ingestPath(d.db, target, {
        home: HOME, root: sourcesDir(HOME), embedder,
        ...(scope ? { scope } : {}),
        force: rest.includes("--rebuild"),
        sensitivity: rest.includes("--shareable") ? "shareable" : "local_only",
      });
      for (const x of r.results) {
        const status = x.skipped ? "skipped" : x.degraded.some((g) => g.startsWith("E_")) ? "FAILED" : "ok";
        console.log(`${status.padEnd(8)} ${x.file}  ${x.chunks} 块 ${x.tokens} tok${x.skipped ? "" : `  ${x.ms}ms`}${x.degraded.length ? "  " + x.degraded.join(" ") : ""}`);
      }
      console.log(`合计 ${r.total.files} 个文件 · ${r.total.chunks} 块 · 跳过 ${r.total.skipped} · 失败 ${r.total.failed}`);
      process.exitCode = r.total.failed ? 1 : 0;
      return;
    }
    case "docs": {
      const { listDocs } = await import("../ingest.ts");
      const d = openDb(dbFile);
      const rows = listDocs(d.db, 200);
      if (!rows.length) { console.log("（还没有摄入任何文档）"); return; }
      for (const x of rows) console.log(`${x.id}  ${String(x.chunks).padStart(4)} 块  ${(x.converter ?? "").padEnd(12)} ${x.sensitivity === "shareable" ? "可发送" : "仅本地"}  ${x.title}`);
      console.log(`共 ${rows.length} 篇 · ${rows.reduce((n, x) => n + x.chunks, 0)} 块`);
      return;
    }
    case "forget-doc": {
      const { forgetDoc } = await import("../ingest.ts");
      const id = rest.find((x) => !x.startsWith("--"));
      if (!id) { console.log("用法: jingjing forget-doc <doc_id>"); process.exitCode = 1; return; }
      const d = openDb(dbFile);
      const n = forgetDoc(d.db, id);
      console.log(`已忘掉 ${id}（${n} 块）：文档与块标 deleted_at，FTS 行已删`);
      return;
    }
    case "export": {
      // 搬家第一步：导出一致快照（先停面板；不停也能导，只是 inbox 尾部可能多几条）
      const { exportHome, defaultExportDir } = await import("../handoff.ts");
      const out = rest.find((x) => !x.startsWith("--")) ?? defaultExportDir(HOME);
      const r = exportHome(HOME, out);
      console.log("导出 " + r.files + " 个文件 / " + (r.bytes / 1048576).toFixed(1) + " MB → " + r.outDir);
      console.log(JSON.stringify(r.manifest.counts));
      console.log("不带：secrets/（DPAPI 绑本机）、tokens/、pending/、snapshots/");
      return;
    }
    case "verify-export": {
      const { verifyExport } = await import("../handoff.ts");
      const dir = rest.find((x) => !x.startsWith("--"));
      if (!dir) { console.log("用法: jingjing verify-export <导出目录>"); process.exitCode = 1; return; }
      const v = verifyExport(dir);
      console.log(JSON.stringify({ ok: v.ok, files: v.manifest ? Object.keys(v.manifest.files).length : 0, counts: v.manifest?.counts, problems: v.problems.slice(0, 10) }, null, 2));
      process.exitCode = v.ok ? 0 : 1;
      return;
    }
    case "import": {
      // 搬家第三步：校验 → staging → 换进来 → 补跑
      const { importHome } = await import("../handoff.ts");
      const dir = rest.find((x) => !x.startsWith("--"));
      if (!dir) { console.log("用法: jingjing import <导出目录> [--force]"); process.exitCode = 1; return; }
      try {
        const r = importHome(dir, HOME, { force: rest.includes("--force") });
        console.log("导入 " + r.files + " 个文件 → " + HOME);
        if (r.backup) console.log("旧目录已备份：" + r.backup);
        console.log("补算衰减 " + r.decayed + " 条 · inbox " + r.inbox.events + " 事件 · 记忆 " + r.counts.memories + " 条");
        console.log("⚠ secrets/ 没搬过来：需要时重新 auth set <provider>");
      } catch (e) {
        console.error(String((e as Error).message ?? e));
        process.exitCode = 1;
      }
      return;
    }

    case "smoke-tools": {
      // 工具调用冒烟（P0-1）：换模型之前先问一句"你到底会不会调工具"。
      //   jingjing smoke-tools                       # 默认跑 night 角色（本地）
      //   jingjing smoke-tools --model qwen2.5:7b-instruct --n 10
      //   jingjing smoke-tools --role express        # 用云端角色自己的 provider/端点
      const { runToolSmoke, describeSmoke, ollamaModels } = await import("../toolsmoke.ts");
      const cfg = resolveConfig(HOME);
      const role = (flag(rest, "--role") ?? "night") as string;
      const base = cfg.roles[role];
      if (!base) { console.error(`E_NO_ROLE: ${role}`); process.exitCode = 1; return; }
      const model = flag(rest, "--model") ?? base.model;
      // 本地角色先看模型装没装：404 会让 10 轮全红，看起来像"模型不会调工具"，其实是根本没装
      if (base.provider === "ollama") {
        const have = await ollamaModels(cfg.ollama);
        if (have === null) { console.error("E_OLLAMA_DOWN: 连不上 " + cfg.ollama); process.exitCode = 2; return; }
        if (!have.includes(model) && !have.includes(model + ":latest")) {
          console.error("⚠ Ollama 里没有模型 " + model + "（现有：" + (have.join(", ") || "无") + "）");
          console.error("  ollama pull " + model + "   # 或换个已装的：--model <name>");
          process.exitCode = 2; return;
        }
      }
      const n = Number(flag(rest, "--n") ?? 10);
      const roles = { ...cfg.roles, [role]: { ...base, model } };
      const store = createStore(join(HOME, "secrets"));
      const keys: Record<string, string> = {};
      for (const pv of ["deepseek", "anthropic", "openai"] as Provider[]) { const k = store.get(pv); if (k) keys[pv] = k; }

      // 探针文件：读文件那条用例要它真的存在
      const probe = join(HOME, "workspace", "smoke-probe.txt");
      mkdirSync(join(HOME, "workspace"), { recursive: true });
      if (!existsSync(probe)) writeFileSync(probe, "smoke-probe " + new Date().toISOString().slice(0, 19) + String.fromCharCode(10));

      // 工具面用真实的注册表（不是玩具 schema）：够不了真工具，冒烟就没意义
      const d = openDb(dbFile);
      const policy = await import("../policy.ts").then((m) => m.loadPolicy(HOME));
      const reg = createToolRegistry({ db: d.db, policy, ctx: { home: HOME, now: () => new Date(), db: d.db, embedder: null } });
      const schema = reg.schema();

      let tokens = { in: 0, out: 0 };
      const t = createChatTransport(routerFrom(roles as never), { apiKeys: keys, onUsage: (u) => { tokens.in += u.inTokens; tokens.out += u.outTokens; } });
      const chat = (messages: unknown[], tools: unknown) => t.chat(role as never, messages, {
        containsMemory: false, purpose: "tool-smoke", maxTokens: 300, tools: tools as never,
      });

      console.log(`跑 ${n} 轮 × 3 个用例，模型 ${base.provider}/${model}（role=${role}）…`);
      const r = await runToolSmoke({
        chat, schema, model,
        n: Number.isFinite(n) && n > 0 ? n : 10,
        onAttempt: (a) => {
          if (!has(rest, "--quiet")) console.log(`  ${a.ok ? "✓" : "✗"} ${a.caseId.padEnd(7)} ${String(a.ms).padStart(5)}ms ${a.ok ? (a.toolName ?? "") : `${a.code} ${a.detail ?? ""}`}`);
        },
      });
      console.log(String.fromCharCode(10) + describeSmoke(r));
      if (tokens.in || tokens.out) {
        const usd = estimateCost(base.provider, model, { inTokens: tokens.in, outTokens: tokens.out });
        console.log(`用量 in ${tokens.in} / out ${tokens.out} tok${usd > 0 ? ` · 约 $${usd.toFixed(4)}` : ""}`);
      }
      process.exitCode = r.pass ? 0 : 1;
      return;
    }

    case "templates": {
      const { templateCatalog } = await import("../shell.ts");
      for (const t of templateCatalog()) console.log(`${t.id.padEnd(20)} [${t.tier}] ${t.description}`);
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
      // db / embedder 必须给：memory.search、doc.search 这类 verb 没它就直接 E_NO_DB
      const cfg0 = resolveConfig(HOME);
      const emb = rest.includes("--no-embed") ? null
        : createEmbedder("ollama", { baseUrl: cfg0.ollama, model: cfg0.roles.embed!.model });
      const r = await execute({ db: d.db, policy, ctx: { home: HOME, now: () => new Date(), db: d.db, embedder: emb } },
        name, args, { approved: rest.includes("--yes") });
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
      // E-4：参数属于 ② 参数类 —— 可调，但有白名单、有范围、有理由、有版本号
      if (has(rest, "--params")) {
        applyDecayConfig(HOME, (m) => console.error(m));
        const kinds = Object.fromEntries(Object.keys(KIND_PARAMS).map((k) => [k, effectiveParams(k)]));
        console.log(JSON.stringify({
          version: decayVersion(HOME),
          codeVersion: DECAY_PARAMS_VERSION,
          paramsVersion: DECAY_PARAMS_VERSION,
          overrides: currentOverrides(),
          kinds,
          globals: { T: { ...T }, RECONSOLIDATION: { ...RECONSOLIDATION }, ACCESS: { ...ACCESS } },
          audit: readAudit(HOME, 5),
        }, null, 2));
        return;
      }
      if (has(rest, "--set")) {
        const target = String(rest[rest.indexOf("--set") + 1] ?? "");
        const valueRaw = String(rest[rest.indexOf("--set") + 2] ?? "");
        const whyIdx = rest.indexOf("--because");
        const because = whyIdx >= 0 ? rest.slice(whyIdx + 1).join(" ") : "";
        const value = valueRaw === "Infinity" ? Infinity : Number(valueRaw);
        if (!target || !valueRaw || Number.isNaN(value)) {
          console.error("用法: jingjing decay --set <kind.field|T.activeIn|ACCESS.alpha> <值> --because \"为什么\"");
          process.exitCode = 2; return;
        }
        const r = setDecayParam(HOME, target, value, because);
        console.log(JSON.stringify(r, null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (has(rest, "--reset")) {
        const v = resetDecayParams(HOME);
        console.log(JSON.stringify({ ok: true, version: v, note: "已恢复默认参数（审计里留了一条）" }, null, 2));
        return;
      }
      // E-2：把已有记忆的 w0 按 importance 重算一遍。
      // 为什么要单独一个开关：这是**改历史**（旧行写入时 w0 恒 0.55），必须显式触发；
      // 默认 dry-run，看清楚要动多少行再 --apply。
      if (has(rest, "--reweight")) {
        const apply = has(rest, "--apply");
        const rows = d.db.prepare("SELECT id,layer,importance,w0 FROM memories WHERE status='active'").all() as
          Array<{ id: number; layer: string; importance: number; w0: number }>;
        const plan = rows.map((r) => ({
          id: r.id,
          from: r.w0,
          to: r.layer === "contract" ? 1 : w0FromImportance(r.importance, "narrative"),
        })).filter((x) => Math.abs(x.to - x.from) > 1e-9);
        if (!apply) {
          console.log(JSON.stringify({ dryRun: true, wouldChange: plan.length, of: rows.length, first5: plan.slice(0, 5),
            note: "加 --apply 才会写库（改历史需要显式确认）" }, null, 2));
          return;
        }
        const upd = d.db.prepare("UPDATE memories SET w0=?, weight=?, updated_at=? WHERE id=?");
        d.db.exec("BEGIN");
        try {
          for (const x of plan) upd.run(x.to, x.to, new Date().toISOString(), x.id);
          d.db.exec("COMMIT");
        } catch (e) { d.db.exec("ROLLBACK"); throw e; }
        console.log(JSON.stringify({ ok: true, changed: plan.length, of: rows.length, paramsVersion: DECAY_PARAMS_VERSION }, null, 2));
        return;
      }
      console.log(JSON.stringify({ recomputed: tickDecay(d.db), paramsVersion: DECAY_PARAMS_VERSION }));
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

// Node 版本（H-1）：`node:sqlite` 在 22 是实验性 API，行为在 24 才稳。
// 不直接退出（老版本还能跑 md/txt），但必须说清楚，否则用户会遇到"莫名其妙的 SQL 错误"。
{
  const major = Number(String(process.versions.node).split(".")[0]);
  if (Number.isFinite(major) && major < 24) {
    console.error(`⚠ Node ${process.versions.node}：本项目要求 >= 24（node:sqlite 在 22 还是实验性）。`);
    console.error("  行为可能不对（尤其是 sqlite/vec 相关）。升级：https://nodejs.org/ 或 nvm/fnm。");
  }
}
// D-5：配置坏了要**明确停下**（exit 78），而不是带着坏配置假装能跑。
// migrate / import 例外：它们本来就是用来修库的。
{
  const cmd = process.argv[2] ?? "";
  const exempt = new Set(["migrate", "import", "verify-export"]);
  if (!exempt.has(cmd)) {
    const problems = checkConfig(HOME);
    const fatal = problems.filter((p) => p.fatal);
    const warn = problems.filter((p) => !p.fatal);
    for (const w of warn) console.error("⚠ " + describeProblems([w]));
    if (fatal.length) {
      console.error("✗ 配置有问题，拒绝启动（exit " + EXIT_CONFIG + "）：");
      console.error(describeProblems(fatal));
      console.error(String.fromCharCode(10) + "提示：配置坏了重启循环只会把日志冲掉；docker 里配的是 restart: on-failure:5。");
      process.exit(EXIT_CONFIG);
    }
  }
}
try { applyDecayConfig(HOME, (m) => console.error(m)); } catch { /* 参数配置有问题不影响其他命令 */ }
main().catch((e) => { console.error(e); process.exitCode = 1; });

