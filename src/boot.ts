/**
 * 断电/停机感知（18 §2）
 *   boot_id 变 + 无 clean 标志 → power（断电）
 *   无 clean 标志但 boot 未变   → crash（进程被杀）
 *   有 clean 标志               → restart（正常关机/重启）
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import type { Outage, OutageKind } from "./types.ts";

const CLEAN = ".clean_shutdown";
const BOOT = ".boot_id";

export function bootId(): string {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
  catch {
    // Windows：用开机时间（毫秒）近似
    return `win-${Math.round((Date.now() - process.uptime() * 1000) / 1000)}`;
  }
}

export function markStart(dir: string): { prevBootId: string | null; clean: boolean } {
  const clean = existsSync(join(dir, CLEAN));
  let prevBootId: string | null = null;
  try { prevBootId = readFileSync(join(dir, BOOT), "utf8").trim(); } catch { /* first boot */ }
  atomicWriteFile(join(dir, BOOT), bootId());
  return { prevBootId, clean };
}

export function markCleanShutdown(dir: string): void {
  atomicWriteFile(join(dir, CLEAN), new Date().toISOString());
}

export function clearCleanShutdown(dir: string): void {
  const p = join(dir, CLEAN);
  if (existsSync(p)) { try { require("node:fs").unlinkSync(p); } catch { /* ignore */ } }
}

/** 由"最后一条事件时间"与"现在"推断缺口（精度 ±tick，默认 60s） */
export function detectOutage(
  dir: string, lastEventTs: Date | null, now: Date, clean: boolean,
): Outage | null {
  if (!lastEventTs) return null;
  const gapMs = now.getTime() - lastEventTs.getTime();
  if (gapMs < 120_000) return null;                  // 太短，不算缺口
  const stored = existsSync(join(dir, BOOT)) ? readFileSync(join(dir, BOOT), "utf8").trim() : "";
  const kind: OutageKind = clean ? "restart" : stored === bootId() ? "crash" : "power";
  return { from: lastEventTs, to: now, kind };
}
