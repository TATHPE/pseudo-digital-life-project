/**
 * CLI：night —— 跑一次闲时整理（抽取 + 冲突消解 + 归并 + 自传）。
 * 抽取走**本地模型**（role=extract），不出网；这一点由 transport 的守卫保证。
 */
import { join } from "node:path";
import { openDb } from "../db.ts";
import { runNightly } from "../nightly.ts";
import { writeAutobiography, listAutobiography } from "../autobio.ts";
import { ensureTerritory, territoryListing } from "../territory.ts";
import { loadState, advance, describe } from "../state.ts";
import { createTransport, createChatTransport, routerFrom } from "../transport.ts";
import { createEmbedder } from "../embed.ts";
import { defaultConfig } from "../config.ts";
import { resolveConfig } from "../configfile.ts";
import { createToolRegistry } from "../tools.ts";
import { makeToolExtractor, NIGHT_TOOLS, type ToolTrace } from "../nightagent.ts";
import { loadPolicy } from "../policy.ts";
import { createStore, type Provider } from "../auth.ts";
import { preflight, describeSkip } from "../preflight.ts";

export interface NightOptions {
  home: string;
  dbFile: string;
  inbox: string;
  dryRun?: boolean;
  /** dry-run 时也把 notes 打出来（核对抽取质量用） */
  verbose?: boolean;
  skipAutobio?: boolean;
  /** E-7：同一批事件重复巩固几轮（1..5） */
  rounds?: number;
  now?: Date;
}

export async function runNightCli(opts: NightOptions): Promise<number> {
  const now = opts.now ?? new Date();
  const cfg = resolveConfig(opts.home);
  // 前置检查：本地整理模型在不在。
  // 2026-10-28 删掉了 1.5B（它调不动工具）。缺模型是**降级**不是失败（E-6）：
  //   · 能做的部分照做：衰减补算 + advance({night:true})（energy 的唯一恢复点就在这）
  //   · 不能做的部分（抽取/冲突消解/自传）跳过，游标不动，/health 报 nightly-skipped
  // 前置检查统一走 preflight（C-3）：5 分钟按端点缓存、不可达≠失败
  const localRoles = Object.entries(cfg.roles)
    .filter(([role, r]) => role !== "embed" && r.kind === "local" && r.provider === "ollama")
    .map(([role, r]) => ({ role, model: r.model }));
  const pf = await preflight(cfg.ollama);
  const why = describeSkip(pf, localRoles);
  const skipReason = why ?? undefined;

  const d = openDb(opts.dbFile);
  // 降级时**不许**建 transport：routerFrom 会对空 model 报 E_CONFIG（这是对的，
  // 但不能让它把整轮 night 带崩——降级的要点就是“能做的照做”）。
  const transport = skipReason ? null : createTransport(routerFrom(cfg.roles as never));
  const embedder = createEmbedder("ollama", { baseUrl: cfg.ollama, model: cfg.roles["embed"]!.model });

  ensureTerritory(opts.home);

  // ── 抽取：带只读工具循环（P0-2）───────────────────────────
  // 以前是一次性长 prompt：模型看不到库里已有什么，只能猜 → 必然重复、认不出冲突。
  // 现在它能先 memory_search 核对一遍再交 JSON。工具白名单写在 nightagent.ts，
  // **执行侧也校验**（只从 schema 里藏起来不算数）。
  const toolTrace: ToolTrace[] = [];
  const extract = async (prompt: string): Promise<string> => {
    if (!transport) throw new Error("E_NO_MODEL");
    const policy = await loadPolicy(opts.home);
    const store = createStore(join(opts.home, "secrets"));
    const keys: Record<string, string> = {};
    for (const p of ["deepseek", "anthropic", "openai"] as Provider[]) { const k = store.get(p); if (k) keys[p] = k; }
    // 只读白名单：写入永远由 parseCandidates → remember() 的确定性闸门做
    const allow = new Set<string>(NIGHT_TOOLS);
    const registry = createToolRegistry({
      db: d.db, policy, ctx: { home: opts.home, now: () => new Date(), db: d.db, embedder },
      allow: (n) => allow.has(n),
    });
    const chatTransport = createChatTransport(routerFrom(cfg.roles as never), { apiKeys: keys });
    const extractor = makeToolExtractor({
      tools: registry,
      chat: (messages, tools) => chatTransport.chat("extract", messages, {
        containsMemory: true, purpose: "nightly-extract", maxTokens: 900, temperature: 0.2,
        tools: tools as never,
      }),
      onTool: (t) => toolTrace.push(t),
    });
    try {
      return await extractor(prompt);
    } catch (e) {
      // 纯抽取模型（如 NuExtract3）在 Ollama 里没有 tools 能力：
      // 那就退到「不带工具的纯文本抽取」——它本来也不需要查库，核对交给 verbatimGate。
      const msg = String((e as Error)?.message ?? e);
      if (!/does not support tools/i.test(msg)) throw e;
      let out = "";
      for await (const ev of chatTransport.chat("extract", [{ role: "user", content: prompt }], {
        containsMemory: true, purpose: "nightly-extract", maxTokens: 1200, temperature: 0.2,
      })) { if (ev.type === "delta") out += ev.text; }
      return out;
    }
  };

  // 纯文本通道（不带工具）：只给「她对你的理解」用
  const complete = async (prompt: string): Promise<string> => {
    if (!transport) throw new Error("E_NO_MODEL");
    const r = await transport.complete("night", [{ role: "user", content: prompt }], {
      containsMemory: true, purpose: "interpret", maxTokens: 500, temperature: 0.3,
    });
    return r.text;
  };

  const report = await runNightly({
    db: d.db, inboxDir: opts.inbox, home: opts.home, embedder, extract, complete, now,
    scoredBy: `extract:${cfg.roles["extract"]?.model || "?"}`,
    ...(skipReason ? { skipExtract: skipReason } : {}),
    ...(opts.rounds ? { rounds: opts.rounds } : {}),
  });

  let autobio: Awaited<ReturnType<typeof writeAutobiography>> | null = null;
  if (!skipReason && !opts.skipAutobio && transport) {
    const st = describe(loadState(d.db));
    autobio = await writeAutobiography({
      db: d.db, home: opts.home, now,
      complete: async (prompt) => (await transport.complete("night", [{ role: "user", content: prompt }], {
        containsMemory: true, purpose: "autobio", maxTokens: 600, temperature: 0.7,
      })).text,
      stateText: st,
    });
  }
  // H-a：从事实里刷新「她自己在惦记的事」（未闭合承诺 / 拖太久的线索 / 待人判的矛盾）
  // 纯确定性，不花模型；上限 5 条，超了就不加
  let agendaAdded = 0;
  try {
    const { refreshFromFacts } = await import("../agenda.ts");
    agendaAdded = refreshFromFacts(d.db, opts.home, now).added;
  } catch { /* 惦记刷新失败不影响整备 */ }

  // 无论抽没抽，这一句都要执行：能量、closeness、silenceDays 全靠它推进
  advance(d.db, { night: true, silenceDays: 1 }, now);

  if (skipReason) {
    console.error("⚠ 闲时整理降级：" + skipReason);
    console.error("   已做：衰减补算 + 状态推进。未做：抽取 / 冲突消解 / 自传。游标未推进，这轮对话没丢。");
    console.error("   要让它真整理：ollama pull qwen2.5:7b-instruct，然后 jingjing models use qwen2.5:7b-instruct");
  }

  const out = {
    skipped: skipReason ?? null,
    tools: toolTrace.map((t) => ({ name: t.name, ms: t.ms, result: String(t.result).slice(0, 160) })),
    nightly: report,
    autobio: autobio ? { path: autobio.path?.replace(opts.home, "<home>"), bytes: autobio.bytes, cited: autobio.cited, skipped: autobio.skipped } : null,
    territory: territoryListing(opts.home),
    spirits: listAutobiography(opts.home).slice(0, 3),
    outbound: (transport as unknown as { outbound?: () => unknown[] } | null)?.outbound?.() ?? [],
  };
  if (!opts.dryRun) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    // --verbose：dry-run 也把 notes 全打出来（核对有没有按新模板给 quote）
    console.log(JSON.stringify({ dryRun: true, scanned: report.scanned, candidates: report.candidates, ...(opts.verbose ? { notes: report.notes } : {}) }, null, 2));
  }
  return 0;
}

export const paths = (home: string) => ({
  dbFile: join(home, "memory.db"),
  inbox: join(home, "inbox"),
});
