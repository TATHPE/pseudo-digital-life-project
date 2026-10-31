import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfig, EXIT_CONFIG } from "../src/startupcheck.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-start-"));

test("D-5 好配置：没有任何致命项", () => {
  const h = H();
  writeFileSync(join(h, "config.json"), JSON.stringify({ express: { model: "deepseek-chat" } }));
  const ps = checkConfig(h);
  assert.equal(ps.filter((p) => p.fatal).length, 0, JSON.stringify(ps));
  assert.equal(EXIT_CONFIG, 78);
});

test("D-5 config.json 解不开 → 致命（不再静默回到默认值）", () => {
  const h = H();
  writeFileSync(join(h, "config.json"), "{ 这不是 JSON");
  const ps = checkConfig(h);
  const f = ps.filter((p) => p.fatal);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.code, "E_CONFIG_CORRUPT");
  assert.ok(f[0]!.fix, "要给出照做的方法");
});

test("D-5 policy.csv 结构坏 → 致命（不再等到某次调用才炸）", () => {
  const h = H();
  writeFileSync(join(h, "policy.csv"), "p, allow, T0, fs.read, *, enforce\n坏行, 随便写\n");
  const ps = checkConfig(h).filter((p) => p.fatal);
  assert.equal(ps.length, 1);
  assert.equal(ps[0]!.code, "E_POLICY_CORRUPT");
  assert.match(ps[0]!.detail, /1 行结构不对/);
});

test("D-5 policy.model.conf 缺段落 → 致命", () => {
  const h = H();
  writeFileSync(join(h, "policy.model.conf"), "[request_definition]\nr = sub, obj, act\n");
  const ps = checkConfig(h).filter((p) => p.fatal);
  assert.ok(ps.some((p) => p.code === "E_POLICY_MODEL_CORRUPT"));
});

test("D-5 衰减参数越界只警告，不阻止启动", () => {
  const h = H();
  writeFileSync(join(h, "config.json"), JSON.stringify({ decay: { kinds: { episode: { halfLifeDays: 99999 } } } }));
  const ps = checkConfig(h);
  assert.equal(ps.filter((p) => p.fatal).length, 0, "参数问题属于②类，只警告");
  assert.ok(ps.some((p) => p.code === "E_DECAY_PARAM"));
});

test("D-5 命令行真的退 78（而不是带坏配置跑起来）", async () => {
  const { spawnSync } = await import("node:child_process");
  const h = H();
  mkdirSync(join(h, "inbox"), { recursive: true });
  writeFileSync(join(h, "config.json"), "{坏了");
  const r = spawnSync(process.execPath, ["src/cli/jingjing.ts", "capabilities"], {
    encoding: "utf8", env: { ...process.env, JJ_HOME: h },
  });
  assert.equal(r.status, 78, `期望 78，实际 ${r.status}；stderr=${r.stderr.slice(0, 200)}`);
  assert.match(r.stderr, /E_CONFIG_CORRUPT/);
  // migrate 例外：它本来就是用来修库的
  const m = spawnSync(process.execPath, ["src/cli/jingjing.ts", "migrate"], {
    encoding: "utf8", env: { ...process.env, JJ_HOME: h },
  });
  assert.notEqual(m.status, 78, "migrate 不该被配置校验拦住");
});
