import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESET_AGENT_NAME, MAX_AGENT_NAME, normalizeAgentName, readFileConfig, writeFileConfig } from "../src/configfile.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-name-"));

test("她的名字：默认是预置人格名，不是项目名", () => {
  assert.equal(PRESET_AGENT_NAME, "鲸鲸", "预置人格叫鲸鲸");
  const home = H();
  assert.equal(normalizeAgentName(readFileConfig(home).agent?.name), PRESET_AGENT_NAME, "没配就用预置名");
});

test("她的名字：空串回到预置名；控制字符去掉；超长截断", () => {
  assert.equal(normalizeAgentName(""), PRESET_AGENT_NAME);
  assert.equal(normalizeAgentName("   "), PRESET_AGENT_NAME);
  assert.equal(normalizeAgentName(undefined), PRESET_AGENT_NAME);
  assert.equal(normalizeAgentName("小满"), "小满");
  assert.equal(normalizeAgentName("a" + String.fromCharCode(1) + "b"), "ab", "控制字符要去掉");
  assert.equal(normalizeAgentName("x".repeat(50)).length, MAX_AGENT_NAME);
});

test("她的名字：写进 config.json 的 agent.name，读得回来", () => {
  const home = H();
  writeFileSync(join(home, "config.json"), JSON.stringify({ express: { provider: "deepseek", model: "m" } }), "utf8");
  writeFileConfig(home, { agent: { name: "小满" } });
  const cfg = readFileConfig(home);
  assert.equal(cfg.agent?.name, "小满");
  assert.equal(cfg.express?.provider, "deepseek", "别的字段不能被名字覆盖掉");
  writeFileConfig(home, { agent: { name: "" } });
  assert.equal(readFileConfig(home).agent?.name, "", "存进去的是原样，读取时再规范化");
});
