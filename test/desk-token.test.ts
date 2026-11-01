import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newToken, writeDeskRuntime, readDeskRuntime, clearDeskRuntime,
  tokenFromRequest, sameToken, tokenExempt, DESK_COOKIE,
} from "../src/web/desk.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-desk-"));

test("令牌：随机、长度够、不重复", () => {
  const a = newToken(), b = newToken();
  assert.equal(a.length, 32);
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test("运行时文件：写 → 读 → 清", () => {
  const home = H();
  assert.equal(readDeskRuntime(home), null, "没写过就是 null");
  writeDeskRuntime(home, { port: 41234, token: "abc123", pid: 999 });
  const j = readDeskRuntime(home);
  assert.equal(j?.port, 41234);
  assert.equal(j?.token, "abc123");
  assert.equal(j?.pid, 999);
  clearDeskRuntime(home);
  assert.equal(existsSync(join(home, ".desk.json")), false);
  assert.equal(readDeskRuntime(home), null);
});

test("运行时文件：坏了就当他没写（不许让壳读到半个 JSON）", () => {
  const home = H();
  writeDeskRuntime(home, { port: 1, token: "t", pid: 1 });
  const p = join(home, ".desk.json");
  writeFileSync(p, "{ 这不是 json", "utf8");
  assert.equal(readDeskRuntime(home), null);
});

test("取令牌：?k= 优先，其次 cookie；都没有就是 null", () => {
  assert.equal(tokenFromRequest(new URL("http://x/?k=abc"), undefined), "abc");
  assert.equal(tokenFromRequest(new URL("http://x/"), `${DESK_COOKIE}=def`), "def");
  assert.equal(tokenFromRequest(new URL("http://x/"), `a=1; ${DESK_COOKIE}=def; b=2`), "def");
  assert.equal(tokenFromRequest(new URL("http://x/"), undefined), null);
  assert.equal(tokenFromRequest(new URL("http://x/"), "other=1"), null);
});

test("比令牌：等长才行，错一个字符就不算", () => {
  assert.equal(sameToken("abc", "abc"), true);
  assert.equal(sameToken("abc", "abd"), false);
  assert.equal(sameToken("ab", "abc"), false, "长度不同直接拒");
  assert.equal(sameToken(null, "abc"), false);
});

test("放行清单只有 /health 与 /icon.svg（其它一律要令牌）", () => {
  assert.equal(tokenExempt("/health"), true);
  assert.equal(tokenExempt("/icon.svg"), true);
  assert.equal(tokenExempt("/"), false);
  assert.equal(tokenExempt("/welcome"), false);
  assert.equal(tokenExempt("/api/say"), false);
});
