/**
 * 原子写 + fsync（18 §1.2）
 *
 * 协议：write(tmp) → fsync(tmp) → rename(tmp,target) → fsync(dir)
 * 省掉最后一步是最常见的错：rename 本身也可能没落盘。
 */
import { closeSync, openSync, fsyncSync, renameSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function fsyncDir(dir: string): void {
  // Windows 上无法以只读方式打开目录句柄（EISDIR/EPERM），POSIX 才支持目录 fsync。
  // 所以在 win32 上退化为 no-op，并在 verify 里用「重启后校验」兜底（18 §1.3）。
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function atomicWriteFile(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  const fd = openSync(tmp, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  fsyncDir(dir);
}

/** 追加一行并 fsync（inbox 专用：每轮一次，不能省） */
export function appendLineSync(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeFileSync(fd, line.endsWith("\n") ? line : line + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDir(dirname(path));
}
