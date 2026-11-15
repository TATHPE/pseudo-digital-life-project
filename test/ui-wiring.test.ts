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
  assert.ok(/<summary class="cp-ctrlhead"/.test(TPL), "折叠标题要可点");
  // 用户找不到「视觉设置」：默认布局把四节视觉相关的小节收进一组，陪伴视图的调参按钮也改名
  assert.ok(TPL.includes('视觉 · 镜头'), "陪伴视图的视觉调参入口要叫得出「视觉」");
  assert.ok(NB.includes("视觉 · 观感") && NB.includes("'眼 · 视觉', '形象与背景', '外观', '开机片头'"),
    "默认布局里看图 / 形象 / 外观 / 片头要在同一组");
  assert.ok(NB.includes('id="cf-find"') && NB.includes("function apply()") && NB.includes("cf-findout"),
    "设置页要能直接搜小节，不靠猜组名");
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
  assert.ok(UI.includes("var CFG_GROUPS_DEFAULT"), "要有内置默认分组表");
  // 2026-11-15：内置表只是兜底，用户可从 /api/ui 的 raw.cfgGroups 覆盖（分组与顺序不再写死）
  assert.ok(UI.includes("function cfgGroupsFrom"), "要有「读用户布局」的入口");
  assert.ok(UI.includes("raw.cfgGroups"), "布局要来自用户自己的 config.json");
  assert.ok(UI.includes('cf-edit-layout') && UI.includes('cf-edit-raw'), "要有分组编辑器与原始 JSON 编辑器");

  const secs = [...UI.matchAll(/html \+= sec\('([^']+)'/g)].map((m) => m[1]!);
  assert.ok(secs.length >= 18, `节数不该骤减，实际 ${secs.length}`);

  const start = UI.indexOf("var CFG_GROUPS_DEFAULT");
  const block = UI.slice(start, UI.indexOf("function cfgGroupsFrom", start));
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

test("能力体检页（阶段 2）：有入口、能深链、开关写的是 config 而不是命令行", () => {
  const UI = NB;
  const TPL = readFileSync(new URL("../src/web/notebook.ts", import.meta.url), "utf8");
  assert.ok(TPL.includes('data-v="ovw"'), "左栏要有「体检」入口，否则接口有数据也没人看得见");
  assert.ok(UI.includes("function ovwView"), "要有体检页");
  assert.ok(UI.includes("fetch('/api/overview')"), "体检页要读只读总览接口");
  assert.ok(UI.includes("v === 'ovw'"), "go() 要能分派到体检页");
  assert.ok(UI.includes("'cap','ovw'"), "?view=ovw 必须在深链白名单里，否则打开就跳回工作台");
  assert.ok(UI.includes("v: '能力体检', go: 'ovw'"), "命令面板要能搜到");
  // 决策 2：开关写配置键，按钮上必须写清「要重启」，不许暗示点了就生效
  assert.ok(UI.includes("jsend('PUT', '/api/ui', { beat:"), "心跳开关要走 /api/ui 的写入闸门");
  assert.ok(UI.includes("data-ovwbeat"), "心跳那一行要有可点的开关");
  assert.ok(UI.includes("需要重启面板") || UI.includes("重启面板后才生效"), "要写明重启才生效");
  // 决策 5：安装引导只给命令文本，不自动执行
  assert.ok(UI.includes("data-copy="), "安装引导要能复制命令");
  assert.ok(!/exec|spawn/.test(UI.slice(UI.indexOf("function ovwView"), UI.indexOf("function capView"))), "体检页不许自己执行命令");
});

test("记忆浏览器（阶段 4）：筛选 + 抽屉，且界面没有任何改正文的入口（决策 3）", () => {
  const UI = NB;
  assert.ok(UI.includes("function memView"), "要有记忆列表");
  assert.ok(UI.includes("function memDrawer"), "详情要开抽屉，不要整页跳走");
  assert.ok(UI.includes("data-mf="), "筛选 chip 要能点");
  assert.ok(UI.includes("/api/memories/summary"), "筛选项要用真实分布，别列一排零结果选项");
  assert.ok(UI.includes("history.replaceState"), "筛选要写进 URL，刷新不丢");
  assert.ok(UI.includes("清掉条件"), "筛窄了要给下一步 —— 零命中 ≠ 没发生过");
  const mem = UI.slice(UI.indexOf("function memView"), UI.indexOf("function docsView"));
  // 决策 3：正文不可编辑。编辑框、保存正文的 PUT、编辑按钮，一个都不许留
  assert.ok(!mem.includes("textarea"), "不许有能改正文的输入框");
  assert.ok(!mem.includes("method: 'PUT'"), "记忆块里不许直接 PUT 正文");
  assert.ok(!mem.includes("nb-medit"), "不许有编辑入口");
  assert.ok(mem.includes("为什么不能改正文"), "要说明为什么不能改，而不是只把按钮藏起来");
  assert.ok(mem.includes("忘掉 → 重新记住"), "要给出替代路径");
  assert.ok(mem.includes("/sensitivity"), "敏感度是另一回事，走独立路由");
});

test("趋势（阶段 5）：记忆页可展开，图只画能算的东西", () => {
  const UI = NB;
  assert.ok(UI.includes("id=\"nb-mtrend\""), "记忆页要有趋势容器");
  assert.ok(UI.includes("/api/memories/trend"), "要读趋势接口");
  assert.ok(UI.includes("memTrendSlot"), "首屏不该为趋势多打一次请求，要能按需展开");
  assert.ok(UI.includes("横轴是记忆年龄"), "要写明横轴是什么 —— 这是它和「时间序列」的区别");
  // 诚实性：没有逐日权重快照，所以不许出现「按日期画权重」的字样/口径
  assert.ok(!UI.includes("权重随时间"), "库里没有历史权重，不能这么写");
  // 空样本的桶不画点也不连线：连线会跨过空档，看起来像那段真的掉了
  assert.ok(UI.includes("不画点"), "空桶的语义要写在页面上");
  assert.ok(UI.includes("含断片"), "断片能不能算进去要给开关，不能替用户决定");
});

test("存储页（阶段 3）：总览卡片 + 可排序明细 + 最大文件，且只读不给删除入口", () => {
  const UI = NB;
  const TPL = readFileSync(new URL("../src/web/notebook.ts", import.meta.url), "utf8");
  assert.ok(TPL.includes('data-v="sto"'), "左栏要有「存储」入口");
  assert.ok(UI.includes("function stoView"), "要有存储页");
  assert.ok(UI.includes("v === 'sto'"), "go() 要能分派到存储页");
  assert.ok(UI.includes("'ovw','sto'"), "?view=sto 必须在深链白名单里");
  assert.ok(UI.includes("v: '存储', go: 'sto'"), "命令面板要能搜到");
  assert.ok(UI.includes("data-sto-sort"), "明细表要能点列头排序");
  assert.ok(UI.includes("data-sto-open"), "分组要能展开看组内明细，否则大目录等于黑箱");
  assert.ok(UI.includes("topFiles"), "要看得到「最大的文件」——目录表会把长文件压平");
  assert.ok(UI.includes("data-ovwsto"), "体检页的概要要能跳到存储页，而不是两处各画一遍");
  // 决策 4/6：只读快照，不给删除 / 清理入口（删只能用户自己确认后手动做）
  const body = UI.slice(UI.indexOf("function stoView"), UI.indexOf("function capView"));
  assert.ok(!/jsend\('DELETE'|method:\s*'DELETE'|nb-btn danger/.test(body), "存储页不许有删除按钮");
  assert.ok(!/exec|spawn/.test(body), "存储页不许自己执行命令或清理脚本");
});

test("设置页要有「主动开口」开关（只放在体检页里，用户会找不到）", () => {
  const UI = NB;
  // 2026-11-15：心跳之前只有一个按钮在体检页第三段「后台」分组里。
  // 用户找不到开关就是证据 —— 开关该在设置里，体检页只是给结论。
  assert.ok(UI.includes("sec('主动开口'"), "设置页要有主动开口这一节");
  assert.ok(UI.includes("'声音', '主动开口']"), "要挂进「她」组的分组表，否则该节整块静默消失");
  assert.ok(UI.includes("id=\"cf-beat\""), "要有可点的开关按钮");
  assert.ok(UI.includes("cf-beatstate"), "要把「已开启」和「正在跑」分开显示，别把没生效的说成已开启");
  // 写入必须走 /api/ui，且必须是布尔 —— 这里再兜一层，防止有人改成字符串
  // 注意：sysView() 定义在 cfgView 之前，不能拿它当右边界（会切出空串，断言假通过/假失败）
  const from = UI.indexOf("function cfgView");
  assert.ok(from > 0, "找不到 cfgView");
  const body = UI.slice(from);
  assert.ok(/JSON\.stringify\(\{\s*beat:\s*next\s*\}\)/.test(body), "开关写的是布尔 beat");
  assert.ok(/\/api\/ui/.test(body), "写进 config.json，不是改命令行参数");
});

test("陪伴视图：长回复不能把气泡顶出窗口（2026-11-15）", () => {
  const TPL = readFileSync(new URL("../src/web/notebook.ts", import.meta.url), "utf8");
  // 实测：收起态写 max-height:none 时，一条 22 行的回复把气泡撑到 1006px（窗口 1093×640，y=−461），
  // 开头几段直接跑到窗口外面，且 overflow:visible 滚都滚不回去 —— 读不到的答案等于没答。
  const clip = TPL.match(/\.cp-log\.clip\{[^}]*\}/)?.[0] ?? "";
  assert.ok(clip, "找不到 .cp-log.clip 规则");
  assert.ok(!/max-height\s*:\s*none/.test(clip), "收起态不许解除高度上限");
  assert.ok(!/overflow\s*:\s*visible/.test(clip), "收起态超出时要能滚");
  assert.ok(/\.cp-log\{[^}]*max-height:min\(46vh,480px\)/.test(TPL), "气泡要有明确的高度上限");
  // 折叠入口压在照片背景上，10.5px + 低对比等于不存在
  assert.ok(/\.cp-more\{[^}]*font:11\.5px/.test(TPL), "「之前 N 条」要够大才看得见");
});

test("陪伴面板：正文渲染 markdown、历史不截断、工具能点开（2026-11-15）", () => {
  // 气泡原来是 textContent：`**读**`、`- ` 列表、反引号全裸奔（用户截图里就是这么一坨）。
  // markdown 只该有一份实现（src/md.ts），前端拿服务端渲染好的 html，不再各写一套。
  assert.ok(NB.includes("opts.html"), "cpLine 要能接服务端渲染的 html");
  assert.ok(NB.includes("cp-body cp-md"), "渲染后的正文要挂 cp-md 类（white-space 要退回 normal）");
  assert.ok(!NB.includes("cpClip("), "历史不许再按字符数截断");
  const TPL2 = readFileSync(new URL("../src/web/notebook.ts", import.meta.url), "utf8");
  assert.ok(NB.includes("cpBodyOf") && NB.includes("bt.appendChild(cpToolStrip"), "工具胶囊挂在正文外层");
  // 工具：她说「刚跑了两条」，面板得让人能核对
  assert.ok(NB.includes("function cpToolStrip"), "要有工具胶囊");
  assert.ok(NB.includes("toolList"), "历史工具要读 /api/timeline 的结构化那份");
  assert.ok(NB.includes("ev.type === 'tool'") && NB.includes("ev.type === 'tool_result'"), "当场那一轮要从流里捡工具与结果");
  // 渲染走「回读 timeline」，不新增 SSE 收尾帧（最后一帧仍是 done）
  assert.ok(NB.includes("function cpUpgrade"), "说完要回读 timeline 换成渲染版");
  assert.ok(!NB.includes('ev.type === \'html\''), "不要在流里加 html 帧：收尾帧只能是 done");
  assert.ok(TPL2.includes(".cp-tchip"), "胶囊要有样式");
  assert.ok(TPL2.includes(".cp-body.cp-md p"), "markdown 段落要重设间距");
});

test("/api/timeline 给陪伴视图一份结构化工具列表", () => {
  const SRV = readFileSync(new URL("../src/web/server.ts", import.meta.url), "utf8");
  // 记录页用 toolCardHtml（<details> 卡片），气泡 580px 塞不下 → 另给 name/ms/result
  assert.ok(/toolList:\s*src\.tools\.map/.test(SRV), "timeline 要返回 toolList");
  // html 在 timeline 里算（记录页和陪伴视图共用一份 renderMarkdown），不额外推 SSE 帧
  assert.ok(/renderMarkdown\(b\.text\)/.test(SRV), "timeline 要给正文的 html");
  assert.ok(!/send\(\{\s*type:\s*"html"/.test(SRV), "收尾帧只能是 done，别在流里塞 html");
});

test("陪伴视图：收起时也要能用鼠标滚轮翻历史（2026-11-15）", () => {
  // 前三版把「收起」实现成 display:none 只留最后两条 / 按 4 行钳正文 ——
  // 历史行根本不在布局里，滚轮滚不动。收起应该只是把同一个滚动容器的窗口收窄。
  const TPL = readFileSync(new URL("../src/web/notebook.ts", import.meta.url), "utf8");
  const clip = TPL.match(/\.cp-log\.clip\{[^}]*\}/)?.[0] ?? "";
  assert.ok(/max-height:min\(20vh,168px\)/.test(clip), "收起态是更小的滚动窗口");
  assert.ok(/\.cp-log\{[^}]*overflow-y:auto/.test(TPL), "两态共用的容器必须能滚");
  assert.ok(!TPL.includes(".cp-log.clip .cp-line{display:none}"), "历史行不许再被藏掉");
  assert.ok(!TPL.includes(".cp-body.clip-more"), "正文不许再按行钳（历史要能读全）");
  assert.ok(!/\.cp-log\.clip\.cp-line:nth-last-child/.test(TPL), "不许再只留最后两条");
  // 默认贴底跟最新；人手动往上翻时不能被新内容硬拽回来
  assert.ok(NB.includes("CP_AT_BOTTOM"), "要记「人是否还在底部」");
  assert.ok(NB.includes("function cpLogBottom") && NB.includes("function cpLogTop"), "展开到顶 / 收起到底");
  assert.ok(/CP_AT_BOTTOM\s*=\s*cpLogEl\.scrollTop\s*\+\s*cpLogEl\.clientHeight/.test(NB), "滚动事件要更新贴底标志");
  assert.ok(NB.includes("CP_AT_BOTTOM = true;\n    cpLine('me', text)"), "发新话时强制回到这一轮");
  assert.ok(/log\.classList\.toggle\('clip', !CP_EXPANDED\)/.test(NB), "收起态不依赖 hiddenN，始终是小窗");
  assert.ok(NB.includes("addEventListener('wheel'"), "指针在气泡按钮/内边距上时也要能滚");
  assert.ok(NB.includes("l.contains(e.target)"), "落在 cp-log 内部别滚两遍");
});

test("声音没配后端：陪伴视图安静跳过、主动试听明确报错（2026-11-15）", () => {
  // 用户定：「没配就干脆不发声 / 明确报错」。不许再静默拿 local 兜底。
  const TTS = readFileSync(new URL("../src/tts.ts", import.meta.url), "utf8");
  assert.ok(!/backend\s*\|\|\s*"local"/.test(TTS), "配置读取不许把空后端补成 local");
  assert.ok(TTS.includes("E_TTS_NO_BACKEND"), "合成要有明确的错误码");
  assert.ok(TTS.includes("NO_BACKEND_HINT"), "状态/音色列表/错误共用同一个口径");
  assert.ok(NB.includes("CP_TTS_CONFIGURED"), "陪伴视图要读「有没有配后端」");
  assert.ok(/CP_SOUND && CP_TTS_CONFIGURED && window\.JJPal/.test(NB), "没配时连发声请求都不发");
  assert.ok(NB.includes("没配 · 不发声"), "设置页要如实说明，不能写「暂用内置 local」");
  assert.ok(/use <后端名\|clear>/.test(readFileSync(new URL("../src/cli/jingjing.ts", import.meta.url), "utf8")),
    "CLI 也不该把后端名锁死在 local|cloud");
});
