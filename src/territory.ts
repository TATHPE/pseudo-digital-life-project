/**
 * 领地（16 §3.5）：它自己的那块磁盘。
 * 规则：人可以看，但不占用；允许弄乱；journal/drafts 不进语义索引。
 */
import { mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const TERRITORY = ["journal", "autobiography", "drafts", "collection", "tools", "ruins"] as const;
export type TerritoryDir = (typeof TERRITORY)[number];

/** 这些目录**永远不进语义索引**（只在 FTS 里，且 taint=owner） */
export const NOT_INDEXED: ReadonlySet<TerritoryDir> = new Set(["journal", "drafts", "ruins"]);

export function territoryRoot(home: string): string { return join(home, "life"); }

export function ensureTerritory(home: string): string {
  const root = territoryRoot(home);
  for (const d of TERRITORY) mkdirSync(join(root, d), { recursive: true });
  return root;
}

export function territoryListing(home: string): Array<{ dir: TerritoryDir; files: number; bytes: number; indexed: boolean }> {
  const root = territoryRoot(home);
  return TERRITORY.map((dir) => {
    const p = join(root, dir);
    let files = 0, bytes = 0;
    if (existsSync(p)) {
      for (const f of readdirSync(p)) {
        try { const st = statSync(join(p, f)); if (st.isFile()) { files++; bytes += st.size; } } catch { /* ignore */ }
      }
    }
    return { dir, files, bytes, indexed: !NOT_INDEXED.has(dir) };
  });
}

export function shouldIndex(dir: TerritoryDir): boolean {
  return !NOT_INDEXED.has(dir);
}
