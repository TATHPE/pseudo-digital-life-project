/** 发布前生成干净快照；只写仓库内 bundle-src 与显式保留的 tmp 备份，不触碰安装版或其数据。 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const PAYLOAD = ["src", "persona", "package.json", "package-lock.json"];

/** 拒绝 junction/symlink，包括父目录：快照绝不能借链接写进源码或安装目录。 */
function plainPath(path: string) {
  const parent = dirname(path);
  if (parent !== path) plainPath(parent);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`快照路径不允许链接：${path}`);
}
function files(path: string, rel = ""): Record<string, string> {
  const here = join(path, rel);
  const st = lstatSync(here);
  if (st.isSymbolicLink()) throw new Error(`载荷不允许链接：${here}`);
  if (st.isFile()) return { [rel.replaceAll("\\", "/")]: createHash("sha256").update(readFileSync(here)).digest("hex") };
  if (!st.isDirectory()) throw new Error(`载荷不是普通文件或目录：${here}`);
  return Object.assign({}, ...readdirSync(here).sort().map((n) => files(path, join(rel, n))));
}
function payload(root: string) {
  return Object.assign({}, ...PAYLOAD.map((p) => files(root, p))) as Record<string, string>;
}
function same(a: Record<string, string>, b: Record<string, string>) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function runtime(root: string) {
  const path = join(root, "desktop/bundle-src/node/node.exe");
  plainPath(path);
  const p = spawnSync(path, ["-p", "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})"], { encoding: "utf8", windowsHide: true });
  if (p.error || p.status !== 0) throw new Error("缺少可运行的 bundle-src/node/node.exe；请先准备 Windows x64 Node ≥24");
  const info = JSON.parse(p.stdout.trim()) as { version: string; platform: string; arch: string };
  if (Number(info.version.split(".")[0]) < 24 || info.platform !== "win32" || info.arch !== "x64") {
    throw new Error("内置 Node 必须是 Windows x64、版本 ≥24");
  }
  return info;
}
function installProduction(stage: string) {
  // 固定命令、无动态 shell 参数；cwd 单独传递，包含空格的项目路径也可用。
  const args = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
  const p = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm " + args.join(" ")], { cwd: stage, stdio: "inherit", windowsHide: true })
    : spawnSync("npm", args, { cwd: stage, stdio: "inherit" });
  if (p.error || p.status !== 0) throw new Error("生产依赖安装失败；原打包快照未改动");
}

export function checkDesktopBundle(root = ROOT) {
  root = resolve(root);
  const app = join(root, "desktop/bundle-src/app");
  plainPath(app);
  const expected = payload(root);
  if (!same(expected, payload(app))) throw new Error("打包快照与源码不一致，请运行 npm run desktop:sync");
  const manifest = JSON.parse(readFileSync(join(app, "bundle-manifest.json"), "utf8"));
  if (!same(expected, manifest.files)) throw new Error("快照清单与载荷不一致");
  if (!existsSync(join(app, "node_modules/.package-lock.json"))) throw new Error("快照缺少生产依赖");
  const allowed = new Set([...PAYLOAD, "node_modules", "bundle-manifest.json"]);
  for (const n of readdirSync(app)) if (!allowed.has(n)) throw new Error(`快照有未知内容：${n}`);
  return { files: Object.keys(expected).length, version: manifest.version };
}

/** install 可替换仅用于临时夹具；正式入口始终运行 npm ci。 */
export function syncDesktopBundle(root = ROOT, install = installProduction, archiveExisting = false) {
  root = resolve(root);
  const base = join(root, "desktop/bundle-src");
  const app = join(base, "app");
  plainPath(app);
  const expected = payload(root);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const conf = JSON.parse(readFileSync(join(root, "desktop/src-tauri/tauri.conf.json"), "utf8"));
  const cargo = readFileSync(join(root, "desktop/src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (pkg.version !== conf.version || pkg.version !== cargoVersion) throw new Error("package / Tauri / Cargo 版本不一致，拒绝打包");
  if (existsSync(app)) {
    // 历史快照只能含发布载荷；发现数据等意外目录时停下，不帮用户清理。
    const allowed = new Set([...PAYLOAD, "node_modules", "bundle-manifest.json"]);
    for (const n of readdirSync(app)) if (!allowed.has(n) && !archiveExisting) throw new Error(`旧快照有未知内容，需人工确认：${n}`);
    for (const n of PAYLOAD) if (existsSync(join(app, n))) files(app, n);
  }
  mkdirSync(base, { recursive: true });
  const stage = mkdtempSync(join(base, ".stage-"));
  let backup = stage + "-previous";
  let moved = false;
  try {
    for (const rel of Object.keys(expected)) {
      mkdirSync(dirname(join(stage, rel)), { recursive: true });
      copyFileSync(join(root, rel), join(stage, rel));
    }
    install(stage);
    if (!same(expected, payload(stage)) || !same(expected, payload(root))) throw new Error("同步期间源码发生变化或复制不一致，拒绝打包");
    writeFileSync(join(stage, "bundle-manifest.json"), JSON.stringify({ version: pkg.version, files: expected }, null, 2) + "\n");
    if (!existsSync(join(stage, "node_modules/.package-lock.json"))) throw new Error("生产依赖未生成，拒绝替换快照");
    if (existsSync(app)) {
      if (archiveExisting) {
        // 仅显式授权才保留整份旧 app；备份在 Tauri 资源范围外，绝不带入安装包。
        const tmp = join(root, "tmp");
        plainPath(tmp);
        mkdirSync(tmp, { recursive: true });
        backup = join(mkdtempSync(join(tmp, "desktop-bundle-previous-")), "app");
      }
      renameSync(app, backup); moved = true;
    }
    try { renameSync(stage, app); }
    catch (e) { if (moved) renameSync(backup, app); moved = false; throw e; }
    if (moved && !archiveExisting) rmSync(backup, { recursive: true, force: true });
    return { ...checkDesktopBundle(root), archived: moved && archiveExisting ? backup : undefined };
  } finally {
    // 只清本次创建的暂存目录；失败时旧快照留在原处。
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const node = runtime(ROOT);
    const r = process.argv.includes("--check") ? checkDesktopBundle() : syncDesktopBundle(ROOT, installProduction, process.argv.includes("--archive-existing"));
    console.log(`✅ 桌面快照 ${r.version}：${r.files} 个载荷文件逐字一致；内置 Node ${node.version}`);
    if ("archived" in r && r.archived) console.log(`旧快照完整保留：${r.archived}`);
  } catch (e) {
    console.error("❌ " + (e as Error).message);
    process.exitCode = 1;
  }
}
