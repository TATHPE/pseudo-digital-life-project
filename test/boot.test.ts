import { test } from "node:test";
import assert from "node:assert/strict";
import { bootOverlay, WHALE_D } from "../src/web/boot.ts";
import { PAGE } from "../src/web/page.ts";
import { WELCOME } from "../src/web/welcome.ts";

test("开机片头：两块页面都有，而且整段 ≤3.4s 会自己收尾", () => {
  const b = bootOverlay("simple");
  assert.ok(b.includes('id="jjboot"'), "遮罩要在 HTML 里（首帧就盖住，不等 JS）");
  assert.ok(b.includes("pointerdown"), "点一下要能跳过");
  assert.ok(b.includes("Escape"), "Esc 要能跳过");
  assert.match(b, /setTimeout\(off,slow\?1800:3400\)/, "自动收尾：正常 3.4s / 降级 1.8s");
  assert.ok(PAGE.includes("<!--BOOT-->"), "主面板留了片头占位（档位由 server 决定）");
  assert.ok(String(WELCOME).includes("<!--BOOT-->"), "首启引导页也要播（那是第一屏）");
});

test("开机片头：只用黑白（青色是她的回话气泡专用）", () => {
  const b = bootOverlay();
  assert.ok(!/--cyan|#0f97a4|#7fe6f2/i.test(b), "片头里不许出现青色");
  assert.ok(!/--amber|#ffb454|#e8a020/i.test(b), "也不许出现琥珀（那是蓝色鲸鲸之外的别人家的语言）");
  assert.ok(b.includes("#e9f0f2"), "用我们的白");
});

test("开机片头：prefers-reduced-motion 有单独一条路（不描边、不呼吸，但状态还在）", () => {
  const b = bootOverlay();
  assert.ok(b.includes("prefers-reduced-motion: reduce"), "要有降级分支");
  assert.ok(/prefers-reduced-motion[\s\S]{0,200}animation:none/.test(b), "降级里要关掉动画");
  assert.ok(/prefers-reduced-motion[\s\S]{0,200}fill:#e9f0f2/.test(b), "降级也要给出成品形状");
});

test("开机片头的鲸尾和站点图标是同一个 path（防漂移）", () => {
  const pageD = PAGE.match(/<symbol id="whale" viewBox="[^"]+"><path[^>]*d="([^"]+)"/)?.[1];
  assert.ok(pageD, "page.ts 里要有 #whale symbol");
  assert.equal(WHALE_D, pageD, "boot.ts 的 WHALE_D 必须和 symbol 的 d 完全一致");
});

test("开机片头：片段里不许有反引号或 ${（它会被拼进模板字符串）", () => {
  const b = bootOverlay();
  assert.ok(!b.includes(String.fromCharCode(96)), "不许有反引号");
  assert.ok(!b.includes("${"), "不许有 ${");
});

test("两档：完整档多一段真实读数（来自 /api/dossier），简易档没有", () => {
  const full = bootOverlay("full");
  const simple = bootOverlay("simple");
  assert.ok(full.includes("jjbLines"), "完整档要有读数区");
  assert.ok(!simple.includes("jjbLines"), "简易档不该有读数区");
  assert.ok(full.includes("/api/dossier"), "读数必须来自真实接口");
  assert.ok(full.includes("READY"), "完整档结尾要有 READY");
  // 自动收尾时长：完整 9s / 简易 3.4s（都能点一下跳过）
  assert.match(full, /setTimeout\(off,slow\?2200:9000\)/);
  assert.match(simple, /setTimeout\(off,slow\?1800:3400\)/);
});

test("完整档不会编数字：拿不到就跳过那一行", () => {
  const full = bootOverlay("full");
  // 只允许"有值才 row(...)"的写法，不许出现写死的读数常量
  assert.ok(!/row\('MEMORIES','\d/.test(full), "不许把条数写死");
  assert.ok(full.includes("if(c.memories)"), "有值才显示");
  assert.ok(full.includes("if(c.docs)"), "有值才显示");
});
