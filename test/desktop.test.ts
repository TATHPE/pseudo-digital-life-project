import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTEBOOK } from "../src/web/notebook.ts";
import { WELCOME } from "../src/web/welcome.ts";

/**
 * H-6 桌面壳：不验"窗口能开"（那要 msvc 工具链），只验**壳的形状**。
 * 壳只做四件事，多一件都是越界 —— 所以这里断言它没有业务能力。
 */
const T = join(process.cwd(), "desktop", "src-tauri");
const read = (p: string) => readFileSync(join(T, p), "utf8");


test("H-6 壳没有 fs / shell / http 权限（不然它就成了第二条能力路径）", () => {
  const cap = JSON.parse(read("capabilities/default.json")) as { permissions: string[] };
  for (const p of cap.permissions) {
    assert.ok(!/^(fs|shell|http|sql)/.test(p), `壳不该有 ${p} 权限`);
  }
});

test("H-6 壳只做四件事：拉起 / 探测与报错 / 托盘 / 退出杀进程", () => {
  const src = read("src/main.rs") + read("src/sidecar.rs");
  assert.match(src, /Sidecar::start/, "要拉起 sidecar");
  assert.match(src, /try_ready/, "要健康探测");
  // 用户 2026-11-01：不做浏览器回落，也不做接 API 自修 —— 真失败就只弹报错
  assert.match(src, /show_boot_error/, "真失败要把窗口换成错误页");
  assert.ok(!src.includes("fallback_to_browser"), "回落浏览器那条路已经删了");
  assert.ok(!src.includes("xdg-open"), "壳不该再打开系统浏览器");
  assert.match(src, /taskkill/, "Windows 上要杀进程树");
  assert.match(src, /CloseRequested/, "关窗要停 sidecar");
  // 托盘四项
  for (const s of ["暂停 / 继续心跳", "打开数据目录", "导出备份", "退出"]) assert.ok(src.includes(s), s);
});

test("H-6 窗口指向我们自己的面板 /（不是 /desk）", () => {
  const src = read("src/main.rs");
  assert.ok(src.includes("try_ready()"), "窗口地址要用 sidecar 探测到的端口");
  assert.ok(src.includes("?k="), "导航要带一次性令牌（否则服务端 403）");
  assert.ok(/127\.0\.0\.1:\{\}\/\?k=\{\}/.test(src), "端口与令牌都来自 .desk.json，不许写死");
  assert.ok(!src.includes("{}/desk"), "Trianon 那条线不再进壳（注释里提到它没关系）");
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

test("H-6 开机冷启动不误判：慢也继续等，且不杀掉刚要起来的 sidecar", () => {
  // 2026-11-14：原来 wait_healthy 是 24×500ms 一次性预算，到点就判「起不来」；
  // 而失败分支里 sc Drop → stop() → taskkill，把刚要监听的 node 杀掉 ——
  // 用户开机第一次点必弹「找不到服务」，第二次才正常。这条守住新的启动握手。
  const main = read("src/main.rs");
  const side = read("src/sidecar.rs");
  assert.match(main, /loop \{/, "探测要持续循环，不是一次预算用完就判死");
  assert.match(main, /try_ready\(\)/, "每轮重新读 .desk.json 并探端口");
  assert.match(main, /exited\(\)/, "要区分「慢」和「子进程真退了」");
  assert.match(main, /secs >= 300/, "要有最终兜底（5 分钟）");
  assert.ok(!/wait_healthy/.test(main + side), "不许退回一次预算到点就报错的写法");
  // 句柄必须在探测循环**之前**托管，否则失败分支的 Drop 会把 node 杀掉
  const hostAt = main.indexOf("*st.sidecar.lock().unwrap() = Some(Sidecar::start");
  const loopAt = main.indexOf("loop {");
  assert.ok(hostAt >= 0 && hostAt < loopAt, "sidecar 句柄要先交给 AppState");
  assert.match(main, /BOOT SLOW 30s/, "慢要写日志 + 给排障页");
  assert.match(main, /show_boot_waiting/, "冷启动要有「还在准备」提示");
});



test("H-6 sidecar 输出落盘（错误页让看的 serve.log 必须真的存在）", () => {
  const rs = read("src/sidecar.rs");
  assert.match(rs, /serve\.log/, "stdout/stderr 要写 data/logs/serve.log");
  assert.match(rs, /\.stdout\(out\)\.stderr\(err\)/, "不许再把 serve 的输出丢进 null()");
  assert.match(rs, /serve\.prev\.log/, "每次启动轮转，别让日志无限增长");
});

test("启动不许白屏：窗口第一帧必须是黑的（tauri.conf + 预热页 + html 底色）", async () => {
  const conf = JSON.parse(readFileSync(join(T, "tauri.conf.json"), "utf8"));
  const win = conf.app.windows[0];
  // 这条是"写了没接上"的原始事故：assets/index.html 黑底页早就存在，但 url 一直是 about:blank
  assert.notEqual(win.url, "about:blank", "不许用 about:blank（WebView2 默认底色是白的）");
  assert.equal(win.url, "index.html", "第一帧加载 assets/index.html（黑底预热页）");
  assert.ok(
    existsSync(join(T, "assets/index.html")),
    "这个文件必须真的存在"
  );
  assert.equal(String(win.backgroundColor).toLowerCase(), "#050706", "窗口/WebView 底色设成黑的");

  // 预热页自己也要是黑的，且不依赖任何外部资源
  const warm = readFileSync(join(T, "assets/index.html"), "utf8");
  assert.ok(/background:\s*#050706/.test(warm), "预热页黑底");
  assert.ok(!/https?:\/\//.test(warm.replace(/<!--[\s\S]*?-->/g, "")), "预热页不许拉外部资源");
  assert.ok(warm.includes("PSEUDO DIGITAL"), "预热页显示项目名");

  // 面板自己也给 html 底色（只给 body 的话导航首帧会闪白）
  assert.ok(NOTEBOOK.includes("background:var(--void)"), "记录本要有底色");
  assert.ok(String(WELCOME).includes("html{background:#050706;}"), "引导页 html 要有底色");
});
