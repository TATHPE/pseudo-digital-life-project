/**
 * 引导步骤的执行（H-4 的第 2–4 步）。
 *
 * 每一步都遵守同一条规矩：**先记账，再动手**。
 * 因为"装到一半崩了"比"没装"更糟 —— 下次启动要能接着清干净。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import { completeStep, noteFileWillChange, notePulledModel, noteStartedProcess, noteTempDir, type SetupStep } from "./setup.ts";

export interface Runner {
  run(cmd: string, args: string[], opts?: { timeoutMs?: number }): { ok: boolean; out: string };
  /** 流式（pull 可能要几分钟）；默认跑 runner 的 run */
  stream?(cmd: string, args: string[], onLine: (s: string) => void): { ok: boolean };
}

export const BIN = {
  ollama: "ollama",
  winget: "winget",
} as const;

/** 第 2 步：Ollama 装没装、跑没跑 */
export function ensureOllama(home: string, r: Runner): { ok: boolean; note: string } {
  const ver = r.run(BIN.ollama, ["--version"]);
  if (!ver.ok) {
    // 不静默装：装系统软件必须让人知道发生了什么、且能被终止
    const w = r.run(BIN.winget, [
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
    const again = r.run(BIN.ollama, ["--version"]);
    if (!again.ok) return { ok: false, note: "装完了但 ollama 还不可用：可能需要重开一个终端（PATH 生效）" };
  }

  // 探活；没跑就起一个常驻（并记账，终止时停掉）
  const probe = r.run(BIN.ollama, ["list"]);
  if (!probe.ok) {
    const started = r.run(BIN.ollama, ["serve"], { timeoutMs: 5_000 });
    noteStartedProcess(home, "ollama serve");
    if (!started.ok) return { ok: false, note: "ollama serve 起不来；手动开一个终端跑 ollama serve 再继续" };
  }
  return { ok: true, note: "Ollama 可用" };
}

/**
 * 第 3 步：装 embedding。
 * **这一步不能跳过**：chat 模型可以云端兜底，embedding 没有语义检索整个退化。
 */
export function ensureEmbedding(home: string, r: Runner, model = "bge-m3", onLine?: (s: string) => void): { ok: boolean; note: string } {
  const has = r.run(BIN.ollama, ["list"]).out.includes(model.split(":")[0]!);
  if (has) return { ok: true, note: `${model} 已在（不是我们装的，终止时不会删）` };

  // 先记账，再拉：拉一半失败也要能被清掉
  notePulledModel(home, model);
  const res = r.stream
    ? r.stream(BIN.ollama, ["pull", model], (l) => onLine?.(l))
    : r.run(BIN.ollama, ["pull", model], { timeoutMs: 60 * 60_000 });
  if (!res.ok) {
    return {
      ok: false,
      note: `拉 ${model} 失败。可以重试，或手动：ollama pull ${model}（约 1.2 GB）`,
    };
  }
  return { ok: true, note: `${model} 装好了（终止引导会把它删掉，因为是我们装的）` };
}

/** 第 4 步：本地 chat 模型（可选 —— 有云端 key 也能跑） */
export function ensureChatModel(home: string, r: Runner, model: string, onLine?: (s: string) => void): { ok: boolean; note: string } {
  if (!model) return { ok: true, note: "不装本地 chat 模型（夜间抽取会跳过；表达仍走云端）" };
  const has = r.run(BIN.ollama, ["list"]).out.includes(model.split(":")[0]!);
  if (has) return { ok: true, note: `${model} 已在（不是我们装的）` };
  notePulledModel(home, model);
  const res = r.stream
    ? r.stream(BIN.ollama, ["pull", model], (l) => onLine?.(l))
    : r.run(BIN.ollama, ["pull", model], { timeoutMs: 60 * 60_000 });
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
export function runStep(home: string, step: SetupStep, r: Runner, opts: { model?: string; chat?: string } = {}): { ok: boolean; note: string } {
  try {
    let out: { ok: boolean; note: string };
    switch (step) {
      case "ollama": out = ensureOllama(home, r); break;
      case "embed": out = ensureEmbedding(home, r, opts.model ?? "bge-m3"); break;
      case "chat": {
        const res = ensureChatModel(home, r, opts.chat ?? "");
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
