/**
 * 源码 import 图不许有环（2026-11-09）。
 *
 * 修之前有两个强连通分量：
 *   verbs ↔ project ↔ coreguard ↔ shell
 *   interpret → nightly → interpretnight → interpret
 * 前者让「能力表本该在最底层」变成环的一部分，后者让意义层反向依赖夜间整理。
 * 现在路径原语抽到 pathsafe.ts、建边抽到 links.ts，两处都断了；
 * 这条用例盯住别再长回来。静态 import 与动态 import() 都算边。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = normalize(join(dirname(fileURLToPath(import.meta.url)), "..", "src"));

function collect(dir: string, out: Map<string, Set<string>>): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { collect(p, out); continue; }
    if (!e.name.endsWith(".ts")) continue;
    const rel = relative(SRC, p).replace(/\\/g, "/");
    const text = readFileSync(p, "utf8");
    const deps = new Set<string>();
    for (const m of text.matchAll(/(?:from\s+|import\s*\()\s*["'](\.[^"']+\.ts)["']/g)) {
      const t = normalize(join(dirname(rel), m[1]!)).replace(/\\/g, "/");
      if (!t.startsWith("../")) deps.add(t);
    }
    out.set(rel, deps);
  }
}

/** Tarjan：只要返回非空就是有环 */
function stronglyConnected(graph: Map<string, Set<string>>): string[][] {
  let idx = 0;
  const num = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], on = new Set<string>(), cycles: string[][] = [];
  const visit = (v: string): void => {
    num.set(v, idx); low.set(v, idx); idx += 1;
    stack.push(v); on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;              // 指向不存在的文件不参与判环
      if (!num.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, num.get(w)!));
    }
    if (low.get(v) === num.get(v)) {
      const group: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        on.delete(w);
        group.push(w);
        if (w === v) break;
      }
      if (group.length > 1) cycles.push(group.sort());
    }
  };
  for (const v of graph.keys()) if (!num.has(v)) visit(v);
  return cycles;
}

test("src/ 的 import 图无循环依赖（含动态 import）", () => {
  const g = new Map<string, Set<string>>();
  collect(SRC, g);
  assert.ok(g.size > 100, `源文件数不对：${g.size}`);
  const cycles = stronglyConnected(g);
  assert.deepEqual(cycles, [], `出现循环依赖：${cycles.map((c) => c.join(" ↔ ")).join(" | ")}`);
});
