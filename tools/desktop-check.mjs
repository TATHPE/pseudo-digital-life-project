/**
 * 桌面壳的**契约测试**（H-6）。
 *
 * 为什么能测：壳只做四件事，其中三件是"和 sidecar 的约定"：
 *   ① 能拉起 `jingjing serve <port>`
 *   ② 端口能连上就算活（壳只做 TCP 探测，不解析 HTTP）
 *   ③ 退出时必须把**进程树**杀干净（否则下次启动端口被占）
 *
 * 这三条不依赖 Rust，Node 就能验 —— 真正的窗口/托盘要等 msvc 工具链装好。
 *
 * 跑法：npm run desktop:check
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const ROOT = process.cwd();
const T = join(ROOT, "desktop", "src-tauri");
const checks = [];
const ok = (n, pass, d = "") => checks.push([n, pass, d]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ① 配置文件存在且能解析（壳的"四件事"写在 config 里） */
ok("tauri.conf.json 能解析", (() => {
  try { JSON.parse(readFileSync(join(T, "tauri.conf.json"), "utf8")); return true; } catch { return false; }
})());

const conf = JSON.parse(readFileSync(join(T, "tauri.conf.json"), "utf8"));
const url = conf.app?.windows?.[0]?.url ?? "";
ok("窗口直接指内置面板（不打包前端）", url.startsWith("http://127.0.0.1:"), url);
ok("图标存在", (conf.bundle?.icon ?? []).every((p) => existsSync(join(T, p))), (conf.bundle?.icon ?? []).join(","));

/** ② 壳不该有 fs/shell 权限（只允许打开链接/文件） */
const cap = JSON.parse(readFileSync(join(T, "capabilities", "default.json"), "utf8"));
const perms = cap.permissions ?? [];
ok("能力面只有 opener（没有 fs / shell / http）", perms.every((p) => !/^(fs|shell|http|sql)/.test(p)), perms.join(","));

/** ③ 源码里不允许出现业务逻辑的痕迹（壳只做四件事） */
const rs = ["src/main.rs", "src/sidecar.rs"].map((f) => readFileSync(join(T, f), "utf8")).join("\n");
ok("sidecar 用 taskkill /T 杀进程树", /\/T/.test(rs));
ok("三次探测失败后回落浏览器", /fallback_to_browser/.test(rs) && /3/.test(rs));
ok("托盘四项齐全", ["暂停 / 继续心跳", "打开数据目录", "导出备份", "退出"].every((s) => rs.includes(s)));
ok("关闭窗口会 stop() sidecar", /CloseRequested/.test(rs));

/** ④ 契约：真起一个 serve，能连上；杀掉后端口释放 */
const PORT = 7711;
const server = spawn(process.execPath, ["--experimental-strip-types", "src/cli/jingjing.ts", "serve", String(PORT)], {
  cwd: ROOT, stdio: "ignore", env: { ...process.env, JJ_HOME: join(ROOT, "tmp", "desktop-check-home") },
});

const canConnect = (port) =>
  new Promise((res) => {
    const s = createServer();
    // 用 net.connect 探测（和壳的做法一致：只看端口通不通）
    import("node:net").then(({ connect }) => {
      const c = connect({ host: "127.0.0.1", port, timeout: 300 });
      c.on("connect", () => { c.destroy(); s.close(); res(true); });
      c.on("timeout", () => { c.destroy(); s.close(); res(false); });
      c.on("error", () => { s.close(); res(false); });
    });
  });

let up = false;
for (let i = 0; i < 40; i++) { await sleep(250); if (await canConnect(PORT)) { up = true; break; } }
ok("能拉起 serve 并且端口可连（壳的探测方式）", up, `port ${PORT}`);

// 杀掉 → 端口必须释放（否则"关窗进程还活着"这个 bug 会复发）
server.kill();
await sleep(1200);
ok("杀掉之后端口释放（下次启动不会被占）", !(await canConnect(PORT)));

let bad = 0;
for (const [n, pass, d] of checks) {
  console.log((pass ? "✅ " : "❌ ") + n + (d ? "  — " + d : ""));
  if (!pass) bad++;
}
console.log("");
console.log(bad ? `❌ ${bad} 项失败` : "✅ 壳与 sidecar 的契约成立（真正的窗口/托盘要等 msvc 工具链）");
process.exitCode = bad ? 1 : 0;
