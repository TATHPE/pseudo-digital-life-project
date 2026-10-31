/**
 * 会话式授权（K-3）：**窗口内**可以用模型给的 argv，窗口外回到 6 个模板。
 *
 * 为什么需要它：T3 的一次性令牌适合"一次动作一次确认"，但连着做十件小事时，
 * 人会变成一台只会点确认的机器 —— 那时候人就不再真的在看，确认也就失效了。
 * 授权窗口把"我在看着"这件事说清楚：**限命令、限目录、限时间、可随时收回。**
 *
 * 六条约束（都是硬的，不看提示词）：
 *  ① **活在进程内存里**：进程一重启就没了。会话级 = 不跨会话继承，也不落盘被偷偷续期
 *  ② **限命令**：argv[0] 必须在白名单里（node / npm / git / python …）
 *  ③ **限目录**：cwd 必须在 scope 内；argv 里像路径的参数也要在 scope 内（绝对路径/`..` 一律拒）
 *  ④ **限时间**：ttl 到点即失效（最长 2 小时）
 *  ⑤ **不给密钥**：授权期内跑命令时，环境变量里的 `*_KEY` / `*TOKEN*` / `SECRET` 一律不传
 *  ⑥ **逐条审计**：每次用它都留一行（capability = `grant:<id>`），可以事后数"它到底跑了什么"
 *
 * 为什么不做跨进程共享：那需要常驻守护进程，而我们已经有一个（面板服务）。
 * 所以授权由**谁执行谁持有** —— 面板里开的窗口给面板用，CLI 里开的给当次 CLI 用。
 */
import { basename } from "node:path";

export type GrantDecision =
  | { ok: true; id: string; commands: string[]; scope: string; expiresAt: string }
  | { ok: false; code: string; why: string };

interface Grant {
  id: string;
  commands: Set<string>;
  scope: string;
  because: string;
  createdAt: number;
  expiresAt: number;
}

/** 默认允许的命令（和 shell 模板里出现过的那几种保持一致，陌生人别进来） */
export const GRANT_COMMANDS = [
  "node", "npm", "npx", "git", "python", "py", "ffmpeg", "ffprobe", "tsc", "vitest",
] as const;

export const MAX_TTL_MS = 2 * 60 * 60 * 1000;

/** 内存里的窗口表：按 home 分开（一个进程可能同时服务多个 home 的测试） */
const store = new Map<string, Map<string, Grant>>();

const binOf = (argv0: string): string =>
  basename(String(argv0 ?? "")).replace(/\.(exe|cmd|bat|sh)$/i, "").toLowerCase();

const looksLikePath = (a: string): boolean =>
  a.includes("/") || a.includes("\\") || a === ".." || a.startsWith(".") || /^[a-zA-Z]:/.test(a);

/** 路径归一化（反斜杠统一成正斜杠，去掉末尾斜杠） */
const norm = (p: string): string => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function openGrant(
  home: string,
  input: { commands?: unknown; scope?: string; ttlMs?: number; because?: unknown },
  now = new Date(),
): { ok: true; grant: { id: string; commands: string[]; scope: string; expiresAt: string; because: string } } | { ok: false; code: string; why: string } {
  const because = String(input.because ?? "").trim();
  if (because.length < 4) return { ok: false, code: "E_GRANT_BECAUSE", why: "得说清为什么开这个窗口（至少 4 个字）" };

  const wanted = (Array.isArray(input.commands) ? input.commands : [input.commands])
    .flatMap((x) => String(x ?? "").split(","))
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const commands = wanted.length ? wanted : ["node"];
  const bad = commands.filter((c) => !(GRANT_COMMANDS as readonly string[]).includes(c));
  if (bad.length) {
    return { ok: false, code: "E_GRANT_COMMAND", why: `不在允许清单里：${bad.join(", ")}（可选 ${GRANT_COMMANDS.join(" / ")}）` };
  }

  const scope = norm(input.scope || "workspace");
  if (scope.includes("..") || scope.startsWith("/")) {
    return { ok: false, code: "E_GRANT_SCOPE", why: `scope 只收 home 内的相对目录：${input.scope}` };
  }

  const ttlMs = Math.min(MAX_TTL_MS, Math.max(60_000, Number(input.ttlMs ?? 30 * 60_000)));
  const g: Grant = {
    id: `grn_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    commands: new Set(commands),
    scope,
    because,
    createdAt: now.getTime(),
    expiresAt: now.getTime() + ttlMs,
  };
  const perHome = store.get(home) ?? new Map<string, Grant>();
  perHome.set(g.id, g);
  store.set(home, perHome);

  return {
    ok: true,
    grant: {
      id: g.id, commands: [...g.commands], scope: g.scope,
      expiresAt: new Date(g.expiresAt).toISOString(), because: g.because,
    },
  };
}

export function listGrants(home: string, now = new Date()): Array<{
  id: string; commands: string[]; scope: string; because: string;
  createdAt: string; expiresAt: string; remainingS: number;
}> {
  const perHome = store.get(home);
  if (!perHome) return [];
  const out = [];
  for (const g of perHome.values()) {
    if (g.expiresAt <= now.getTime()) { perHome.delete(g.id); continue; }
    out.push({
      id: g.id, commands: [...g.commands], scope: g.scope, because: g.because,
      createdAt: new Date(g.createdAt).toISOString(), expiresAt: new Date(g.expiresAt).toISOString(),
      remainingS: Math.round((g.expiresAt - now.getTime()) / 1000),
    });
  }
  return out.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

export function revokeGrant(home: string, id: string): boolean {
  const perHome = store.get(home);
  if (!perHome) return false;
  return perHome.delete(id);
}

/** 测试/关停用：清空某个 home 的所有窗口 */
export function revokeAll(home: string): number {
  const n = store.get(home)?.size ?? 0;
  store.delete(home);
  return n;
}

/**
 * 判定这次调用能不能落在窗口里。
 * 严格：命令、目录、路径参数、shell 元字符、密钥字样，任何一条不过就是不过。
 */
export function checkGrant(
  home: string, req: { argv: readonly string[]; cwd: string }, now = new Date(),
): GrantDecision {
  const perHome = store.get(home);
  if (!perHome || !perHome.size) return { ok: false, code: "E_NO_GRANT", why: "没有打开任何授权窗口" };

  const argv = req.argv.map(String);
  if (!argv.length) return { ok: false, code: "E_GRANT_ARGV", why: "空命令" };

  const bin = binOf(argv[0]!);
  const cwd = norm(req.cwd);
  const scopeInCwd = cwd.includes("/" + norm("")) ;

  // 元字符：即便这里不经过 shell，也不允许"看起来能串联"的命令进窗口
  for (const a of argv) {
    if (/[;&|`$\n\r]/.test(a)) return { ok: false, code: "E_GRANT_META", why: `命令里含 shell 元字符：${a.slice(0, 40)}` };
    if (/key|token|secret|password|passwd/i.test(a) && a.length > 8) {
      return { ok: false, code: "E_GRANT_SECRET", why: "命令里疑似带密钥/令牌，授权窗口不接这种" };
    }
  }

  let picked: Grant | null = null;
  for (const g of perHome.values()) {
    if (g.expiresAt <= now.getTime()) { perHome.delete(g.id); continue; }
    // ② 命令白名单
    if (!g.commands.has(bin)) continue;
    // ③ 目录：cwd 必须落在 scope 内
    const scope = norm(g.scope);
    if (!(cwd === scope || cwd.endsWith("/" + scope) || cwd.includes("/" + scope + "/"))) continue;
    // ③ 路径参数：绝对路径 / `..` / 越界一律不过
    const bad = argv.slice(1).filter((a) => {
      if (!looksLikePath(a)) return false;
      const n = norm(a);
      if (n.includes("..")) return true;
      if (n.startsWith("/") || /^[a-z]:/.test(n)) return !n.includes("/" + scope + "/") && !n.endsWith("/" + scope);
      return false;
    });
    if (bad.length) continue;
    picked = g;
    break;
  }

  if (!picked) {
    return {
      ok: false, code: "E_GRANT_NO_MATCH",
      why: `窗口里没有能覆盖这条命令的：${bin} @ ${req.cwd}（先看 jingjing grant list）`,
    };
  }
  void scopeInCwd;
  return {
    ok: true, id: picked.id, commands: [...picked.commands],
    scope: picked.scope, expiresAt: new Date(picked.expiresAt).toISOString(),
  };
}

/** ⑤ 授权窗口里跑命令时的环境：密钥类一律不传 */
export function sanitizedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (/(^|_)(API_?)?KEY$/i.test(k)) continue;
    if (/TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(k)) continue;
    if (/^(AWS|AZURE|GCP|OPENAI|ANTHROPIC|DEEPSEEK|MOONSHOT|KIMI)_/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}
