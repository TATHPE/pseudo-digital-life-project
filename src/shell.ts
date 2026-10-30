/**
 * T3 受限命令执行（04 §5.2 模板 / §4.1 一次性令牌 / §6 宿主层）
 *
 * 三条硬规矩，任何一条松了这套东西就白做：
 *
 *  ① **永不拼字符串。** 注册的是完整 argv 模板（`["node", ["{script}"]]`），
 *     参数槽只能占满**整个** argv 元素，不能嵌在别的元素里。
 *     于是 `; rm -rf /` 没有地方可以"拼进去"——它要么过不了正则，要么就是一个独立的 argv 元素，
 *     而被执行的二进制永远是模板里写死的那个（不经过 shell，没有 $IFS、没有引号解析）。
 *
 *  ② **确认不能复用。** 令牌绑定 `argv_sha256 + cwd`，短时效，**单次**（用完立刻标记 used）。
 *     改一个字节、换一个目录、过 2 分钟、再来一次，全部失效。
 *
 *  ③ **杀得掉。** 超时杀**进程树**（Windows: taskkill /T；POSIX: 独立进程组 + kill(-pid)），
 *     输出超限就截断并杀掉，环境变量走白名单（`*_KEY`/`*_TOKEN` 一律不传下去）。
 *
 * 已知的边界（写在这里，免得以后有人以为它是沙箱）：
 *   - 只做"超时 + 杀树 + 环境清洗"，**没有** Job Object / bwrap / 降权 / 低完整性级别。
 *     04 §6.1 的完整隔离属于 M6/P6；现在靠"模板表里没有 rm/sudo/curl"这一层。
 *   - 模板里如果注册了 `node.run_script`，那个脚本本身是任意代码——所以它是 T3、每次确认。
 *   - Windows 双栈（PS 5.1 / 7）**不适用**：我们从不生成 PowerShell 字符串，一律 execve 直调。
 *     这是 04 §5.3 那三个坑（&&、??、引号）最彻底的绕法。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import { safePath } from "./verbs.ts";
import type { Tier } from "./types.ts";

// ── 模板表：能跑的命令**只有**这里的 ──────────────────────────

export interface SlotSpec {
  /** 必须匹配整串（不隐式加锚，模板里写全） */
  pattern: string;
  /** 解析后必须落在这个相对目录下（如 "workspace/"） */
  must_be_under?: string;
  max?: number;
}

export interface TemplateDef {
  id: string;
  tier: Tier;
  description: string;
  /** [二进制, argv]，占位符只能独占一个元素 */
  win: [string, string[]];
  linux?: [string, string[]];
  slots: Record<string, SlotSpec>;
  timeoutMs?: number;
}

// 首字符不许是 - ：否则槽值会被目标程序当成选项（"-e" 之类）
const NAME = "^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$";
const SCRIPT = "^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}\\.(mjs|js|cjs|py)$";

export const TEMPLATES: TemplateDef[] = [
  {
    id: "node.version", tier: "T0",
    description: "看 Node 版本（完全确定的命令，没有参数槽）",
    win: ["node", ["--version"]], linux: ["node", ["--version"]],
    slots: {}, timeoutMs: 10_000,
  },
  {
    id: "git.status", tier: "T1",
    description: "git status --porcelain（只读）",
    win: ["git", ["status", "--porcelain"]], linux: ["git", ["status", "--porcelain"]],
    slots: {}, timeoutMs: 15_000,
  },
  {
    id: "git.diff", tier: "T1",
    description: "git diff --stat（只读）",
    win: ["git", ["diff", "--stat"]], linux: ["git", ["diff", "--stat"]],
    slots: {}, timeoutMs: 15_000,
  },
  {
    id: "node.run_script", tier: "T3",
    description: "跑 workspace/ 下的一个 .mjs/.js（脚本本身是任意代码 → 每次确认）",
    win: ["node", ["{script}"]], linux: ["node", ["{script}"]],
    slots: { script: { pattern: SCRIPT, must_be_under: "workspace/", max: 96 } },
    timeoutMs: 60_000,
  },
  {
    id: "python.run_script", tier: "T3",
    description: "跑 workspace/ 下的一个 .py（JJ_PYTHON / 项目 .venv / PATH 上的 python3）",
    win: ["python", ["-X", "utf8", "{script}"]], linux: ["python3", ["-X", "utf8", "{script}"]],
    slots: { script: { pattern: SCRIPT, must_be_under: "workspace/", max: 96 } },
    timeoutMs: 60_000,
  },
  {
    id: "git.log", tier: "T1",
    description: "最近 10 条提交（只读，模板参数写死）",
    win: ["git", ["log", "--oneline", "-n", "10"]], linux: ["git", ["log", "--oneline", "-n", "10"]],
    slots: {}, timeoutMs: 15_000,
  },
];

export function templateById(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** 给模型/人看的目录（不含 argv 细节，只有 id + 档位 + 说明 + 槽） */
export function templateCatalog(): Array<{ id: string; tier: Tier; description: string; slots: Record<string, SlotSpec> }> {
  return TEMPLATES.map(({ id, tier, description, slots }) => ({ id, tier, description, slots }));
}

// ── 渲染：参数槽 → 确定的 argv ────────────────────────────────

const toPosix = (p: string) => p.split(sep).join("/");

export function workspaceDir(home: string): string {
  return normalize(join(home, "workspace"));
}

/** argv 指纹：cwd + 每个元素，用 NUL 分隔（避免 "a b" 与 "a" "b" 撞车） */
export function argvSha256(argv: string[], cwd: string): string {
  const norm = toPosix(normalize(cwd)).toLowerCase();
  return createHash("sha256").update([norm, ...argv].join("\u0000")).digest("hex");
}

export interface Rendered {
  template: string;
  tier: Tier;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  digest: string;
}

export function renderTemplate(
  home: string, templateId: string, slots: Record<string, unknown> = {},
): Rendered {
  const t = templateById(templateId);
  if (!t) throw new Error(`E_NO_TEMPLATE: ${templateId}`);
  if (process.env.JJ_SHELL === "off") throw new Error("E_DISABLED: shell.run 被 JJ_SHELL=off 关闭");

  const spec = process.platform === "win32" ? t.win : (t.linux ?? t.win);
  const declared = Object.keys(t.slots);
  for (const k of Object.keys(slots)) {
    if (!declared.includes(k)) throw new Error(`E_BAD_SLOT: ${k}（模板 ${t.id} 没有这个槽）`);
  }

  const argv: string[] = [spec[0]];
  for (const raw of spec[1]) {
    const m = raw.match(/^\{([A-Za-z0-9_]+)\}$/);
    if (!m) {
      if (raw.includes("{")) throw new Error(`E_BAD_TEMPLATE: 占位符只能独占一个 argv 元素（${raw}）`);
      argv.push(raw);           // 字面量：模板作者写死的，不经过任何输入
      continue;
    }
    const name = m[1]!;
    const s = t.slots[name];
    if (!s) throw new Error(`E_BAD_TEMPLATE: 占位符 {${name}} 没有对应的槽定义`);
    const v = String(slots[name] ?? "");
    if (!v) throw new Error(`E_BAD_ARGV: 缺少参数 ${name}`);
    if (v.length > (s.max ?? 200)) throw new Error(`E_BAD_ARGV: ${name} 过长`);
    if (!new RegExp(s.pattern).test(v)) throw new Error(`E_BAD_ARGV: ${name} 不匹配 ${s.pattern}`);
    if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error(`E_BAD_ARGV: ${name} 含控制字符`);
    if (s.must_be_under) {
      const under = s.must_be_under.endsWith("/") ? s.must_be_under : s.must_be_under + "/";
      const target = under + v;
      safePath(home, target, true);   // 必须在 home 内、真实路径也在（junction 逃逸一起挡）
      const real = toPosix(safePath(home, target, true));
      const base = toPosix(safePath(home, under, true));
      if (real !== base && !real.startsWith(base + "/")) throw new Error(`E_PATH_DENIED: ${name} 不在 ${under} 下`);
    }
    argv.push(v);
  }

  const cwd = workspaceDir(home);
  return {
    template: t.id, tier: t.tier, argv, cwd,
    timeoutMs: t.timeoutMs ?? 300_000,
    digest: argvSha256(argv, cwd),
  };
}

// ── 一次性令牌（04 §4.1）────────────────────────────────────

export interface CapToken {
  token: string;
  verb: string;
  template: string;
  argv_sha256: string;
  cwd: string;
  expires_at: string;
  uses: number;
  used_at?: string;
  issued_by: string;
  issued_at: string;
}

export const tokensDir = (home: string) => join(home, "tokens");
const TOKEN_RE = /^cap_[0-9a-z]{6,40}$/;

function tokenPath(home: string, id: string): string {
  if (!TOKEN_RE.test(id)) throw new Error(`E_TOKEN_UNKNOWN: 形状不对`);
  return join(tokensDir(home), id + ".json");
}

export interface IssueOpts {
  verb: string;
  template: string;
  digest: string;
  cwd: string;
  ttlMs?: number;
  now?: Date;
  issuedBy?: string;
  /** 测试用 */
  id?: string;
}

export function issueToken(home: string, o: IssueOpts): CapToken {
  const now = o.now ?? new Date();
  const id = o.id ?? `cap_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const t: CapToken = {
    token: id, verb: o.verb, template: o.template, argv_sha256: o.digest, cwd: o.cwd,
    expires_at: new Date(now.getTime() + (o.ttlMs ?? 120_000)).toISOString(),
    uses: 1, issued_by: o.issuedBy ?? "user", issued_at: now.toISOString(),
  };
  mkdirSync(tokensDir(home), { recursive: true });
  atomicWriteFile(tokenPath(home, id), JSON.stringify(t, null, 2) + "\n");
  sweepTokens(home, now);
  return t;
}

export type ConsumeResult =
  | { ok: true; token: CapToken }
  | { ok: false; code: "E_TOKEN_UNKNOWN" | "E_TOKEN_EXPIRED" | "E_TOKEN_USED" | "E_TOKEN_MISMATCH" };

/**
 * 校验并**立即用掉**。顺序很重要：
 *   形状 → 存在 → 过期 → 已用 → 指纹 / verb 不匹配 → 标记 used
 * 标记 used 在**执行之前**做：执行崩了也不能让同一个令牌活过来。
 */
export function consumeToken(
  home: string, id: string, want: { verb: string; digest: string }, now = new Date(),
): ConsumeResult {
  let p: string;
  try { p = tokenPath(home, id); } catch { return { ok: false, code: "E_TOKEN_UNKNOWN" }; }
  if (!existsSync(p)) return { ok: false, code: "E_TOKEN_UNKNOWN" };

  let t: CapToken;
  try { t = JSON.parse(readFileSync(p, "utf8")) as CapToken; }
  catch { return { ok: false, code: "E_TOKEN_UNKNOWN" }; }

  if (t.used_at) return { ok: false, code: "E_TOKEN_USED" };
  if (Date.parse(t.expires_at) <= now.getTime()) {
    try { unlinkSync(p); } catch { /* ignore */ }
    return { ok: false, code: "E_TOKEN_EXPIRED" };
  }
  if (t.verb !== want.verb || t.argv_sha256 !== want.digest) return { ok: false, code: "E_TOKEN_MISMATCH" };

  atomicWriteFile(p, JSON.stringify({ ...t, used_at: now.toISOString(), uses: 0 }, null, 2) + "\n");
  return { ok: true, token: t };
}

/** 清掉过期的令牌文件（保留 used 一段时间，方便回答"这个令牌被用过"） */
export function sweepTokens(home: string, now = new Date()): number {
  const dir = tokensDir(home);
  if (!existsSync(dir)) return 0;
  let n = 0;
  const keep = 3_600_000;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    try {
      if (now.getTime() - statSync(p).mtimeMs < keep) continue;
      const t = JSON.parse(readFileSync(p, "utf8")) as CapToken;
      if (Date.parse(t.expires_at) + keep < now.getTime()) { unlinkSync(p); n++; }
    } catch { /* 坏文件留着，verify 会报 */ }
  }
  return n;
}

// ── 宿主层：清环境、跑进程、超时杀树 ─────────────────────────

/** 白名单传环境。凭据类一律不继承（这就是"不传"比"删掉"可靠的地方） */
const ENV_KEEP = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP",
  "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMSPEC",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "LANG", "LC_ALL", "TERM", "USERNAME",
];
const ENV_DENY = /(KEY|TOKEN|SECRET|PASSW|CRED|COOKIE|AUTH|SESSION)/i;

export function cleanEnv(src: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_KEEP) {
    const v = src[k];
    if (v !== undefined && !ENV_DENY.test(k)) out[k] = v;
  }
  out.JJ_SHELL_CHILD = "1";
  return out;
}

export function hostProfile(): string {
  return `direct/node${process.versions.node}-${process.platform}-${process.arch}`;
}

// ── 可选沙箱：容器化宿主（04 §6.4）────────────────────────────
//
// 为什么要有它：模板 + 令牌只保证"只跑这几条命令"，不保证"跑坏了关在笼子里"。
// 真正能收窄爆炸半径的是容器（`--network=none --read-only --cap-drop=ALL`）。
//
// 一条硬规矩（04 §4.0）：**降级必须显式**。
// 要了沙箱但 Docker 引擎不在 → 拒跑（E_SANDBOX_UNAVAILABLE），
// **不会** 悄悄改成直跑；只有 `JJ_SHELL_ALLOW_DIRECT=1` 时才能降，且审计里记一笔。

export interface RunPlan {
  kind: "direct" | "docker";
  argv: string[];
  cwd: string;
  /** 写进 exec_audit.host_profile */
  profile: string;
  /** docker 模式下的容器名（超时要用它 rm -f，否则容器会成孤儿） */
  container?: string;
  note?: string;
}

let dockerMemo: boolean | null = null;
/** 引擎在不在（结果进程内缓存：一次 T3 调用不该卡两次 docker version） */
export function dockerAvailable(): boolean {
  if (dockerMemo !== null) return dockerMemo;
  try {
    const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"],
      { stdio: "ignore", windowsHide: true, timeout: 4000 });
    dockerMemo = r.status === 0;
  } catch { dockerMemo = false; }
  return dockerMemo;
}

/** 仅供测试：清掉“引擎在不在”的缓存 */
export function _resetDockerProbe(): void { dockerMemo = null; }

export function planRun(
  r: Rendered,
  o: { env?: Record<string, string | undefined>; dockerOk?: () => boolean } = {},
): RunPlan {
  const env = o.env ?? process.env;
  const mode = (env.JJ_SHELL_SANDBOX ?? "direct").toLowerCase();
  const direct = (note?: string): RunPlan => ({
    kind: "direct", argv: r.argv, cwd: r.cwd,
    profile: note ? `${hostProfile()}(降级)` : hostProfile(),
    ...(note ? { note } : {}),
  });

  if (mode !== "docker" && mode !== "container") return direct();

  const ok = (o.dockerOk ?? dockerAvailable)();
  if (!ok) {
    if (env.JJ_SHELL_ALLOW_DIRECT === "1") return direct("沙箱不可用，按 JJ_SHELL_ALLOW_DIRECT=1 显式降级为直跑");
    throw new Error("E_SANDBOX_UNAVAILABLE: 要了沙箱但 Docker 引擎不可用（启动引擎，或显式设 JJ_SHELL_ALLOW_DIRECT=1 降级）");
  }

  const image = env.JJ_SHELL_IMAGE ?? "node:24-alpine";
  const container = `jj-${r.digest.slice(0, 8)}-${Date.now().toString(36).slice(-4)}`;
  const argv = [
    "docker", "run", "--rm", "--init",
    "--name", container,
    "--network=none",                 // 不出网
    "--read-only",                    // 根文件系统只读
    "--tmpfs", "/tmp",               // 但 /tmp 给个内存盘（node/python 都要用）
    "--cap-drop=ALL",                 // 不给任何 capability
    "--security-opt", "no-new-privileges",
    "-v", `${toPosix(normalize(r.cwd))}:/w`, "-w", "/w",   // 只把 workspace 挂进去，可写
    ...(process.platform === "win32" ? [] : ["--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`]),
    "--entrypoint", r.argv[0]!, image, ...r.argv.slice(1),
  ];
  return { kind: "docker", argv, cwd: r.cwd, profile: `docker:${image}`, container };
}

export interface RunOpts {
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
  env?: Record<string, string>;
  now?: () => number;
  /** 被我们主动杀掉时调用（超时 / 输出爆炸）——docker 模式要在这里 rm -f 容器 */
  onKill?: () => void;
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  truncated: boolean;
  killed: boolean;
}

function killTree(pid: number, force = true): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", [force ? "/F" : "", "/T", "/PID", String(pid)].filter(Boolean), { stdio: "ignore", windowsHide: true });
    return;
  }
  try { process.kill(-pid, force ? "SIGKILL" : "SIGTERM"); }
  catch { try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* 已退出 */ } }
}

export async function runArgv(argv: string[], o: RunOpts): Promise<RunResult> {
  const timeoutMs = o.timeoutMs ?? 300_000;
  const maxBytes = o.maxBytes ?? 32 * 1024;
  if (!argv.length) throw new Error("E_NO_ARGV");
  mkdirSync(o.cwd, { recursive: true });

  const t0 = Date.now();
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: o.cwd,
    env: o.env ?? cleanEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,                       // ← 永不经过 shell
    detached: process.platform !== "win32", // POSIX：自己一个进程组，好连根杀
  });

  let out = "", err = "", outBytes = 0, errBytes = 0, truncated = false, timedOut = false, killed = false;

  const take = (s: string, which: "out" | "err") => {
    const b = Buffer.byteLength(s);
    if (which === "out") {
      if (outBytes < maxBytes) out += s.slice(0, Math.max(0, maxBytes - outBytes));
      outBytes += b;
    } else {
      if (errBytes < maxBytes) err += s.slice(0, Math.max(0, maxBytes - errBytes));
      errBytes += b;
    }
    if (outBytes + errBytes > maxBytes * 8) {
      truncated = true; killed = true; killTree(child.pid ?? 0); o.onKill?.();
    }
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => take(d, "out"));
  child.stderr?.on("data", (d: string) => take(d, "err"));

  const done = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: 127, signal: null }));
  });

  const timer = setTimeout(() => {
    timedOut = true; killed = true;
    killTree(child.pid ?? 0); o.onKill?.();
    // 兜底：2s 后还没退就再补一刀硬杀
    const hard = setTimeout(() => { killTree(child.pid ?? 0); o.onKill?.(); }, 2000);
    (hard as { unref?: () => void }).unref?.();
  }, timeoutMs);

  const { code, signal } = await done;
  clearTimeout(timer);
  if (outBytes > maxBytes || errBytes > maxBytes) truncated = true;

  return {
    code, signal,
    stdout: out, stderr: err,
    ms: Date.now() - t0,
    timedOut, truncated, killed,
  };
}
