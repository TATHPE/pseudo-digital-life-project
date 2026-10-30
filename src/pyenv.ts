/**
 * 找 MarkItDown 用的 Python（H-1）
 *
 * 以前 `ingest.ts` 里写死了 `D:/LLM/.venv/Scripts/python.exe` —— 别人 clone 之后
 * **摄入 PDF 必挂**，而且报错信息还在告诉人家"markitdown 在 D:/LLM/.venv 里"。
 *
 * 现在的顺序（第一个能 import markitdown 的胜出）：
 *   1. `JJ_PYTHON`（显式指定，可以是路径也可以是命令名）
 *   2. 项目自己的 `.venv`（仓库根 / 数据目录旁边，两种平台路径都查）
 *   3. `py -3`（Windows 启动器）→ `python3` → `python`
 *
 * 探测失败**不是错误**：`.md / .txt` 根本不需要 Python，只有 PDF/docx 这类才需要。
 * 所以这里返回 null，由调用方给出可操作的提示（而不是抛一个"找不到 D:/LLM/.venv"）。
 */
import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";

export interface PyCmd { cmd: string; args: string[]; source: string }

export interface ProbeEnv {
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
  /** 实际试跑：能不能 import markitdown */
  canImport: (cmd: string, args: string[]) => boolean;
  /** 项目根（找 .venv 用） */
  roots: string[];
}

function defaultCanImport(cmd: string, args: string[]): boolean {
  try {
    const r = spawnSync(cmd, [...args, "-c", "import markitdown"], {
      encoding: "utf8", timeout: 15_000, windowsHide: true,
    });
    return r.status === 0;
  } catch { return false; }
}

export function resolvePython(o: Partial<ProbeEnv> = {}): PyCmd | null {
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const canImport = o.canImport ?? defaultCanImport;
  const roots = o.roots ?? [process.cwd(), join(process.cwd(), "..")];

  // 1) 显式指定
  const explicit = env.JJ_PYTHON?.trim();
  if (explicit) {
    if (isAbsolute(explicit) || explicit.includes("/") || explicit.includes("\\")) {
      if (exists(explicit) && canImport(explicit, [])) return { cmd: explicit, args: [], source: "JJ_PYTHON" };
      // 指定了但不可用：直接返回 null，让调用方报“你指的那个用不了”，别偷偷换别的解释器
      return null;
    }
    if (canImport(explicit, [])) return { cmd: explicit, args: [], source: "JJ_PYTHON" };
    return null;
  }

  // 2) 项目 venv（两种平台的目录结构都查）
  const venvCands = roots.flatMap((r) => [
    join(r, ".venv", "Scripts", "python.exe"),
    join(r, ".venv", "bin", "python"),
  ]);
  for (const p of venvCands) if (exists(p) && canImport(p, [])) return { cmd: p, args: [], source: "venv" };

  // 3) PATH 上的解释器（Windows 上 `py -3` 最稳）
  const launchers: Array<{ cmd: string; args: string[] }> = process.platform === "win32"
    ? [{ cmd: "py", args: ["-3"] }, { cmd: "python", args: [] }, { cmd: "python3", args: [] }]
    : [{ cmd: "python3", args: [] }, { cmd: "python", args: [] }];
  for (const l of launchers) if (canImport(l.cmd, l.args)) return { ...l, source: "path" };
  return null;
}

/** 给人看的补救办法（错误信息里要能照做，而不是"去找 python"） */
export function pythonHint(): string {
  return [
    "这个格式需要 Python + markitdown（.md / .txt 不需要）：",
    "  · 任选：pip install markitdown",
    "  · 或用项目 venv：python -m venv .venv && .venv/bin/pip install markitdown（Windows: .venv\\Scripts\\pip）",
    "  · 或指定解释器：JJ_PYTHON=/path/to/python",
  ].join(String.fromCharCode(10));
}
