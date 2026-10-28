/** 时间轴渲染（17 §4）：**没有"会话"，只有时间；空白要可见** */
export interface Msg { ts: string; role: "user" | "agent"; text: string }
export type Block =
  | { type: "day"; label: string; gapMs?: number }
  | { type: "gap"; label: string }
  | { type: "msg"; role: "user" | "agent"; text: string; ts: string };

export const GAP_MS = 30 * 60 * 1000;   // 超过 30 分钟就显式标出空白

export function gapLabel(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "刚刚";
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${mm} 分`;
  return `${mm} 分钟`;
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const w = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${w}`;
}

export function groupTimeline(msgs: Msg[], gapMs = GAP_MS): Block[] {
  const out: Block[] = [];
  let lastDay = "", lastTs = 0;
  for (const m of [...msgs].sort((a, b) => (a.ts < b.ts ? -1 : 1))) {
    const t = new Date(m.ts).getTime();
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) {
      // 跨天时把间隔写进日期标签（17 §4：空白必须可见），避免"换了个日期就假装没断"
      const gap = lastTs && t - lastTs >= gapMs ? t - lastTs : undefined;
      out.push(gap ? { type: "day", label: dayLabel(m.ts), gapMs: gap } : { type: "day", label: dayLabel(m.ts) });
      lastDay = day;
    } else if (lastTs && t - lastTs >= gapMs) out.push({ type: "gap", label: gapLabel(t - lastTs) });
    out.push({ type: "msg", role: m.role, text: m.text, ts: m.ts });
    lastTs = t;
  }
  return out;
}
