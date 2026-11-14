/**
 * [boot] 启动打点的「格式协议 + 解析器」（观测层，不进 CI 闸门）。
 *
 * 生产侧在 src/cli/jingjing.ts 的 listen 回调里按这个格式输出**一行**：
 *   [boot] listen=123ms desk=130ms health=145ms mcp=980ms mcpOk=true
 * 四个数值都是从「进程启动」起的累计毫秒；mcpOk 表示后台 MCP startAll 是否成功。
 *
 * 这里只放纯函数：格式化（规范定义 / 测试用）、单行解析、批量解析、p50/p95 统计。
 * 放 tools/ 而不是 src/ 有两个原因：① 不进生产打包（jingjing.ts 内联输出，不依赖本文件）；
 * ② map:check 只核对 src 文件清单，放这里不触发 docs/map.md 重新生成。无副作用，可被测试直接 import。
 */
export interface BootTiming {
  listen: number;
  desk: number;
  health: number;
  mcp: number;
  mcpOk: boolean;
}

export interface BootStat { p50: number; p95: number; max: number }

export interface BootSummary {
  samples: number;
  mcpOk: number;
  mcpFailed: number;
  listen: BootStat;
  desk: BootStat;
  health: BootStat;
  mcp: BootStat;
}

export const BOOT_PREFIX = "[boot]";

/** 规范格式：与 jingjing.ts 内联的 console.log 模板逐字一致，测试据此做 round-trip。 */
export function formatBootLine(t: BootTiming): string {
  return `${BOOT_PREFIX} listen=${t.listen}ms desk=${t.desk}ms health=${t.health}ms mcp=${t.mcp}ms mcpOk=${t.mcpOk}`;
}

/** 严格解析单行：缺字段 / 顺序错 / 非整数 / mcpOk 非布尔 / 前缀不对 → null。 */
const LINE_RE = /^\[boot\]\s+listen=(\d+)ms\s+desk=(\d+)ms\s+health=(\d+)ms\s+mcp=(\d+)ms\s+mcpOk=(true|false)\s*$/;

export function parseBootLine(line: string): BootTiming | null {
  const m = LINE_RE.exec(line.trim());
  if (!m) return null;
  return {
    listen: Number(m[1]), desk: Number(m[2]), health: Number(m[3]),
    mcp: Number(m[4]), mcpOk: m[5] === "true",
  };
}

/** 逐行解析：跳过空行、普通日志与畸形行，只留合法的 [boot] 行。 */
export function parseBootLines(text: string): BootTiming[] {
  const out: BootTiming[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = parseBootLine(line);
    if (t) out.push(t);
  }
  return out;
}

function stat(xs: number[]): BootStat {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
}

/** 没有样本返回 null（调用方据此写「无打点数据」，不伪造 0 或假数字）。 */
export function summarizeBootTiming(samples: BootTiming[]): BootSummary | null {
  if (!samples.length) return null;
  const seg = (pick: (t: BootTiming) => number): BootStat => stat(samples.map(pick));
  return {
    samples: samples.length,
    mcpOk: samples.filter((t) => t.mcpOk).length,
    mcpFailed: samples.filter((t) => !t.mcpOk).length,
    listen: seg((t) => t.listen),
    desk: seg((t) => t.desk),
    health: seg((t) => t.health),
    mcp: seg((t) => t.mcp),
  };
}
