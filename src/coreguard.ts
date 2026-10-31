/**
 * 记忆核心的**结构性保护**（用户 2026-10-31 定的边界）：
 *
 * > 除了记忆核心它不能动外，其他的，开放完全权限后它都能动。
 *
 * 所以「哪些不能动」必须是一条**硬清单**，而不是靠 policy 的 glob 碰运气：
 *   · 记忆库本体（memory.db 及 -wal/-shm）—— 改它等于改历史，必须走 store/verbs
 *   · 密钥（secrets*）—— 授权跑命令 ≠ 授权拿钥匙
 *   · 人格六块（persona/）—— 改设定要开新一代（H-5），不许绕过
 *   · 事件流（inbox/）—— append-only 的时间线，删一行就是抹掉"发生过什么"
 *   · 回收站与快照（trash/ snapshots/）—— 那是兜底本身，抹掉它就没得回滚
 *
 * 其余一切（workspace、docs、项目源码、配置、临时目录）都可以动。
 */
import { relative } from "node:path";
import { realpathish } from "./verbs.ts";

/** 相对 home 的受保护前缀（小写比较、正斜杠） */
export const CORE_PROTECTED = [
  "memory.db",
  "memory.db-wal",
  "memory.db-shm",
  "secrets",
  "persona",
  "inbox",
  "trash",
  "snapshots",
] as const;

const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

/**
 * 这个路径是不是"记忆核心"。
 * 用 realpath 解析过再比：否则 `workspace/../data/memory.db` 或目录联接能绕过去。
 */
export function isCorePath(home: string, target: string): boolean {
  let rel: string;
  try {
    rel = norm(relative(realpathish(home), realpathish(target)));
  } catch {
    rel = norm(relative(home, target));
  }
  if (!rel || rel.startsWith("..")) return false;   // 不在 home 里：由 safePath 管
  // 允许 `data/` 前缀（home 可能就是 data/，也可能 home 下有 data/）
  const bare = rel.startsWith("data/") ? rel.slice("data/".length) : rel;
  return CORE_PROTECTED.some((p) => bare === p || bare.startsWith(p + "/"));
}

/** 给人看的名字（错误信息里要用"记忆库 / 人格 / 事件流"这种话，不是路径） */
export function coreLabel(p: string): string {
  const bare = norm(p);
  if (bare.startsWith("memory.db")) return "记忆库本体";
  if (bare.startsWith("secrets")) return "密钥";
  if (bare.startsWith("persona")) return "人格设定";
  if (bare.startsWith("inbox")) return "事件流（append-only）";
  if (bare.startsWith("trash")) return "回收站";
  if (bare.startsWith("snapshots")) return "写前快照";
  return "受保护区域";
}
