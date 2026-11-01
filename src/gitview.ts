/**
 * git 校样（只读）：把"她改了什么"摊开给人看。
 *
 * 为什么不复用 shell 模板 `git.status`：模板的 cwd 被锁在 `home/workspace`
 * （那是**运行目录**，不是代码仓），在那里跑 git 只会得到 "not a git repository"。
 * 所以这里单独做一层，但**仍然走 verbs → execute → policy → audit**，不开第二条路。
 *
 * 三条规矩：
 *   1. **只读**：只跑 status / diff / log，绝不跑 checkout / reset / stash / commit。
 *   2. **参数写死**：模型给不了 argv，只能给"看哪个文件"；文件名过白名单校验。
 *   3. **有界**：输出截断（diff 可能几十万行），并明说截断了。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 单次最多回这么多字符（面板上一屏差不多 4 万，多了也没人看） */
export const MAX_OUT = 200_000;
const TIMEOUT_MS = 15_000;

export interface GitFile {
  /** porcelain 状态码（M/A/D/R/?? …） */
  x: string;
  y: string;
  path: string;
  /** 有两栏（重命名/复制）：原路径 */
  from?: string;
}

export type GitResult<T> = { ok: true; data: T; ms: number } | { ok: false; code: string; why: string };

/**
 * 调一次 git（异步！别用 spawnSync —— 那会堵住事件循环，把面板请求一起卡死，踩过）
 */
async function git(cwd: string, args: string[]): Promise<{ ok: true; out: string } | { ok: false; code: string; why: string }> {
  try {
    const r = await run("git", ["-c", "core.quotepath=false", ...args], {
      cwd, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", windowsHide: true,
    });
    return { ok: true, out: r.stdout ?? "" };
  } catch (e) {
    const err = e as { code?: number | string; stderr?: string; message?: string; killed?: boolean };
    if (err.killed) return { ok: false, code: "E_GIT_TIMEOUT", why: `git ${args[0]} 超过 ${TIMEOUT_MS / 1000} 秒没结束` };
    const stderr = String(err.stderr ?? err.message ?? "").trim();
    if (/not a git repository/i.test(stderr)) {
      return { ok: false, code: "E_NOT_A_REPO", why: `这里不是 git 仓库：${cwd}` };
    }
    if (/git.*not recognized|'git' is not recognized|ENOENT/i.test(stderr) || err.code === "ENOENT") {
      return { ok: false, code: "E_NO_GIT", why: "这台机器上没有 git（装一个再来，或者直接看文件面板）" };
    }
    return { ok: false, code: "E_GIT", why: stderr.slice(0, 300) || `git ${args.join(" ")} 失败` };
  }
}

/** `git status --porcelain=v1`：只解析，不解释 */
export function parsePorcelain(out: string): GitFile[] {
  const files: GitFile[] = [];
  for (const line of out.split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    let rest = line.slice(3);
    // 重命名/复制：`R  old -> new`
    const arrow = rest.indexOf(" -> ");
    let from: string | undefined;
    if ((x === "R" || x === "C" || y === "R" || y === "C") && arrow >= 0) {
      from = rest.slice(0, arrow).trim();
      rest = rest.slice(arrow + 4).trim();
    }
    files.push({ x, y, path: rest.trim(), ...(from ? { from } : {}) });
  }
  return files;
}

export async function gitStatus(cwd: string): Promise<GitResult<{ files: GitFile[]; clean: boolean; branch: string | null }>> {
  const t0 = Date.now();
  const br = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const st = await git(cwd, ["status", "--porcelain=v1"]);
  if (!st.ok) return st;
  const files = parsePorcelain(st.out);
  return {
    ok: true, ms: Date.now() - t0,
    data: { files, clean: files.length === 0, branch: br.ok ? br.out.trim() : null },
  };
}

/**
 * 差异：默认 `--stat`（一眼看改了哪些文件、多少行），
 * 给 path 就给那一个文件的完整 diff。
 */
export async function gitDiff(cwd: string, path?: string): Promise<GitResult<{ text: string; truncated: boolean; stat: boolean }>> {
  const t0 = Date.now();
  const args = ["diff", "--no-color"];
  const stat = !path;
  if (stat) args.push("--stat");
  // 文件名只当"路径"用：不接受选项（- 开头一律拒）、不接受 .. 穿越
  if (path) {
    const p = String(path).trim();
    if (!p || p.startsWith("-") || p.includes("..") || p.includes(String.fromCharCode(0))) {
      return { ok: false, code: "E_BAD_PATH", why: `不是合法文件路径：${p.slice(0, 80)}` };
    }
    args.push("--", p);
  }
  const r = await git(cwd, args);
  if (!r.ok) return r;
  const truncated = r.out.length > MAX_OUT;
  return { ok: true, ms: Date.now() - t0, data: { text: truncated ? r.out.slice(0, MAX_OUT) : r.out, truncated, stat } };
}

export async function gitLog(cwd: string, n = 10): Promise<GitResult<{ text: string }>> {
  const t0 = Date.now();
  const k = Math.min(50, Math.max(1, Math.floor(n)));
  const r = await git(cwd, ["log", `-n`, String(k), "--oneline", "--decorate=short"]);
  if (!r.ok) return r;
  return { ok: true, ms: Date.now() - t0, data: { text: r.out.slice(0, MAX_OUT) } };
}
