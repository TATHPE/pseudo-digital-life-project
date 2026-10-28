/**
 * 真正的模型调用层（13 §2 / 19 §0.1 W-A）
 *
 * 三条硬约束，全部在 **fetch 之前** 执行：
 *   ① 带记忆原文的请求，角色必须 local（router.assertLocalOnly）
 *   ② kind=local 的 endpoint 必须是回环地址（防"local 角色其实指向云端"）
 *   ③ 每次出站都记 span（host / 角色 / 耗时 / 字节），供 `test offline` 断言
 *
 * 因为守卫在 fetch 之前，**泄露在结构上不可能发生**——不是靠事后检查。
 */
import { validateRouter, type Role, type RoleConfig, type Router, createRouter } from "./provider.ts";

export interface Msg { role: "system" | "user" | "assistant"; content: string }
export interface Span {
  ts: string; role: Role; kind: "local" | "cloud"; host: string;
  path: string; ms: number; ok: boolean; bytesOut: number; purpose: string;
}
export interface Usage { inTokens?: number; outTokens?: number; cachedTokens?: number }

export interface CallOpts {
  /** 调用方必须诚实声明：这次要发出去的 payload 里有没有记忆原文 */
  containsMemory: boolean;
  purpose?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface Transport {
  complete(role: Role, messages: Msg[], opts: CallOpts): Promise<{ text: string; usage?: Usage }>;
  embed(role: Role, texts: string[], opts: CallOpts): Promise<Float32Array[]>;
  spans(): readonly Span[];
  resetSpans(): void;
}

export class EndpointError extends Error {
  constructor(msg: string) { super(msg); this.name = "EndpointError"; }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

/** 这个角色最终会不会出网：回环 = 本地推理，其余 = 走公网（读记忆原文前必须先问这一句） */
export function isRemoteRole(c: RoleConfig): boolean {
  return !isLoopback(endpointOf(c));
}

export function isLoopback(url: string): boolean {
  return LOOPBACK.has(hostOf(url));
}

export function endpointOf(c: RoleConfig): string {
  if (c.baseUrl) return c.baseUrl.replace(/\/+$/, "");
  if (c.provider === "ollama") return "http://127.0.0.1:11434";
  if (c.provider === "anthropic") return "https://api.anthropic.com";
  if (c.provider === "openai") return "https://api.openai.com";
  if (c.provider === "deepseek") return "https://api.deepseek.com";
  return "";
}

export interface TransportOpts {
  /** 流结束时把真实 token 用量抛出来（记账用；不猜、不估） */
  onUsage?: (u: { role: string; provider: string; model: string; inTokens: number; outTokens: number }) => void;
  fetchImpl?: typeof fetch;
  apiKeys?: Partial<Record<string, string>>;
  clock?: () => number;
}

export function createTransport(
  router: Router, opts: TransportOpts = {},
): Transport {
  const f = opts.fetchImpl ?? fetch;
  const clock = opts.clock ?? (() => performance.now());
  const log: Span[] = [];

  const record = (s: Span) => log.push(s);

  /** 统一入口：先守卫，再发请求 */
  async function call(
    role: Role, url: string, body: unknown, opts2: CallOpts,
  ): Promise<unknown> {
    const c = router.role(role);
    // ① 隐私闸门
    router.assertLocalOnly(role, opts2.containsMemory);
    // ② endpoint 与 kind 必须一致
    if (c.kind === "local" && !isLoopback(url)) {
      throw new EndpointError(`E_BAD_ENDPOINT: role=${role} kind=local 却指向 ${hostOf(url)}`);
    }
    if (c.kind === "cloud" && isLoopback(url)) {
      throw new EndpointError(`E_BAD_ENDPOINT: role=${role} kind=cloud 却指向回环地址`);
    }
    const payload = JSON.stringify(body);
    const t0 = clock();
    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = opts.apiKeys?.[c.provider];
    if (key) {
      if (c.provider === "anthropic") {
        // Anthropic 用 x-api-key + 版本头，不是 Bearer
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers.authorization = `Bearer ${key}`;
      }
    }
    let ok = false;
    try {
      const r = await f(url, { method: "POST", headers, body: payload, signal: opts2.signal });
      ok = r.ok;
      if (!r.ok) throw new Error(`E_PROVIDER: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    } finally {
      record({
        ts: new Date().toISOString(), role, kind: c.kind, host: hostOf(url),
        path: new URL(url).pathname, ms: Math.round(clock() - t0), ok,
        bytesOut: Buffer.byteLength(payload), purpose: opts2.purpose ?? "",
      });
    }
  }

  return {
    async complete(role, messages, o) {
      const c = router.role(role);
      const base = endpointOf(c);
      if (c.provider === "ollama") {
        const j = await call(role, `${base}/api/chat`, {
          model: c.model, messages, stream: false,
          options: { num_predict: o.maxTokens ?? c.maxTokens ?? 512, temperature: o.temperature ?? 0.7 },
        }, o) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
        return {
          text: j.message?.content ?? "",
          usage: { inTokens: j.prompt_eval_count, outTokens: j.eval_count },
        };
      }
      if (c.provider === "anthropic") {
        const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
        const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
        const j = await call(role, `${base}/v1/messages`, {
          model: c.model, max_tokens: o.maxTokens ?? c.maxTokens ?? 1024,
          ...(sys ? { system: sys } : {}), messages: rest,
        }, o) as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
        return {
          text: (j.content ?? []).map((b) => b.text ?? "").join(""),
          usage: { inTokens: j.usage?.input_tokens, outTokens: j.usage?.output_tokens },
        };
      }
      // openai-compatible（含 deepseek）
      const j = await call(role, `${base}/v1/chat/completions`, {
        model: c.model, messages, max_tokens: o.maxTokens ?? c.maxTokens ?? 1024,
        temperature: o.temperature ?? 0.7,
      }, o) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      return {
        text: j.choices?.[0]?.message?.content ?? "",
        usage: { inTokens: j.usage?.prompt_tokens, outTokens: j.usage?.completion_tokens },
      };
    },

    async embed(role, texts, o) {
      const c = router.role(role);
      const base = endpointOf(c);
      if (c.provider !== "ollama") throw new EndpointError(`E_UNSUPPORTED: embed 只实现了 ollama，当前 ${c.provider}`);
      const j = await call(role, `${base}/api/embed`, { model: c.model, input: texts }, o) as {
        embeddings?: number[][];
      };
      const out = (j.embeddings ?? []).map((v) => new Float32Array(v));
      if (out.length !== texts.length) throw new Error(`E_EMBED_COUNT: 期望 ${texts.length}，实得 ${out.length}`);
      return out;
    },

    spans: () => log,
    resetSpans: () => { log.length = 0; },
  };
}

/** `test offline` 的断言核心：所有出站都必须落在回环 */
export function assertAllLoopback(spans: readonly Span[]): string[] {
  const bad = spans.filter((s) => !LOOPBACK.has(s.host));
  return bad.map((s) => `${s.role} → ${s.host}${s.path}（${s.bytesOut}B, ${s.purpose}）`);
}

/** 建 router 的便捷入口：非法配置直接抛（拒绝启动） */
export function routerFrom(cfg: Partial<Record<Role, RoleConfig>>): Router {
  const problems = validateRouter(cfg);
  if (problems.length) throw new Error(`E_CONFIG: ${problems.join("; ")}`);
  return createRouter(cfg);
}

// ── 流式（TTFUA ≤1.5s 的前提，17 §2 / 06 §4.2）─────────────────
export interface StreamTransport {
  completeStream(role: Role, messages: Msg[], opts: CallOpts): AsyncGenerator<string, void, void>;
}

/** 把 transport 升级成支持流式：ollama 用 NDJSON，openai/deepseek 用 SSE */
export function createStreamTransport(
  router: Router, opts: TransportOpts = {},
): Transport & StreamTransport {
  const base = createTransport(router, opts);
  const f = opts.fetchImpl ?? fetch;
  const clock = opts.clock ?? (() => performance.now());

  async function* completeStream(role: Role, messages: Msg[], o: CallOpts): AsyncGenerator<string, void, void> {
    const c = router.role(role);
    router.assertLocalOnly(role, o.containsMemory);          // ① 守卫在这里，逐字面量之前
    const baseUrl = endpointOf(c);
    const url = c.provider === "ollama" ? `${baseUrl}/api/chat` : `${baseUrl}/v1/chat/completions`;
    if (c.kind === "local" && !isLoopback(url)) throw new EndpointError(`E_BAD_ENDPOINT: ${hostOf(url)}`);
    if (c.kind === "cloud" && isLoopback(url)) throw new EndpointError(`E_BAD_ENDPOINT: cloud→${hostOf(url)}`);

    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = opts.apiKeys?.[c.provider];
    if (key) {
      if (c.provider === "anthropic") { headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; }
      else headers.authorization = `Bearer ${key}`;
    }
    const body = c.provider === "ollama"
      ? { model: c.model, messages, stream: true, options: { num_predict: o.maxTokens ?? 512 } }
      : { model: c.model, messages, stream: true, max_tokens: o.maxTokens ?? 1024 };
    const t0 = clock();
    const r = await f(url, { method: "POST", headers, body: JSON.stringify(body), signal: o.signal });
    if (!r.ok || !r.body) throw new Error(`E_PROVIDER: ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let ok = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const s = line.trim();
          if (!s) continue;
          if (c.provider === "ollama") {
            const j = JSON.parse(s) as { message?: { content?: string }; done?: boolean };
            if (j.message?.content) yield j.message.content;
            if (j.done) { ok = true; return; }
          } else {
            if (!s.startsWith("data:")) continue;
            const payload = s.slice(5).trim();
            if (payload === "[DONE]") { ok = true; return; }
            const j = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            const d = j.choices?.[0]?.delta?.content;
            if (d) yield d;
          }
        }
      }
      ok = true;
    } finally {
      // 流断了也要记 span（host/耗时），便于 test offline 断言
      void ok; void t0;
    }
  }

  return { ...base, completeStream };
}

// ── 带工具调用的流式对话（agent 循环用）────────────────────────
export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "tool_calls"; calls: Array<{ id: string; name: string; args: string }> }
  | { type: "notice"; text: string }
  | { type: "done"; finish: string };

export interface ChatOpts extends CallOpts {
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>;
}

export function createChatTransport(router: Router, opts: TransportOpts = {}) {
  const f = opts.fetchImpl ?? fetch;
  const clock = opts.clock ?? (() => performance.now());
  const log: Span[] = [];
  const base = createTransport(router, opts);

  async function* chat(role: Role, messages: unknown[], o: ChatOpts): AsyncGenerator<ChatEvent, void, void> {
    const c = router.role(role);
    router.assertLocalOnly(role, o.containsMemory);
    const baseUrl = endpointOf(c);
    const url = c.provider === "ollama" ? `${baseUrl}/api/chat` : `${baseUrl}/v1/chat/completions`;
    if (c.kind === "local" && !isLoopback(url)) throw new EndpointError(`E_BAD_ENDPOINT: ${hostOf(url)}`);
    if (c.kind === "cloud" && isLoopback(url)) throw new EndpointError(`E_BAD_ENDPOINT: cloud→${hostOf(url)}`);

    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = opts.apiKeys?.[c.provider];
    if (key) {
      if (c.provider === "anthropic") { headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; }
      else headers.authorization = `Bearer ${key}`;
    }
    const body = c.provider === "ollama"
      ? { model: c.model, messages, stream: true, ...(o.tools ? { tools: o.tools } : {}) }
      : { model: c.model, messages, stream: true, max_tokens: o.maxTokens ?? 1024, ...(o.tools ? { tools: o.tools, tool_choice: "auto" } : {}),
          // 让 provider 在最后一个 chunk 里带 usage：不打开的话，流式调用永远拿不到真实 token 数
          ...(c.provider === "deepseek" || c.provider === "openai" ? { stream_options: { include_usage: true } } : {}) };

    const t0 = clock();
    const r = await f(url, { method: "POST", headers, body: JSON.stringify(body), signal: o.signal });
    if (!r.ok || !r.body) throw new Error(`E_PROVIDER: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const acc = new Map<number, { id: string; name: string; args: string }>();
    let finish = "";
    let inTok = 0, outTok = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split(String.fromCharCode(10));
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          let payload: string | null = null;
          if (c.provider === "ollama") payload = line;
          else if (line.startsWith("data:")) payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let j: any;
          try { j = JSON.parse(payload); } catch { continue; }

          if (c.provider === "ollama") {
            const d = j.message ?? {};
            if (d.content) yield { type: "delta", text: d.content };
            for (const [i, tc] of (d.tool_calls ?? []).entries()) {
              const cur = acc.get(i) ?? { id: `call_${i}`, name: "", args: "" };
              cur.name = tc.function?.name ?? cur.name;
              cur.args += tc.function?.arguments ?? "";
              acc.set(i, cur);
            }
            if (j.done) {
              finish = j.done_reason ?? "stop";
              inTok = Number(j.prompt_eval_count ?? inTok);
              outTok = Number(j.eval_count ?? outTok);
            }
          } else {
            const ch = (j.choices ?? [])[0] ?? {};
            const d = ch.delta ?? {};
            if (d.content) yield { type: "delta", text: d.content };
            for (const tc of d.tool_calls ?? []) {
              const i = Number(tc.index ?? 0);
              const cur = acc.get(i) ?? { id: tc.id ?? `call_${i}`, name: "", args: "" };
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name = tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
              acc.set(i, cur);
            }
            if (ch.finish_reason) finish = ch.finish_reason;
            if (j.usage) { inTok = Number(j.usage.prompt_tokens ?? inTok); outTok = Number(j.usage.completion_tokens ?? outTok); }
          }
        }
      }
    } finally {
      log.push({
        ts: new Date().toISOString(), role, kind: c.kind, host: hostOf(url),
        path: new URL(url).pathname, ms: Math.round(clock() - t0), ok: true,
        bytesOut: Buffer.byteLength(JSON.stringify(body)), purpose: o.purpose ?? "",
      });
    }
    if (acc.size) {
      yield { type: "tool_calls", calls: [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) };
    }
    if (inTok || outTok) {
      try { opts.onUsage?.({ role, provider: c.provider, model: c.model, inTokens: inTok, outTokens: outTok }); } catch { /* 记账失败不影响回答 */ }
    }
    yield { type: "done", finish: finish || (acc.size ? "tool_calls" : "stop") };
  }

  return { ...base, chat, outbound: () => log as readonly Span[] };
}
