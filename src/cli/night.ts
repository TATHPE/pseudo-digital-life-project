/**
 * CLI：night —— 跑一次夜间整备（抽取 + 冲突消解 + 归并 + 自传）。
 * 抽取走**本地模型**（role=extract），不出网；这一点由 transport 的守卫保证。
 */
import { join } from "node:path";
import { openDb } from "../db.ts";
import { runNightly } from "../nightly.ts";
import { writeAutobiography, listAutobiography } from "../autobio.ts";
import { ensureTerritory, territoryListing } from "../territory.ts";
import { loadState, advance, describe } from "../state.ts";
import { createTransport, routerFrom } from "../transport.ts";
import { createEmbedder } from "../embed.ts";
import { defaultConfig } from "../config.ts";
import { resolveConfig } from "../configfile.ts";

export interface NightOptions {
  home: string;
  dbFile: string;
  inbox: string;
  dryRun?: boolean;
  skipAutobio?: boolean;
  now?: Date;
}

/**
 * 检查角色表里那些本地角色，模型到底装没装（问一次 Ollama 的 /api/tags）。
 * 只检查 kind=local 的；云端角色不做网络探测（也不该在夜间流程里出网）。
 */
async function missingLocalModels(roles: Record<string, { kind: string; provider: string; model: string }>): Promise<string[]> {
  const local = Object.values(roles).filter((r) => r.kind === "local" && r.provider === "ollama");
  const unset = local.filter((r) => !r.model).length;
  const wanted = [...new Set(local.map((r) => r.model).filter(Boolean))];
  // 没配模型 ≠ 没装模型：以前默认值指向已删的 qwen2.5:1.5b-instruct，报错会把人引错（C-5）
  const unsetNote = unset ? [`（未配置本地模型：设 JJ_MODEL_DEFAULT，或用 jingjing models use 写进 config.json）`] : [];
  if (!wanted.length) return unsetNote;
  let have: string[] = [];
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    const j = await r.json() as { models?: Array<{ name: string }> };
    have = (j.models ?? []).map((m) => m.name);
  } catch {
    return [...unsetNote, "（Ollama 没在跑：http://127.0.0.1:11434 连不上）"];
  }
  return [...unsetNote, ...wanted.filter((m) => !have.includes(m) && !have.includes(m + ":latest"))];
}

export async function runNightCli(opts: NightOptions): Promise<number> {
  const now = opts.now ?? new Date();
  const cfg = resolveConfig(opts.home);
  // 前置检查：本地整理模型在不在。
  // 2026-10-28 删掉了 1.5B（它调不动工具）。缺模型是**降级**不是失败（E-6）：
  //   · 能做的部分照做：衰减补算 + advance({night:true})（energy 的唯一恢复点就在这）
  //   · 不能做的部分（抽取/冲突消解/自传）跳过，游标不动，/health 报 nightly-skipped
  const missing = await missingLocalModels(cfg.roles);
  const skipReason = missing.length ? `缺本地模型：${missing.join(", ")}` : undefined;

  const d = openDb(opts.dbFile);
  // 降级时**不许**建 transport：routerFrom 会对空 model 报 E_CONFIG（这是对的，
  // 但不能让它把整轮 night 带崩——降级的要点就是“能做的照做”）。
  const transport = skipReason ? null : createTransport(routerFrom(cfg.roles as never));
  const embedder = createEmbedder("ollama", { baseUrl: cfg.ollama, model: cfg.roles["embed"]!.model });

  ensureTerritory(opts.home);

  const extract = async (prompt: string): Promise<string> => {
    if (!transport) throw new Error("E_NO_MODEL");
    // containsMemory=true → 只允许本地角色（19 §0.1 W-A）
    const r = await transport.complete("extract", [{ role: "user", content: prompt }], {
      containsMemory: true, purpose: "nightly-extract", maxTokens: 700, temperature: 0.2,
    });
    return r.text;
  };

  const report = await runNightly({
    db: d.db, inboxDir: opts.inbox, home: opts.home, embedder, extract, now,
    ...(skipReason ? { skipExtract: skipReason } : {}),
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
  // 无论抽没抽，这一句都要执行：能量、closeness、silenceDays 全靠它推进
  advance(d.db, { night: true, silenceDays: 1 }, now);

  if (skipReason) {
    console.error("⚠ 夜间整备降级：" + skipReason);
    console.error("   已做：衰减补算 + 状态推进。未做：抽取 / 冲突消解 / 自传。游标未推进，这轮对话没丢。");
    console.error("   要让它真整理：ollama pull qwen2.5:7b-instruct，然后 export JJ_MODEL_DEFAULT=qwen2.5:7b-instruct");
  }

  const out = {
    skipped: skipReason ?? null,
    nightly: report,
    autobio: autobio ? { path: autobio.path?.replace(opts.home, "<home>"), bytes: autobio.bytes, cited: autobio.cited, skipped: autobio.skipped } : null,
    territory: territoryListing(opts.home),
    spirits: listAutobiography(opts.home).slice(0, 3),
    outbound: (transport as unknown as { outbound?: () => unknown[] } | null)?.outbound?.() ?? [],
  };
  if (!opts.dryRun) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(JSON.stringify({ dryRun: true, scanned: report.scanned, candidates: report.candidates }, null, 2));
  }
  return 0;
}

export const paths = (home: string) => ({
  dbFile: join(home, "memory.db"),
  inbox: join(home, "inbox"),
});
