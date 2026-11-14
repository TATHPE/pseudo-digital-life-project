/**
 * 桌面端的**启动令牌**（2026-11-01：软件只有桌面端，不提供浏览器入口）。
 *
 * 问题：只要知道 127.0.0.1:7700，任何浏览器都能打开这个面板 —— 那就等于还有一个 web 界面。
 * 做法：sidecar 启动时生成一枚随机令牌，写进 `data/.desk.json`（只有本机、只有壳去读），
 *       壳加载 `/?k=<token>`；之后靠 cookie 维持。**没令牌的页面请求一律 403。**
 *
 * 三个边界：
 *   · 令牌只保护**页面**（/、/welcome）与 API；`/health` 放行（壳探测要用，且不含隐私）。
 *   · cookie 是 HttpOnly + SameSite=Strict，脚本读不到、跨站带不出去。
 *   · 令牌每次启动都换（不落盘复用），进程一退就失效 —— 没有"长期有效"这一档。
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../fsx.ts";

export const DESK_FILE = ".desk.json";
export const DESK_COOKIE = "jjdesk";

/** 这个进程的令牌（null = 不做校验：测试/CLI 直连时用） */
export function newToken(): string {
  return randomBytes(16).toString("hex");
}

export function deskPath(home: string): string {
  return join(home, DESK_FILE);
}

/** sidecar 启动时写：壳读它拿端口和令牌 */
export function writeDeskRuntime(home: string, info: { port: number; token: string; pid: number }): void {
  atomicWriteFile(deskPath(home), JSON.stringify({ ...info, startedAt: new Date().toISOString() }, null, 2) + String.fromCharCode(10));
}

export function readDeskRuntime(home: string): { port: number; token: string; pid?: number } | null {
  try {
    if (!existsSync(deskPath(home))) return null;
    const j = JSON.parse(readFileSync(deskPath(home), "utf8")) as { port?: number; token?: string; pid?: number };
    if (!j.port || !j.token) return null;
    return { port: j.port, token: j.token, ...(j.pid ? { pid: j.pid } : {}) };
  } catch { return null; }
}

export function clearDeskRuntime(home: string): void {
  try { rmSync(deskPath(home), { force: true }); } catch { /* 没有就算了 */ }
}

/** 从请求里取令牌：`?k=` 或 cookie */
export function tokenFromRequest(url: URL, cookieHeader: string | undefined): string | null {
  const q = url.searchParams.get("k");
  if (q) return q;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === DESK_COOKIE) return rest.join("=") || null;
  }
  return null;
}

/** 常量时间比较（避免按位猜测；16 字节的随机数本来也猜不到，但这行注释值这个函数） */
export function sameToken(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 放行的路径：健康探测、favicon、界面脚本与静态资源（都不含隐私，壳/浏览器都能取） */
export function tokenExempt(pathname: string): boolean {
  return pathname === "/health" || pathname === "/icon.svg" || pathname.startsWith("/ui/") || pathname.startsWith("/static/") || pathname.startsWith("/pal/");
}
