/**
 * 发布工具（2026-11-14 P2 产品化）：版本一致性 / 生成发布清单 / 校验下载产物。
 *
 *   node --experimental-strip-types tools/release.ts check
 *   node --experimental-strip-types tools/release.ts manifest [安装包1.exe 安装包2.exe ...]
 *   node --experimental-strip-types tools/release.ts verify [release.json]
 *   node --experimental-strip-types tools/release.ts snapshot <数据目录> [快照文件]
 *   node --experimental-strip-types tools/release.ts verify-data [数据目录] [快照文件]
 *
 * `check` 是发布闸门（CI 里跑）：六处版本号逐字一致、CHANGELOG 与对应版本发布说明存在、
 * 打包快照不含 junction/symlink。`manifest` 只在构建出安装包后手工跑，产出 release.json
 * 供用户核对 SHA-256；`verify` 让下载方用同一份清单校验手里的文件。
 * `snapshot` / `verify-data` 是升级前后的数据目录指纹（2026-11-14）：退出应用 → 取快照 →
 * 覆盖安装 → 不启动应用 → 再比对；把「升级只该改安装目录」变成可断言的检查。
 * 这些命令都不联网、不改源码、不碰已安装的软件。
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  checkVersionConsistency, diffDataSnapshots, verifyArtifact,
  type DataSnapshot, type ReleaseArtifact, type ReleaseManifest,
} from "../src/release.ts";
import { scanLinks } from "./uninstall-guard.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

function check(): number {
  const results: Array<[string, boolean, string]> = [];
  const v = checkVersionConsistency(ROOT);
  results.push(["六处版本号逐字一致", v.ok, v.ok ? v.version : v.mismatches.map((m) => m.file + "=" + m.version).join(", ")]);
  for (const s of v.sources) console.log("  · " + s.file.padEnd(36) + s.version);
  console.log("");

  const changelog = join(ROOT, "CHANGELOG.md");
  results.push(["CHANGELOG.md 存在", existsSync(changelog), "CHANGELOG.md"]);
  const notes = join(ROOT, "docs", "ops", `release-notes-v${v.version}.md`);
  results.push([`发布说明 v${v.version} 存在`, existsSync(notes), rel(notes)]);

  const bundle = join(ROOT, "desktop", "bundle-src", "app");
  const links = existsSync(bundle) ? scanLinks(bundle) : [];
  results.push(["打包快照不含链接（防卸载递归删源码）", links.length === 0, links.slice(0, 5).join(", ") || "无"]);

  let bad = 0;
  for (const [name, pass, detail] of results) {
    console.log((pass ? "✅ " : "❌ ") + name + (detail && !pass ? "  — " + detail : ""));
    if (!pass) bad++;
  }
  console.log(bad ? `\n❌ ${bad} 项未通过，先修再发版` : "\n✅ 发布元数据齐全，可以构建");
  return bad ? 1 : 0;
}

function sha256Of(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** 默认找 Tauri NSIS 产物；也可以直接把文件路径当参数传进来。 */
function defaultArtifacts(): string[] {
  const dir = join(ROOT, "desktop", "src-tauri", "target", "release", "bundle", "nsis");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /\.exe$/i.test(n)).map((n) => join(dir, n));
}

function manifest(paths: string[]): number {
  const v = checkVersionConsistency(ROOT);
  if (!v.ok) { console.error("版本不一致，拒绝生成清单：" + v.mismatches.map((m) => m.file).join(", ")); return 1; }
  const files = paths.length ? paths.map((p) => resolve(p)) : defaultArtifacts();
  if (!files.length) {
    console.error("没找到安装包。先跑 npm run desktop:build，或把 .exe 路径作为参数传进来。");
    return 1;
  }
  const missing = files.filter((p) => !existsSync(p));
  if (missing.length) { console.error("文件不存在：" + missing.join(", ")); return 1; }
  const artifacts: ReleaseArtifact[] = files.map((p) => ({
    name: rel(p), sha256: sha256Of(p), size: statSync(p).size,
  }));
  const m: ReleaseManifest = {
    version: v.version,
    releasedAt: new Date().toISOString(),
    minNode: String(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).engines?.node ?? ">=24"),
    changelog: "CHANGELOG.md",
    notes: rel(join(ROOT, "docs", "ops", `release-notes-v${v.version}.md`)),
    artifacts,
  };
  const out = join(ROOT, "release.json");
  writeFileSync(out, JSON.stringify(m, null, 2) + "\n");
  console.log("已写出 " + rel(out));
  for (const a of artifacts) console.log("  · " + a.name + "  " + a.size + " B  sha256=" + a.sha256);
  console.log("把这份清单和安装包一起交给用户；对方用 `npm run release:verify` 核对。");
  return 0;
}

function verify(arg?: string): number {
  const path = resolve(arg ?? join(ROOT, "release.json"));
  if (!existsSync(path)) { console.error("清单不存在：" + path); return 1; }
  const m = JSON.parse(readFileSync(path, "utf8")) as ReleaseManifest;
  if (!m.artifacts?.length) { console.error("清单里没有 artifacts"); return 1; }
  let bad = 0;
  for (const a of m.artifacts) {
    const p = resolve(dirname(path), a.name);
    if (!existsSync(p)) { console.log("❌ 缺文件：" + a.name); bad++; continue; }
    const size = statSync(p).size;
    const ok = verifyArtifact(p, a.sha256) && size === a.size;
    console.log((ok ? "✅ " : "❌ ") + a.name + (ok ? "  sha256 与大小都对得上" : `  哈希或大小不符（本地 ${size} B / 清单 ${a.size} B）`));
    if (!ok) bad++;
  }
  console.log(bad ? `❌ ${bad} 个文件没通过校验 —— 别装，重新下载` : `✅ v${m.version} 产物校验通过`);
  return bad ? 1 : 0;
}

/** 逐文件 SHA-256；不跟随 symlink / junction（别把链接指向的目录也扫进来）。 */
function fingerprintTree(root: string): { files: DataSnapshot["files"]; skipped: string[] } {
  const files: DataSnapshot["files"] = {};
  const skipped: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const key = prefix ? prefix + "/" + name : name;
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) { skipped.push(key); continue; }
      if (st.isDirectory()) { walk(full, key); continue; }
      if (!st.isFile()) { skipped.push(key); continue; }
      files[key] = { sha256: sha256Of(full), size: st.size };
    }
  };
  walk(root, "");
  return { files, skipped };
}

function dataDir(raw: string | undefined): string | null {
  if (!raw) return null;
  const p = resolve(raw);
  return existsSync(p) && statSync(p).isDirectory() ? p : null;
}

function snapshot(rootArg?: string, outArg?: string): number {
  const root = dataDir(rootArg);
  if (!root) { console.error("用法：release.ts snapshot <数据目录> [快照文件]（目录必须存在）"); return 1; }
  const out = resolve(outArg ?? join(process.cwd(), "data-snapshot.json"));
  const { files, skipped } = fingerprintTree(root);
  const snap: DataSnapshot = { version: 1, root, takenAt: new Date().toISOString(), files };
  writeFileSync(out, JSON.stringify(snap, null, 2) + "\n");
  console.log(`已记录 ${Object.keys(files).length} 个文件的 SHA-256 → ${out}`);
  if (skipped.length) console.log(`跳过 ${skipped.length} 个链接/特殊项（未跟随）：` + skipped.slice(0, 5).join(", "));
  console.log("现在可以覆盖安装了；装完先别启动应用，再跑 verify-data。");
  return 0;
}

function verifyData(rootArg?: string, snapArg?: string): number {
  // 只给一个参数且它是文件时，当成「快照文件」而不是数据目录
  if (rootArg && !snapArg) {
    const p = resolve(rootArg);
    if (existsSync(p) && statSync(p).isFile()) { snapArg = rootArg; rootArg = undefined; }
  }
  const snapPath = resolve(snapArg ?? join(process.cwd(), "data-snapshot.json"));
  if (!existsSync(snapPath)) { console.error("快照不存在：" + snapPath + "（升级前先跑 snapshot）"); return 1; }
  let before: DataSnapshot;
  try { before = JSON.parse(readFileSync(snapPath, "utf8")) as DataSnapshot; }
  catch { console.error("快照不是合法 JSON：" + snapPath); return 1; }
  if (before.version !== 1 || !before.files || typeof before.files !== "object") {
    console.error("快照格式不对（需要 version:1 与 files）"); return 1;
  }
  const root = dataDir(rootArg ?? before.root);
  if (!root) { console.error("数据目录不存在：" + resolve(rootArg ?? before.root)); return 1; }
  const { files, skipped } = fingerprintTree(root);
  const after: DataSnapshot = { version: 1, root, takenAt: new Date().toISOString(), files };
  const d = diffDataSnapshots(before, after);
  for (const v of d.violations) console.log("❌ " + v);
  if (d.ok) {
    console.log(`✅ 数据目录未被升级改动（${Object.keys(files).length} 个文件一致${d.ignored.length ? "，" + d.ignored.length + " 个运行产物按白名单忽略" : ""}）`);
  } else {
    console.log(`❌ ${d.violations.length} 处异常 —— 先别启动应用，从备份恢复或重装上一版`);
  }
  if (skipped.length) console.log(`（跳过 ${skipped.length} 个链接/特殊项，未跟随）`);
  return d.ok ? 0 : 1;
}

const [, , cmd, ...args] = process.argv;
const code = cmd === "manifest" ? manifest(args)
  : cmd === "verify" ? verify(args[0])
  : cmd === "snapshot" ? snapshot(args[0], args[1])
  : cmd === "verify-data" ? verifyData(args[0], args[1])
  : cmd === "check" || !cmd ? check()
  : (console.error("未知子命令：" + cmd + "（可用：check | manifest | verify | snapshot | verify-data）"), 1);
process.exitCode = code;
