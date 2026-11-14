/**
 * 发布与更新：版本真源、发布清单、产物校验（2026-11-14 P2 产品化）。
 *
 * 产品决策（见 docs/ops/26-更新与卸载策略.md）：单机单人、离线优先，
 * **不做后台静默下载 / 自替换** —— 一次网络抖动不该把用户正在用的版本换掉，
 * 更不能让升级动作碰数据目录。这里只做三件可验证的事：
 *   ① 版本可查（六处真源一致性 + /api/version）
 *   ② 发布清单可校验（SHA-256，用户下载后自己核对）
 *   ③ 更新检查是纯函数：只比较版本，不联网、不下载、不安装。
 *
 * 本文件不发起任何网络请求，也不写任何文件。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 更新策略标识：由用户主动下载 → 校验 → 覆盖安装，绝不自动执行。 */
export const UPDATE_POLICY = "manual-verified" as const;

const PKG_URL = new URL("../package.json", import.meta.url);

function readPkg(): { version: string; engines?: { node?: string } } {
  try { return JSON.parse(readFileSync(PKG_URL, "utf8")); }
  catch { return { version: "unknown" }; }
}

/** 运行时版本信息。只读 package.json —— 桌面端的 app/ 里没有 desktop/ 与 README，别去读那些。 */
export function appVersion(): string { return String(readPkg().version); }

/** 工作区根目录（package.json 所在目录）。发布方把 release.json 与安装包一起放在这里。 */
export function workspaceRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

export interface VersionSource { file: string; version: string; missing: boolean }

/**
 * 发一版要动的六处版本号（docs/ops/23 §1.5）。少一处就会出现
 * 「安装包叫 0.1.1、exe 里还是 0.1.0」。缺文件时标 missing，不抛异常。
 */
export function versionSources(root: string): VersionSource[] {
  const read = (p: string): string | null => {
    const f = join(root, p);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  };
  const pick = (text: string | null, re: RegExp): VersionSource["version"] =>
    text === null ? "MISSING" : (text.match(re)?.[1] ?? "MISSING");
  const pkg = read("package.json");
  const tauri = read("desktop/src-tauri/tauri.conf.json");
  const out = (file: string, version: string): VersionSource => ({
    file, version, missing: version === "MISSING",
  });
  let pkgV = "MISSING", tauriV = "MISSING";
  try { if (pkg) pkgV = String(JSON.parse(pkg).version); } catch { /* 坏 JSON 就当缺失 */ }
  try { if (tauri) tauriV = String(JSON.parse(tauri).version); } catch { /* 同上 */ }
  return [
    out("package.json", pkgV),
    out("desktop/src-tauri/tauri.conf.json", tauriV),
    out("desktop/src-tauri/Cargo.toml", pick(read("desktop/src-tauri/Cargo.toml"), /^\s*version\s*=\s*"([^"]+)"/m)),
    out("src/capabilities.ts", pick(read("src/capabilities.ts"), /const\s+VERSION\s*=\s*"([^"]+)"/)),
    out("src/mcp.ts", pick(read("src/mcp.ts"), /clientInfo:\s*\{\s*name:\s*"jingjing",\s*version:\s*"([^"]+)"/)),
    out("README.md", pick(read("README.md"), /Not a mature product\*{0,2}:\s*([0-9]+\.[0-9]+\.[0-9]+)/)),
  ];
}

export interface VersionCheck {
  ok: boolean;
  version: string;
  sources: VersionSource[];
  mismatches: VersionSource[];
}

/** 六处全在、且逐字相同才算一致。发布闸门（npm run release:check）用它。 */
export function checkVersionConsistency(root: string): VersionCheck {
  const sources = versionSources(root);
  const version = sources[0]?.version ?? "MISSING";
  const mismatches = sources.filter((s) => s.missing || s.version !== version);
  return {
    ok: /^\d+\.\d+\.\d+$/.test(version) && mismatches.length === 0,
    version,
    sources,
    mismatches,
  };
}

/** 运行时自报家门，给 /api/version 用：回答「我装的到底是哪版」。 */
export function releaseInfo() {
  const pkg = readPkg();
  return {
    version: String(pkg.version),
    updatePolicy: UPDATE_POLICY,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    minNode: pkg.engines?.node ?? null,
  };
}

const SEMVER = /^\d+\.\d+\.\d+$/;

/** 三段式 semver 比较：a>b 返回 1，a<b 返回 -1，相等 0。不认预发布标签（本项目不用）。 */
export function compareVersions(a: string, b: string): number {
  if (!SEMVER.test(a) || !SEMVER.test(b)) throw new Error(`E_BAD_VERSION: ${a} / ${b}`);
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export interface ReleaseArtifact { name: string; sha256: string; size: number }
export interface ReleaseManifest {
  version: string;
  releasedAt: string;
  minNode: string;
  changelog: string;
  notes: string;
  /** 可选：只作展示，客户端不自动打开、不自动下载。 */
  downloadUrl?: string;
  artifacts: ReleaseArtifact[];
}

export interface UpdateAdvice {
  hasUpdate: boolean;
  current: string;
  latest: string;
  policy: typeof UPDATE_POLICY;
  notes: string;
  downloadUrl: string | null;
  sha256: string | null;
}

/**
 * 纯比较，无副作用。有新版只把「去哪下、下完该对上哪个哈希」告诉人，
 * 由人决定装不装。清单缺字段时降级成 hasUpdate:false，不抛异常（面板不该被一份坏清单带崩）。
 */
export function checkUpdate(current: string, manifest: ReleaseManifest | null | undefined): UpdateAdvice {
  const base = (latest: string): UpdateAdvice => ({
    hasUpdate: false, current, latest, policy: UPDATE_POLICY,
    notes: "", downloadUrl: null, sha256: null,
  });
  if (!manifest || !SEMVER.test(String(manifest.version ?? "")) || !SEMVER.test(current)) {
    return base(String(manifest?.version ?? current));
  }
  const hasUpdate = compareVersions(manifest.version, current) > 0;
  return {
    hasUpdate,
    current,
    latest: manifest.version,
    policy: UPDATE_POLICY,
    notes: hasUpdate ? String(manifest.notes ?? "") : "",
    downloadUrl: hasUpdate ? (manifest.downloadUrl ?? null) : null,
    sha256: hasUpdate ? (manifest.artifacts?.[0]?.sha256 ?? null) : null,
  };
}

/** /api/update-check 的返回：UpdateAdvice 外加一句给人看的中文说明（缺清单/坏清单时）。 */
export interface LocalUpdateAdvice extends UpdateAdvice {
  /** 缺清单 / 坏清单时的中文说明；清单正常时为 null。只作展示，不触发任何动作。 */
  notice: string | null;
}

/**
 * GET /api/update-check 的服务端逻辑：只读工作区根目录的 release.json，
 * 交给纯函数 checkUpdate() 比 semver。**不联网、不下载、不安装、不写文件**。
 * 缺文件 / 坏 JSON / 坏清单一律降级成 hasUpdate:false + 中文说明，不抛异常
 * （面板不该被一份坏清单带崩，见 docs/ops/26 §1）。
 */
export function checkLocalUpdate(root: string, current: string = appVersion()): LocalUpdateAdvice {
  const degraded = (notice: string): LocalUpdateAdvice => ({ ...checkUpdate(current, null), notice });
  const file = join(root, "release.json");
  if (!existsSync(file)) return degraded("没有本地发布清单");
  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8")) as ReleaseManifest;
  } catch {
    return degraded("没有本地发布清单");
  }
  // JSON 解得开但结构不对（缺 version / 版本不是三段 semver）也算坏清单
  if (!manifest || !SEMVER.test(String(manifest.version ?? ""))) {
    return degraded("没有本地发布清单");
  }
  return { ...checkUpdate(current, manifest), notice: null };
}

/** 下载完的安装包和用户手里的清单对得上吗。大小写不敏感，坏文件直接抛（发布工具会转成红字）。 */
export function verifyArtifact(path: string, expectedSha256: string): boolean {
  const got = createHash("sha256").update(readFileSync(path)).digest("hex");
  return got.toLowerCase() === String(expectedSha256).toLowerCase();
}

/* ── 覆盖安装前后的数据目录指纹（2026-11-14，学自 dsh-world 的 update-world.mjs）──
 * 发布侧此前只能承诺「升级不碰数据目录」，没有可断言的证据。这里把它变成纯比较：
 * 退出应用 → 取快照 → 覆盖安装 → 不启动应用 → 再取一次 → 逐文件比对。
 * 只允许应用正常运行本来就会改写的文件有差异，其余（memory.db / persona / secrets…）一律判红。
 */
export interface DataSnapshot {
  version: 1;
  root: string;
  takenAt: string;
  files: Record<string, { sha256: string; size: number }>;
}

export interface DataDiff {
  ok: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  ignored: string[];
  violations: string[];
}

/** 可预期的运行产物：日志、SQLite WAL、临时文件、启动时重写的端口/令牌指针。 */
export const DATA_IGNORE: readonly RegExp[] = [
  /\.log$/i,
  /-(?:wal|shm)$/i,
  /\.tmp$/i,
  /(?:^|[\\/])\.desk\.json$/i,
  /(?:^|[\\/])where\.json$/i,
];

export function isIgnoredDataPath(p: string, ignore: readonly RegExp[] = DATA_IGNORE): boolean {
  return ignore.some((re) => re.test(p));
}

/** 纯函数：两张快照逐文件比对；目录不同或关键数据有增删改都判红。 */
export function diffDataSnapshots(before: DataSnapshot, after: DataSnapshot, ignore: readonly RegExp[] = DATA_IGNORE): DataDiff {
  const added: string[] = [], removed: string[] = [], changed: string[] = [], ignored: string[] = [], violations: string[] = [];
  if (before.root !== after.root) violations.push(`快照目录不一致：${before.root} ≠ ${after.root}`);
  const bf = before.files ?? {}, af = after.files ?? {};
  const keys = [...new Set([...Object.keys(bf), ...Object.keys(af)])].sort();
  for (const key of keys) {
    const a = bf[key], b = af[key];
    if (a && b && a.sha256 === b.sha256 && a.size === b.size) continue;
    if (isIgnoredDataPath(key, ignore)) { ignored.push(key); continue; }
    if (!a) added.push(key);
    else if (!b) removed.push(key);
    else changed.push(key);
  }
  for (const k of added) violations.push(`多出文件：${k}`);
  for (const k of removed) violations.push(`少了文件：${k}`);
  for (const k of changed) violations.push(`内容变了：${k}`);
  return { ok: violations.length === 0, added, removed, changed, ignored, violations };
}
