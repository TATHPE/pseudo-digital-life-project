# AGENTS.md

> 给"下一个 agent"（或下一个我）。**只写怎么跑、东西在哪、去哪读。**
> 交接文档与待办**不在本仓**（内部笔记，里面有本机路径与没做完的判断）：它们在本机文档仓 `../docs/` 与 `../HANDOFF.md`。

## 1. 怎么跑

```bash
npm run check        # tsc + 全部测试（失败的用例会自动重跑两次；重跑通过会标 FLAKY 并列出文件名）
npm run ui:test      # headless Edge 真点真发：记录本 + 首启引导页
npm run desktop:dev  # 桌面壳（Tauri；自己起 sidecar）

node src/cli/jingjing.ts serve 7700   # 开发用的面板（固定端口）
node src/cli/jingjing.ts serve 0      # 壳用的：随机端口，端口与令牌写到 data/.desk.json
```

界面只有一套：记录本（HTML/CSS 在 `src/web/notebook.ts`，界面脚本在 `src/web/ui/notebook.js`），挂在 `/`。
旧的 `src/web/page.ts` 已于 2026-11-06 删除：它曾被一批测试当成活代码来断言，属于假绿。

环境：Node ≥ 24（`node:sqlite`）、TypeScript 直接跑、没有构建步骤；`sqlite-vec` 可缺（缺了退化成纯 FTS 并在 `/health` 报）；摄入 PDF 要 Python + markitdown，`.md/.txt` 不需要。

自检三件：`jingjing eval`（检索四道门）、`jingjing redteam`（拦截用例）、`deploy smoke`（冒烟）。

## 2. 想知道什么 → 读哪

| 想知道 | 读 |
|---|---|
| 定义与验收口径（四条件 / L0–L4 / 五组指标） | `docs/design/0-定义-数字生命.md` |
| 衰减、四段生命周期、再巩固、心跳 | `docs/design/01-记忆动力学.md` |
| 表结构、分块、两阶段检索、MCP 契约 | `docs/design/02-存储与索引层.md` |
| 能力分级 T0–T4、红队、执行层 | `docs/runtime/04-执行层与权限分级.md` |
| 技能/插件兼容（只吃 MCP + SKILL.md） | `docs/runtime/11-技能与插件兼容.md` |
| 模型角色与本地门槛 | `docs/runtime/13-模型与API配置方案.md` |
| 界面三处关键区别与管理面 | `docs/design/17-界面与上下文.md` |
| 自我更新四类（核心永不自改） | `docs/runtime/18-断电与自我更新.md` |
| 发布 · 桌面端 · 首次配置 · 封存 | `docs/ops/23-发布-桌面端-首次配置.md` |
| 基准与口径（我们的数字能跟谁比、不能跟谁比） | `docs/ops/24-基准与口径.md` |
| 常驻指令（她按点做事）的设计记录 | `docs/ops/25-常驻指令-设计记录.md` |
| **云端接不上怎么降级、聊天/工作怎么自动切、任务怎么分步** | `docs/runtime/26-降级与编排.md` |
| 语言与技术栈的选择 | `docs/runtime/21-语言与技术栈选择.md` |

---

## 3. 代码地图（一行一个，只写"找什么去哪"）

```
cli/jingjing.ts   入口（40 个命令；CLI_COMMANDS 表与 switch 必须一致，有测试盯）
web/server.ts     HTTP + SSE 的骨架与 /api/say（路由按族拆到 web/routes/ 下）
web/routes/       路由按族拆开：config（配置/诊断）、control（面板控制）、memory（记忆/文档）、
                  setup（首次配置）、status（状态/健康）；server.ts 只留骨架与对话流
web/ui/notebook.js 记录本的界面脚本（真文件：能 node --check、能 import 测试）
verbs.ts          **唯一**的能力表（tools.ts 只是适配层）
execute/policy    策略与审计（casbin，deny-overrides）
store.ts          remember / reinforce / tickDecay / updateMemoryText / patchMemoryMeta
decay.ts          纯函数：weight / classify / reconsolidate / w0FromImportance
decayparams.ts    参数白名单 + 版本号 + 审计（config.json 的 decay 段）
retrieve.ts       两阶段检索 + 一跳扩展（expandByLinks）
recall.ts         P10 装配 + 隐私闸门（shareable 才进简报）
nightly.ts        闲时整理（游标增量；失败不推进游标；**四条 return 都留痕**）
nightagent.ts     夜间抽取的**只读**工具循环
surface.ts        浮现时机（4 个 trigger + 每日上限）
embedindex.ts     索引身份（哪版模型建的向量）
reembed.ts        重建向量（全成或全不成）
preflight.ts      本地端点前置检查（5 分钟按端点缓存）
project.ts        只读的项目读取（白名单根 + 按段拒绝）
capabilities.ts   能力自述（从代码真读，不手写常量）
startupcheck.ts   启动前配置校验（致命 → exit 78）

# ── 执行层 / 授权 ──────────────────────────────
grant.ts          会话授权窗口（命令/目录/时限/环境脱敏）+ FULL_DENY + 预设档
supergrant.ts     超级权限（能改记忆与人格、能跑任意命令；trash/snapshots 仍拒）
coreguard.ts      记忆核心硬清单（memory.db / persona / secrets / inbox / trash / snapshots）
egress.ts         代码外发按次授权（默认拒 → 面板批一次/一段时间；待批落盘）
shell.ts          命令模板表（argv 写死 + 参数槽）+ 超时杀进程树 + 一次性令牌

# ── 她自己那一层 ───────────────────────────────
agent.ts          工具循环（step / 用法见 maxSteps）—— **tool 消息必须连续回填**，否则 400
agentguard.ts     C-1/C-2/C-3：改完自己验 / 先列步骤 / 错误当输入（提醒预算 3 次）
agenda.ts         她自己在惦记的事（必须带出处、上限 5、可了结）
interpret.ts      意义层（解释必须挂 derived_from；复述原文不算）
interpretnight.ts 把它接进闲时整理（五道防线：basis 真实/不许复述/排除系统日志/至少 2 条/可解释性）
threads.ts        未闭合的线（承诺/待办，aging）
links.ts          记忆之间的边（why + 止期 + 黑名单；抽检断线共用）
proposals.ts      「它想做但需要人点头」的提议卡（写 data/pending，不执行）
notify.ts         回执通道（送达≠已读；3 天没人读就停用对应常驻指令）
standing.ts       常驻指令（只收模板、必须指定通知通道、每次触发现开 60 秒窗口）
posture.ts        **永远 full**（2026-11-04 档位 UI 删了）；JJ_PARANOID=1 回到什么都问
memoryonly.ts     本地模型能碰的工具白名单（只记忆类，执行侧也校验）

# ── 技能 / 插件 / 只读工具 ─────────────────────
skills.ts         SKILL.md 扫描/解析/按需读（简报 P14 只放名字+一句描述）
plugins.ts        插件（MCP）与技能的**增删**（id 白名单；写 mcp.json / skills/<id>）
hooks.ts          钩子（after_turn / before_night / after_night；只收模板，走 execute）
gitview.ts        git 只读三连（status/diff/log）—— cwd 是项目根，不是 home
mcp.ts            MCP stdio 客户端（initialize → tools/list → tools/call）

# ── 这一轮新增（2026-11-03/04）─────────────────
explicit.ts       **当场记住**：说「记住 X」「以后别…（指向人）」「我对…过敏」→ 立刻落库
profile.ts        「关于你」的六道题（称呼/作息/忌口/生日/所在地/工作）+ 缺口 + 一天一问的冷却
erosion.ts        三段侵蚀（原文保留，按 erase_stage 渲染）
gapnote.ts        离线补账（空档 ≥24h 补一条真记忆）
nightdue.ts       闲时整理的自动触发（≥20h）+ 进程内锁
fillvec.ts        补缺的向量（写入路径不建向量）
queryrewrite.ts   别名归一 + 多路补召回（只做别名不做联想）
selfupdate.ts     草稿区 / 版本记录 / A-B 槽 / 失败冻结 24h
autocommit.ts     写文件后自动留一版 git（作者是她）
mcphub.ts         MCP 连接中心（单插件重连，不重启 sidecar）
toolhint.ts       工具调用 → 人话（路径只留文件名；正文/密钥不上屏）
host.ts           解释器（按扩展名选）+ PowerShell 输出编码 + profile
web/desk.ts       桌面端令牌（随机端口 + 一次性令牌 + cookie）
web/splash.ts     片头完整档（550C 骨架改造）+ web/boot.ts 简易档

# ── 人格 / 配置 ────────────────────────────────
generation.ts     分代（人格指纹 + 开代理由 + 日志）；改设定只向前生效
interview.ts      人格访谈（5 问 → 草稿 → 封存）；「只能说用户原话」是代码校验
firstrun.ts       首启试运行 + 第一句话（写进 journal）
setup.ts          首次配置的**事务**（先记账再动手、可暂停、终止按账回滚）
setupsteps.ts     八步的执行（装 Ollama / embedding / 模型 / 试运行…）
configfile.ts     config.json 读写（深合并；agent.name = 她叫什么）

# ── 界面（web/）────────────────────────────────
web/ui/notebook.js 记录本界面脚本（真文件；node --check 与测试直接读它）
web/welcome.ts    首启引导页（/welcome，全屏八步；GET / 没配完就分流到这里）
web/desk.ts       桌面端令牌（随机端口 + 一次性令牌；没令牌 403）
web/server.ts     HTTP + SSE（/api/say 流式；/health 的 degraded 是全部状态的汇合点）
web/state.ts      一句话状态（醒着 / 距上次 / 离线多久）
web/timeline.ts   时间轴分组（按天 + 沉默间隔插缝）
```
