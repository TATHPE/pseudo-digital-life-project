import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A-3 的"不撒谎"：AGENTS.md 里点名的路径与命令必须真的存在 */
const MD = readFileSync("AGENTS.md", "utf8");

test("A-3 AGENTS.md 指向的文档都在（路径漂了就红）", () => {
  const refs = [...MD.matchAll(/`\.\.\/([^`]+\.md)`/g)].map((m) => m[1]);
  assert.ok(refs.length >= 8, "至少要指向核心文档");
  for (const r of refs) {
    assert.ok(existsSync(join("..", r!)), `AGENTS.md 指向的 ${r} 不存在`);
  }
});

test("A-3 代码地图里点名的文件都在", () => {
  const map = MD.slice(MD.indexOf("## 6. 代码地图"));
  const files = [...map.matchAll(/^([a-z]+(?:\/[a-z]+)?\.ts)/gm)].map((m) => m[1]);
  assert.ok(files.length >= 15, `代码地图条目太少：${files.length}`);
  for (const f of files) assert.ok(existsSync(join("src", f!)), `代码地图里的 src/${f} 不存在`);
});

test("A-3 写的命令都真的存在（不许写在文档里但跑不了）", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  for (const s of ["check", "ui:test"]) assert.ok(pkg.scripts[s], `package.json 缺 script ${s}`);
  assert.ok(MD.includes("node src/cli/jingjing.ts serve 7700"), "serve 的写法要能直接复制");
});

test("A-3 不缓存环境能答的东西：不许写死测试条数", () => {
  assert.ok(!/\d+\s*条测试/.test(MD), "条数会过期；让 `npm run check` 自己报");
});
