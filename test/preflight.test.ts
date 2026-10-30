import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight, lastPreflight, resetPreflight, missingFrom, describeSkip, PREFLIGHT_TTL_MS } from "../src/preflight.ts";

const B = "http://127.0.0.1:11434";

test("C-3 不可达 ≠ 失败：返回 online:false，不抛异常", async () => {
  resetPreflight();
  let calls = 0;
  const st = await preflight(B, { probe: async () => { calls++; return { online: false, names: [], error: "ECONNREFUSED" }; } });
  assert.equal(st.online, false);
  assert.equal(st.error, "ECONNREFUSED");
  assert.equal(calls, 1, "探一次就够，不许重试风暴");
});

test("C-3 按端点缓存 5 分钟：短时间内只探一次，force 可强制重探", async () => {
  resetPreflight();
  let calls = 0;
  let t = 1_000_000;
  const probe = async () => { calls++; return { online: true, names: ["bge-m3:latest"] }; };
  await preflight(B, { probe, now: () => t });
  t += 60_000;                       // 1 分钟后：命中缓存
  const second = await preflight(B, { probe, now: () => t });
  assert.equal(calls, 1, "TTL 内不该再敲端口");
  assert.equal(second.cached, true);

  t += PREFLIGHT_TTL_MS;             // 超过 TTL
  await preflight(B, { probe, now: () => t });
  assert.equal(calls, 2, "过了 TTL 要重探");

  await preflight(B, { probe, now: () => t, force: true });
  assert.equal(calls, 3, "force 必须绕过缓存");
});

test("C-3 并发去重：同一时刻的多个调用共享一次探测", async () => {
  resetPreflight();
  let calls = 0;
  let release: (v: { online: boolean; names: string[] }) => void = () => {};
  const probe = () => { calls++; return new Promise<{ online: boolean; names: string[] }>((r) => { release = r; }); };
  const p1 = preflight(B, { probe, force: true });
  const p2 = preflight(B, { probe, force: true });
  release({ online: true, names: [] });
  await Promise.all([p1, p2]);
  assert.equal(calls, 1, "并发应共享同一个 in-flight 请求");
});

test("C-3 lastPreflight 只读缓存：没探过就是 null（/health 不许自己探头）", async () => {
  resetPreflight();
  assert.equal(lastPreflight(B), null);
  await preflight(B, { probe: async () => ({ online: true, names: ["bge-m3"] }) });
  assert.equal(lastPreflight(B)?.online, true);
});

test("C-3 missingFrom 容忍 :latest；describeSkip 分清三种原因", async () => {
  resetPreflight();
  const st = await preflight(B, { probe: async () => ({ online: true, names: ["bge-m3:latest"] }) });
  assert.deepEqual(missingFrom(st, ["bge-m3"]), [], "bge-m3 与 bge-m3:latest 是同一个");
  assert.deepEqual(missingFrom(st, ["qwen2.5:7b"]), ["qwen2.5:7b"]);

  // ① 端点不可达
  resetPreflight();
  const off = await preflight(B, { probe: async () => ({ online: false, names: [], error: "ECONNREFUSED" }) });
  assert.match(String(describeSkip(off, [{ role: "extract", model: "bge-m3" }])), /不可达/);

  // ② 没配
  const on = await preflight(B, { force: true, probe: async () => ({ online: true, names: ["bge-m3"] }) });
  assert.match(String(describeSkip(on, [{ role: "extract", model: "" }])), /未配置/);

  // ③ 配了但没装
  assert.match(String(describeSkip(on, [{ role: "extract", model: "qwen2.5:7b" }])), /未安装/);

  // ④ 都齐了 → null（不跳过）
  assert.equal(describeSkip(on, [{ role: "extract", model: "bge-m3" }]), null);
});

test("C-3 night 的跳过原因能区分「端点不可达」与「没装模型」", async () => {
  // 这一条测的是 describeSkip 的语义；night 直接用它，所以原因不会混
  resetPreflight();
  const off = await preflight(B, { probe: async () => ({ online: false, names: [] }) });
  const a = describeSkip(off, [{ role: "extract", model: "bge-m3" }]);
  const on = await preflight(B, { force: true, probe: async () => ({ online: true, names: [] }) });
  const b = describeSkip(on, [{ role: "extract", model: "bge-m3" }]);
  assert.notEqual(a, b);
  assert.match(String(a), /不可达/);
  assert.match(String(b), /未安装/);
});

test("C-3 embed 已配不能盖住“聊天角色没配”（night 报错过一次）", async () => {
  resetPreflight();
  const on = await preflight(B, { force: true, probe: async () => ({ online: true, names: ["bge-m3"] }) });
  const why = describeSkip(on, [
    { role: "route", model: "" }, { role: "extract", model: "" }, { role: "night", model: "" },
  ]);
  assert.match(String(why), /未配置本地模型/);
  // 已配但没装的那类要同时报出来
  const both = describeSkip(on, [{ role: "route", model: "" }, { role: "extract", model: "qwen2.5:7b" }]);
  assert.match(String(both), /未配置/);
  assert.match(String(both), /未安装/);
});
