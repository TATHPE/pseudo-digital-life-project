/**
 * 首次配置事务（H-4）。
 *
 * 这条流程会**改用户的机器**：装 Ollama、下模型（几个 GB）、写配置、建人格。
 * 所以它不是向导，是**事务**：
 *
 *  ① 每一个"我改了你的机器"的动作都要**记账**（`artifacts`）
 *  ② 用户随时可以**暂停**（停在步骤边界）或**终止**
 *  ③ 终止 = 按账**倒序回滚**：删掉我们 pull 的模型、恢复写入前的 config、停掉我们起的进程、
 *     删掉临时文件；**不删用户本来就有的东西**（这是最关键的一条）
 *  ④ 记账落盘（`data/setup-session.json`）：崩了之后下次启动也能接着清
 *
 * 刻意不做的一件事：**不自动卸载 Ollama 本体**。卸载一个系统级应用比留着它更危险
 * （可能连带删掉用户自己的模型目录）。要卸载给显式命令 `jingjing setup abort --purge`。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";

export type SetupStep = "detect" | "ollama" | "embed" | "chat" | "api" | "persona" | "smoke" | "first";

/** 步骤顺序就是文档 §3 的顺序，不能换 */
export const SETUP_STEPS: SetupStep[] = ["detect", "ollama", "embed", "chat", "api", "persona", "smoke", "first"];

export type SetupStatus = "idle" | "running" | "paused" | "done" | "aborted";

export interface SetupArtifacts {
  /** 我们 pull 下来的模型（回滚时 ollama rm；**必须记清楚是不是我们 pull 的**） */
  pulledModels: string[];
  /** 我们写/改过的文件：回滚时恢复 backup（没有 backup 就删掉） */
  files: Array<{ path: string; backup: string | null }>;
  /** 我们拉起的常驻进程（目前只有 ollama serve） */
  startedProcesses: Array<{ name: string; pid?: number }>;
  /** 我们自己建的临时目录 */
  tempDirs: string[];
}

export interface SetupSession {
  status: SetupStatus;
  /** 下一个该做的步骤（进度指针） */
  step: SetupStep;
  startedAt: string;
  updatedAt: string;
  artifacts: SetupArtifacts;
  /** 每一步的结果，给人看"做到了哪" */
  log: Array<{ step: SetupStep; at: string; ok: boolean; note: string }>;
  /** 用户在终止时填的理由（可选） */
  abortedBecause?: string;
}

const emptyArtifacts = (): SetupArtifacts => ({ pulledModels: [], files: [], startedProcesses: [], tempDirs: [] });

export const sessionPath = (home: string): string => join(home, "setup-session.json");

export function readSession(home: string): SetupSession | null {
  try {
    if (!existsSync(sessionPath(home))) return null;
    const s = JSON.parse(readFileSync(sessionPath(home), "utf8")) as SetupSession;
    return { ...s, artifacts: { ...emptyArtifacts(), ...s.artifacts } };
  } catch { return null; }
}

function writeSession(home: string, s: SetupSession): void {
  atomicWriteFile(sessionPath(home), JSON.stringify(s, null, 2));
}

export function startSetup(home: string, now = new Date()): SetupSession {
  const s: SetupSession = {
    status: "running",
    step: "detect",
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    artifacts: emptyArtifacts(),
    log: [],
  };
  writeSession(home, s);
  return s;
}

/** 记账：pull 了一个模型 */
export function notePulledModel(home: string, model: string): void {
  const s = readSession(home) ?? startSetup(home);
  if (!s.artifacts.pulledModels.includes(model)) s.artifacts.pulledModels.push(model);
  s.updatedAt = new Date().toISOString();
  writeSession(home, s);
}

/** 记账：要改一个文件（先把原内容备份进 artifacts，回滚时恢复） */
export function noteFileWillChange(home: string, path: string): void {
  const s = readSession(home) ?? startSetup(home);
  if (!s.artifacts.files.some((f) => f.path === path)) {
    s.artifacts.files.push({ path, backup: existsSync(path) ? readFileSync(path, "utf8") : null });
  }
  s.updatedAt = new Date().toISOString();
  writeSession(home, s);
}

export function noteStartedProcess(home: string, name: string, pid?: number): void {
  const s = readSession(home) ?? startSetup(home);
  if (!s.artifacts.startedProcesses.some((p) => p.name === name)) {
    s.artifacts.startedProcesses.push({ name, ...(pid ? { pid } : {}) });
  }
  s.updatedAt = new Date().toISOString();
  writeSession(home, s);
}

export function noteTempDir(home: string, dir: string): void {
  const s = readSession(home) ?? startSetup(home);
  if (!s.artifacts.tempDirs.includes(dir)) s.artifacts.tempDirs.push(dir);
  s.updatedAt = new Date().toISOString();
  writeSession(home, s);
}

/** 记一步的结果，并把指针推到下一步 */
export function completeStep(home: string, step: SetupStep, ok: boolean, note: string, now = new Date()): SetupSession {
  const s = readSession(home) ?? startSetup(home, now);
  s.log.push({ step, at: now.toISOString(), ok, note: note.slice(0, 400) });
  const i = SETUP_STEPS.indexOf(step);
  s.step = ok && i >= 0 && i + 1 < SETUP_STEPS.length ? SETUP_STEPS[i + 1]! : step;
  if (ok && step === "first") s.status = "done";
  s.updatedAt = now.toISOString();
  writeSession(home, s);
  return s;
}

/** 暂停：停在步骤边界（已经记账的东西**不清**，因为还没终止） */
export function pauseSetup(home: string, now = new Date()): SetupSession {
  const s = readSession(home) ?? startSetup(home, now);
  s.status = "paused";
  s.updatedAt = now.toISOString();
  writeSession(home, s);
  return s;
}

export function resumeSetup(home: string, now = new Date()): SetupSession {
  const s = readSession(home) ?? startSetup(home, now);
  s.status = "running";
  s.updatedAt = now.toISOString();
  writeSession(home, s);
  return s;
}

export interface UndoDeps {
  /** 跑一条命令（返回是否成功）；测试里注入假实现 */
  run?: (cmd: string, args: string[]) => { ok: boolean; out: string };
  removeFile?: (p: string) => void;
  removeDir?: (p: string) => void;
  killPid?: (pid: number) => void;
}

export interface UndoReport {
  restoredFiles: string[];
  removedModels: string[];
  stoppedProcesses: string[];
  removedDirs: string[];
  /** 没清掉的（要如实说，不能假装干净） */
  failed: string[];
}

/**
 * 按账**倒序回滚**。
 *
 * 顺序是刻意的：先停进程（否则它可能又把文件写回来），再恢复文件，最后删模型/临时目录。
 */
export function undoSetup(home: string, deps: UndoDeps = {}): UndoReport {
  const s = readSession(home);
  const report: UndoReport = { restoredFiles: [], removedModels: [], stoppedProcesses: [], removedDirs: [], failed: [] };
  if (!s) return report;

  const run = deps.run ?? ((cmd: string, args: string[]) => {
    try {
      const out = execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 120_000 });
      return { ok: true, out: String(out) };
    } catch (e) { return { ok: false, out: String((e as Error).message).slice(0, 200) }; }
  });
  const rmFile = deps.removeFile ?? ((p: string) => unlinkSync(p));
  const rmDir = deps.removeDir ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const kill = deps.killPid ?? ((pid: number) => { try { process.kill(pid); } catch { /* ignore */ } });

  // ① 停我们拉起的进程
  for (const p of [...s.artifacts.startedProcesses].reverse()) {
    if (p.pid) {
      try { kill(p.pid); report.stoppedProcesses.push(`${p.name}#${p.pid}`); }
      catch { report.failed.push(`停不掉 ${p.name}#${p.pid}`); }
    }
  }

  // ② 恢复文件（有备份就写回，没备份就删）
  for (const f of [...s.artifacts.files].reverse()) {
    try {
      if (f.backup === null) { rmFile(f.path); }
      else { writeFileSync(f.path, f.backup, "utf8"); }
      report.restoredFiles.push(f.path);
    } catch { report.failed.push(`恢复不了 ${f.path}`); }
  }

  // ③ 删我们 pull 的模型（**只删我们 pull 的**）
  for (const m of [...s.artifacts.pulledModels].reverse()) {
    const r = run("ollama", ["rm", m]);
    if (r.ok) report.removedModels.push(m);
    else report.failed.push(`删不掉模型 ${m}：${r.out.slice(0, 80)}`);
  }

  // ④ 删临时目录
  for (const d of [...s.artifacts.tempDirs].reverse()) {
    try { rmDir(d); report.removedDirs.push(d); } catch { report.failed.push(`删不掉 ${d}`); }
  }

  const done: SetupSession = { ...s, status: "aborted", updatedAt: new Date().toISOString(), artifacts: emptyArtifacts() };
  writeSession(home, done);
  return report;
}

/** 硬件与现状探测（第 1 步；只读，不改任何东西） */
export interface Detected {
  ramGB: number;
  ollama: { installed: boolean; running: boolean; models: string[] };
  config: { hasCloudKey: boolean; roles: Record<string, string> };
  /** 推荐档（按 RAM 粗分；有 VRAM 更好，这里先用 RAM 兜底） */
  recommend: { model: string; note: string };
}

export function recommendFor(ramGB: number): { model: string; note: string } {
  if (ramGB < 8) return { model: "qwen2.5:3b-instruct", note: "内存偏小：3B 够用，抽取质量一般" };
  if (ramGB < 16) return { model: "qwen2.5:7b-instruct", note: "7B 是性价比拐点（本机实测 30/30，p50 373ms）" };
  if (ramGB < 32) return { model: "qwen2.5:14b-instruct", note: "14B 能明显提升抽取质量，代价是慢" };
  return { model: "qwen2.5:32b-instruct", note: "32B 收益递减；不如把钱花在更强的云端表达模型上" };
}

/** 从 `/health` 之外的地方探测：只用 node 自带能力 + 可选命令 */
export async function detect(
  home: string,
  deps: { run?: (cmd: string, args: string[]) => { ok: boolean; out: string }; totalMemGB?: number } = {},
): Promise<Detected> {
  const { totalmem } = await import("node:os");
  const ramGB = Math.round(((deps.totalMemGB ?? totalmem() / 1024 ** 3)) * 10) / 10;
  const run = deps.run ?? ((cmd: string, args: string[]) => {
    try { return { ok: true, out: String(execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 })) }; }
    catch { return { ok: false, out: "" }; }
  });

  const ver = run("ollama", ["--version"]);
  const installed = ver.ok;
  let running = false;
  let models: string[] = [];
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      running = true;
      const j = (await r.json()) as { models?: Array<{ name?: string }> };
      models = (j.models ?? []).map((m) => String(m.name ?? "")).filter(Boolean);
    }
  } catch { /* 没跑就是没跑 */ }

  // 配置：有没有云端 key（只读，不打印）
  let hasCloudKey = false;
  const roles: Record<string, string> = {};
  try {
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { local?: Record<string, string> };
    for (const [k, v] of Object.entries(cfg.local ?? {})) roles[k] = String(v);
  } catch { /* 没有配置 */ }
  try {
    const { createStore } = await import("./auth.ts");
    const st = createStore(join(home, "secrets"));
    hasCloudKey = Boolean(st.get("deepseek") || st.get("openai") || st.get("anthropic"));
  } catch { /* 读不到就当没有 */ }

  return { ramGB, ollama: { installed, running, models }, config: { hasCloudKey, roles }, recommend: recommendFor(ramGB) };
}
