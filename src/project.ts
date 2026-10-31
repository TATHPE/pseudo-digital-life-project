/**
 * 项目读取（K-1）
 *
 * 为什么单独一条通道：`fs.*` 的根是 `data/`（`safePath(home, …)`），
 * 所以鲸鲸读不到 `src/`、`docs/` —— 它连自己是怎么写的都看不见。
 *
 * 三条纪律：
 *  1. **只读**。这里没有任何写函数；写入仍走 `fs.write`（限 `workspace/`）。
 *  2. **白名单根**：只有下面几个目录可读，别的一律 `E_OUT_OF_PROJECT`。
 *     根之外的路径**不靠字符串比较**，靠 `realpathish()` 解析后再比对（防目录联接逃逸）。
 *  3. **硬拒绝清单**：`data/`（含 secrets/tokens/pending）、`.git/`、`node_modules/`
 *     以及任何 `*.secret` / `.env*`。它们不是"项目源码"，是运行期私密状态。
 *
 * 出网：代码和记忆是两种隐私。读到的内容如果正被云端表达模型使用，
 * 默认**拒绝**（`E_NEEDS_EGRESS`），要显式 `JJ_PROJECT_EGRESS=1`。
 * 这是 H-7（按次授权）的临时形态，等 K-3 的 grant 上线后换成按次。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { realpathish } from "./verbs.ts";

/** 可读的根（相对项目根）。第二条是文档仓（`D:/LLM/docs`），因为它不在 jingjing/ 里 */
export const PROJECT_ROOTS = ["jingjing", "docs"] as const;

/** 路径里出现这些片段就拒（相对项目根的小写比较） */
const DENY_SEGMENTS = ["data", "node_modules", ".git", ".venv", "secrets", "tokens", "pending", "exports"];
const DENY_SUFFIX = [".secret", ".db", ".db-wal", ".db-shm", ".pem", ".key"];
const DENY_PREFIX = [".env"];

const MAX_BYTES = 64 * 1024;

export interface ProjectFile { path: string; text: string; bytes: number; truncated: boolean }

/** 项目的两个根：`D:/LLM`（含 docs/ 与 jingjing/）。可用 JJ_PROJECT_HOME 覆盖。 */
export function projectHome(env: Record<string, string | undefined> = process.env): string {
  return normalize(env.JJ_PROJECT_HOME ?? "D:/LLM");
}

function roots(env?: Record<string, string | undefined>): string[] {
  const h = projectHome(env);
  return PROJECT_ROOTS.map((r) => join(h, r)).filter((p) => existsSync(p));
}

/** 相对项目根的写法（`jingjing/src/recall.ts` / `docs/22-….md`），也接受只写 `src/…` */
export function resolveProjectPath(p: string, env?: Record<string, string | undefined>): string {
  const raw = String(p ?? "").trim();
  if (!raw) throw new Error("E_NO_PATH");
  if (isAbsolute(raw)) throw new Error("E_ABSOLUTE_PATH: 用相对项目根的路径（如 jingjing/src/recall.ts）");

  const h = projectHome(env);
  const tries = [
    normalize(join(h, raw)),                       // 含根名：jingjing/src/x.ts
    ...roots(env).map((r) => normalize(join(r, raw))), // 省根名：src/x.ts → 试 jingjing/ 与 docs/
  ];

  // 先判拒绝清单：私密路径**无论存不存在**都报 E_PATH_DENIED，
  // 否则 .env 这类文件会伪装成“路径不在项目里”，排障时会想错方向
  for (const t of tries) {
    if (withinRoots(t, env)) denyCheck(t, h);
  }

  const hit = tries.filter((c) => existsSync(c)).find((c) => withinRoots(c, env));
  if (!hit) throw new Error(`E_OUT_OF_PROJECT: ${raw}（只能读 ${PROJECT_ROOTS.join(" / ")} 下的文件）`);
  denyCheck(hit, h);
  return hit;
}

function withinRoots(abs: string, env?: Record<string, string | undefined>): boolean {
  const real = realpathish(abs);
  return roots(env).some((r) => {
    const rel = relative(realpathish(r), real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function denyCheck(abs: string, home: string): void {
  const rel = relative(realpathish(home), realpathish(abs)).split("\\").join("/").toLowerCase();
  const segs = rel.split("/").filter(Boolean);
  // 按**段**匹配：目录本身（rel=".git"）与它下面（rel=".git/config"）都要拦下来，
  // 所以不能用带尾斜杠的字符串包含（踩过：.git/ 与 .venv/ 会以"目录名"的形式露出来）
  if (segs.some((x) => DENY_SEGMENTS.includes(x))) throw new Error(`E_PATH_DENIED: ${rel}（运行期私密状态）`);
  if (DENY_SUFFIX.some((x) => rel.endsWith(x))) throw new Error(`E_PATH_DENIED: ${rel}`);
  const base = segs.pop() ?? "";
  if (DENY_PREFIX.some((x) => base.startsWith(x))) throw new Error(`E_PATH_DENIED: ${rel}`);
}

export interface ReadOpts {
  /** 只读第 a 到 b 行（1 基，含两端）；默认读全文（上限 64 KB） */
  from?: number;
  to?: number;
  env?: Record<string, string | undefined>;
}

export function readProjectFile(p: string, o: ReadOpts = {}): ProjectFile {
  const abs = resolveProjectPath(p, o.env);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`E_NOT_FILE: ${p}`);
  if (st.size > 8 * 1024 * 1024) throw new Error(`E_TOO_BIG: ${st.size} 字节（项目文件上限 8 MB）`);

  const full = readFileSync(abs, "utf8");
  let text = full;
  let truncated = false;
  if (o.from || o.to) {
    const lines = full.split(String.fromCharCode(10));
    const a = Math.max(1, Number(o.from ?? 1));
    const b = Math.min(lines.length, Number(o.to ?? a + 400));
    text = lines.slice(a - 1, b).join(String.fromCharCode(10));
  } else if (Buffer.byteLength(full, "utf8") > MAX_BYTES) {
    text = full.slice(0, MAX_BYTES);
    truncated = true;
  }
  return { path: relative(projectHome(o.env), abs).split("\\").join("/"), text, bytes: st.size, truncated };
}

export interface Entry { path: string; type: "file" | "dir"; bytes?: number }

export function listProject(dir = "", env?: Record<string, string | undefined>): Entry[] {
  const base = dir ? resolveProjectPath(dir, env) : projectHome(env);
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error(`E_NOT_DIR: ${dir}`);
  const out: Entry[] = [];
  for (const name of readdirSync(base).sort()) {
    const abs = join(base, name);
    try {
      const st = statSync(abs);
      const rel = relative(projectHome(env), abs).split("\\").join("/");
      // 目录列表也要过 deny：不然 data/ 会以"目录名"的形式露出来
      try { denyCheck(abs, projectHome(env)); } catch { continue; }   // .git/ .venv/ data/ 不出现在列表里
      out.push(st.isDirectory() ? { path: rel, type: "dir" } : { path: rel, type: "file", bytes: st.size });
    } catch { /* 跳过读不到的项 */ }
    if (out.length >= 200) break;
  }
  return out;
}

export interface Match { path: string; line: number; text: string }

/**
 * 把用户给的模式变成正则：**语法不合法就当字面量**（像 grep -F）。
 * 搜代码时 `foo(` 这种写法太常见，报错只会逼调用方自己去转义。
 */
function toSearchRegExp(pattern: string): RegExp {
  try { return new RegExp(pattern); }
  catch { return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
}

/** 在项目里按正则搜（逐文件读，单文件 512 KB 上限；结果默认 40 条） */
export function searchProject(pattern: string, o: { glob?: string; limit?: number; env?: Record<string, string | undefined> } = {}): Match[] {
  // 语法不合法就**当字面量**搜（像 grep -F）：搜代码时 `foo(` 这种写法太常见，
  // 报 E_BAD_REGEX 只会逼调用方自己去转义
  const re = toSearchRegExp(pattern);
  const limit = Math.max(1, Math.min(200, o.limit ?? 40));
  const globRe = o.glob ? new RegExp(o.glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").split("*").join(".*") + "$") : null;
  const out: Match[] = [];

  const walk = (dir: string): void => {
    if (out.length >= limit) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (out.length >= limit) return;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        const rel = relative(projectHome(o.env), abs).split("\\").join("/");
        if (DENY_SEGMENTS.some((s) => (rel + "/").includes(s))) continue;
        walk(abs);
        continue;
      }
      if (st.size > 512 * 1024) continue;
      try { denyCheck(abs, projectHome(o.env)); } catch { continue; }
      const rel = relative(projectHome(o.env), abs).split("\\").join("/");
      if (globRe && !globRe.test(rel)) continue;
      let text: string;
      try { text = readFileSync(abs, "utf8"); } catch { continue; }
      if (text.includes(String.fromCharCode(0))) continue;   // 二进制跳过
      const lines = text.split(String.fromCharCode(10));
      for (let i = 0; i < lines.length && out.length < limit; i++) {
        if (re.test(lines[i]!)) out.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, 200) });
      }
    }
  };

  for (const r of roots(o.env)) walk(r);
  return out;
}
