/**
 * 卸载前守卫（2026-11-14 P2 产品化）。**只读，不删任何东西。**
 *
 * 真坑见 desktop/DEV.md 三条风险之一：NSIS 按文件清单卸载，Windows 目录 junction
 * 会被当成普通目录递归删。本机安装版 `D:\Apps\PDLP\app\src` 正是指向仓库的 junction，
 * 直接卸载可能把 `D:\LLM\jingjing\src` 一起删掉。
 *
 * 用法（卸载前跑一次）：
 *   node --experimental-strip-types tools/uninstall-guard.ts "D:\Apps\PDLP"
 *   npm run uninstall:guard -- "D:\Apps\PDLP"
 * 退出码：0 = 可以按正常流程卸载；1 = 有链接/内嵌数据，先按输出处理；2 = 目录不存在。
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";

/** 列出 root 下所有链接（junction / symlink），**不跟随**，所以不会走进被指向的目录。 */
export function scanLinks(root: string, maxDepth = 8): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) { out.push(relative(root, p).split(sep).join("/")); continue; }
      if (st.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out.sort();
}

/** 用户数据若躺在安装目录里，卸载会一并删掉 —— 必须报出来。
 *  注意 `app/persona` 是随包分发的人格模板，不是用户数据，卸载删掉它是对的，别误报。 */
export function dataInsideInstall(root: string): string[] {
  const candidates = [
    "data", "app/data", "memory.db", "app/memory.db",
    "inbox", "app/inbox", "secrets", "app/secrets",
  ];
  return candidates.filter((p) => existsSync(join(root, p)));
}

export interface UninstallAssessment {
  root: string;
  links: string[];
  dataInside: string[];
  safe: boolean;
  advice: string[];
}

/** 纯函数：给卸载前的结论与可执行步骤，便于测试和其它工具复用。 */
export function assessUninstall(root: string): UninstallAssessment {
  const links = scanLinks(root);
  const dataInside = dataInsideInstall(root);
  const advice: string[] = [];
  if (links.length) {
    advice.push("检测到链接（junction / symlink）—— 卸载器可能沿链接递归删到目标目录，先把链接回滚成实体目录：");
    for (const l of links) advice.push("  · " + l);
    advice.push("  PowerShell（纯改名，别用 Remove-Item -Recurse 删 junction）：");
    const first = links[0] ?? "app/src";
    advice.push("    Rename-Item -LiteralPath '" + join(root, first) + "' -NewName '" + (first.split("/").pop() ?? "src") + ".test-link'");
    advice.push("    再把安装版自带的 src.release-* 备份改回 src（本机备份名见 desktop/DEV.md）");
    advice.push("  完整回滚步骤见 desktop/DEV.md。");
  }
  if (dataInside.length) {
    advice.push("安装目录内含数据（" + dataInside.join(", ") + "）—— 卸载前先导出备份，并把数据目录搬到安装目录之外。");
  }
  advice.push("默认策略：卸载只删安装目录，外部数据目录（D:\\Pseudo Digital Life Project\\data 等）原样保留。");
  advice.push("要彻底清干净：设置 → 工作区域 → 清空重来（会先自动备份），别靠卸载器。");
  return { root, links, dataInside, safe: links.length === 0 && dataInside.length === 0, advice };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const root = resolve(process.argv[2] ?? "D:/Apps/PDLP");
  if (!existsSync(root)) {
    console.error("安装目录不存在：" + root);
    process.exitCode = 2;
  } else {
    const a = assessUninstall(root);
    console.log("安装目录：" + a.root);
    console.log("链接：" + (a.links.length ? a.links.join(", ") : "无") + " | 内嵌数据：" + (a.dataInside.join(", ") || "无"));
    for (const line of a.advice) console.log(line);
    console.log(a.safe
      ? "✅ 可以按正常流程卸载（外部数据目录仍会保留）"
      : "⚠️ 先按上面处理，再卸载");
    process.exitCode = a.safe ? 0 : 1;
  }
}
