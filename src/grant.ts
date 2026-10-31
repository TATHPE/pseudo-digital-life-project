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
import { basename, resolve } from "node:path";

export type GrantDecision =
  | { ok: true; id: string; commands: string[]; scope: string; expiresAt: string | null; full?: boolean }
  | { ok: false; code: string; why: string };

interface Grant {
  id: string;
  commands: Set<string>;
  scope: string;
  because: string;
  createdAt: number;
  expiresAt: number;
  /** 完全权限：任意命令（除硬禁名单）、home 全域、可用 shell.exec 跑任意 argv */
  full: boolean;
  /** 这一档是哪来的（ask 不会产生 grant） */
  preset: Preset;
}

/** 默认允许的命令（和 shell 模板里出现过的那几种保持一致，陌生人别进来） */
/**
 * 权限预设（形状照 DeepSeek Harness 的 permission presets）：
 *   ask   逐次确认（我们的默认）
 *   read  仅可查看：任何 T3 都拒
 *   write 工作区内修改：注册过的模板 + workspace 内
 *   full  完全权限：任意命令（除硬禁）+ 整个 home
 * 当前会话用 composer 旁的选择器切；设置里那行只管「以后新建会话的默认值」。
 */
export type Preset = "ask" | "read" | "write" | "full";
export const PRESETS: Array<{ id: Preset; label: string; hint: string }> = [
  { id: "ask", label: "逐次确认", hint: "每次动作都要你看一眼（最安全，也最啰嗦）" },
  { id: "read", label: "仅可查看", hint: "只读；任何要动手的命令都拒绝" },
  { id: "write", label: "工作区内修改", hint: "注册过的模板，只在 workspace 内" },
  { id: "full", label: "完全权限", hint: "任意命令 + 整个 home；删/磁盘/系统/下载器/壳永久拒绝" },
];
export const GRANT_COMMANDS = [
  "node", "npm", "npx", "git", "python", "py", "ffmpeg", "ffprobe", "tsc", "vitest",
] as const;

/**
 * 会话级窗口**不设到期时间**：它活在进程内存里，进程一退就没了 ——
 * 再叠一层 15/30 分钟只是让人多点几次，并没有多一层真正的保护。
 * （用户原话：切权限太麻烦还有时间限制，取消掉。）
 */
export const SESSION_ONLY = Number.POSITIVE_INFINITY;
const never = (t: number): boolean => !Number.isFinite(t);

export const MAX_TTL_MS = 2 * 60 * 60 * 1000;
/**
 * 完全权限窗口：**也是会话级**（见 SESSION_ONLY）。
 * 之前限制 15 分钟，用户实测反馈是「多点几次，没多一层保护」—— 真正的边界是硬禁名单 + 密钥不传 + 审计。
 */
export const FULL_MAX_TTL_MS = 15 * 60 * 1000;

/**
 * 完全权限里**依然不放开**的东西（结构性排除，不是可配置项）：
 *  · 删除/磁盘/系统配置类：跑坏了自己也救不回来
 *  · 下载器：把「它想跑什么」变成「网上让它跑什么」
 *  · 解释器/壳：一条 -e / -Command 就能绕过整套闸门，等于全权变无限全权
 */
export const FULL_DENY = new Set([
  "rm", "del", "erase", "rmdir", "rd", "format", "diskpart", "mkfs", "dd",
  "reg", "regedit", "sc", "net", "netsh", "schtasks", "shutdown", "reboot", "logoff",
  "taskkill", "bcdedit", "takeown", "icacls", "cacls", "attrib",
  "curl", "wget", "certutil", "bitsadmin",
  "powershell", "pwsh", "cmd", "bash", "sh", "zsh", "wsl",
]);
/** 内联求值：node -e / python -c / sh -c …。命令必须落在**能读的文件**上。 */
export const INLINE_EVAL = /^(-e|--eval|-c|-p|--print|-Command|-EncodedCommand)$/i;

/** 内存里的窗口表：按 home 分开（一个进程可能同时服务多个 home 的测试） */
const store = new Map<string, Map<string, Grant>>();

const binOf = (argv0: string): string =>
  basename(String(argv0 ?? "")).replace(/\.(exe|cmd|bat|sh)$/i, "").toLowerCase();

const looksLikePath = (a: string): boolean =>
  a.includes("/") || a.includes("\\") || a === ".." || a.startsWith(".") || /^[a-zA-Z]:/.test(a);

/** 目标路径是否落在 home 之内（按归一化字符串比较；调用方已排除 `..`） */
function insideHome(home: string, target: string): boolean {
  // 两边都转绝对路径再比：home 可能是相对的（CLI 传进来的 "data"）
  const h = norm(resolve(home));
  const t = norm(resolve(target));
  return t === h || t.startsWith(h + "/");
}

/** 路径归一化（反斜杠统一成正斜杠，去掉末尾斜杠） */
const norm = (p: string): string => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function openGrant(
  home: string,
  input: { commands?: unknown; scope?: string; ttlMs?: number; because?: unknown; full?: boolean },
  now = new Date(),
): { ok: true; grant: { id: string; commands: string[]; scope: string; expiresAt: string | null; because: string; full: boolean } } | { ok: false; code: string; why: string } {
  const because = String(input.because ?? "").trim();
  const full = input.full === true;
  // 全权的理由要更硬：不是「测一下」，而是「为什么值得把闸门开到最大」
  if (because.length < (full ? 10 : 4)) {
    return { ok: false, code: "E_GRANT_BECAUSE", why: full ? "开完全权限必须写清为什么（至少 10 个字）" : "得说清为什么开这个窗口（至少 4 个字）" };
  }
  if (full) {
    const ttlMs = input.ttlMs === undefined ? SESSION_ONLY : Math.min(FULL_MAX_TTL_MS, Math.max(60_000, Number(input.ttlMs)));
    const g: Grant = {
      id: `grn_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      commands: new Set(["*"]),
      scope: "",
      because, createdAt: now.getTime(), expiresAt: now.getTime() + ttlMs,
      full: true,
      preset: "full",
    };
    const perHomeF = store.get(home) ?? new Map<string, Grant>();
    perHomeF.set(g.id, g);
    store.set(home, perHomeF);
    return {
      ok: true,
      grant: {
        id: g.id, commands: ["*"], scope: "(整个 home)",
        expiresAt: never(g.expiresAt) ? null : new Date(g.expiresAt).toISOString(), because: g.because, full: true,
      },
    };
  }

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

  const ttlMs = input.ttlMs === undefined ? SESSION_ONLY : Math.min(MAX_TTL_MS, Math.max(60_000, Number(input.ttlMs)));
  const g: Grant = {
    id: `grn_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    commands: new Set(commands),
    scope,
    because,
    createdAt: now.getTime(),
    expiresAt: now.getTime() + ttlMs,
    full: false,
    preset: "write",
  };
  const perHome = store.get(home) ?? new Map<string, Grant>();
  perHome.set(g.id, g);
  store.set(home, perHome);

  return {
    ok: true,
    grant: {
      id: g.id, commands: [...g.commands], scope: g.scope,
      expiresAt: never(g.expiresAt) ? null : new Date(g.expiresAt).toISOString(), because: g.because, full: g.full,
    },
  };
}

export function listGrants(home: string, now = new Date()): Array<{
  id: string; commands: string[]; scope: string; because: string; full: boolean;
  createdAt: string; expiresAt: string | null; remainingS: number;
}> {
  const perHome = store.get(home);
  if (!perHome) return [];
  const out = [];
  for (const g of perHome.values()) {
    if (!never(g.expiresAt) && g.expiresAt <= now.getTime()) { perHome.delete(g.id); continue; }
    out.push({
      id: g.id, commands: [...g.commands], scope: g.scope, because: g.because, full: g.full,
      createdAt: new Date(g.createdAt).toISOString(),
      expiresAt: never(g.expiresAt) ? null : new Date(g.expiresAt).toISOString(),
      remainingS: never(g.expiresAt) ? -1 : Math.round((g.expiresAt - now.getTime()) / 1000),
    });
  }
  return out.sort((a, b) => String(a.expiresAt ?? "").localeCompare(String(b.expiresAt ?? "")));
}

export function revokeGrant(home: string, id: string): boolean {
  const perHome = store.get(home);
  if (!perHome) return false;
  return perHome.delete(id);
}

/** 当前会话的档位：有窗口就是那一档，没有就是逐次确认 */
export function currentPreset(home: string, now = new Date()): { preset: Preset; remainingS: number; grantId: string | null } {
  const rows = listGrants(home, now);
  if (!rows.length) return { preset: "ask", remainingS: 0, grantId: null };
  const top = rows[0]!;
  const preset: Preset = top.full ? "full" : top.commands.length === 0 ? "read" : "write";
  return { preset, remainingS: top.remainingS, grantId: top.id };
}

/**
 * 切档：**先收回现有窗口**，再按新档开一个（ask 就是全收回）。
 * 为什么先收：两档并存会让「当前是什么权限」没有唯一答案，而权限必须能一句话说清。
 */
export function setPreset(
  home: string,
  preset: Preset,
  input: { because?: unknown; ttlMs?: number; commands?: readonly string[] } = {},
  now = new Date(),
): { ok: true; preset: Preset; grant: { id: string; expiresAt: string | null; full?: boolean } | null } | { ok: false; code: string; why: string } {
  revokeAll(home);
  if (preset === "ask") return { ok: true, preset, grant: null };

  const because = String(input.because ?? "").trim() || `档位切到 ${preset}（输入框旁的选择器）`;
  if (preset === "read") {
    const g: Grant = {
      id: `grn_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      commands: new Set(), scope: "", because,
      createdAt: now.getTime(), expiresAt: now.getTime() + (input.ttlMs === undefined ? SESSION_ONLY : Math.max(60_000, Number(input.ttlMs))),
      full: false, preset: "read",
    };
    const perHome = store.get(home) ?? new Map<string, Grant>();
    perHome.set(g.id, g);
    store.set(home, perHome);
    return { ok: true, preset, grant: { id: g.id, expiresAt: never(g.expiresAt) ? null : new Date(g.expiresAt).toISOString() } };
  }
  if (preset === "full") {
    const r = openGrant(home, { full: true, because, ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}) }, now);
    return r.ok ? { ok: true, preset, grant: { id: r.grant.id, expiresAt: r.grant.expiresAt, full: true } } : r;
  }
  const commands = input.commands && input.commands.length ? [...input.commands] : [...GRANT_COMMANDS];
  const r = openGrant(home, { commands, scope: "workspace", because, ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }) }, now);
  return r.ok ? { ok: true, preset, grant: { id: r.grant.id, expiresAt: r.grant.expiresAt } } : r;
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
  home: string, req: { argv: readonly string[]; cwd: string; verb?: string }, now = new Date(),
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

  // 内联求值一律拒（两种窗口都拒）：命令必须落在能读的文件上，否则审计只剩一个 -e
  const inlineAt = argv.findIndex((a) => INLINE_EVAL.test(a));
  if (inlineAt > 0) {
    return { ok: false, code: "E_GRANT_INLINE_EVAL", why: `不许内联求值（${argv[inlineAt]}）：把代码写进文件再跑，才留得下痕迹` };
  }

  const wantFull = req.verb === "shell.exec";
  let picked: Grant | null = null;
  let sawFullOnlyMismatch = false;
  let sawFullDeny = "";
  let sawPathEscape = "";
  let sawReadOnly = false;
  for (const g of perHome.values()) {
    if (!never(g.expiresAt) && g.expiresAt <= now.getTime()) { perHome.delete(g.id); continue; }

    // 仅可查看：任何 T3 都拒（只读 verb 本来就是 T0/T1，不需要窗口）
    if (g.preset === "read") { sawReadOnly = true; continue; }

    // 完全权限窗口：任意命令（除硬禁名单）+ 整个 home；但**普通窗口不因此变宽**
    if (g.full) {
      if (FULL_DENY.has(bin)) { sawFullDeny = bin; continue; }
      if (!insideHome(home, req.cwd)) continue;
      const badPath = argv.slice(1).filter((a) => {
        if (!looksLikePath(a)) return false;
        const n = norm(a);
        if (n.includes("..")) return true;
        // 绝对路径：必须**本身**就在 home 内（拼 cwd 只会把任意绝对路径「洗白」）
        if (n.startsWith("/") || /^[a-z]:/.test(n)) {
          if (!insideHome(home, n)) { sawPathEscape = a; return true; }
          return false;
        }
        return false;
      });
      if (badPath.length) continue;
      picked = g;
      break;
    }

    // 普通窗口**不允许**用 shell.exec 跑任意 argv：它只能跑模板（走 shell.run）
    if (wantFull) { sawFullOnlyMismatch = true; continue; }

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
    if (sawReadOnly && !sawFullDeny) {
      return { ok: false, code: "E_PRESET_READ_ONLY", why: "当前是「仅可查看」：要动手就得先换一档（输入框旁的选择器）" };
    }
    if (wantFull && sawPathEscape) {
      return {
        ok: false, code: "E_GRANT_PATH",
        why: sawPathEscape + " 在 home 之外 —— 完全权限也不出这个家门",
      };
    }
    if (wantFull && sawFullDeny) {
      return {
        ok: false, code: "E_GRANT_FULL_DENY",
        why: sawFullDeny + " 在完全权限窗口里也**永久拒绕**（删/磁盘/系统/下载/壳）—— 这一条不可配置",
      };
    }
    if (wantFull) {
      return {
        ok: false, code: "E_GRANT_NEEDS_FULL",
        why: "任意 argv 只能在**完全权限**窗口里跑（普通窗口只放行注册过的模板）；而且删/系统/下载/壳类命令在全权窗口里也仍然拒绝",
      };
    }
    return {
      ok: false, code: "E_GRANT_NO_MATCH",
      why: `窗口里没有能覆盖这条命令的：${bin} @ ${req.cwd}（先看 jingjing grant list）` + (sawFullOnlyMismatch ? "" : ""),
    };
  }
  void scopeInCwd;
  return {
    ok: true, id: picked.id, commands: [...picked.commands],
    scope: picked.full ? "" : picked.scope,
    expiresAt: never(picked.expiresAt) ? null : new Date(picked.expiresAt).toISOString(),
    full: picked.full,
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
