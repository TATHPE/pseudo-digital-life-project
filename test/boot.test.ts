import { test } from "node:test";
import assert from "node:assert/strict";
import { bootOverlay, PROJECT_NAME, SPLASH_MODES, splashMode } from "../src/web/boot.ts";
import { PAGE } from "../src/web/page.ts";
import { WELCOME } from "../src/web/welcome.ts";

test("开机片头：两块页面都有，而且整段 ≤3.6s 会自己收尾", () => {
  const b = bootOverlay("simple");
  assert.ok(b.includes('id="jjboot"'), "遮罩要在 HTML 里（首帧就盖住，不等 JS）");
  assert.ok(b.includes("pointerdown"), "点一下要能跳过");
  assert.ok(b.includes("Escape"), "Esc 要能跳过");
  assert.match(b, /setTimeout\(off,slow\?1600:3600\)/, "自动收尾：正常 3.6s / 降级 1.6s");
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
  assert.ok(/prefers-reduced-motion[\s\S]{0,600}\.jjb-ch\{animation:none;opacity:1;filter:none/.test(b), "降级也要直接给出清晰的字");
});

test("片头的主视觉是项目名，不是图标（用户 2026-11-02 明确要求）", () => {
  const full = bootOverlay("full");
  const simple = bootOverlay("simple");
  assert.equal(PROJECT_NAME, "PSEUDO DIGITAL LIFE PROJECT");
  for (const b of [full, simple]) {
    assert.ok(b.includes("jjb-title"), "要有标题块");
    assert.ok(!b.includes("<svg"), "开场不要图标（不再画鲸尾）");
    assert.ok(!b.includes("jjb-p{"), "也不该留着描边用的那条 CSS");
    const text = b.replace(/<[^>]+>/g, "").split("&nbsp;").join(" ");
    assert.ok(text.includes("PSEUDO DIGITAL"), "第一行是 PSEUDO DIGITAL");
    assert.ok(text.includes("LIFE PROJECT"), "第二行是 LIFE PROJECT");
  }
});

test("开机片头：片段里不许有反引号或 ${（它会被拼进模板字符串）", () => {
  const b = bootOverlay();
  assert.ok(!b.includes(String.fromCharCode(96)), "不许有反引号");
  assert.ok(!b.includes("${"), "不许有 ${");
});

test("两档：完整档是三栏 HUD（遥测 / 终端 / 节点矩阵），简易档只有标题", () => {
  const full = bootOverlay("full");
  const simple = bootOverlay("simple");
  for (const id of ["jjbTel", "jjbTerm", "jjbTools", "jjbMx", "jjbPct"]) {
    assert.ok(full.includes(id), "完整档要有 " + id);
    assert.ok(!simple.includes(id), "简易档不该有 " + id);
  }
  assert.ok(full.includes("TELEMETRY") && full.includes("CORE TERMINAL") && full.includes("NODE MATRIX"));
  assert.ok(full.includes("/api/dossier") && full.includes("/health") && full.includes("/api/capabilities"),
    "三栏的数据都必须来自真实接口");
  assert.ok(full.includes("jjb-ready"), "完整档结尾要有 READY");
  // 自动收尾：完整 10.2s / 简易 3.6s（都能点一下跳过）
  assert.ok(full.includes("setTimeout(off,slow?2400:11000)"), "完整档 11s 自动收尾");
  assert.ok(simple.includes("setTimeout(off,slow?1600:3600)"), "简易档 3.6s 自动收尾");
});

test("完整档不会编数字：每个数字都从接口来，拿不到就整行不出现", () => {
  const full = bootOverlay("full");
  // 遥测行只能通过 T(key, value) 写入，且都被 if 包着
  const telAt = full.indexOf("T('");
  assert.ok(telAt > 0, "遥测行要存在");
  const hard = full.indexOf("T('MEMORIES','");
  if (hard >= 0) {
    const next = full.charCodeAt(hard + "T('MEMORIES','".length);
    assert.ok(next < 48 || next > 57, "MEMORIES 后面不许直接跟写死的数字");
  }
  assert.ok(full.includes("if(h.memories)T("), "有值才写这一行");
  assert.ok(full.includes("if(ctx.docs)T("), "有值才写这一行");
  // 终端行：L(...) 的头部不许出现三位以上裸数字
  const calls = full.split("L(").slice(1);
  for (const c of calls) {
    const head = c.slice(0, 70).split("127.0.0.1").join("");
    const m = head.match(new RegExp("[0-9]{3,}"));
    assert.ok(!m, "终端行里不许有写死的数字：" + head.slice(0, 40));
  }
});
test("片头档位：off / simple / full 三档，默认 full（配置说了算，不靠'配没配完'猜）", () => {
  assert.deepEqual([...SPLASH_MODES], ["off", "simple", "full"]);
  assert.equal(splashMode(undefined), "full", "没配过就是完整档（用户 2026-11-02 要的）");
  assert.equal(splashMode({ splash: "off" }), "off");
  assert.equal(splashMode({ splash: "simple" }), "simple");
  assert.equal(splashMode({ splash: "FULL" }), "full", "大小写不敏感");
  assert.equal(splashMode({ splash: "乱写的" }), "full", "认不出来就 full，别让人以为坏了");
});
