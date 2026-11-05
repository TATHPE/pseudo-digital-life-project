/**
 * OneBot 11 网桥：连 NapCat（/ LLOneBot / Lagrange）的 WS，收消息 → 问她自己 → 回消息。
 *
 * 为什么不自己调模型：`/api/say` 已经带着简报、记忆、工具、重排那一整套；
 * 桥只负责搬运，这样 QQ 上和面板上她说的话是同一个她，记忆也是同一份。
 *
 * 配置：data/bridge.json
 *   {
 *     "onebot": {
 *       "enabled": true,
 *       "ws": "ws://127.0.0.1:3001",
 *       "accessToken": "",
 *       "selfId": "你的QQ号",
 *       "mode": "private",          // private | group | all
 *       "allowUsers": [],           // 空 = 谁的私聊都回
 *       "allowGroups": [],          // 群必须显式列，空 = 不回任何群
 *       "prefix": "鲸鲸，"           // 群里除了 @ 之外的前缀
 *     }
 *   }
 *
 * 用法：node src/cli/jingjing.ts bridge
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDeskRuntime } from "./web/desk.ts";
import { parseIncoming, sendPayload, type Incoming, type ObConfig } from "./onebot.ts";

const NL = String.fromCharCode(10);

export function configPath(home: string): string { return join(home, "bridge.json"); }

export function readBridgeConfig(home: string): ObConfig {
  const p = configPath(home);
  if (!existsSync(p)) return { enabled: false };
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { onebot?: ObConfig };
    return j.onebot ?? { enabled: false };
  } catch { return { enabled: false, ws: "" }; }
}

/** 本地面板的地址与令牌：优先环境变量，其次 data/.desk.json */
export function localEndpoint(home: string): { base: string; key: string } | null {
  const envBase = process.env.JJ_BRIDGE_BASE;
  if (envBase) return { base: envBase, key: String(process.env.JJ_BRIDGE_KEY ?? "") };
  const d = readDeskRuntime(home);
  if (d) return { base: "http://127.0.0.1:" + d.port, key: d.token };
  // 开发模式（node src/cli/jingjing.ts serve 7700）不会写 .desk.json：退回默认端口，不带令牌
  const devPort = String(process.env.JJ_BRIDGE_PORT ?? "7700");
  return { base: "http://127.0.0.1:" + devPort, key: "" };
}

/** 问一句，拿回她的完整回答。走 SSE，只收 delta。 */
export async function askHer(base: string, key: string, text: string, timeoutMs = 120_000): Promise<string> {
  const url = base + "/api/say" + (key ? "?k=" + encodeURIComponent(key) : "");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jj": "1" },
      body: JSON.stringify({ text }),
      signal: ctl.signal,
    });
    if (!r.ok || !r.body) throw new Error("E_BRIDGE_HTTP_" + r.status);
    let buf = "";
    let out = "";
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split(NL + NL);
      buf = frames.pop() ?? "";
      for (const f of frames) {
        const line = f.trim();
        if (!line.startsWith("data: ")) continue;
        try {
          const ev = JSON.parse(line.slice(6)) as { type?: string; text?: string };
          if (ev.type === "delta" && typeof ev.text === "string") out += ev.text;
        } catch { /* 半帧，忽略 */ }
      }
    }
    return out.trim();
  } finally { clearTimeout(timer); }
}

export interface BridgeOpts {
  /** 只连一次、处理完就退出（排障用） */
  once?: boolean;
  log?: (s: string) => void;
  /** 注入用（测试/干跑）：不真的连 WS */
  socketFactory?: (url: string) => WebSocket;
}

interface Seen { has(id: string): boolean; add(id: string): void }

function seenSet(cap = 200): Seen {
  const s = new Set<string>();
  return {
    has: (id) => s.has(id),
    add: (id) => { s.add(id); if (s.size > cap) { const first = s.values().next().value; if (first) s.delete(first); } },
  };
}

/** 连上就跑；断了按 1s→30s 退避重连。Ctrl+C 退出。 */
export async function startBridge(home: string, o: BridgeOpts = {}): Promise<void> {
  const log = o.log ?? ((s) => console.log(s));
  const cfg = readBridgeConfig(home);
  if (!cfg.enabled) {
    log("bridge 没开：先在 " + configPath(home) + " 写 {\"onebot\":{\"enabled\":true,…}}");
    return;
  }
  const wsUrl = String(cfg.ws ?? "");
  if (!wsUrl) { log("bridge.json 里缺 onebot.ws"); return; }
  const ep = localEndpoint(home);
  if (!ep) { log("找不到本地面板（data/.desk.json）。先启动软件，再跑 bridge。"); return; }

  STATE.running = true;
  STATE.since = new Date().toISOString();
  if (STATE.running && !STOP) { log("bridge 已经在跑了"); return; }
  STOP = false;
  const seen = seenSet();
  let backoff = 1000;
  let stop = false;
  const onSig = () => { stop = true; log("收到退出信号"); };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  const url = new URL(wsUrl);
  if (cfg.accessToken) url.searchParams.set("access_token", String(cfg.accessToken));
  const selfId = String(cfg.selfId ?? "");

  while (!stop && !STOP) {
    const ws = o.socketFactory ? o.socketFactory(url.toString()) : new WebSocket(url.toString());
    CURRENT = ws;
    const closed = await new Promise<boolean>((resolve) => {
      let opened = false;
      ws.addEventListener("open", () => {
        opened = true; backoff = 1000; STATE.connected = true; STATE.lastError = null;
        log("已连上 OneBot：" + url.origin + "（mode=" + (cfg.mode ?? "private") + "）");
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        void (async () => {
          let parsed: unknown;
          try { parsed = JSON.parse(String(ev.data)); } catch { return; }
          const msg: Incoming | null = parseIncoming(parsed, cfg, selfId);
          if (!msg) return;
          if (msg.messageId && seen.has(msg.messageId)) return;
          if (msg.messageId) seen.add(msg.messageId);
          log("← " + msg.kind + ":" + msg.chatId + " " + msg.text.slice(0, 40));
          let reply = "";
          try { reply = await askHer(ep.base, ep.key, msg.text); }
          catch (e) { log("问她失败：" + String((e as Error).message).slice(0, 80)); return; }
          if (!reply) { log("她这轮没说话（可能是拒答），不回"); return; }
          const payload = sendPayload(msg, reply, "jj-" + Date.now());
          try {
            ws.send(JSON.stringify(payload));
            log("→ " + msg.kind + ":" + msg.chatId + " " + reply.slice(0, 40));
          } catch (e) { log("回不出去：" + String((e as Error).message).slice(0, 80)); }
        })();
      });
      ws.addEventListener("error", () => { if (!opened) { STATE.lastError = "连不上 " + url.origin; log("连不上 " + url.origin); } resolve(true); });
      ws.addEventListener("close", () => { STATE.connected = false; CURRENT = null; resolve(true); });
    });
    if (o.once || stop) break;
    if (closed) {
      if (!STATE.connected) STATE.lastError = STATE.lastError || ("没连上 " + url.origin);
      log("断线，" + Math.round(backoff / 1000) + " 秒后重连");
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  log("bridge 已退出");
}

export interface BridgeState {
  running: boolean;
  connected: boolean;
  since: string | null;
  lastError: string | null;
}

const STATE: BridgeState = { running: false, connected: false, since: null, lastError: null };
let CURRENT: WebSocket | null = null;
let STOP = false;

/** 停掉（面板上关掉开关时用；不用重启软件） */
export function stopBridge(): void {
  STOP = true;
  try { CURRENT?.close(); } catch { /* 已经断了 */ }
  CURRENT = null;
  STATE.running = false;
  STATE.connected = false;
}

/** 面板要能说清「桥现在到底连没连上」——不看日志也能知道 */
export function bridgeState(): BridgeState { return { ...STATE }; }

export function sampleConfig(): string {
  return JSON.stringify({
    onebot: {
      enabled: true,
      ws: "ws://127.0.0.1:3001",
      accessToken: "",
      selfId: "在这里填她的 QQ 号",
      mode: "private",
      allowUsers: [],
      allowGroups: [],
      prefix: "鲸鲸，",
    },
  }, null, 2) + NL;
}
