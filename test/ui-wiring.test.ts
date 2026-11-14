import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 2026-11-11 小补全：四组已实现但漏接的接口接进记录本。
// 照 k2j5bf1.test.ts 的惯例做源码断言——后端 HTTP 行为另有 web.test.ts 真发请求覆盖。
const NB = readFileSync(new URL("../src/web/ui/notebook.js", import.meta.url), "utf8");

test("会话详情补全 close / rename / interrupt 三个动作", () => {
  assert.ok(NB.includes('id="nb-close"'), "要有关闭会话按钮");
  assert.ok(NB.includes('id="nb-rename"'), "要有改名按钮");
  assert.ok(NB.includes('id="nb-interrupt"'), "要有打断回答按钮");
  assert.ok(NB.includes("/close'"), "close 要走接口");
  assert.ok(NB.includes("/rename'"), "rename 要走接口");
  assert.ok(NB.includes("/interrupt'"), "interrupt 要走接口");
  assert.ok(NB.includes("j.interrupted"), "打断要按返回的 interrupted 提示，而不是写死");
});

test("文档忘掉后给撤销落点（调 /api/docs/:id/restore）", () => {
  assert.ok(NB.includes("function docForgotten"), "要有忘掉后的落点页（照 memForgotten）");
  assert.ok(NB.includes("/restore'"), "恢复要走接口");
  // 两处 forget（列表 + 详情）成功后都落到 docForgotten，而不是直接回列表
  assert.equal(NB.split("docForgotten(id)").length - 1 >= 3, true, "落点函数 + 两处调用都要在");
});

test("授权窗口列表化并能收回（调 /api/grants/:id/revoke）", () => {
  assert.ok(NB.includes("data-revoke="), "每个窗口要有收回按钮");
  assert.ok(NB.includes("/revoke'"), "收回要走接口");
  assert.ok(NB.includes("g.remainingS"), "要显示剩余时间（长期/分钟/秒）");
});

test("工作台读夜间整理日志（/api/nightlog），不硬编码", () => {
  assert.ok(NB.includes("'/api/nightlog'"), "最近几晚要读接口");
  assert.ok(NB.includes("nlog.runs"), "要渲染 runs");
  assert.ok(NB.includes("r.decayed"), "要说出新增/合并/衰减，而不是只一个 ok");
});

test("手眼与自我更新接进面板（2026-11-12）", () => {
  // WSL 小房子：状态 + 自主开关 + 快照 + 安装
  assert.ok(NB.includes("'/api/wsl'"), "WSL 要读接口");
  assert.ok(NB.includes('id="cf-wauto"'), "要有自主开关");
  assert.ok(NB.includes('id="cf-wsetup"'), "要有安装/初始化按钮");
  assert.ok(NB.includes("/api/wsl/snapshot"), "要能立即快照");
  // 眼：视觉配置 + 云闸
  assert.ok(NB.includes("'/api/vision'"), "视觉要读接口");
  assert.ok(NB.includes('id="cf-vsave"'), "要有视觉保存");
  assert.ok(NB.includes("cloudEnabled"), "要有屏幕可发云端的闸");
  // 自我更新：她写的技能草稿箱
  assert.ok(NB.includes("function paintDrafts"), "能力屏要有草稿箱");
  assert.ok(NB.includes("/api/skills/drafts"), "草稿箱要读接口");
  assert.ok(NB.includes("data-promote="), "草稿要能上岗");
});

test("陪伴视图：鲸鱼娘主视觉 + 浮动对话 + 右上切换（2026-11-13）", () => {
  const PAL = readFileSync(new URL("../src/web/ui/pal.js", import.meta.url), "utf8");
  const TPL = readFileSync(new URL("../src/web/notebook.ts", import.meta.url), "utf8");
  // notebook 接线：陪伴模式只替换中间对话区，顶栏右上切换
  assert.ok(NB.includes("function companionOn"), "要有陪伴模式开关");
  assert.ok(NB.includes("nb-companion-toggle"), "顶栏要有陪伴切换键");
  assert.ok(NB.includes("companion-on"), "要有陪伴模式样式钩子");
  assert.ok(NB.includes("cp-stage"), "对话区要有人物舞台");
  assert.ok(NB.includes("cp-bubble"), "要有浮动对话气泡");
  assert.ok(NB.includes("cpLoadHistory"), "陪伴视图要载入同一条对话的最近几条，不能从空开始");
  assert.ok(NB.includes("cpMoreSync"), "气泡默认只露最近一轮，更早的要点开才展开");
  assert.ok(TPL.includes("cp-more"), "要有「之前 N 条」的展开入口");
  assert.ok(NB.includes("/api/timeline"), "陪伴的对话要和记录本同源（/api/timeline）");
  assert.ok(NB.includes("TL_DIRTY"), "陪伴里说过的话，回记录本要重拉时间线");
  assert.ok(NB.includes("/ui/pal.js"), "要加载陪伴模块");
  assert.ok(NB.includes("'/api/tts'"), "陪伴/设置要调 TTS");
  assert.ok(NB.includes('id="cf-ttssave"'), "设置要有声音保存");
  // 背景/形象在设置页里点选与上传（2026-11-13），选择存服务端，陪伴视图共用
  assert.ok(NB.includes("$('cp-bg')"), "右上要有背景切换键");
  assert.ok(NB.includes("'/api/pal'"), "设置与陪伴都要读 /api/pal");
  assert.ok(NB.includes('id="pal-avatars"'), "设置页要有形象卡片列");
  assert.ok(NB.includes('id="pal-bgs"'), "设置页要有背景卡片列");
  assert.ok(NB.includes('id="pal-bg-add"'), "要有上传背景按钮");
  assert.ok(NB.includes('id="pal-av-add"'), "要有导入形象包按钮");
  assert.ok(NB.includes("palUpload('/api/pal/bg'"), "背景上传走接口");
  assert.ok(NB.includes("palUpload('/api/pal/avatar'"), "形象包导入走接口");
  assert.ok(TPL.includes(".pal-card"), "卡片样式要在模板里");
  // 右卷宗在陪伴模式里留着（用户要的 0/I/II/III/IV + 计数）
  assert.ok(!TPL.includes(".nb.companion-on .nb-tabs{display:none}"), "陪伴模式不能把右卷宗藏了");
  assert.ok(TPL.includes(".cp-canvas"), "舞台里是 WebGL 画布");
  // pal.js：RuiC-2D 绑定的 mesh avatar（不再是静态图/Live2D 模型）
  assert.ok(PAL.includes("MeshAvatar.createMeshAvatar"), "要挂 RuiC-2D 的 mesh avatar");
  assert.ok(PAL.includes("setParameters"), "要逐帧驱动参数");
  assert.ok(PAL.includes("gazeX"), "视线要跟随鼠标");
  assert.ok(PAL.includes("mouthOpen"), "说话要驱动口型");
  assert.ok(PAL.includes("advance("), "要推进骨骼");
  assert.ok(PAL.includes("/static/pal/ruic/"), "资源在 static/pal/ruic/");
  assert.ok(PAL.includes("/api/tts"), "说话要调 TTS 接口");
  // Cubism 通道（2026-11-13）：现成 Live2D 公皮可直接导入，不依赖 RuiC-2D
  assert.ok(PAL.includes("Live2DModel.from"), "要能加载 Live2D 公皮");
  assert.ok(PAL.includes("/static/pal/cubism/pixi.min.js"), "Cubism 运行库要 vendored");
  assert.ok(PAL.includes("ParamMouthOpenY"), "公皮口型要驱动");
  assert.ok(NB.includes("$('cp-expr')"), "公皮要有表情/动作按钮");
  assert.ok(TPL.includes(".cp-exprpop"), "表情/动作弹层样式要在模板里");
  // 镜头/形象调参面板：界面直接调半身松紧，不靠改代码（2026-11-13）
  assert.ok(TPL.includes('id="cp-ctrl"'), "要有常驻调参面板");
  assert.ok(TPL.includes('data-tune="frac"'), "要有取景松紧滑杆");
  assert.ok(NB.includes("cpCtrlSync"), "滑杆读数要同步");
  assert.ok(PAL.includes("setTune"), "渲染器要接受实时调参");
  assert.ok(PAL.includes("loadTune"), "调参要持久化");
  // 2026-11-13：面板默认折叠 + 鼻影修复接线（黑方块 / NaN / 复选框没生效三处一起修）
  assert.ok(TPL.includes('<details class="cp-ctrl"'), "调参面板要默认折叠");
  assert.ok(TPL.includes('<summary class="cp-ctrlhead">'), "折叠标题要可点");
  assert.ok(TPL.includes('cp-grp'), "调参面板要按「镜头 / 表现 / 画面」分组，别一长串平铺");
  assert.ok(TPL.includes('id="cp-sub"'), "要有「玻璃卡片 ⇄ 纯字幕」的切换键");
  assert.ok(TPL.includes('sub-mode'), "字幕模式要有独立的样式钩子");
  assert.ok(TPL.includes('--cp-glass-panel'), "右栏展开面板要用同一套玻璃（单独一档更实）");
  assert.ok(TPL.includes('.nb.companion-on .nb-panel'), "右栏面板在陪伴模式下要变成玻璃卡片");
  assert.ok(TPL.includes("type=\"checkbox\" data-tune=\"noseFix\""), "伪影修复要保留为可切换开关");
  assert.ok(NB.includes("jj.cp.ctrl.open"), "折叠状态要记住");
  assert.ok(TPL.includes('data-tune="noseFix"'), "鼻影修复开关要在");
  assert.ok(PAL.includes("noseFix:1"), "鼻影修复默认开");
  assert.ok(PAL.includes("rig.face.nose.rx = 0.01"), "要从源头压掉鼻区伪影");
  assert.ok(NB.includes("inp.type === 'checkbox'"), "复选框要真正接线");
  assert.ok(NB.includes("if (k === 'noseFix') return v ? '开' : '关';"), "读数不能再出现 NaN");
  assert.ok(PAL.includes("applyMeshTune"), "mesh 模式的缩放/位移也要生效");
  assert.ok(PAL.includes("applyHideParams"), "Live2D 公皮的加载方块也要关掉");
  assert.ok(PAL.includes("DisplayInfo"), "要从 cdi3.json 找加载开关，不硬编码模型参数");
  assert.ok(PAL.includes("setPartOpacityById"), "公皮伪影要按部件透明度关掉，只压参数无效");
  assert.ok(PAL.includes("鼻子|加载|load"), "要隐藏名字含鼻子/加载的部件（实测黑方块挂在「鼻子」部件下）");
  // 说明不假设人人装了 RuiC-2D：现成 Live2D 直接导，RuiC 只是可选
  assert.ok(NB.includes("model3.json"), "说明要提现成 Live2D 模型");
  assert.ok(NB.includes("github.com/HRuiCcc/RuiC-2D"), "RuiC-2D 只作为可选工具给链接");
});

test("设置页收成 5 组，且每一节都被分组表覆盖（2026-11-14 重排）", () => {
  const UI = readFileSync(new URL("../src/web/ui/notebook.js", import.meta.url), "utf8");
  const TPL = readFileSync(new URL("../src/web/notebook.ts", import.meta.url), "utf8");

  // 旧版是 20 个平铺标签：总宽 1407 > 容器 1075，末尾 5 项要横向滚动才看得见
  assert.ok(!TPL.includes("nb-jumpbar"), "旧的横向平铺标签条要彻底移除");
  assert.ok(TPL.includes(".cf-navitem"), "左侧分类栏要有自己的样式");
  assert.ok(TPL.includes(".cf-group"), "组内整组铺开要有容器");
  assert.ok(UI.includes("var CFG_GROUPS"), "要有分组表");

  const secs = [...UI.matchAll(/html \+= sec\('([^']+)'/g)].map((m) => m[1]!);
  assert.ok(secs.length >= 18, `节数不该骤减，实际 ${secs.length}`);

  const start = UI.indexOf("var CFG_GROUPS");
  const block = UI.slice(start, UI.indexOf("function cfgView", start));
  const groups = block.match(/\{\s*name:/g) || [];
  assert.equal(groups.length, 5, "固定 5 个分类");

  // 逐段取出每个 secs: [...] 里的标题（不用正则，避开转义）
  const listed: string[] = [];
  let at = 0;
  while ((at = block.indexOf("secs:", at)) >= 0) {
    const open = block.indexOf("[", at);
    const close = block.indexOf("]", open);
    for (const m of block.slice(open + 1, close).matchAll(/'([^']+)'/g)) listed.push(m[1]!);
    at = close;
  }
  // 分组表是渲染的唯一依据：漏一个，那一节在页面上就静默消失了
  assert.equal(listed.length, secs.length, "分组表节数要和实际定义的节数一致");
  for (const t of secs) assert.ok(listed.includes(t), `「${t}」没进分组表，会从页面上消失`);
  for (const t of listed) assert.ok(secs.includes(t), `分组表里的「${t}」没有对应的实现`);
});

test("外壳真的有两种形态，且系统页有六块（2026-11-14）", () => {
  const UI = readFileSync(new URL("../src/web/ui/notebook.js", import.meta.url), "utf8");
  const TPL = readFileSync(new URL("../src/web/notebook.ts", import.meta.url), "utf8");
  // ui.shell 以前 API 读写得通，但没有任何消费方；现在 classic = 单栏专注
  assert.ok(UI.includes("function applyShell"), "要有应用外壳的函数");
  assert.ok(UI.includes("data-shellv"), "设置里要有切换外壳的按钮");
  assert.ok(TPL.includes('data-shell="classic"'), "classic 外壳要有样式落点");
  assert.ok(TPL.includes('id="nb-navtoggle"'), "单栏下要有一个唤回导航的入口，不能把人困住");
  // 后端早就有、界面一直没有入口的六块
  assert.ok(TPL.includes('data-v="sys"'), "左栏要有「系统」");
  assert.ok(UI.includes("function sysView"), "要有系统页");
  for (const ep of ["/api/tools", "/api/audit", "/api/receipts", "/api/pending", "/api/threads", "/api/surface/review"]) {
    assert.ok(UI.includes(ep), `系统页要读 ${ep}`);
  }
});
