import { test } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_ONLY_TOOLS, NIGHT_TOOLS, isMemoryTool, isLocalRole } from "../src/memoryonly.ts";
import { NIGHT_TOOLS as NIGHT } from "../src/nightagent.ts";
import { createToolRegistry } from "../src/tools.ts";
import { openDb } from "../src/db.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("本地模型的能力面：只含记忆/只读，**不含** fs.write / shell / 网络", () => {
  for (const t of MEMORY_ONLY_TOOLS) {
    assert.ok(!/^shell\./.test(t), "本地模型不许有 shell：" + t);
    assert.ok(!/^net\./.test(t), "本地模型不许发网络：" + t);
    assert.notEqual(t, "fs.write", "本地模型不许写文件");
    assert.notEqual(t, "fs.trash", "本地模型不许删东西");
  }
  assert.ok(isMemoryTool("memory.search"));
  assert.equal(isMemoryTool("shell.run"), false);
  assert.equal(isLocalRole({ kind: "local" }), true);
  assert.equal(isLocalRole({ kind: "cloud" }), false);
});

test("夜间白名单与本地白名单是**同一份**（只少一个写入）", () => {
  assert.deepEqual([...NIGHT], [...NIGHT_TOOLS], "夜间直接引用 memoryonly.ts，不复制第二份");
  assert.ok(!NIGHT.includes("memory.remember" as never), "夜间不为模型开写入（写入由确定性代码做）");
  assert.ok(MEMORY_ONLY_TOOLS.includes("memory.remember" as never), "本地对话角色可以有 remember");
});

test("执行侧也校验：白名单外的工具就算被硬报名字也跑不起来", async () => {
  const home = mkdtempSync(join(tmpdir(), "jj-memonly-"));
  const d = openDb(join(home, "m.db"));
  const reg = createToolRegistry({
    db: d.db,
    policy: { authorize: async () => ({ allow: true, strength: "advise", reason: "test" }) } as never,
    ctx: { home, now: () => new Date(), db: d.db },
    allow: (n) => isMemoryTool(n),
  });
  const ok = await reg.run("memory.remember", { text: "本地模型记一条" });
  assert.equal(ok.ok, true, ok.output);
  const bad = await reg.run("fs.write", { path: "workspace/x.txt", content: "x" });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /E_NO_CAPABILITY/);
  const shell = await reg.run("shell.run", { template: "node.run_script", slots: { script: "a.mjs" } });
  assert.equal(shell.ok, false);
  assert.match(shell.output, /E_NO_CAPABILITY/);
});
