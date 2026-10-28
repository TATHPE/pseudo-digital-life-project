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

export async function runNightCli(opts: NightOptions): Promise<number> {
  const now = opts.now ?? new Date();
  const cfg = resolveConfig(opts.home);
  const d = openDb(opts.dbFile);
  const transport = createTransport(routerFrom(cfg.roles as never));
  const embedder = createEmbedder("ollama", { baseUrl: cfg.ollama, model: cfg.roles["embed"]!.model });

  ensureTerritory(opts.home);

  const extract = async (prompt: string): Promise<string> => {
    // containsMemory=true → 只允许本地角色（19 §0.1 W-A）
    const r = await transport.complete("extract", [{ role: "user", content: prompt }], {
      containsMemory: true, purpose: "nightly-extract", maxTokens: 700, temperature: 0.2,
    });
    return r.text;
  };

  const report = await runNightly({
    db: d.db, inboxDir: opts.inbox, home: opts.home, embedder, extract, now,
  });

  let autobio: Awaited<ReturnType<typeof writeAutobiography>> | null = null;
  if (!opts.skipAutobio) {
    const st = describe(loadState(d.db));
    autobio = await writeAutobiography({
      db: d.db, home: opts.home, now,
      complete: async (prompt) => (await transport.complete("night", [{ role: "user", content: prompt }], {
        containsMemory: true, purpose: "autobio", maxTokens: 600, temperature: 0.7,
      })).text,
      stateText: st,
    });
  }
  advance(d.db, { night: true, silenceDays: 1 }, now);

  const out = {
    nightly: report,
    autobio: autobio ? { path: autobio.path?.replace(opts.home, "<home>"), bytes: autobio.bytes, cited: autobio.cited, skipped: autobio.skipped } : null,
    territory: territoryListing(opts.home),
    spirits: listAutobiography(opts.home).slice(0, 3),
    outbound: (transport as unknown as { outbound?: () => unknown[] }).outbound?.() ?? [],
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
