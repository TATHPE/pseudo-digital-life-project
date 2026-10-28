/**
 * inbox：原始事件的唯一事实源（18 §1.1）
 *
 * 每轮先 append + fsync 再回复；DB 里有没有写进去都不影响"事实"。
 * 断电常见现象：最后一行只有半截 → **跳过并隔离**，不报错、不丢历史。
 */
import { appendLineSync, atomicWriteFile } from "./fsx.ts";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Actor = "user" | "agent" | "extractor" | "system";

export interface Event {
  v: 1;
  id: string;
  ts: string;          // ISO
  kind: string;        // utterance | memory_write | outage | tick | tool | ...
  actor: Actor;
  payload: unknown;
}

let seq = 0;
export function newEventId(now = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
         `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}` +
         `${pad(now.getUTCMilliseconds(), 3)}-${pad(seq++ % 1000, 3)}`;
}

export function dayFile(dir: string, d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return join(dir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`);
}

/** 写一条事件（fsync 后才返回）。这一步成功 = 事实成立 */
export function appendEvent(dir: string, ev: Event): void {
  appendLineSync(dayFile(dir, new Date(ev.ts)), JSON.stringify(ev));
}

export interface ReadResult {
  events: Event[];
  quarantined: number;   // 被隔离的坏行（通常是断电截断的尾行）
  corrupted: number;     // 非尾行的坏行（真问题，要报）
}

/** 重放：按文件名排序、逐行解析、容忍截断尾行 */
export function readEvents(dir: string, opts: { quarantine?: boolean } = {}): ReadResult {
  const out: Event[] = [];
  let quarantined = 0, corrupted = 0;
  if (!existsSync(dir)) return { events: out, quarantined, corrupted };

  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  const qdir = join(dir, "quarantine");
  const bad: string[] = [];

  for (const [fi, f] of files.entries()) {
    const raw = readFileSync(join(dir, f), "utf8");
    const lines = raw.split("\n");
    // 末尾元素要么是 ""（正常换行结尾），要么是半截行（断电）
    const tail = lines.pop() ?? "";
    const body = lines.filter((l) => l.length > 0);
    const isLastFile = fi === files.length - 1;

    for (const line of body) {
      try { out.push(JSON.parse(line) as Event); }
      catch { corrupted++; bad.push(line); }
    }
    // 半截行：只在最后一个文件里视为断电残留；其它情况算 corruption
    if (tail.length > 0) {
      if (isLastFile) { quarantined++; bad.push(tail); }
      else { corrupted++; bad.push(tail); }
    }
  }

  if (opts.quarantine && bad.length) {
    mkdirSync(qdir, { recursive: true });
    atomicWriteFile(join(qdir, `bad-${Date.now()}.log`), bad.join("\n"));
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { events: out, quarantined, corrupted };
}

export function lastEvent(events: Event[]): Event | undefined {
  return events.length ? events[events.length - 1] : undefined;
}
