/**
 * 片头（完整档）：**在 dsh-550c-boot 的 550C 骨架上改出来的那一个**。
 *
 * 缘起（2026-11-03）：用户问「你为什么不能在别人的基础上对应着改」。之前两版都是
 * 我照着感觉重写，只能做到"像"。这一版是把原版那份 80KB 的自包含 HTML 拿过来改：
 *
 *   ① 颜色   所有颜色走 CSS 变量（`--amber` / `--red` / `--text` / `--bg`），改 14 个变量
 *            + 扫掉 55 处硬编码色值 → 琥珀/红 变黑白（青色仍然只给她回话的气泡）
 *   ② 文案   军事术语换成我们的语义（550C → 项目名、NODES → TOOLS、DISARM → 待确认）
 *   ③ 数据   **全部接我们的真实量**：静态遥测整块换成 JS 生成（teleBody），
 *            读数来自 window.JJ_BOOT（服务端注入 /health + /api/dossier + /api/capabilities，
 *            拿不到的项一律显示 —）；节点矩阵的 47 改成真实工具数
 *   ④ 假实时 原版那四个 Math.random() 抖动（RSRP/SINR/BLER/密钥轮换）换成真会变的量
 *            （进程运行时长 / 今天 token / 记忆条数 / 检索延迟）—— 随机数是最刺眼的一种编
 *
 * 结构、相位机、窗口系统、动效时序、扫描线一律不碰 —— 那些正是"炫"的来源。
 *
 * 用法：`GET /splash` 返回注入数据后的整页；面板把它放进 `<iframe>`（样式完全隔离），
 * 播完或用户跳过时由页内桥 `postMessage('jjboot-done')` 通知父页面撤掉。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 模板只读一次（80KB，别每次请求都读盘） */
// 开发模式每次读盘：改完 splash.body.html 刷新就能看到，不用重启 serve。
// （踩过：模板缓存着，改了文案还以为没生效 —— 用户看到的就是旧的那份。）
const DEV = process.env.JJ_NO_DESK_TOKEN === "1" || process.env.JJ_DEV === "1";
let cached: string | null = null;
function template(): string {
  if (DEV || cached === null) cached = readFileSync(join(import.meta.dirname, "splash.body.html"), "utf8");
  return cached;
}

/** 片头要显示的数据。**字段拿不到就不传**，前端显示 —（绝不编）。 */
export interface SplashData {
  schema?: string;
  memories?: number;
  stage?: { name: string; count: number };
  docs?: number;
  chunks?: number;
  embed?: string;
  model?: string;
  tokensToday?: string;
  usdToday?: string;
  tools?: number;
  commands?: number;
  skills?: number;
  plugins?: string;
  hooks?: number;
  sidecar?: string;
  uptime?: string;
  degraded?: string;
  latency?: string;
}

/** 把数据注入模板：顶部一行 <script>window.JJ_BOOT=…</script> */
export function renderSplash(data: SplashData): string {
  // 只保留有值的字段（undefined 会让页面显示 undefined）
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null) clean[k] = v;
  // JSON → HTML：`<` 要转义，否则字符串里出现 </script> 会把整页截断
  const json = JSON.stringify(clean).split("<").join(String.fromCharCode(92) + "u003c");
  const tag = "<script>window.JJ_BOOT=" + json + ";</script>";
  return template().replace("<head>", "<head>" + String.fromCharCode(10) + tag);
}
