/**
 * 宿主层（host）的**解释器选择**（2026-11-01 用户要求）：
 *
 * > 「把用户电脑里的 powershell 作为项目的默认工具，git bash 作为扩展让用户自己配」
 *
 * 一条硬约束先说清楚：**powershell 在 FULL_DENY 里**，`-Command` / `-EncodedCommand` 永远拒。
 * 那不是遗漏 —— 一条 `-Command` 就能把整套闸门（白名单、路径、审计粒度）绕干净。
 *
 * 所以这里的做法是：**解释器只用于跑「home 里的脚本文件」**（`.ps1` / `.sh` / `.mjs` / `.py`），
 * 文件本身可读、可审计、可 diff。任意命令仍然走 argv 直传（`shell.exec`），不经 shell 包装。
 *
 * 三种宿主：
 *   powershell  Windows PowerShell 5.1（系统自带，默认）
 *   pwsh        PowerShell 7（装了才用，用户可选）
 *   gitbash     Git for Windows 的 bash.exe（**需要用户自己给路径**，因为安装位置五花八门）
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFileConfig } from "./configfile.ts";

export type ShellKind = "powershell" | "pwsh" | "gitbash" | "bash" | "none";

export interface ShellInfo {
  kind: ShellKind;
  /** 可执行文件的绝对路径（找不到就是空串） */
  path: string;
  /** 给人看的名字，进 host_profile：`win-local/ps5.1` / `win-local/pwsh7` / `win-local/gitbash` */
  label: string;
  /** 跑脚本时用的 argv 前缀（不含脚本路径） */
  argv: string[];
}

const WIN = process.platform === "win32";

/** 常见安装位置（探测用；找不到就让用户自己填） */
const GITBASH_CANDIDATES = [
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files/Git/usr/bin/bash.exe",
  "C:/Program Files (x86)/Git/bin/bash.exe",
];

function firstExisting(paths: string[]): string {
  return paths.find((p) => existsSync(p)) ?? "";
}

/** PowerShell 5.1：系统自带，路径固定 */
function ps5(): ShellInfo {
  const p = firstExisting([
    join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
  ]);
  return {
    kind: p ? "powershell" : "none", path: p, label: "ps5.1",
    // -ExecutionPolicy Bypass 只对**这一次**生效；跑的是文件，且文件必须在 workspace/ 下
    argv: p ? [p, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"] : [],
  };
}

/** PowerShell 7（pwsh）：装了才有 */
function pwsh7(): ShellInfo {
  const p = firstExisting([
    join(process.env.ProgramFiles ?? "C:/Program Files", "PowerShell/7/pwsh.exe"),
    join(process.env.ProgramFiles ?? "C:/Program Files", "PowerShell/7-preview/pwsh.exe"),
  ]);
  return {
    kind: p ? "pwsh" : "none", path: p, label: "pwsh7",
    argv: p ? [p, "-NoProfile", "-NonInteractive", "-File"] : [],
  };
}

/** Git Bash：优先用配置里的路径，其次常见位置 */
function gitbash(configured?: string): ShellInfo {
  const p = (configured && existsSync(configured) ? configured : "") || firstExisting(GITBASH_CANDIDATES);
  return {
    kind: p ? "gitbash" : "none", path: p, label: "gitbash",
    // --noprofile --norc：不读用户的 bashrc（可复现）；跑文件，不是 -c 字符串
    argv: p ? [p, "--noprofile", "--norc"] : [],
  };
}

function posixBash(): ShellInfo {
  const p = firstExisting(["/bin/bash", "/usr/bin/bash"]);
  return {
    kind: p ? "bash" : "none", path: p, label: "bash",
    argv: p ? [p, "--noprofile", "--norc"] : [],
  };
}

/** 探测这台机器上有哪些（给面板列选项用） */
export function detectShells(opts: { gitbashPath?: string } = {}): Record<ShellKind, ShellInfo> {
  return {
    powershell: ps5(),
    pwsh: pwsh7(),
    gitbash: gitbash(opts.gitbashPath),
    bash: posixBash(),
    none: { kind: "none", path: "", label: "direct", argv: [] },
  };
}

/**
 * 当前该用哪个解释器。
 *
 * `config.host.shell`：
 *   "auto"（默认）→ Windows 上用 PowerShell 5.1（系统自带、最稳）；没有就 pwsh → gitbash → direct
 *   "powershell" / "pwsh" / "gitbash" / "bash" → 用它；找不到就**退回 auto 并报告**（不静默变成 direct）
 */
export function resolveShell(
  home: string, opts: { env?: Record<string, string | undefined> } = {},
): { shell: ShellInfo; wanted: string; fellBack: boolean; reason?: string } {
  const cfg = readFileConfig(home).host?.shell ?? "auto";
  const found = detectShells({ gitbashPath: readFileConfig(home).host?.gitbashPath });
  const direct: ShellInfo = { kind: "none", path: "", label: "direct", argv: [] };
  const pick = (k: ShellKind): ShellInfo | null => (found[k].kind === "none" ? null : found[k]);

  if (cfg !== "auto") {
    const want = found[cfg as ShellKind];
    if (want && want.kind !== "none") return { shell: want, wanted: cfg, fellBack: false };
    // 用户点名要一个没装/没配的解释器 → 退回自动，并说清为什么
    const auto = autoPick();
    return { shell: auto, wanted: cfg, fellBack: true, reason: `${cfg} 没找到（Git Bash 要在设置里填 bash.exe 的路径）` };
  }
  return { shell: autoPick(), wanted: "auto", fellBack: false };

  function autoPick(): ShellInfo {
    if (!WIN) return pick("bash") ?? direct;
    return pick("powershell") ?? pick("pwsh") ?? pick("gitbash") ?? direct;
  }
}

/** 跑脚本的 argv：解释器前缀 + 脚本路径 + 额外参数 */
export function scriptArgv(shell: ShellInfo, scriptPath: string, args: string[] = []): string[] {
  if (shell.kind === "none") {
    // 没有解释器就只能直接执行脚本（需要 shebang / 可执行位）
    return [scriptPath, ...args];
  }
  return [...shell.argv, scriptPath, ...args];
}

/** host_profile 字符串（写进 exec_audit）：`win-local/ps5.1` / `linux-local/bash` */
export function profileOf(shell: ShellInfo): string {
  const os = WIN ? "win-local" : "linux-local";
  return os + "/" + (shell.kind === "none" ? "direct" : shell.label);
}

/**
 * PowerShell 的输出编码修补（2026-11-01）。
 *
 * 问题：Windows PowerShell 5.1 默认把输出按**系统 OEM 代码页**（中文机器是 GBK）写出来，
 * 而我们按 UTF-8 解码 → 中文全是乱码（实测 `Get-ChildItem` 输出的「目录:」变成 `Ŀ¼:`）。
 *
 * 做法：**只在 `-Command` 前面插一句**把 `[Console]::OutputEncoding` 与 `$OutputEncoding` 设成 UTF-8。
 * 两个边界：
 *   · `-File` 模式**不动**（那是跑脚本文件，脚本自己决定输出；改 argv 会破坏它的参数语义）
 *   · 包装后的 argv 是**实际要跑的**，审计里记的也是它（`exec_audit.argv_json` 不许撒谎）
 */
export function withUtf8Output(argv: string[]): { argv: string[]; wrapped: boolean } {
  if (argv.length < 2) return { argv, wrapped: false };
  const bin = String(argv[0] ?? "").split(/[\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
  if (bin !== "powershell" && bin !== "pwsh") return { argv, wrapped: false };
  const i = argv.findIndex((a) => /^-command$/i.test(a));
  if (i < 0 || i + 1 >= argv.length) return { argv, wrapped: false };
  const prelude = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;";
  const next = [...argv];
  next[i + 1] = prelude + " " + String(argv[i + 1] ?? "");
  return { argv: next, wrapped: true };
}
