/**
 * WSL 之手（2026-11-12）：她自己的 Linux 小房子。
 *
 * 设计依据 `docs/design/00` 的爆炸半径 1：**专属设备可以给 root**，兜底不是「少给权限」，
 * 而是「控制爆炸半径 + 保住恢复路径」——逐条审计 + 定期快照 + 硬禁区。
 * 用户 2026-11-12 定：装 Ubuntu，完全自主（不逐次问）。
 *
 * 三条实现纪律：
 *  1. **argv 直传，不拼 shell 字符串**（沿用 shell.ts）。模型给的命令渲染成
 *     `wsl.exe -d <distro> -u root -- timeout -k 5 <s> <argv...>`。
 *  2. **Linux 侧 timeout 收尸**：杀 wsl.exe 客户端**杀不死** Linux 里的进程（WSL 的真坑），
 *     所以让 Linux 自己用 coreutils timeout 超时自尽；exit 124 = 超时。
 *  3. **硬禁区防 mistakes 不防恶意**：她是 root、/mnt 可写，模式匹配只挡「把自己弄死」那几类
 *     （格式化/写块设备/删 Windows 盘根与系统目录/删审计快照）。真正的底是快照 + 审计。
 *
 * 自主开关 `config.wsl.autonomous` 只能人开（config 写入没有模型 verb）；模型开不了它。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readFileConfig } from "./configfile.ts";

export const WSL_DISTRO_DEFAULT = "Ubuntu";
/** 单条命令默认超时（秒）；Linux 侧 timeout 用 */
export const WSL_TIMEOUT_S = 120;
/** 快照保留几份 */
export const SNAP_KEEP = 3;
/** 距上次快照超过这么久才再拍（与闲时整理同节奏） */
export const SNAP_EVERY_MS = 20 * 3600_000;

export function wslDistro(home: string): string {
  return readFileConfig(home).wsl?.distro?.trim() || WSL_DISTRO_DEFAULT;
}
export function wslAutonomous(home: string): boolean {
  return readFileConfig(home).wsl?.autonomous === true;
}

/** wsl.exe 的输出常是 UTF-16LE（带 BOM）；按 BOM 判，两种都吃得下 */
function wsl(args: string[], timeoutMs = 60_000): { code: number; out: string } {
  const r = spawnSync("wsl.exe", args, { encoding: "buffer", timeout: timeoutMs, windowsHide: true });
  const buf = r.stdout as Buffer | null;
  let out = "";
  if (buf && buf.length) {
    out = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8");
  }
  return { code: r.status ?? 127, out: out.trim() };
}

export interface WslDistro { name: string; state: string; version: number; default: boolean }

/** 解析 `wsl.exe -l -v`。机器上没有 wsl 或没装发行版都如实报，不装懂。 */
export function detect(): { available: boolean; distros: WslDistro[] } {
  const r = wsl(["-l", "-v"], 15_000);
  if (r.code !== 0) return { available: false, distros: [] };
  const distros: WslDistro[] = [];
  for (const line of r.out.split(/\r?\n/).slice(1)) {
    const t = line.trim();
    if (!t) continue;
    const def = t.startsWith("*");
    const parts = t.replace(/^\*\s*/, "").split(/\s+/).filter(Boolean);
    if (parts.length >= 3) distros.push({ name: parts[0]!, state: parts[1]!, version: Number(parts[2]) || 2, default: def });
  }
  return { available: true, distros };
}

export function snapshotsDir(home: string): string { return join(home, "wsl", "snapshots"); }

export function listSnapshots(home: string): Array<{ file: string; bytes: number; at: string }> {
  const dir = snapshotsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".tar")).sort().reverse().map((f) => {
    const st = statSync(join(dir, f));
    return { file: f, bytes: st.size, at: st.mtime.toISOString() };
  });
}

/** 面板/CLI 用的一次性状态 */
export function status(home: string): {
  available: boolean; distro: string; installed: boolean; state: string;
  autonomous: boolean; snapshots: Array<{ file: string; bytes: number; at: string }>;
} {
  const d = detect();
  const name = wslDistro(home);
  const mine = d.distros.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? null;
  return {
    available: d.available, distro: name, installed: !!mine,
    state: mine?.state ?? "未安装", autonomous: wslAutonomous(home),
    snapshots: listSnapshots(home),
  };
}

/**
 * 把模型给的 argv 渲染成确切命令（纯函数，测试不依赖真 WSL）。
 * 校验形状 → 包 Linux 侧 timeout → 直传。审计记的就是这份。
 */
export function renderExec(argv: readonly string[], opts: { distro?: string; timeoutS?: number } = {}): string[] {
  const a = argv.map(String);
  if (!a.length) throw new Error("E_BAD_ARGV: argv 不能为空");
  if (a.length > 32) throw new Error("E_BAD_ARGV: argv 太长（≤32 段）");
  if (a.some((x) => x.length > 2000)) throw new Error("E_BAD_ARGV: 单段太长");
  if (a.some((x) => /[\u0000-\u001f\u007f]/.test(x))) throw new Error("E_BAD_ARGV: 含控制字符");
  const distro = opts.distro || WSL_DISTRO_DEFAULT;
  const t = Math.max(1, Math.min(3600, Math.floor(opts.timeoutS ?? WSL_TIMEOUT_S)));
  return ["wsl.exe", "-d", distro, "-u", "root", "--", "timeout", "-k", "5", String(t), ...a];
}

/** 取命令名：绝对路径、.exe、大小写都收成可比形式 */
const binName = (s: string): string =>
  s.replace(/\\/g, "/").toLowerCase().split("/").pop()!.replace(/\.exe$/, "");

/**
 * 目标路径归一化：反斜杠 / 大小写 / `~` / `$HOME` / `/.` / 重复斜杠 / 尾斜杠
 * 都收成同一种写法，免得 `rm -rf //`、`/./`、`~/` 之类绕过字面匹配。
 */
function normTarget(x: string): string {
  if (!x.trim()) return "";
  let n = x.replace(/\\/g, "/").toLowerCase();
  n = n.replace(/^~(?=\/|$)/, "/root").replace(/^\$home(?=\/|$)/, "/root");
  n = n.replace(/\/\.\//g, "/").replace(/\/{2,}/g, "/").replace(/\/\.$/, "");
  const trimmed = n.replace(/\/+$/, "");
  return trimmed || (n.startsWith("/") ? "/" : "");
}

/** Linux 系统根与一删就回不来的关键目录（只挡「目录本身」与「目录/*」，子目录里的单个文件不管） */
const CRITICAL_ROOTS = /^\/(?:bin|boot|dev|etc|home|lib|lib32|lib64|libx32|mnt|proc|root|run|sbin|srv|sys|usr|var)?(?:\/?\*)?$/;

function deniedTarget(x: string): string | null {
  const n = normTarget(x);
  if (/^\/mnt\/[a-z]$/.test(n)) return "不许删 Windows 盘根（" + x + "）";
  if (/^\/mnt\/[a-z]\/(windows|users|program files)/.test(n)) return "不许动 Windows 系统目录（" + x + "）";
  if (n.includes("/pseudo digital life project/data") || n.includes("/data/wsl/snapshots")) {
    return "不许删审计/快照（" + x + "）—— 那是回滚的底";
  }
  // 2026-11-14：自主档只过这一层硬禁区，原先不挡 Linux 侧 `rm -rf /`、`/etc`、`/home` …
  // 比 supergrant 的兜底还松。这里补齐「把自己弄死」那一类。
  if (CRITICAL_ROOTS.test(n)) return "不许删 Linux 系统根/关键目录（" + x + "）—— 删了她自己也回不来";
  if (n === "/root/jj" || n === "/root/jj/*") return "不许整个删掉她的 Linux 家（" + x + "）—— 先说清要删哪个文件";
  return null;
}

/** 对一条（拆分过的）命令复核硬禁区。命中返回一句人话，否则 null。 */
function denyTokens(a: readonly string[]): string | null {
  if (!a.length) return null;
  const bins = a.map(binName);
  const disk = bins.find((b) => /^(mkfs|fdisk|parted|diskpart)/.test(b));
  if (disk) return disk + " 会动磁盘分区/格式化 —— 不做（那不是接管，是把机器弄没）";
  if (bins.includes("dd") && a.some((x) => /^of=\/dev\//i.test(x))) return "dd 写块设备 —— 不做";
  if (bins.includes("wsl") && a.some((x) => /--unregister|--shutdown/.test(x))) return "不许从里面注销/关停 WSL";
  // 扫全串而不是只看第一个词：`sudo -u root rm -rf /etc` 这类包装写法同样要挡。
  const destructive = bins.some((b) => /^(rm|rmdir|del|shred)$/.test(b)) || (bins.includes("find") && a.includes("-delete"));
  if (destructive) {
    for (const x of a.slice(1)) {
      const why = deniedTarget(x);
      if (why) return why;
    }
  }
  return null;
}

/**
 * 硬禁区（纯函数）：命中返回一句人话，否则 null。
 * 只挡「把自己弄死 / 把宿主弄没」那几类；不是沙箱，兜底靠快照 + 审计。
 * 内联 shell 求值（-c/-lc）会按 `; | &` 拆成一条条命令再各复核一遍，只展开一层。
 */
export function wslHardDeny(argv: readonly string[]): string | null {
  const a = argv.map(String);
  const first = denyTokens(a);
  if (first) return first;
  const ci = a.findIndex((x, j) => j > 0 && /^-[a-z]*c$/i.test(x));
  if (ci >= 0 && a[ci + 1]) {
    for (const seg of a[ci + 1]!.split(/[;|&\n]+/).map((s) => s.trim()).filter(Boolean)) {
      const inner = denyTokens(seg.split(/\s+/).filter(Boolean));
      if (inner) return "内联命令里：" + inner;
    }
  }
  return null;
}

/** 从 renderExec 的产物里取回模型给的原始 argv（跳过 wsl/timeout 前缀），供闸门复核硬禁区。 */
export function innerArgv(rendered: readonly string[]): string[] {
  const a = rendered.map(String);
  const sep = a.indexOf("--");
  if (sep < 0) return a;
  // "--" 后是 timeout -k 5 <秒> <原始 argv...>
  return a.slice(sep + 5);
}

/** Windows 路径 ↔ WSL /mnt 路径 */
export function winToWsl(p: string): string {
  const n = p.replace(/\\/g, "/");
  const m = n.match(/^([A-Za-z]):\/(.*)$/);
  return m ? "/mnt/" + m[1]!.toLowerCase() + "/" + m[2] : n;
}
export function wslToWin(p: string): string {
  const m = p.match(/^\/mnt\/([a-z])\/(.*)$/);
  return m ? m[1]!.toUpperCase() + ":/" + m[2] : p;
}

/** 拍一份快照（wsl --export），保留最近 SNAP_KEEP 份 */
export function snapshot(home: string, now = new Date()): { ok: boolean; file?: string; why?: string } {
  const d = detect();
  const name = wslDistro(home);
  if (!d.distros.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, why: "E_WSL_NO_DISTRO: " + name + " 没装（先 jingjing wsl setup）" };
  }
  const dir = snapshotsDir(home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, now.toISOString().replace(/[:.]/g, "-") + ".tar");
  const r = wsl(["--export", name, file], 600_000);
  if (r.code !== 0 || !existsSync(file)) return { ok: false, why: "E_WSL_EXPORT: " + (r.out || "导出失败").slice(0, 200) };
  const all = readdirSync(dir).filter((f) => f.endsWith(".tar")).sort();
  while (all.length > SNAP_KEEP) {
    const old = all.shift()!;
    try { unlinkSync(join(dir, old)); } catch { /* 删不掉留着，下次再清 */ }
  }
  return { ok: true, file };
}

/** 闲时整理末尾调：距上次 >20h 且发行版在，才拍；失败只回原因，不抛 */
export function snapshotIfDue(home: string, now = new Date()): { ran: boolean; why?: string } {
  const d = detect();
  const name = wslDistro(home);
  if (!d.distros.some((x) => x.name.toLowerCase() === name.toLowerCase())) return { ran: false, why: "no-distro" };
  const snaps = listSnapshots(home);
  if (snaps.length && now.getTime() - Date.parse(snaps[0]!.at) < SNAP_EVERY_MS) return { ran: false, why: "recent" };
  const r = snapshot(home, now);
  return { ran: r.ok, ...(r.ok ? {} : { why: r.why }) };
}

/** 恢复（破坏性：unregister + import）。**只给 CLI/人**，不做成模型 verb。 */
export function restore(home: string, file: string): { ok: boolean; why?: string } {
  const name = wslDistro(home);
  const abs = join(snapshotsDir(home), file);
  if (!existsSync(abs)) return { ok: false, why: "E_NO_SNAPSHOT: " + file };
  const un = wsl(["--unregister", name], 120_000);
  if (un.code !== 0) return { ok: false, why: "E_WSL_UNREGISTER: " + un.out.slice(0, 200) };
  const installDir = join(home, "wsl", "distro-" + name);
  mkdirSync(installDir, { recursive: true });
  const im = wsl(["--import", name, installDir, abs], 600_000);
  if (im.code !== 0) return { ok: false, why: "E_WSL_IMPORT: " + im.out.slice(0, 200) };
  return { ok: true };
}

/**
 * 装好她的 Linux 小房子（**由人触发**：装软件不自主）。
 * 装发行版 → 非交互初始化 root + /etc/wsl.conf + /root/jj → exchange 软链到 Windows workspace → 初始快照。
 * 这里的 `bash -c` 是**自家可信安装代码**（照 auth.ts 调 PowerShell 的先例），不是模型 argv。
 */
export function setup(home: string, log: (s: string) => void = () => {}): { ok: boolean; why?: string } {
  const d = detect();
  if (!d.available) return { ok: false, why: "E_WSL_UNAVAILABLE: 这台机器没有 wsl.exe（先启用 WSL）" };
  const name = wslDistro(home);
  if (!d.distros.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
    log("安装 " + name + "（约 1GB，可能要几分钟）…");
    const inst = wsl(["--install", "-d", name, "--no-launch"], 900_000);
    if (inst.code !== 0) return { ok: false, why: "E_WSL_INSTALL: " + inst.out.slice(0, 300) };
  }
  log("初始化 root 与她的 Linux 家（/root/jj）…");
  const init = wsl(["-d", name, "-u", "root", "--", "bash", "-c",
    "mkdir -p /root/jj && printf '[automount]\\nenabled=true\\n[boot]\\nsystemd=true\\n' > /etc/wsl.conf && echo ok"], 120_000);
  if (init.code !== 0) return { ok: false, why: "E_WSL_INIT: " + init.out.slice(0, 300) };
  const ws = winToWsl(join(home, "workspace"));
  wsl(["-d", name, "-u", "root", "--", "bash", "-c", "ln -sfn '" + ws + "' /root/jj/exchange"], 30_000);
  log("拍初始快照…");
  const snap = snapshot(home);
  if (!snap.ok) log("（初始快照没成：" + snap.why + "）");
  return { ok: true };
}