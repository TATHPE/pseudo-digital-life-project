/**
 * 工作区域（数据放哪）：2026-11-06。
 *
 * 背景：安装版以前把一切塞进 `%APPDATA%\...\data`（C 盘）。
 * 现在壳启动时读 `where.json`；这里负责给它读写、以及"换地方时要不要把旧数据搬过去"。
 *
 * 约定：
 *   · where.json 由壳通过 `JJ_WHERE_FILE` 告诉 Node（开发态没有这个变量 → 一切按老路子）
 *   · dataRoot 指"工作区域"，真正的数据在 `<dataRoot>/data`
 *   · 搬迁是**复制**：先复制、校验文件数，再写指针；失败就原样留着，不动旧目录
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const PRODUCT_DIR = "Pseudo Digital Life Project";

export function whereFilePath(): string | null {
  const p = process.env.JJ_WHERE_FILE;
  return p && p.trim() ? p : null;
}

/** 读当前工作区域；没有指针就返回 null（= 用默认，即 AppData 或项目 data/） */
export function readRoot(): string | null {
  const f = whereFilePath();
  if (!f || !existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as { dataRoot?: string };
    const p = String(j.dataRoot ?? "").trim();
    return p || null;
  } catch {
    return null;
  }
}

/** 默认工作区域：第一个非 C 盘 + 产品名目录（和壳里的规则一致） */
export function defaultRoot(): string {
  for (const letter of ["D", "E", "F", "G"]) {
    const base = `${letter}:\\`;
    try {
      if (statSync(base).isDirectory()) return join(base, PRODUCT_DIR);
    } catch { /* 这块盘不存在 */ }
  }
  return PRODUCT_DIR;
}

export function writeRoot(root: string): void {
  const f = whereFilePath();
  if (!f) throw new Error("E_NO_WHERE_FILE: 这个运行方式没有工作区域指针（开发态请直接改 JJ_HOME）");
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ dataRoot: root }, null, 2));
}

function countFiles(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) n += countFiles(p);
    else n++;
  }
  return n;
}

export interface MoveReport {
  ok: boolean;
  from: string;
  to: string;
  files: number;
  why?: string;
}

/**
 * 把 `<oldRoot>/data` 复制到 `<newRoot>/data`。
 * 不删旧的（用户后悔还能回去），只做"复制 + 校验文件数"。
 */
export function moveData(oldHome: string, newRoot: string): MoveReport {
  const src = oldHome;
  const dst = join(newRoot, "data");
  if (!existsSync(src)) return { ok: true, from: src, to: dst, files: 0 };
  if (resolve(src) === resolve(dst)) return { ok: true, from: src, to: dst, files: 0 };
  if (existsSync(dst)) {
    const has = readdirSync(dst).length;
    if (has > 0) return { ok: false, from: src, to: dst, files: 0, why: "E_DEST_NOT_EMPTY: 目标已经有数据了，先清空或换个目录" };
  }
  try {
    mkdirSync(newRoot, { recursive: true });
    cpSync(src, dst, { recursive: true, errorOnExist: false, force: false });
    const a = countFiles(src);
    const b = countFiles(dst);
    if (a > b) return { ok: false, from: src, to: dst, files: b, why: `E_COPY_SHORT: 只复制了 ${b}/${a} 个文件` };
    return { ok: true, from: src, to: dst, files: b };
  } catch (e) {
    return { ok: false, from: src, to: dst, files: 0, why: String((e as Error).message).slice(0, 200) };
  }
}

export function validRoot(p: string): { ok: true; root: string } | { ok: false; why: string } {
  const raw = String(p ?? "").trim().replace(/^"|"$/g, "");
  if (!raw) return { ok: false, why: "E_EMPTY: 路径不能是空的" };
  if (!isAbsolute(raw)) return { ok: false, why: "E_NOT_ABS: 要绝对路径，例如 D:\\Pseudo Digital Life Project" };
  const root = resolve(raw);
  if (/^[a-z]:\\?$/i.test(root)) return { ok: false, why: "E_ROOT_DIR: 不能直接用盘符根目录，请建一个子目录" };
  return { ok: true, root };
}

/** 清空时**只能标记、不能真删**：Windows 上 DB 正被进程打开着。
 *  真正动手在下次启动、openDb 之前（见 applyPendingWipe）。 */
export const WIPE_MARK = ".wipe-pending";

export function markWipe(home: string, backup: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, WIPE_MARK), JSON.stringify({ backup, at: new Date().toISOString() }, null, 2));
}

export interface WipeReport { applied: boolean; backup: string | null; removed: string[]; failed: string[] }

/** 启动时（openDb 之前）调用：按标记把记忆与人格清掉。 */
export function applyPendingWipe(home: string): WipeReport {
  const mark = join(home, WIPE_MARK);
  const out: WipeReport = { applied: false, backup: null, removed: [], failed: [] };
  if (!existsSync(mark)) return out;
  try { out.backup = (JSON.parse(readFileSync(mark, "utf8")) as { backup?: string }).backup ?? null; } catch { /* 标记坏了也照删 */ }
  const targets = ["memory.db", "memory.db-wal", "memory.db-shm", "persona", "journal", "autobiography", "drafts", "session.json", "setup.json"];
  for (const t of targets) {
    const p = join(home, t);
    if (!existsSync(p)) continue;
    try { rmSync(p, { recursive: true, force: true }); out.removed.push(t); }
    catch { out.failed.push(t); }
  }
  if (!out.failed.length) { try { rmSync(mark, { force: true }); } catch { /* 下次再来 */ } }
  out.applied = true;
  return out;
}