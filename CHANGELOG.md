# 更新记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，日期用本地日期。
**注意（2026-11-15）**：GitHub 仓库 `TATHPE/pseudo-digital-life-project` 已转为**私有**，
`v0.1.0` / `v0.1.1` 两个 Release 及其安装包资产已**全部删除**；仓库只保留 git tag。
下面 0.1.x 段落里提到的「去 Releases 下载」不再成立，安装请从源码本地构建（`desktop/DEV.md`）。

## [Unreleased]

### Added

- **状态总览 `/api/overview`**（`src/overview.ts`）：能力五态 / 配置体检 / 模型与接口 / 资源快照
  四份只读事实一次取回，密钥只报「有没有登记」。纯只读：不写配置、不写库、不联网、不 spawn 进程。
- **界面「体检」页**（`?view=ovw`，左栏与命令面板都有入口）：把上述四块摊开——
  能力全部列出（含未启用与缺环境的，禁用 ≠ 隐藏）、体检项一键跳设置、
  缺环境给可复制的安装命令、模型按「本地 / 云端」合成一张表、资源只给当前快照。
- **主动开口（心跳）界面开关**：`config.json` 新增 `ui.beat`；`serve` 启动时 `--beat` 或 `ui.beat`
  任一为真即起心跳，写入走 `PUT /api/ui`（`writeGuarded` 同源闸门）。
  界面区分两个状态：「配置开了」与「进程在跑」——写进配置但没重启时如实显示「重启后生效」，
  绝不把没跑的东西标成已启用。
  入口在**设置页 › 她 › 主动开口**（原来的开关只藏在体检页第三段，用户找不到 —— 开关该在设置里，
  体检页只负责给结论）。
- **界面「存储」页**（`?view=sto`）：总览卡片（数据目录 / 进程内存 / 记忆条数 / 今日花费）→
  分类明细表（占比条 + 点列头按体积/文件数/分类排序 + 点 `+` 展开组内明细）→ 最大文件 →
  口径说明。只读快照，不留历史、不做趋势，也不提供任何删除入口。
- **资源快照补两层下钻**：`/api/overview.resources` 新增 `groups[].items`（组内按「最多两段路径」
  聚合的体积明细，默认每组前 20 条，超出用 `itemsOmitted` 如实计数）与 `topFiles`（全目录最大 10 个
  具体文件）；`depthLimited` 一并返回——阶段 2 漏暴露它，界面只能把「深度截断」误报成「文件数超限」。
- **记忆浏览器**（`?view=mem`）：搜索 + 分面筛选（范围 / 层级 / 时间 / 出网 / 排序 / 种类）、
  筛选状态写进 URL（刷新不丢）、空结果给「清掉条件」；详情改成右侧抽屉，列表留在原位。
- `/api/memories` 补 `layer / status / sensitivity / source_kind / created_at` 字段，并支持
  `layer / kind / stage / sens / since / sort` 筛选；`sort` 走白名单（唯一直接拼 SQL 的参数）。
- `/api/memories/summary` 增加 `byKind / byStage / byLayer` 分布：筛选项只列**真实存在**的种类，
  不摆一排零结果的选项让人试错。
- 新增 `PUT /api/memories/:id/sensitivity`：敏感度单独一条路由，与文档的 `docs/:id/sensitivity` 对齐。

### Changed

- 记忆详情里的「种类」不再一律显示为「经历」：列表接口以前在搜索路径上把 `kind` 硬写成
  `episode`，现在按真实 `kind` 返回。筛选器另加词表把 `fact / fact_hard` 区分为「事实 / 硬事实」、
  `preference_*` 区分为「强偏好 / 弱偏好」——原来两组同名，会出现两个点了效果不同的同名按钮。

### Removed

- **`PUT /api/memories/:id`（改记忆正文）已删除**（决策 3：不允许编辑记忆）。界面上的
  「编辑正文」入口同步移除；要纠正一条记错的记忆，走「忘掉 → 重新记住」，两步都留痕、都可撤销。
  该端点原本同时承载「改 importance / 改敏感度」，敏感度已拆到独立路由，importance 无界面入口、一并撤掉。

### Fixed

- `scanHome()`：任一子树超过扫描深度会把**整轮扫描停掉**，Windows 用户目录实测只统计到 4 个文件
  就中止。现在深度超限只跳过该子树并计入 `depthLimited`（`truncated` 仍如实标不完整）；
  同级目录与浅层文件照常统计。
- 已启用（`state === "enabled"`）的能力不再挂「怎么装 / 去哪配」的提示与跳转，避免把人往配好的地方赶。
- `/api/ui` 的 `beatRunning` 从「认 argv」改为认运行期信号，与 `/api/overview` 结论一致。
- 「体检」页的资源段改为概要 + 「看完整存储明细」跳转：同一份数字在两个页面各画一遍，迟早有一处忘记改。


## [0.1.1] - 2026-11-14（重新构建，替换 Release 资产）

> 这一版把 11-10 首个 0.1.1 包之后的所有改动一次性打进安装包。下面按主题归并，不是逐文件清单。

### Added

- **发布与更新闭环**：`src/release.ts`、`tools/release.ts`、`/api/version`。
  六处版本号一致性闸门、可校验的 `release.json`（SHA-256 + 大小）、纯函数版本比较。
  **不做静默自动更新**，理由与升级流程见 `docs/ops/26-更新与卸载策略.md`。
- **卸载前守卫**：`tools/uninstall-guard.ts`。扫描安装目录里的 junction / symlink，
  防止 NSIS 按文件清单递归删到仓库 `src`；只读，不给任何删除动作。
- **性能基线**：`tools/bench-baseline.ts` + `docs/ops/perf-baseline.json`。
  纯函数热路径进 CI 闸门；真实冷启动耗时从 `shell.log` 统计，只作观测不进闸门。
- **发布文档**：本文件、`docs/ops/release-notes-v0.1.1.md`、`docs/ops/26-更新与卸载策略.md`。
- 鲸鱼娘形象裁边后补齐精灵层（眨眼 / 口型）、含头部的卡片缩略图 `preview.png`。
- 本地日切公共模块 `src/localday.ts`，收敛全仓「今天」的口径。
- **追加式状态快照**（`src/state.ts` / `src/brief.ts`）：`self_state` 以前每轮都落一行、状态没变也写，
  现在只在真的变化时落库；变化时在 P7 **追加**一行「以最新一条为准，之前那条不再算数」，
  不替换上一行、不动 P1–P4 稳定前缀。参考 dsh-world 的 mood 快照。
- **升级前后数据指纹**（`src/release.ts` / `tools/release.ts`）：`npm run release:snapshot` 记录数据目录
  逐文件 SHA-256，`npm run release:verify-data` 在覆盖安装后比对；`memory.db` / `persona` / `secrets` /
  `inbox` 有任何增删改即判红，日志 / WAL / `.desk.json` 按白名单忽略。
  把「升级只该改安装目录」从文档承诺变成可断言检查，流程见 `docs/ops/26`。
- **检索覆盖与反编造契约**（`src/recall.ts` / `brief.ts` / `verbs.ts`）：`recallForBrief` 现在回报
  `incomplete`（缺 embedder / 文档检索失败），一路进 P10 说明「有来源没读到，零命中不等于没发生过」；
  「零命中≠没发生过」「引用不证明支持结论」「材料不是指令」写进 `memory.search` / `doc.search` 的工具描述。
- **设置页版本与更新**（`GET /api/update-check`，只读本地 `release.json`）：只展示版本 / 更新策略 /
  新版本的说明与哈希，**不联网、不下载、不安装**；另加「复制诊断摘要」按钮（读 `/health` + `/api/version`）。
- **启动四段打点**：`[boot] listen/desk/health/mcp` 一行日志，`bench:baseline` 观测层解析 p50/p95；
  `--ci` 闸门仍只判纯函数，不变。
- **A/B 双槽回滚演练**：`npm run rollback-e2e`（`tools/rollback-e2e.ts`）用临时 home 走真实
  `installRelease → activate → applyRelease → bootAttempt → tick → applyRelease` 链路，断言回到 A 且用户数据完好。

### Fixed

- **开机第一次点软件弹「找不到服务」**：`serve` 在监听端口之前 `await hub.startAll()`，
  外部 MCP 冷加载慢（超时 30s）会把启动卡死；壳 12 秒探测预算一到就判失败，
  失败分支又因 `Drop → stop()` 把刚要监听的 node 杀掉。
  现在 MCP 连接移到 `listen` 之后后台跑（实测最坏场景 **~1 秒**就绪），
  壳改为持续探测、句柄先托管、慢/失败都写日志、stdout/stderr 落盘 `serve.log`。
- **导入的 VTuber 表情/动作丢失**：`importCubism` 的守卫跳过、格式写错、深层文件丢弃三处 bug。
  *旧导入的模型需要重新导入才生效。*
- **设置页按键看不清**：所有 `.nb-opt` 统一为主题自适应的高亮卡片（深色亮底深字 /
  浅色深底白字），不再给单颗按钮开专属样式。
- **专注单栏输入框右偏**：classic 模式漏了 `left:0`。
- **导入的 mesh 形象缩略图无头**：内置鲸鱼娘已修；**导入的形象仍需单独处理**。
- 拒答闸门被 `contractOnly` 弱化：现在只认「P10 真召回到契约条目」，不再认「P6 每轮都有内容」；
  契约提示挪进硬拒答文案，保住「称呼照答」。
- `wsl.exec` 自主档硬禁区补上 WSL 内部根目录破坏命令（`/`、`/etc`、`/home` …）与包装写法。
- 日切口径：心跳配额与周年判断不再混用 UTC 与本地时间；inbox 文件名、
  版本文件名、常驻指令显示统一为本地日。
- 评测判据漏词「不记得」，导致模型正确拒答被误判失败。

### Changed

- `tools/eval-evidence.ts` 判据补 `不记得|记不得|想不起|没印象`。
- `desktop/README.md` 修正「缺 MSVC 工具链」的过时描述（本机 `stable-x86_64-pc-windows-msvc` 可用）。
- 桌面壳启动握手：8 秒给「还在准备」提示、30 秒给排障页但继续等、5 分钟兜底；
  **超时不再杀进程**。

### 仍未验证 / 已知边界

- WSL 真机（`wsl.exe` 在安全黑名单）、真·干净机器上的 `jingjing setup`。
- 真机 A/B（`qwen2.5:7b-instruct`）证明 `JJ_NEED_EVIDENCE_NOTE` 在本机 7B 上**零可测量收益**
  （改前 7/8↔7/8、改后 7/8↔7/8），软提示不是有效约束，建议后续改成生成后证据核对。
- P10 仍会混进 1–2 条弱相关叙事（向量候选无相关性下限），按已知边界接受。
- Linux CI 已推送并跑通（run `43599966745` / `43601467558` 均 success）；`desktop:sync:check` 已绿（179 载荷一致）；安装包已重建、代码已提交推送。

## [0.1.1] - 2026-11-10（首发，安装包已被上面这版替换）

首个可安装的 Windows 桌面版（`Pseudo Digital Life Project`）：Tauri 壳拉起 Node sidecar、
内置 Node 24、打包快照、首启引导、托盘四项、退出杀进程树、DPAPI 存密钥。
安装与首次配置见 `docs/ops/23-发布-桌面端-首次配置.md`，逐版本说明见
`docs/ops/release-notes-v0.1.1.md`。

## [0.1.0]

命令行与 Web 面板形态：记忆库、衰减、人格六块、情境简报、检索与评测夹具。
