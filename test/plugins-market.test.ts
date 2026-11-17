import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_MARKET, fetchMarket, marketUrlError, resetMarketCache, type MarketQuery,
} from "../src/plugins.ts";

const fake = (obj: unknown, status = 200): NonNullable<MarketQuery["fetch"]> =>
  async () => ({ ok: status === 200, status, headers: { get: () => null }, text: async () => JSON.stringify(obj) });

const newSchema = {
  $meta: { schema_version: 1, name: "Test Market", version: "1", homepage: "https://x.app" },
  "alice/astrbot_plugin_alpha": {
    author: "alice", name: "astrbot_plugin_alpha", version: "1.2.0",
    repo: "https://github.com/alice/astrbot_plugin_alpha", desc: "表情包管理器，能搜图",
    display_name: "表情包管理器", stars: 42, download_count: 900, tags: ["表情", "图片"],
  },
  "bob/astrbot_plugin_beta": {
    author: "bob", name: "astrbot_plugin_beta", version: "0.1",
    repo: "javascript:alert(1)", desc: "另一个插件", display_name: "Beta", stars: 7, updated_at: "2026-11-01T00:00:00Z",
  },
};

test("市场：新 schema 归一（$meta / author-name key / 身份 / 搜索 / 排序）", async () => {
  resetMarketCache();
  const v = await fetchMarket("https://example.test/market.json", { fetch: fake(newSchema), q: "表情" });
  assert.equal(v.meta?.name, "Test Market");
  assert.equal(v.total, 1);
  assert.equal(v.entries[0]!.id, "alice/astrbot_plugin_alpha");
  assert.equal(v.entries[0]!.displayName, "表情包管理器");
  assert.deepEqual(v.entries[0]!.tags, ["表情", "图片"]);
  const all = await fetchMarket("https://example.test/market.json", { fetch: fake(newSchema) });
  assert.equal(all.total, 2);
  assert.deepEqual(all.entries.map((e) => e.id), [
    "alice/astrbot_plugin_alpha", "bob/astrbot_plugin_beta",   // stars 降序
  ]);
  assert.equal(all.entries[1]!.repo, null, "非法 repo 不能当仓库链接");
});

test("市场：旧源兼容（无 $meta、根 key 就是 name）+ 身份唯一", async () => {
  const old = {
    astrbot_plugin_x: { author: "carol", version: "1", repo: "https://github.com/carol/astrbot_plugin_x", desc: "x" },
    "dave/astrbot_plugin_y": { author: "dave", name: "astrbot_plugin_y", version: "2", repo: "https://github.com/dave/astrbot_plugin_y", desc: "y" },
  };
  resetMarketCache();
  const v = await fetchMarket("https://example.test/old.json", { fetch: fake(old) });
  assert.equal(v.meta, null);
  assert.equal(v.total, 2);
  assert.ok(v.entries.some((e) => e.id === "carol/astrbot_plugin_x"));
  const dup = {
    "A/astrbot_plugin_z": { author: "A", name: "astrbot_plugin_z", version: "1", repo: "", desc: "" },
    "a/astrbot_plugin_z": { author: "a", name: "astrbot_plugin_z", version: "2", repo: "", desc: "" },
  };
  resetMarketCache();
  const d = await fetchMarket("https://example.test/dup.json", { fetch: fake(dup) });
  assert.equal(d.total, 1, "身份小写归一后重复的要丢掉");
});

test("市场：schema 版本、上游错误与过大响应都如实报错，不缓存失败", async () => {
  resetMarketCache();
  await assert.rejects(fetchMarket("https://example.test/bad.json", {
    fetch: fake({ $meta: { schema_version: 9 } }),
  }), /E_MARKET_SCHEMA/);
  await assert.rejects(fetchMarket("https://example.test/http.json", {
    fetch: fake({}, 500),
  }), /E_MARKET_HTTP/);
  await assert.rejects(fetchMarket("https://example.test/big.json", {
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => String(99 * 1024 * 1024) }, text: async () => "{}" }),
  }), /E_MARKET_TOO_BIG/);
  // 失败没进缓存：下一次仍会真去拉
  let calls = 0;
  const flaky: NonNullable<MarketQuery["fetch"]> = async () => {
    calls++;
    return calls === 1
      ? { ok: false, status: 503, headers: { get: () => null }, text: async () => "" }
      : { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(newSchema) };
  };
  await assert.rejects(fetchMarket("https://example.test/flaky.json", { fetch: flaky }), /E_MARKET_HTTP/);
  const ok = await fetchMarket("https://example.test/flaky.json", { fetch: flaky });
  assert.equal(ok.total, 2);
  assert.equal(calls, 2);
});

test("市场：按源缓存 15 分钟，force 强制重拉", async () => {
  resetMarketCache();
  let calls = 0;
  const counting: NonNullable<MarketQuery["fetch"]> = async () => {
    calls++;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(newSchema) };
  };
  const a = await fetchMarket("https://example.test/cache.json", { fetch: counting });
  const b = await fetchMarket("https://example.test/cache.json", { fetch: counting });
  assert.equal(calls, 1, "同源应命中缓存");
  assert.equal(b.cached, true);
  assert.equal(a.entries.length, b.entries.length);
  const c = await fetchMarket("https://example.test/cache.json", { fetch: counting, force: true });
  assert.equal(calls, 2);
  assert.equal(c.cached, false);
});

test("市场：自定义源只收 http(s)；空 = 官方源", () => {
  assert.equal(marketUrlError(""), "地址不能为空（留空表示用官方源）");
  assert.equal(marketUrlError("https://mirror.test/plugins.json"), null);
  assert.equal(marketUrlError("http://127.0.0.1:5000/astrbot/plugins"), null, "本地镜像可用");
  assert.match(marketUrlError("ftp://x/y") ?? "", /http\/https/);
  assert.match(marketUrlError("javascript:alert(1)") ?? "", /http\/https/);
  assert.match(marketUrlError("http://x/\u0000") ?? "", /控制字符/);
  assert.ok(OFFICIAL_MARKET.startsWith("https://"));
});
