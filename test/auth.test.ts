import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, fingerprint } from "../src/auth.ts";

test("指纹只暴露前 5 后 4，中间永不出现", () => {
  const k = "sk-abcdefghijklmnopqrstuvwxyz1234";
  const f = fingerprint(k);
  assert.ok(f.startsWith("sk-ab"));
  assert.ok(f.endsWith("1234"));
  assert.ok(!f.includes("defghij"));
});

test("set/get 往返（当前平台的存储）", () => {
  const dir = mkdtempSync(join(tmpdir(), "jj-auth-"));
  const s = createStore(dir);
  const k = "sk-test-0123456789abcdef";
  s.set("deepseek", k);
  assert.equal(s.get("deepseek"), k);
  const list = s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.provider, "deepseek");
  // 列表里不能出现明文
  assert.ok(!JSON.stringify(list).includes("0123456789abcdef"));
});

test("未设置的 provider 返回 undefined，不抛", () => {
  const s = createStore(mkdtempSync(join(tmpdir(), "jj-auth2-")));
  assert.equal(s.get("openai"), undefined);
});
