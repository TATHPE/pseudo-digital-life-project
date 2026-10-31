import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectFile, listProject, searchProject } from "../src/project.ts";
import { verbs } from "../src/verbs.ts";

/** 造一个假项目：jingjing/{src,data/secrets,.git,node_modules,.env} + docs/ */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jj-proj-"));
  const mk = (p: string) => mkdirSync(join(root, p), { recursive: true });
  const wr = (p: string, s: string) => { mk(p.split("/").slice(0, -1).join("/")); writeFileSync(join(root, p), s); };
  mk("jingjing/src"); mk("jingjing/test");
  wr("jingjing/src/recall.ts", "export function recallForBrief(x) {\n  return x; // 注释里有 secret\n}\n");
  wr("jingjing/test/a.test.ts", "recallForBrief(1);\n");
  wr("jingjing/data/secrets/deepseek.secret", "CIPHERTEXT");
  wr("jingjing/.env", "DEEPSEEK_KEY=sk-x");
  wr("jingjing/.git/config", "[core]");
  wr("jingjing/node_modules/m/index.js", "module.exports=1");
  wr("docs/22-x.md", "# 文档\n");
  const env = { JJ_PROJECT_HOME: root, JJ_PROJECT_EGRESS: "1" } as Record<string, string>;
  return { root, env };
}

test("K-1 读项目：能在 jingjing/ 与 docs/ 下读，行区间生效", () => {
  const { env } = fixture();
  const a = readProjectFile("src/recall.ts", { env });
  assert.match(a.text, /recallForBrief/);
  assert.equal(a.path, "jingjing/src/recall.ts");
  const b = readProjectFile("jingjing/src/recall.ts", { env });
  assert.equal(b.path, "jingjing/src/recall.ts", "带根名与不带根名都能解析");
  const one = readProjectFile("src/recall.ts", { from: 1, to: 1, env });
  assert.equal(one.text.split(String.fromCharCode(10)).length, 1, "from/to 只给那一行");
  assert.match(readProjectFile("docs/22-x.md", { env }).text, /文档/);
});

test("K-1 边界：密钥/.env/.git/node_modules 一律 E_PATH_DENIED；根外 E_OUT_OF_PROJECT", () => {
  const { env } = fixture();
  for (const p of [
    "jingjing/data/secrets/deepseek.secret",
    "jingjing/.env",
    "jingjing/.git/config",
    "jingjing/node_modules/m/index.js",
  ]) {
    assert.throws(() => readProjectFile(p, { env }), /E_PATH_DENIED/, `${p} 必须被拒`);
  }
  assert.throws(() => readProjectFile("../../Windows/win.ini", { env }), /E_OUT_OF_PROJECT/);
  assert.throws(() => readProjectFile("jingjing/src/../data/secrets/x.secret", { env }), /E_PATH_DENIED/, "路径里的 .. 也要展开后再判");
});

test("K-1 列表：.git/ .venv/ data/ 不出现在输出里", () => {
  const { env } = fixture();
  const rows = listProject("jingjing", env);
  const names = rows.map((r) => r.path);
  assert.ok(names.includes("jingjing/src"), "正常目录要在");
  assert.ok(!names.some((n) => /\/\.git$|\/data$|node_modules$/.test(n)), `不该出现：${names.join(",")}`);
});

test("K-1 搜索：非法正则回落成字面量（搜 foo( 不该报错）", () => {
  const { env } = fixture();
  const hits = searchProject("recallForBrief(", { glob: "*.ts", env });
  assert.ok(hits.length >= 2, "两处调用都应命中");
  assert.ok(hits.every((h) => h.path.endsWith(".ts")));
  const docHits = searchProject("文档", { env });
  assert.ok(docHits.some((h) => h.path === "docs/22-x.md"), "docs/ 也要能搜到");
});

test("K-1 出网闸：云端表达模型 + 未显式同意 → 拒（返回 E_PROJECT_EGRESS）", async () => {
  const { root, env } = fixture();
  const v = verbs.find((x) => x.name === "project.read")!;
  const base = { home: root, now: () => new Date() };
  // 未给 JJ_PROJECT_EGRESS：默认配置里 express 是云端 → 必须拒
  const deny = await v.run({ path: "src/recall.ts" }, { ...base, env: { JJ_PROJECT_HOME: root } } as never)
    .then((r: string) => r, (e: Error) => e.message);
  assert.match(String(deny), /E_PROJECT_EGRESS/);
  // 显式同意后放行
  const ok = await v.run({ path: "src/recall.ts" }, { ...base, env } as never);
  assert.match(String(ok), /recallForBrief/);
});
