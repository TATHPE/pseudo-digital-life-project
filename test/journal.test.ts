import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents, newEventId, dayFile } from "../src/journal.ts";
import type { Event } from "../src/journal.ts";

const mk = () => mkdtempSync(join(tmpdir(), "jj-inbox-"));

test("追加-重放：顺序与内容一致", () => {
  const dir = mk();
  for (let i = 0; i < 5; i++) {
    appendEvent(dir, { v: 1, id: newEventId(), ts: new Date(2026, 9, 27, 10, i).toISOString(),
      kind: "utterance", actor: "user", payload: { text: `第 ${i} 句` } });
  }
  const r = readEvents(dir);
  assert.equal(r.events.length, 5);
  assert.equal(r.quarantined, 0);
  assert.equal(r.corrupted, 0);
  assert.equal(((r.events[4]?.payload as any) ?? {}).text, "第 4 句");
});

test("断电：最后一行半截 → 隔离而不是报错", () => {
  const dir = mk();
  appendEvent(dir, { v: 1, id: newEventId(), ts: "2026-10-27T10:00:00.000Z",
    kind: "utterance", actor: "user", payload: { text: "完整的一句" } });
  // 模拟断电：追加半行
  const f = dayFile(dir, new Date("2026-10-27T10:01:00.000Z"));
  writeFileSync(f, readFileSync(f, "utf8") + '{"v":1,"id":"x","ts":"2026-10-27T10:01', "utf8");

  const r = readEvents(dir, { quarantine: true });
  assert.equal(r.events.length, 1);
  assert.equal(r.quarantined, 1);
  assert.equal(r.corrupted, 0);
  const q = join(dir, "quarantine");
  assert.ok(existsSync(q) && readdirSync(q).length === 1, "坏行应被隔离到 quarantine/");
});

test("非尾行的坏行算 corruption（真问题，不能静默）", () => {
  const dir = mk();
  const f = dayFile(dir, new Date("2026-10-27T10:00:00.000Z"));
  const good = JSON.stringify({ v: 1, id: "a", ts: "2026-10-27T10:00:00.000Z", kind: "utterance", actor: "user", payload: {} });
  writeFileSync(f, [good, "{broken", good].join("\n") + "\n", "utf8");
  const r = readEvents(dir);
  assert.equal(r.corrupted, 1);
  assert.equal(r.events.length, 2);
});

test("跨文件按 ts 归并", () => {
  const dir = mk();
  const e = (ts: string): Event => ({ v: 1, id: newEventId(), ts, kind: "utterance", actor: "user", payload: {} });
  appendEvent(dir, e("2026-10-28T09:00:00.000Z"));
  appendEvent(dir, e("2026-10-27T09:00:00.000Z"));
  const r = readEvents(dir);
  assert.deepEqual(r.events.map((x) => x.ts), ["2026-10-27T09:00:00.000Z", "2026-10-28T09:00:00.000Z"]);
});
