/**
 * 引导步骤的执行（H-4 的第 2–4 步）。
 *
 * 每一步都遵守同一条规矩：**先记账，再动手**。
 * 因为"装到一半崩了"比"没装"更糟 —— 下次启动要能接着清干净。
 *
 * 2026-11-17：Runner 允许异步返回。面板端曾经在 `void (async()=>...)` 里用
 * `execFileSync` 跑 pull/winget，那一行会把整个 Node 事件循环同步按住几分钟 ——
 * 外部看就是「引导卡死」（轮询 GET /api/setup 排在同步命令后面，一个都回不来），
 * 连 Ollama 探测也跟着超时。异步 Runner 是修法，不是把超时调大。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import { completeStep, noteFileWillChange, notePulledModel, noteStartedProcess, noteTempDir, type SetupStep } from "./setup.ts";

type MaybePromise<T> = T | Promise<T>;

export interface Runner {
  /** 一次性命令。必须返回真正的结果对象；返回 Promise 时调用方会 await。 */
  run(cmd: string, args: string[], opts?: { timeoutMs?: number }): MaybePromise<{ ok: boolean; out: string }>;
  /** 流式（pull 可能要几分钟）；默认跑 runner 的 run */
  stream?(cmd: string, args: string[], onLine: (s: string) => void): MaybePromise<{ ok: boolean }>;
  /**
   * 启动**常驻**进程（ollama serve）。必须立刻返回，不能等进程退出。
   * 没有这个方法的 Runner 退回「run + 5s 超时」的旧行为 —— 那条路会杀掉刚起的 serve，
   * 只留给 CLI/测试兼容，面板端必须实现。
   */
  start?(cmd: string, args: string[]): MaybePromise<{ ok: boolean; pid?: number; error?: string }>;
}

/**
 * 面板端用的 Runner：全程异步，长命令不按住事件循环。
 *
 * 这是「引导卡死」的修法所在。原先 web 路由在 `void (async()=>{})` 里跑
 * `execFileSync`，外面看是后台任务，实际上 Node 主线程被同步按住 —— 轮询、
 * 探测、别的 API 全部排队，界面就像死了。spawn + Promise 才是真后台。
 */
export function createAsyncRunner(opts: { maxOut?: number } = {}): Runner {
  const maxOut = opts.maxOut ?? 200_000;
  const once = (cmd: string, args: string[], timeoutMs: number, onLine?: (s: string) => void) =>
    new Promise<{ ok: boolean; out: string }>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        resolve({ ok: false, out: String((e as Error).message ?? e).slice(0, 200) });
        return;
      }
      let out = "";
      let tail = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (ok: boolean, extra = "") => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ ok, out: (out + extra).slice(0, maxOut) });
      };
      const feed = (chunk: Buffer | string) => {
        const s = chunk.toString();
        out += s;
        if (!onLine) return;
        tail += s;
        const lines = tail.split(/\r?\n/);
        tail = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) onLine(line.trim().slice(0, 300));
      };
      child.stdout?.on("data", feed);
      child.stderr?.on("data", feed);
      child.on("error", (e) => finish(false, String(e.message).slice(0, 200)));
      child.on("close", (code) => finish(code === 0));
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* 已经退了 */ }
        finish(false, String.fromCharCode(10) + "[TIMEOUT]");
      }, timeoutMs);
    });

  return {
    run: (cmd, args, o) => once(cmd, args, o?.timeoutMs ?? 600_000),
    stream: (cmd, args, onLine) => once(cmd, args, 60 * 60_000, onLine).then((r) => ({ ok: r.ok })),
    start: (cmd, args) => {
      try {
        const child = spawn(cmd, args, { windowsHide: true, detached: true, stdio: "ignore" });
        child.unref();
        return { ok: true, ...(child.pid ? { pid: child.pid } : {}) };
      } catch (e) {
        return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
      }
    },
  };
}

export const BIN = {
  ollama: "ollama",
  winget: "winget",
} as const;

/** 第 2 步：Ollama 装没装、跑没跑 */
export async function ensureOllama(home: string, r: Runner): Promise<{ ok: boolean; note: string }> {
  const ver = await r.run(BIN.ollama, ["--version"]);
  if (!ver.ok) {
    // 不静默装：装系统软件必须让人知道发生了什么、且能被终止
    const w = await r.run(BIN.winget, [
      "install", "--id", "Ollama.Ollama", "--source", "winget",
      "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
    ], { timeoutMs: 15 * 60_000 });
    if (!w.ok) {
      return {
        ok: false,
        note: "装不上 Ollama。可以手动装（https://ollama.com/download），或改用云端模型（下一步跳过本地）",
      };
    }
    // 记账：winget 装的是系统软件，**不自动卸载**（卸载可能连带删掉用户的模型目录）
    const again = await r.run(BIN.ollama, ["--version"]);
    if (!again.ok) return { ok: false, note: "装完了但 ollama 还不可用：可能需要重开一个终端（PATH 生效）" };
  }

  // 探活；没跑就起一个常驻（并记账，终止时停掉）
  const probe = await r.run(BIN.ollama, ["list"]);
  if (!probe.ok) {
    if (r.start) {
      // serve 是常驻进程，绝不能用「等它退出」的 run 去跑 —— 那只会超时并把它杀掉。
      const started = await r.start(BIN.ollama, ["serve"]);
      if (!started.ok) return { ok: false, note: "ollama serve 起不来；手动开一个终端跑 ollama serve 再继续" };
      noteStartedProcess(home, "ollama serve", started.pid);
      return { ok: true, note: "ollama serve 已在后台启动" + (started.pid ? `（PID ${started.pid}）` : "") };
    }
    // 兼容没有 start 的老 Runner（CLI/测试）：保留旧行为，但别假装它失败了。
    const started = await r.run(BIN.ollama, ["serve"], { timeoutMs: 5_000 });
    noteStartedProcess(home, "ollama serve");
    return {
      ok: true,
      note: started.ok ? "Ollama 可用" : "已请求启动 ollama serve（常驻进程不会自然退出，请用「看一眼」确认在线）",
    };
  }
  return { ok: true, note: "Ollama 可用" };
}

/**
 * 第 3 步：装 embedding。
 * **这一步不能跳过**：chat 模型可以云端兜底，embedding 没有语义检索整个退化。
 */
export async function ensureEmbedding(home: string, r: Runner, model = "bge-m3", onLine?: (s: string) => void): Promise<{ ok: boolean; note: string }> {
  const list = await r.run(BIN.ollama, ["list"]);
  const has = list.out.includes(model.split(":")[0]!);
  if (has) return { ok: true, note: `${model} 已在（不是我们装的，终止时不会删）` };

  // 先记账，再拉：拉一半失败也要能被清掉
  notePulledModel(home, model);
  const res = r.stream
    ? await r.stream(BIN.ollama, ["pull", model], (l) => onLine?.(l))
    : await r.run(BIN.ollama, ["pull", model], { timeoutMs: 60 * 60_000 });
  if (!res.ok) {
    return {
      ok: false,
      note: `拉 ${model} 失败。可以重试，或手动：ollama pull ${model}（约 1.2 GB）`,
    };
  }
  return { ok: true, note: `${model} 装好了（终止引导会把它删掉，因为是我们装的）` };
}

/** 第 4 步：本地 chat 模型（可选 —— 有云端 key 也能跑） */
export async function ensureChatModel(home: string, r: Runner, model: string, onLine?: (s: string) => void): Promise<{ ok: boolean; note: string }> {
  if (!model) return { ok: true, note: "不装本地 chat 模型（夜间抽取会跳过；表达仍走云端）" };
  const list = await r.run(BIN.ollama, ["list"]);
  const has = list.out.includes(model.split(":")[0]!);
  if (has) return { ok: true, note: `${model} 已在（不是我们装的）` };
  notePulledModel(home, model);
  const res = r.stream
    ? await r.stream(BIN.ollama, ["pull", model], (l) => onLine?.(l))
    : await r.run(BIN.ollama, ["pull", model], { timeoutMs: 60 * 60_000 });
  return res.ok
    ? { ok: true, note: `${model} 装好了（终止引导会把它删掉）` }
    : { ok: false, note: `拉 ${model} 失败（约 4.7 GB）。可以跳过本地模型，只配云端 API` };
}

/**
 * 把推荐/选择写进配置：**改之前先备份**，终止时能原样恢复。
 */
export function writeLocalConfig(home: string, patch: { embed?: string; chat?: string }): { ok: boolean; note: string } {
  const file = join(home, "config.json");
  noteFileWillChange(home, file);            // 记账在动手之前
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { /* 新文件 */ }
  const local = { ...(cfg.local as Record<string, unknown> | undefined ?? {}) };
  if (patch.embed) local.embed = patch.embed;
  if (patch.chat) local.default = patch.chat;
  cfg.local = local;
  atomicWriteFile(file, JSON.stringify(cfg, null, 2) + String.fromCharCode(10));
  return { ok: true, note: `已写入 config.json：${Object.entries(local).map(([k, v]) => `${k}=${v}`).join(" ")}` };
}

/** 一步的调度器（CLI 与面板共用）：返回给人看的一句话 */
export async function runStep(
  home: string,
  step: SetupStep,
  r: Runner,
  opts: { model?: string; chat?: string; onLine?: (s: string) => void } = {},
): Promise<{ ok: boolean; note: string }> {
  try {
    let out: { ok: boolean; note: string };
    switch (step) {
      case "ollama": out = await ensureOllama(home, r); break;
      case "embed": out = await ensureEmbedding(home, r, opts.model ?? "bge-m3", opts.onLine); break;
      case "chat": {
        const res = await ensureChatModel(home, r, opts.chat ?? "", opts.onLine);
        if (res.ok) writeLocalConfig(home, { ...(opts.model ? { embed: opts.model } : {}), ...(opts.chat ? { chat: opts.chat } : {}) });
        out = res;
        break;
      }
      case "detect":
      case "api":
      case "persona":
      case "smoke":
      case "first":
        // 这几步要么是只读（detect），要么在面板里做（api/persona/smoke/first）
        out = { ok: true, note: "由面板/CLI 的对应命令完成" };
        break;
      default:
        out = { ok: false, note: `未知步骤 ${String(step)}` };
    }
    completeStep(home, step, out.ok, out.note);
    return out;
  } catch (e) {
    const note = String((e as Error).message ?? e).slice(0, 300);
    completeStep(home, step, false, note);
    return { ok: false, note };
  }
}

void noteTempDir;
