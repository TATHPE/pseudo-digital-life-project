import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { verbs } from "../src/verbs.ts";
import { capabilities } from "../src/capabilities.ts";
import { CLI_COMMANDS } from "../src/commands.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-cap-"));

test("B-0 工具清单从 verbs 真读：不是手写常量", async () => {
  const d = openDb(join(H(), "m.db"));
  const cap = await capabilities({ db: d.db, panel: false, commands: [] });
  const names = cap.classes.tool.filter((t) => t.source === "native").map((t) => t.name).sort();
  assert.deepEqual(names, verbs.map((v) => v.name).sort());
  assert.ok(names.includes("project.read"), "新加的 verb 要自动出现（这正是它不许手写的原因）");
});

test("B-0 删掉一个 MCP server → degraded 多一项（验收原文）", async () => {
  const d = openDb(join(H(), "m.db"));
  const before = await capabilities({ db: d.db, panel: true, commands: [], mcp: { servers: ["a"], tools: [], errors: [] } });
  const after = await capabilities({ db: d.db, panel: true, commands: [], mcp: { servers: [], tools: [], errors: ["markitdown: spawn failed"] } });
  assert.ok(!before.degraded.some((x) => x.startsWith("mcp-unavailable")));
  assert.ok(after.degraded.some((x) => x.startsWith("mcp-unavailable:markitdown")), JSON.stringify(after.degraded));
});

test("B-0 不撒谎：没实现的类要明说（hook 空 + 降级项）", async () => {
  const d = openDb(join(H(), "m.db"));
  const cap = await capabilities({ db: d.db, panel: true, commands: ["capabilities"] });
  assert.equal(cap.classes.hook.length, 0);
  // hooks 现在真做了（data/hooks.json）；没装钩子时这一类是空的，但**不再降级**
  assert.ok(!cap.degraded.includes("hooks-not-implemented"), "hooks 已实现，不该再报降级");
  assert.equal(cap.classes.command.length, 1, "命令表只报调用方给的真实表");
});

test("B-0 缺本地模型 / 索引过期 会同时出现在 degraded 与 notes", async () => {
  const d = openDb(join(H(), "m.db"));
  d.db.prepare("INSERT INTO meta(key,value) VALUES('nightly_skipped','x')").run();
  const cap = await capabilities({
    db: d.db, panel: false, commands: [],
    cfg: {
      ollama: "http://127.0.0.1:11434",
      roles: {
        embed: { kind: "local", provider: "ollama", model: "bge-m3" },
        extract: { kind: "local", provider: "ollama", model: "" },
        night: { kind: "local", provider: "ollama", model: "" },
        express: { kind: "cloud", provider: "deepseek", model: "deepseek-chat" },
      },
    } as never,
    ollama: { base: "http://127.0.0.1:11434", online: true, names: ["bge-m3"] },
  });
  assert.ok(cap.degraded.includes("nightly-skipped"));
  assert.ok(cap.degraded.includes("local-model-missing"), JSON.stringify(cap.degraded));
  assert.ok(cap.notes.some((n) => /未配置本地模型/.test(n)));
  assert.ok(cap.providers.roles.some((r) => r.role === "express" && r.kind === "cloud"));
});

test("B-0 CLI 命令表不许漂：与源码里的 switch 分支一致", () => {
  const src = readFileSync("src/cli/jingjing.ts", "utf8");
  const cases = [...src.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]).filter((x): x is string => Boolean(x));
  const fromSrc = [...new Set(cases)].filter((c) => !["set", "list", "remove", "clear", "use"].includes(c));
  const listed = [...CLI_COMMANDS].sort();
  const actual = [...fromSrc].sort();
  // 源码里可能多出嵌套 switch 的 case（如 models 的 use/list），逐个核对：表里每个都要在源码里
  for (const c of listed) assert.ok(actual.includes(c) || c === "capabilities", `CLI_COMMANDS 里有 ${c}，源码里找不到`);
  for (const c of ["capabilities", "night", "beat", "reembed", "links"]) assert.ok(listed.includes(c), `漏了 ${c}`);
});

test("B-0 降级项不许是陈年误报：vec 写入成功后要清掉 vec_error", async () => {
  const { remember } = await import("../src/store.ts");
  const { createEmbedder } = await import("../src/embed.ts");
  const d = openDb(join(H(), "m.db"));
  d.db.prepare("INSERT INTO meta(key,value) VALUES('vec_error','UNIQUE constraint failed')").run();
  const emb = createEmbedder("fake");
  const v = (await emb.embed(["x"]))[0]!;
  remember(d.db, { layer: "narrative", kind: "episode", text: "一条会成功写向量的记忆", embedding: v });
  const leftover = d.db.prepare("SELECT value FROM meta WHERE key='vec_error'").get();
  assert.equal(leftover, undefined, "状态标记只在“现在真的坏”时才该存在");
});

test("B-0 启动自检：陈旧 vec_error 会被清掉（不读旧标记，现在试一下）", async () => {
  const home = H();
  const f = join(home, "m.db");
  const d1 = openDb(f);
  d1.db.prepare("INSERT INTO meta(key,value) VALUES('vec_error','历史失败')").run();
  d1.db.close();
  const d2 = openDb(f);   // 重新打开 = 启动一次
  const leftover = d2.db.prepare("SELECT value FROM meta WHERE key='vec_error'").get();
  assert.equal(leftover, undefined, "探针成功就该清掉历史报错");
});
