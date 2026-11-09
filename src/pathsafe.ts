/**
 * 路径安全与项目根（叶子模块，2026-11-09 从 verbs.ts / project.ts 抽出）。
 *
 * 为什么单独一层：`verbs.ts` 是能力表，却同时提供 realpathish / safePath 这两个
 * 最底层的路径原语；project.ts / coreguard.ts / shell.ts 反过来 import verbs.ts，
 * 于是形成 verbs ↔ project ↔ coreguard ↔ shell 的循环依赖，能力表本该在最底层
 * 却成了环的一部分。把这些纯函数放到不依赖任何业务模块的叶子文件即可断环。
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根：允许 JJ_PROJECT_HOME 覆盖，默认取本文件的上一级（src/..） */
export function projectHome(env: Record<string, string | undefined> = process.env): string {
  if (env.JJ_PROJECT_HOME) return normalize(env.JJ_PROJECT_HOME);
  return normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
}

/**
 * 解析真实路径：对最深的**已存在**祖先做 realpath，再把剩余部分接回去。
 * 为什么要这么做：`normalize()` 只做字符串层面的 `..` 折叠，
 * 而目录联接（junction）/ 符号链接会把路径**指到 home 之外**——
 * 只看字符串是拦不住的（红队第 4 条实测咬到过）。
 */
export function realpathish(p: string): string {
  let cur = normalize(p);
  const rest: string[] = [];
  for (;;) {
    if (existsSync(cur)) {
      const base = realpathSync.native ? realpathSync.native(cur) : realpathSync(cur);
      return rest.length ? join(base, ...rest.reverse()) : base;
    }
    const parent = dirname(cur);
    if (parent === cur) return normalize(p);
    rest.push(basename(cur));
    cur = parent;
  }
}

/**
 * 文件不存在时，**在错误里就把下一步给出来**（2026-11-02）。
 *
 * 起因是她自己的复盘：「我看到 git status 里有 research/dsh-550c-boot/，就直接把它当成 home
 * 下的路径去猜，碰了 E_NOT_FOUND 才回来列目录……我先猜后查，浪费了一次调用。」
 *
 * 一次浪费不是靠"下次小心"解决的 —— 把最近的**已存在祖先目录**和它的同级项直接写进错误里，
 * 她一次就能改对，不用再花一轮 ls。仍然只列 home 内的东西（safePath 已经保证 real 在 home 内）。
 */
function nearbyHint(homeReal: string, target: string): string {
  const parts: string[] = [];
  // 找一个真实存在的祖先（最多往上 12 层，防止深路径拖慢）
  let dir = dirname(target);
  for (let i = 0; i < 12; i++) {
    if (existsSync(dir)) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  try {
    const names = readdirSync(dir, { withFileTypes: true })
      .slice(0, 40)
      .map((d) => (d.isDirectory() ? d.name + "/" : d.name));
    const want = basename(target).toLowerCase();
    // 最接近的：完整包含 basename，或 basename 包含它（长一点的优先）
    const near = names
      .filter((n) => {
        const x = n.replace("/", "").toLowerCase();
        return x.includes(want) || (want.length > 2 && want.includes(x));
      })
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    if (near.length) parts.push("最接近: " + near.join(" "));
    if (names.length) parts.push("同级: " + names.slice(0, 12).join(" ") + (names.length > 12 ? " …" : ""));
    parts.push("目录: " + relative(homeReal, dir).split(String.fromCharCode(92)).join("/").replace(/^$/, "."));
    // 最对症的一句：她分不清"相对谁"。这个路径在**项目根**下 → 直接告诉她改走哪个 verb。
    try {
      const rel = relative(homeReal, target).split(String.fromCharCode(92)).join("/");
      for (const root of [projectHome(), process.cwd()]) {
        if (!root) continue;
        const alt = join(root, rel);
        if (existsSync(alt)) {
          parts.push("这条路径在项目根下（" + root + "）→ 用 project.read 读，不要用 file.read");
          break;
        }
      }
    } catch { /* 拿不到项目根就算了 */ }
  } catch { /* 列不出来就只报路径 */ }
  return parts.length ? String.fromCharCode(10) + parts.join(String.fromCharCode(10)) : "";
}

/** 路径必须在 home 之内，且**解析真实路径后**仍在（防符号链接/目录联接逃逸） */
export function safePath(home: string, p: string, mustExist = true): string {
  const homeReal = realpathish(home);
  const abs = normalize(isAbsolute(p) ? p : join(home, p));
  const real = realpathish(abs);
  const rel = relative(homeReal, real);
  // rel === "" 就是 home 本身。以前连它一起拒 → `fs.list .` 连家目录都列不了；
  // 现在 home 内全域可动，列根目录是正常需求（记忆核心由 coreguard 单独挡）。
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`E_PATH_DENIED: ${p}`);
  if (mustExist && !existsSync(real)) throw new Error(`E_NOT_FOUND: ${p}${nearbyHint(homeReal, real)}`);
  return real;
}
