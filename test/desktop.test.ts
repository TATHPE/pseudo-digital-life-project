import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * H-6 桌面壳：不验"窗口能开"（那要 msvc 工具链），只验**壳的形状**。
 * 壳只做四件事，多一件都是越界 —— 所以这里断言它没有业务能力。
 */
const T = join(process.cwd(), "desktop", "src-tauri");
const read = (p: string) => readFileSync(join(T, p), "utf8");

test("H-6 壳的窗口指向 /desk（桌面工作台），不打包前端", () => {
  const conf = JSON.parse(read("tauri.conf.json")) as { app: { windows: Array<{ url: string }> } };
  assert.match(conf.app.windows[0]!.url, /^http:\/\/127\.0\.0\.1:\d+\/desk$/);
});

test("H-6 壳没有 fs / shell / http 权限（不然它就成了第二条能力路径）", () => {
  const cap = JSON.parse(read("capabilities/default.json")) as { permissions: string[] };
  for (const p of cap.permissions) {
    assert.ok(!/^(fs|shell|http|sql)/.test(p), `壳不该有 ${p} 权限`);
  }
});

test("H-6 壳只做四件事：拉起 / 探测与回落 / 托盘 / 退出杀进程", () => {
  const src = read("src/main.rs") + read("src/sidecar.rs");
  assert.match(src, /Sidecar::start/, "要拉起 sidecar");
  assert.match(src, /wait_healthy/, "要健康探测");
  assert.match(src, /fallback_to_browser/, "三次失败要回落浏览器");
  assert.match(src, /taskkill/, "Windows 上要杀进程树");
  assert.match(src, /CloseRequested/, "关窗要停 sidecar");
  // 托盘四项
  for (const s of ["暂停 / 继续心跳", "打开数据目录", "导出备份", "退出"]) assert.ok(src.includes(s), s);
});

test("H-6 壳里不许出现记忆业务（它不该理解 memories / decay）", () => {
  const src = read("src/main.rs") + read("src/sidecar.rs");
  for (const bad of ["memories", "decay", "nightly", "embedding"]) {
    assert.ok(!src.toLowerCase().includes(bad), `壳里不该出现 ${bad}`);
  }
});

test("H-6 图标文件在（打包必需）", () => {
  const conf = JSON.parse(read("tauri.conf.json")) as { bundle: { icon: string[] } };
  for (const p of conf.bundle.icon) assert.ok(existsSync(join(T, p)), p);
});

test("H-6 壳把 pid 传给 sidecar，serve 挂了看门狗（硬杀也不留孤儿）", async () => {
  const { readFileSync } = await import("node:fs");
  const rs = readFileSync(join(T, "src/sidecar.rs"), "utf8");
  assert.match(rs, /JJ_PARENT_PID/, "壳要把自己的 pid 传下去");
  const cli = readFileSync(join(process.cwd(), "src/cli/jingjing.ts"), "utf8");
  assert.match(cli, /JJ_PARENT_PID/, "serve 要按它挂看门狗");
  assert.match(cli, /process\.kill\(parentPid, 0\)/, "看门狗用 signal 0 探活");
});

test("H-6 探测预算够 Node 启动（≥8 秒），不误判「起不来」", async () => {
  const { readFileSync } = await import("node:fs");
  const rs = readFileSync(join(T, "src/sidecar.rs"), "utf8");
  const m = rs.match(/for _ in 0\.\.(\d+)/);
  assert.ok(m, "要有探测循环");
  const attempts = Number(m![1]);
  assert.ok(attempts * 500 >= 8000, `探测预算只有 ${attempts * 500}ms —— Node 起 serve 要 3–4 秒`);
});

test("H-6 桌面工作台：/desk 提供 Trianon（同源、离线、MIT）", async () => {
  const { readFileSync } = await import("node:fs");
  // ① 单文件真的在仓库里（10 MB，自包含）
  const file = join(process.cwd(), "desktop", "trianon", "trianon.html");
  assert.ok(existsSync(file));
  const html = readFileSync(file, "utf8");
  assert.match(html, /<title>Trianon/, "要有 Trianon 的标题（证明整块搬的，不是我们重画的）");
  // ② 许可与出处要跟着文件走（MIT 底线）
  assert.ok(existsSync(join(process.cwd(), "desktop", "trianon", "LICENSE")), "MIT LICENSE 必须随附");
  assert.ok(existsSync(join(process.cwd(), "desktop", "trianon", "README.md")), "出处与改动记账");
  // ③ 服务端用 /desk 提供，壳的窗口指向它
  const srv = readFileSync(join(process.cwd(), "src", "web", "server.ts"), "utf8");
  assert.match(srv, /url\.pathname === "\/desk"/);
  const conf = JSON.parse(read("tauri.conf.json")) as { app: { windows: Array<{ url: string }> } };
  assert.match(conf.app.windows[0]!.url, /:7700\/desk$/);
});

test("H-6 内置面板仍然在 /（桌面工作台不是替代品）", async () => {
  const { readFileSync } = await import("node:fs");
  const srv = readFileSync(join(process.cwd(), "src", "web", "server.ts"), "utf8");
  assert.match(srv, /url\.pathname === "\/desk"/);
  assert.match(srv, /url\.pathname === "\/"\) \{/, "`/` 必须还在 —— 删掉桌面壳仍是网页");
});
