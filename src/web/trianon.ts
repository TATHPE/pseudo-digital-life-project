/**
 * Trianon（第三方，MIT，shuoshuo）—— 桌面工作台界面，**原样**搬来的单文件。
 *
 * 为什么放成 .ts 而不是静态文件：我们的服务没有静态文件中间件，
 * 而这是**离线自包含**的 10 MB 单文件（图片/字体全内联），读一次进内存即可。
 * 出处与许可见 desktop/trianon/{README.md,LICENSE}。**改它要在 CHANGES.md 里记账。**
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = src/web → 仓库根在两级之上
const FILE = join(HERE, "..", "..", "desktop", "trianon", "trianon.html");

let cached: string | null = null;

/** 桌面工作台页面（首次读盘，之后走内存） */
export function trianonPage(): string {
  if (cached === null) cached = readFileSync(FILE, "utf8");
  return cached;
}
