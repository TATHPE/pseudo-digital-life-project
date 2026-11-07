/**
 * 最小 MCP stdio 客户端（11 §3 方向 B）。
 * 只做三件事：initialize → tools/list → tools/call。
 * 每个 server 一个子进程；超时/崩溃都返回可读错误，不拖垮主进程。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface McpServerConfig { command: string; args?: string[]; trust?: "local" | "external"; tools?: string[] }
export interface McpTool { name: string; description: string; parameters: Record<string, unknown>; server: string }
export interface McpConfig { servers: Record<string, McpServerConfig> }

export function loadMcpConfig(home: string): McpConfig {
  const f = join(home, "mcp.json");
  if (!existsSync(f)) return { servers: {} };
  try { return JSON.parse(readFileSync(f, "utf8")) as McpConfig; } catch { return { servers: {} }; }
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class McpClient {
  private proc: ChildProcess;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private closed = false;
  info: { name?: string; version?: string } = {};

  private serverName: string;

  private constructor(cmd: string, args: string[], serverName: string) {
    this.serverName = serverName;
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => this.onLine(line));
    this.proc.on("exit", () => {
      this.closed = true;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("E_MCP_EXIT")); }
      this.pending.clear();
    });
    this.proc.stderr?.on("data", () => { /* 忽略 stderr，避免噪声 */ });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`E_MCP: ${msg.error.message ?? "unknown"}`));
    else p.resolve(msg.result);
  }

  private request(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("E_MCP_CLOSED"));
    const id = ++this.seq;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`E_MCP_TIMEOUT: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin!.write(payload);
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  static async start(name: string, cfg: McpServerConfig): Promise<McpClient> {
    const c = new McpClient(cfg.command, cfg.args ?? [], name);
    const r = await c.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "jingjing", version: "0.1.0" },
    });
    const info = (r as { serverInfo?: { name?: string; version?: string } }).serverInfo ?? {};
    c.info = info;
    c.notify("notifications/initialized", {});
    return c;
  }

  async listTools(): Promise<McpTool[]> {
    const r = await this.request("tools/list", {});
    const tools = (r as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }).tools ?? [];
    return tools.map((t) => ({
      name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object", properties: {} },
      server: this.serverName,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.request("tools/call", { name, arguments: args }, 120000) as {
      content?: Array<{ type: string; text?: string; mimeType?: string }>; isError?: boolean;
    };
    // P-A：非文本内容不能**静默丢掉**。
    // 以前这里只拼 c.text → 一个只返回图片的工具会变成空字符串，
    // 看起来跟“工具返回了空”一模一样（本项目反复踩的“装饰列”形状）。
    const parts = r.content ?? [];
    const texts = parts.filter((c) => c.type === "text");
    const others = parts.filter((c) => c.type !== "text");
    const text = texts.map((c) => c.text ?? "").join("\n");

    if (others.length) {
      const kinds = [...new Set(others.map((c) => c.type))];
      const kind = kinds.join("/");
      const note = `E_UNSUPPORTED_CONTENT: 本宿主只接受文本，收到 ${others.length} 个 ${kind} 部件（已省略）`;
      if (!texts.length) return r.isError ? `E_TOOL: ${note}` : note;
      // 混合内容：文本照给，但必须明说少了什么
      return (r.isError ? `E_TOOL: ${text.slice(0, 400)}` : text) + String.fromCharCode(10) + note;
    }
    return r.isError ? `E_TOOL: ${text.slice(0, 400)}` : text;
  }

  close(): void { this.closed = true; try { this.proc.kill(); } catch { /* ignore */ } }
}

export interface ToolCallResult {
  content?: Array<{ type: string; text?: string; mimeType?: string }>;
  isError?: boolean;
}

/**
 * 把 MCP 的 content[] 渲染成给模型看的字符串（P-A）。
 *
 * 非文本部件**不能静默丢**：以前只拼 `c.text`，于是一个只返回图片的工具
 * 会得到空字符串 —— 跟“工具返回了空”看起来一模一样（本项目的“装饰列”形状）。
 * 现在：纯文本照旧；有图片/音频时**明说少了什么**；全是非文本时直接报错码。
 */
export function renderToolResult(r: ToolCallResult): string {
  const parts = r.content ?? [];
  const texts = parts.filter((c) => c.type === "text");
  const others = parts.filter((c) => c.type !== "text");
  const text = texts.map((c) => c.text ?? "").join(String.fromCharCode(10));
  if (!others.length) return r.isError ? `E_TOOL: ${text.slice(0, 400)}` : text;

  const kind = [...new Set(others.map((c) => c.type))].join("/");
  const note = `E_UNSUPPORTED_CONTENT: 本宿主只接受文本，收到 ${others.length} 个 ${kind} 部件（已省略）`;
  if (!texts.length) return r.isError ? `E_TOOL: ${note}` : note;
  return (r.isError ? `E_TOOL: ${text.slice(0, 400)}` : text) + String.fromCharCode(10) + note;
}

/** 把 MCP server 的工具接进注册表（命名 mcp__<server>__<tool>） */
export async function attachMcp(
  cfg: McpConfig, register: (t: { name: string; description: string; parameters: unknown; call: (a: Record<string, unknown>) => Promise<string> }) => void,
): Promise<{ clients: McpClient[]; tools: string[]; errors: string[] }> {
  const clients: McpClient[] = [];
  const tools: string[] = [];
  const errors: string[] = [];
  for (const [name, sc] of Object.entries(cfg.servers)) {
    try {
      const c = await McpClient.start(name, sc);
      clients.push(c);
      for (const t of await c.listTools()) {
        if (sc.tools && !sc.tools.includes(t.name)) continue;
        const full = `mcp__${name}__${t.name}`;
        register({ name: full, description: `[${name}] ${t.description}`, parameters: t.parameters, call: (a) => c.callTool(t.name, a) });
        tools.push(full);
      }
    } catch (e) {
      errors.push(`${name}: ${String((e as Error).message ?? e).slice(0, 120)}`);
    }
  }
  return { clients, tools, errors };
}
