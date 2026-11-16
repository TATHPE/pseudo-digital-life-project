/**
 * 对话预算开关（2026-11-16）：工作档不设总预算，聊天档 2600 可关。
 * 这里只测接线与落盘；预算收口本身由 test/brief.test.ts 守。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { createWebServer } from "../src/web/server.ts";
import { CHAT_TOTAL, WORK_TOTAL, buildBrief } from "../src/brief.ts";
import { loadPersona } from "../src/persona.ts";
import type { AddressInfo } from "node:net";

const BLOCKED = new Set([0, 6665, 6666, 6667, 6668, 6669, 10080]);
async function listenSafe(srv: any): Promise<number> {
  for (let i = 0; ; i++) {
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    if (!BLOCKED.has(port)) return port;
    await new Promise<void>((r) => srv.close(() => r()));
    if (i > 8) throw new Error("E_BAD_PORT");
  }
}
async function start() {
  const dir = mkdtempSync(join(tmpdir(), "jj-brief-"));
  const d = openDb(join(dir, "m.db"));
  const srv = createWebServer({
    db: d.db, inboxDir: join(dir, "inbox"), home: dir,
    getTransport: () => { throw new Error("测试不该真调模型"); },
    getEmbedder: () => null,
    getConfig: () => ({ ollama: "http://127.0.0.1:11434", roles: { express: { provider: "deepseek", model: "deepseek-chat", embed: { provider: "ollama", model: "bge-m3" } } } }),
    now: () => new Date("2026-11-16T12:00:00Z"),
    reply: async function* () { yield "在。"; },
  });
  const port = await listenSafe(srv);
  return { srv, dir, base: `http://127.0.0.1:${port}` };
}
const hdr = { "content-type": "application/json", "x-jj": "1" };
const put = async (base: string, body: unknown) => {
  const r = await fetch(base + "/api/brief", { method: "PUT", headers: hdr, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};

test("常量：聊天 2600，工作 Infinity（不设总预算）", () => {
  assert.equal(CHAT_TOTAL, 2600);
  assert.equal(WORK_TOTAL, Number.POSITIVE_INFINITY);
  const p = loadPersona();
  const now = new Date("2026-11-16T12:00:00Z");
  const w = buildBrief({ now, persona: p, contracts: [], threads: [], recalled: [], user: "在吗", mode: "work" });
  // 默认构造下工作档不丢槽，overBudget 恒 false
  assert.equal(w.dropped.slots.length, 0);
  assert.equal(w.overBudget, false);
});

test("接线：server 在 work 或开关打开时传 Infinity，两处常量同源", () => {
  const SRV = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  assert.ok(SRV.includes("chatUnlimited"), "server 要读 config.brief.chatUnlimited");
  assert.ok(/mode === "work" \|\| chatUnlimited/.test(SRV), "工作档或开关打开 → 不设总预算");
  assert.ok(SRV.includes("Number.POSITIVE_INFINITY"), "不设预算的形态是 Infinity");
  assert.ok(/total: WORK_TOTAL/.test(readFileSync(new URL("../src/brief.ts", import.meta.url), "utf8")),
    "buildBrief 要用导出的 WORK_TOTAL，别在第二处手写 5200");
});

test("GET /api/brief：默认聊天 2600、工作不设", async () => {
  const { srv, base } = await start();
  try {
    const j = await (await fetch(base + "/api/brief")).json() as any;
    assert.equal(j.ok, true);
    assert.equal(j.chatUnlimited, false);
    assert.equal(j.chatTotal, CHAT_TOTAL);
    assert.equal(j.workTotal, null, "工作档对客户端显示为 null（不设）");
  } finally { srv.close(); }
});

test("PUT /api/brief：关掉聊天总预算会落盘，GET 反映出来", async () => {
  const { srv, dir, base } = await start();
  try {
    const r = await put(base, { chatUnlimited: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.chatUnlimited, true);
    assert.equal(r.json.chatTotal, null);
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(onDisk.brief.chatUnlimited, true, "要真的写进 config.json");

    const j = await (await fetch(base + "/api/brief")).json() as any;
    assert.equal(j.chatUnlimited, true);
    assert.equal(j.chatTotal, null);

    // 再打开回来
    const back = await put(base, { chatUnlimited: false });
    assert.equal(back.json.chatUnlimited, false);
    assert.equal(back.json.chatTotal, CHAT_TOTAL);
  } finally { srv.close(); }
});

test("PUT /api/brief：只收真布尔，字符串 / 缺字段都 400", async () => {
  const { srv, base } = await start();
  try {
    for (const body of [{ chatUnlimited: "false" }, { chatUnlimited: 1 }, {}]) {
      const r = await put(base, body);
      assert.equal(r.status, 400, `该拒：${JSON.stringify(body)}`);
      assert.equal(r.json.error, "E_BAD_BRIEF");
    }
  } finally { srv.close(); }
});
