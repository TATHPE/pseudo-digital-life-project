#!/usr/bin/env node
/**
 * 开发测试版启动器（2026-11-11）
 *
 * 目的：改仓库里的源码就能立刻看到效果，不跑 `cargo tauri build`、不装 NSIS、
 * 不读 `desktop/bundle-src/app` 那份手工快照。
 *
 * 两种形态：
 *   npm run dev:test            浏览器直连，零编译（默认）
 *   npm run desktop:dev:test    Tauri 原生窗口，首次增量编译 Rust，之后不再打包
 *
 * 三条纪律：
 *   ① 只读仓库 src/：显式设 JJ_PROJECT_ROOT / JJ_NODE，且 main.rs 不再用包内快照覆盖。
 *   ② 数据隔离到 <home>（默认 data2test），绝不碰真实 data/ 或 Roaming 用户数据。
 *   ③ 只绑 127.0.0.1。浏览器形态用 JJ_NO_DESK_TOKEN=1 关掉桌面令牌闸门，
 *      这是本地回环专用的开发开关，别把它配到 0.0.0.0 上。
 *
 * 生效方式：
 *   src/web/ui/*.js 等静态资源 —— 服务端每次请求读盘且 no-store，改完刷新浏览器即可。
 *   src/**.ts 后端 —— --watch 自动重启 node，重启完刷新页面即可。
 *   desktop/src-tauri/**.rs —— 只在桌面形态下需要重新 `cargo tauri dev`（增量编译）。
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const desktop = flag("--desktop");
const port = Number(option("port", "7799"));
const home = resolve(ROOT, option("home", "data2test"));
const watch = !flag("--no-watch") && !desktop;
const open = !flag("--no-open");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`端口不合法：${option("port", "7799")}`);
  process.exit(1);
}

function version(exe) {
  try {
    return execFileSync(exe, ["--version"], { encoding: "utf8", timeout: 6000 }).trim();
  } catch {
    return null;
  }
}
function major(v) {
  const m = /^v?(\d+)/.exec(v ?? "");
  return m ? Number(m[1]) : 0;
}

/** 项目 engines 要求 Node >= 24；PATH 上常见的 22 会让 node:sqlite 变成实验行为。 */
function findNode24() {
  const candidates = [
    process.env.JJ_NODE,
    join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node.exe"),
    join(ROOT, "desktop", "bundle-src", "node", "node.exe"),
    process.execPath,
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p) && major(version(p)) >= 24) return p;
  }
  return null;
}

const node = findNode24();
if (!node) {
  console.error("找不到 Node >= 24；项目 engines 要求 >=24（node:sqlite 在 22 仍是实验性）。");
  console.error("装一个 Node 24，或用 JJ_NODE=<绝对路径> 显式指定。");
  process.exit(1);
}

mkdirSync(home, { recursive: true });

const baseEnv = {
  ...process.env,
  JJ_HOME: home,
  JJ_NODE: node,
  JJ_PROJECT_ROOT: ROOT,
  JJ_BIND: "127.0.0.1",
  JJ_PARENT_PID: "",
};
delete baseEnv.JJ_WHERE_FILE;

let child;
if (desktop) {
  const cargoBin = join(homedir(), ".cargo", "bin");
  const cargo = [
    process.env.CARGO,
    join(cargoBin, "cargo.exe"),
    join(cargoBin, "cargo"),
    "cargo",
  ].filter(Boolean).find((p) => p === "cargo" || existsSync(p));
  if (!cargo) {
    console.error("找不到 cargo：桌面窗口形态需要 Rust 工具链。改用默认浏览器形态（npm run dev:test）。");
    process.exit(1);
  }
  console.log("[测试版·桌面窗口] 项目根 " + ROOT);
  console.log("[测试版·桌面窗口] 数据   " + home + "（隔离，不碰真实库）");
  console.log("[测试版·桌面窗口] Node   " + version(node) + " · " + node);
  console.log("[测试版·桌面窗口] 只做一次增量编译；之后改 src/ 重启窗口即可，不用打 NSIS 包。");
  console.log("[测试版·桌面窗口] Ctrl+C 退出。\n");
  child = spawn(cargo, ["tauri", "dev"], {
    cwd: join(ROOT, "desktop", "src-tauri"),
    env: { ...baseEnv, PATH: `${cargoBin}${delimiter}${process.env.PATH ?? ""}` },
    stdio: "inherit",
  });
} else {
  const nodeArgs = [
    ...(watch ? ["--watch"] : []),
    "--experimental-strip-types",
    "src/cli/jingjing.ts", "serve", String(port),
  ];
  const url = `http://127.0.0.1:${port}/`;
  console.log("[测试版·浏览器] 项目根 " + ROOT);
  console.log("[测试版·浏览器] 数据   " + home + "（隔离，不碰真实库）");
  console.log("[测试版·浏览器] Node   " + version(node) + " · " + node);
  console.log("[测试版·浏览器] 地址   " + url);
  console.log("[测试版·浏览器] 后端   " + (watch ? "watch 自动重启" : "不自动重启（--no-watch）"));
  console.log("[测试版·浏览器] 前端   src/web/ui/*.js 刷新即生效（每次读盘 + no-store）");
  console.log("[测试版·浏览器] 安全   只绑 127.0.0.1、令牌闸门已关；别改 JJ_BIND。Ctrl+C 退出。\n");
  child = spawn(node, nodeArgs, {
    cwd: ROOT,
    env: { ...baseEnv, JJ_NO_DESK_TOKEN: "1" },
    stdio: "inherit",
  });
  if (open) {
    setTimeout(() => {
      const cmd = process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
      try {
        spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
      } catch { /* 没有桌面环境就算了，地址已经打印 */ }
    }, 1500);
  }
}

const forward = (sig) => { try { child.kill(sig); } catch { /* 已退出 */ } };
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code) => { process.exitCode = code ?? 0; });
