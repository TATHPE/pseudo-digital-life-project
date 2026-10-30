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

// ── C-1：密钥必须能删（降级链唯一的精确开关）───────────────────
test("C-1 clear：删掉后 get 返回 undefined、list 里也没有，重复删幂等", () => {
  const s = createStore(mkdtempSync(join(tmpdir(), "jj-auth3-")));
  s.set("deepseek", "sk-test-0123456789abcdef");
  assert.equal(s.get("deepseek"), "sk-test-0123456789abcdef");

  assert.equal(s.clear("deepseek"), true);
  assert.equal(s.get("deepseek"), undefined, "删掉之后不能再读出来");
  assert.equal(s.list().length, 0, "列表里也不能残留指纹");

  assert.equal(s.clear("deepseek"), false, "重复删是幂等的，不报错");
  assert.equal(s.clear("openai"), false, "从没设置过也不报错");
});

test("C-1 clear 之后还能重新 set（不是一次性的破坏）", () => {
  const s = createStore(mkdtempSync(join(tmpdir(), "jj-auth4-")));
  s.set("deepseek", "sk-old-000000000000");
  s.clear("deepseek");
  s.set("deepseek", "sk-new-111111111111");
  assert.equal(s.get("deepseek"), "sk-new-111111111111");
});
