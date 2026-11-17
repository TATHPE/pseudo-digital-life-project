# 更新记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，日期用本地日期。
**注意（2026-11-15）**：GitHub 仓库 `TATHPE/pseudo-digital-life-project` 已转为**私有**，
`v0.1.0` / `v0.1.1` 两个 Release 及其安装包资产已**全部删除**；仓库只保留 git tag。
下面 0.1.x 段落里提到的「去 Releases 下载」不再成立，安装请从源码本地构建（`desktop/DEV.md`）。
**注记（2026-11-17）**：对外分发恢复 —— 版本号重置为 **0.1.0** 重发（旧 `v0.1.0` tag 重指向本次发布，
`v0.1.1` tag 保留为历史），Release 带干净构建的 NSIS 包；**仓库同日转公开**（owner 决定），Release 与资产公开可下载。
**注记（2026-11-17 晚）**：Release v0.1.0 与资产**再次删除**（owner 待真机测试后重构建安装包再发）；仓库仍公开。
陪伴舞台让位修复**同晚回滚**（owner 要求改动前效果），见 0.1.0 段内注记。
下面第一个 0.1.0 段落是本次发布；文末同名旧段落是 2026-11-10 旧版本号的历史记录。

## [Unreleased]

## [0.1.0] - 2026-11-17（版本号重置，重发）

### Added

- **主流风格两档主题**（2026-11-17 用户决定：向主流 AI Agent 软件对齐，新增而非替换）：
  `daylight`（消费级暖白，ChatGPT / Claude 网页版参考）与 `carbon`（深色友好工具级，
  Cherry Studio / Open WebUI 参考），与 ledger / hermes 并存、设置 → 外观即点即切。
  圆角卡面 / 留白 / 无衬线小标是另一套版式语汇；三处行为签名全主题不变
  （没有「新对话」、沉默间隔可见、「醒着 + 距上次」状态行）。
- **STATUS.md 机器事实真源**：`npm run status` 实测生成（两仓 git / 六处版本号 / schema /
  依赖 / 源文件数 / 打包快照一致性），`status:check` 闸门挂进 `npm run check` 与 `release:check`
  （CI 跳过，它是本地闸门）；手写现状漂移由此收口。

### Changed

- **默认值改定**（2026-11-17）：`ui.theme` 未写默认 **carbon**、`ui.splash` 未写默认 **simple**、
  `ui.shell` 未写默认 **notebook 三栏**。只改代码回落值，不写回用户 config.json；
  首屏服务端注入 `data-theme` / `data-shell`，不闪默认色与默认版式。

### Fixed

- **主题变量泄漏**：`[data-theme=…]` 变量块曾命中设置页里自带同名属性的按钮，
  导致跨主题反色、hermes 在 carbon 下深底黑字不可读；选择器全部加 `html` 前缀，变量只落根元素。
- **陪伴视图输入条遮人物**：舞台改为按 `.cp-bottom` 实测高度让位（ResizeObserver），
  人物裁切线永远在气泡 + 输入条之上；mesh 与 Live2D 两种形象都覆盖。
  **（同晚回滚：让位缩小了 fitCubism 缩放基准并暴露半身形裁切缝，owner 要求恢复改动前效果；方案搁置待测试）**
- **ui:test 旧断言修复**（11-14/11-15 界面重排遗留，ui:test 不在 CI 一直藏着）：
  记忆详情改读抽屉、设置改按组导航、Board 往返不再猜状态；首屏断言改查 `<html>` 开标签
  （整页 includes 会命中样式表选择器文本，属假阳性）。

### Added

- **声音 / 视觉配置不再由我预设，全部你自己写**（2026-11-15）。字段口径对齐 OpenAI 兼容
  `/v1/audio/speech` 与常见本地推理服务（Ollama 11434/v1、LM Studio 1234/v1、
  llama.cpp 8080/v1、vLLM 8000/v1）：`baseUrl` / `apiKey` / `model` / `voice` / `speed`
  / `volume` / `format` / `instructions` / `modelPath`。
  `backend` 与 `vision.provider` 从 `local|cloud` / `ollama|cloud` 两个字面量放开成任意字符串：
  local=sherpa-onnx、cloud=msedge-tts、其它名字走 OpenAI 兼容 HTTP（声音 `/v1/audio/speech`，
  视觉 `/v1/chat/completions`）。`apiKey` 走加密凭据库的 `tts` 槽，不进 `config.json`。
  设置页所有输入都显示 **config.json 里的原值**，留空 = 未设置/清掉，不替你写回默认值；
  运行时归一化出来的档位另放在「状态」里，并通过 `configured` / `modelSet` 如实标注。
- **设置页分组与顺序由你决定**：`ui.cfgGroups` 存你自己的 `[{name, hint, secs}]`，
  页首「⚙ 自定义分组与顺序」直接编辑 JSON；不写就用内置默认，「恢复内置默认布局」把键删掉
  而不是写一份默认值进去。
- **「{ } 直接编辑配置 JSON」**（VS Code settings.json 式）：`GET/PUT /api/config/raw`
  只开放 `ui` / `tts` / `vision` 三个命名空间，脱敏、按命名空间合并、没写的键保持不变；
  整份校验，写坏了明拒（`E_BAD_RAW`），不悄悄修。密钥不在这份里。
- **陪伴视图 🔊 真的能存**：以前写死 `CP_SOUND = true`，点了只在内存里翻转、刷新就回去。
  现在从 `/api/ui` 读 `ui.sound`、点击写回；音量读 `tts.volume` 并作用到 `Audio.volume`。
- **声音后端留空 = 没配，不再静默拿 `local` 兜底**（用户定：「没配就干脆不发声 / 明确报错」）。
  `ttsConfig()` 不再把空 backend 补成 `local`；陪伴视图读 `configured`，没配时**连 `/api/tts` 请求都不发**，
  安静跳过发声、不弹错；主动合成（设置页「试听一句」/ `POST /api/tts` / `jingjing tts say`）返回
  `E_TTS_NO_BACKEND` 并附上该填什么。状态、音色列表、错误信息共用同一句 `NO_BACKEND_HINT`。
  设置页如实写「没配 · 不发声」。顺带把 CLI `tts use` 从写死的 `local|cloud` 放开成任意后端名，
  新增 `tts use clear` 清空。
- **对话预算：聊天可关、工作不设总预算**（2026-11-16）。工作档不再按 5200 收口（`WORK_TOTAL = Infinity`）；
  聊天档默认仍是 2600，新增 `config.brief.chatUnlimited` 与 `GET/PUT /api/brief`，设置 → 大脑 →
  对话预算里一个开关就能关掉。**「不设总预算」只取消「超量时按优先级丢槽」这一层**：
  召回 ≤8 条、契约 ≤15 条、最近几轮的行数 / 每行字数上限照旧，所以上下文仍不随轮数增长。
  `eval:assembly` 走聊天档，2600 的预算闸门不受影响。
- **「视觉设置」找得到了**：原来四节视觉相关的设置散在三个组里（「眼 · 视觉」在「大脑」、
  「形象与背景」在「她」、「外观 / 开机片头」在「观感」），点开叫「观感」的组反而找不到视觉。
  默认布局收成一组「视觉 · 观感」（看图 · 形象 · 背景 · 主题 · 片头），陪伴视图的调参按钮
  也从「镜头 · 形象」改叫「视觉 · 镜头」。另加**设置页搜索框**：输「视觉」直接把四节搬到
  结果面板（移动 DOM 节点而非复制，按钮与已绑事件都还是原来那一份），Esc 清空回分组。
  搜索只比小节标题 + 组名 + 别名，不拿整节正文凑数，免得搜「声音」捞出「人格 / 头像」。
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
- **记忆趋势**（`GET /api/memories/trend?days=30&outage=1`，`src/trends.ts`）：近 N 天每日新增、
  active 累计、按**记忆年龄**分桶的权重保留率、按种类的保留率。全部由 `memories` 已有的
  `created_at / w0 / weight / stage` 现算，**没有新增采样、没有落地任何时间序列**——
  资源页仍按决策 4 只给当前快照。
- 记忆页顶部「展开近 30 天趋势」：两张内联 SVG（每日新增柱状、衰减曲线）+ 按种类横条 + 口径说明；
  可切 7 / 30 / 90 天，可切换是否计入断片。默认收起，首屏不为它多打一次请求。
  三条诚实性约束写进了代码注释与界面文案：① 切日按**本地**时区（库里存 UTC，直接取前 10 位会让
  本地 20:00 后写入的落到第二天）；② 库里没有逐日权重快照，所以衰减曲线横轴是**记忆年龄**而不是日期，
  按日期画等于编历史；③ 断片默认排除，但被排除了多少条如实显示，空样本的年龄段不画点也不连线。

### Changed

- 记忆详情里的「种类」不再一律显示为「经历」：列表接口以前在搜索路径上把 `kind` 硬写成
  `episode`，现在按真实 `kind` 返回。筛选器另加词表把 `fact / fact_hard` 区分为「事实 / 硬事实」、
  `preference_*` 区分为「强偏好 / 弱偏好」——原来两组同名，会出现两个点了效果不同的同名按钮。

### Removed

- **`PUT /api/memories/:id`（改记忆正文）已删除**（决策 3：不允许编辑记忆）。界面上的
  「编辑正文」入口同步移除；要纠正一条记错的记忆，走「忘掉 → 重新记住」，两步都留痕、都可撤销。
  该端点原本同时承载「改 importance / 改敏感度」，敏感度已拆到独立路由，importance 无界面入口、一并撤掉。

### Fixed

- **衰减曲线的年龄基准和入参 `now` 不是一个时刻**：`src/trends.ts` 的分桶 SQL 写死
  `julianday('now')`，函数入参 `now` 只用于日期窗口。跨天之后「今天刚记的」会被算成 1 天前，
  测试传固定 `now` 时直接红（`0 !== 1`），界面上也是同一个毛病。现在把 `now` 当参数传进 SQL，
  只认调用方给的时刻。
- `scanHome()`：任一子树超过扫描深度会把**整轮扫描停掉**，Windows 用户目录实测只统计到 4 个文件
  就中止。现在深度超限只跳过该子树并计入 `depthLimited`（`truncated` 仍如实标不完整）；
  同级目录与浅层文件照常统计。
- 已启用（`state === "enabled"`）的能力不再挂「怎么装 / 去哪配」的提示与跳转，避免把人往配好的地方赶。
- `/api/ui` 的 `beatRunning` 从「认 argv」改为认运行期信号，与 `/api/overview` 结论一致。
- 「体检」页的资源段改为概要 + 「看完整存储明细」跳转：同一份数字在两个页面各画一遍，迟早有一处忘记改。
- **陪伴视图的对话气泡会顶出窗口**：收起态 `.cp-log.clip` 写了 `max-height:none;overflow:visible`，
  一条长回复把气泡撑到 1006px（1093×640 的窗口里 y 是 −461）——开头几段跑到窗口外面，
  而且不能滚动，等于读不到。现在两态都是 `overflow-y:auto` 的滚动容器：展开上限
  `min(46vh,480px)`、收起 `min(20vh,168px)`；
  顶部「↑ 之前 N 条」从 10.5px 低对比提到 11.5px 并加底色描边（压在照片背景上原本几乎看不见）。
- **陪伴视图一直在显示裸 markdown**：气泡走 `textContent`，而记录本用的是服务端 `renderMarkdown`
  —— 同一句话在两边长得不一样（`**读**`、`- ` 列表、反引号原样露出来）。现在历史取 `/api/timeline`
  的 `html`，当场那一轮说完回读一次 timeline 换成渲染版（`md.ts` 仍只有一份实现）；
  渲染失败就退回流式那段纯文字，不丢内容。
- **「收起」被实现成了「把历史藏掉」**：先按字符截 200 字、再 `display:none` 只留最后两条、
  再按 4 行钳正文 —— 收起时滚轮根本滚不动，因为那些行不在布局里（「收起时也要能用鼠标滚轮
  滚动对话框查看之前的对话」）。现在收起只是**把同一个滚动窗口收窄**：历史行全部留在 DOM 里、
  正文不截字不截行，默认贴底显示最新一句，往上滚就是完整历史；上下渐隐提示还有内容。
  正文外那层 `.cp-body` 保留下来隔离工具胶囊（markdown 挂点也在它上面）。
  自动跟随只在人本来就在底部时发生（`CP_AT_BOTTOM` 由 scroll 事件维护）：手动翻历史时
  新来的 delta 不会把人硬拽回底部；发一句新话才强制回到这一轮。
  指针压在「↑ 之前 N 条」或气泡内边距上时，滚轮也会转发给对话区。
  实测 1280×800：收起窗口 160px / 可滚 1253px / 气泡 226px；滚轮上翻 `scrollTop` 1093→553
  能看到较早那轮，展开窗口 368px，收起又回到贴底。
- **陪伴视图看不见她动过什么手**：她说「刚跑了两条」，面板里没有任何痕迹。现在正文下方挂一排
  工具胶囊（`git_status · 149ms`），点开就是那条输出，再点收起；数据来自 timeline 新增的
  `toolList`（记录页仍用原来的 `<details>` 卡片）。


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
