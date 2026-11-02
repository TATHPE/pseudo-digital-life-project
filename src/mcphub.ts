/**
 * MCP 连接中心（2026-11-03）。
 *
 * 学自 Coopanion 的 World：每个 World 可以**单独** start / stop / restart。
 * 我们之前：改了 mcp.json 只能重启整个 sidecar —— 4 秒白等，她的会话状态也全丢。
 *
 * 这个类只做三件事：
 *   1. 记住每个 server 的 client（能单独停）
 *   2. 重连某个（或全部）server，把它的工具重新注册进来
 *   3. 把「谁在跑 / 谁连不上」如实报出来（喂给 P17 与面板）
 *
 * 边界：**不碰 verbs**，只换 MCP 那一半；不自动重连（连不上时说清楚，别假装在跑）。
 */
import { McpClient, loadMcpConfig, type McpConfig, type McpTool } from "./mcp.ts";

export interface ExternalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tier: string;
  call(args: Record<string, unknown>): Promise<string>;
}

export interface HubStatus {
  servers: string[];
  tools: string[];
  errors: string[];
}

export class McpHub {
  private clients = new Map<string, McpClient>();
  private cfg: McpConfig;
  private externals: ExternalTool[];
  private errors: string[] = [];

  private home: string;

  constructor(home: string, externals: ExternalTool[]) {
    this.home = home;
    this.externals = externals;
    this.cfg = loadMcpConfig(home);
  }

  /** 去掉某个 server 注册的所有工具（返回还剩几个） */
  private dropTools(server: string): number {
    const prefix = "mcp__" + server + "__";
    for (let i = this.externals.length - 1; i >= 0; i--) {
      if (this.externals[i]!.name.startsWith(prefix)) this.externals.splice(i, 1);
    }
    return this.externals.length;
  }

  /** 连一个 server 并把工具塞进 externals */
  private async connect(server: string): Promise<string[]> {
    const sc = this.cfg.servers[server];
    if (!sc) throw new Error("E_NO_SERVER: " + server);
    const c = await McpClient.start(server, sc);
    this.clients.set(server, c);
    const added: string[] = [];
    for (const t of await c.listTools()) {
      if (sc.tools && !sc.tools.includes(t.name)) continue;
      const full = `mcp__${server}__${t.name}`;
      this.externals.push({
        name: full, description: `[${server}] ${t.description}`, parameters: t.parameters as Record<string, unknown>, tier: "T2",
        call: (a) => c.callTool(t.name, a) as Promise<string>,
      });
      added.push(full);
    }
    return added;
  }

  /** 首次连接（启动时跑一次） */
  async startAll(): Promise<HubStatus> {
    this.errors = [];
    for (const server of Object.keys(this.cfg.servers)) {
      try { await this.connect(server); }
      catch (e) { this.errors.push(`${server}: ${String((e as Error).message ?? e).slice(0, 120)}`); }
    }
    return this.status();
  }

  /**
   * 重连。给了 server 只重连那一个；不给就全部。
   * **重新读 mcp.json**（这才是"改了配置要生效"的意思）。
   */
  async reconnect(server?: string): Promise<HubStatus & { dropped: number; added: number }> {
    this.cfg = loadMcpConfig(this.home);
    const targets = server ? [server] : Object.keys(this.cfg.servers);

    // 磁盘上已经删掉的 server：把它的工具也清掉
    for (const old of [...this.clients.keys()]) {
      if (!this.cfg.servers[old]) { this.dropTools(old); this.clients.delete(old); }
    }

    let dropped = 0, added = 0;
    this.errors = [];
    for (const name of targets) {
      const before = this.externals.length;
      this.dropTools(name);
      dropped += before - this.externals.length;
      const c = this.clients.get(name);
      if (c) { try { c.close(); } catch { /* 已关就算 */ } this.clients.delete(name); }
      if (!this.cfg.servers[name]) continue;             // 被删掉的，不重连
      try { added += (await this.connect(name)).length; }
      catch (e) { this.errors.push(`${name}: ${String((e as Error).message ?? e).slice(0, 120)}`); }
    }
    return { ...this.status(), dropped, added };
  }

  status(): HubStatus {
    return {
      servers: [...this.clients.keys()],
      tools: this.externals.map((e) => e.name),
      errors: [...this.errors],
    };
  }

  async closeAll(): Promise<void> {
    for (const [, c] of this.clients) { try { c.close(); } catch { /* ignore */ } }
    this.clients.clear();
  }
}

export type { McpTool };
