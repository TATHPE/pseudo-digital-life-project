/**
 * Ollama 探测（C-4）：一次 /api/tags + 两个最小调用探针。
 *
 * 为什么单独一个文件：`jingjing models`、面板的「本地模型」块、以及
 * `night` 的缺模型检查都要问同一件事，逻辑不该抄三份。
 *
 * 纪律：这里只做**探测**。真正的模型调用仍走 transport（带隐私闸门与记账）。
 */
export interface ProbeResult {
  online: boolean;
  names: string[];
  error?: string;
}

export async function probeOllama(base: string, timeoutMs = 3000): Promise<ProbeResult> {
  try {
    const r = await fetch(base + "/api/tags", { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { online: false, names: [], error: `HTTP ${r.status}` };
    const j = await r.json() as { models?: Array<{ name: string }> };
    return { online: true, names: (j.models ?? []).map((m) => m.name) };
  } catch (e) {
    return { online: false, names: [], error: String((e as Error).message ?? e).slice(0, 80) };
  }
}

/** 已装与否（Ollama 的 tag 可能带 :latest） */
export function isInstalled(names: readonly string[], model: string): boolean {
  return names.includes(model) || names.includes(model + ":latest");
}

/** 最小 chat 探针：只让模型吐 1 个 token，证明“能加载” */
export async function probeChat(base: string, model: string, timeoutMs = 120_000): Promise<{ ok: boolean; detail?: string }> {
  try {
    const r = await fetch(base + "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, messages: [{ role: "user", content: "答一个字：在" }],
        stream: false, options: { num_predict: 1 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status} ${(await r.text()).slice(0, 80)}` };
    const j = await r.json() as { message?: { content?: string } };
    return { ok: typeof j.message?.content === "string", detail: j.message?.content ? "能加载" : "返回空" };
  } catch (e) {
    return { ok: false, detail: String((e as Error).message ?? e).slice(0, 100) };
  }
}

export async function probeEmbed(base: string, model: string, timeoutMs = 60_000): Promise<{ ok: boolean; detail?: string }> {
  try {
    const r = await fetch(base + "/api/embed", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: "探测" }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status} ${(await r.text()).slice(0, 80)}` };
    const j = await r.json() as { embeddings?: number[][] };
    const dim = j.embeddings?.[0]?.length ?? 0;
    return { ok: dim > 0, detail: dim ? `维度 ${dim}` : "返回空向量" };
  } catch (e) {
    return { ok: false, detail: String((e as Error).message ?? e).slice(0, 100) };
  }
}
