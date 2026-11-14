# 更新记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，日期用本地日期。
**重要**：`Unreleased` 里的改动都还只在工作区源码里，**没有打进任何已发布的 0.1.1 安装包**。
装了桌面版的用户要等下一次发版才会拿到；开发测试版（直读源码）重启应用即可。

## [Unreleased]

> 截至 2026-11-14，工作区有数十个未提交文件（含此前会话的改动）。下面按主题归并，不是逐文件清单。

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

- WSL 真机（`wsl.exe` 在安全黑名单）、Linux CI 流水线（改动未推送，从未跑过）。
- 真机 A/B（`qwen2.5:7b-instruct`）证明 `JJ_NEED_EVIDENCE_NOTE` 在本机 7B 上**零可测量收益**
  （改前 7/8↔7/8、改后 7/8↔7/8），软提示不是有效约束，建议后续改成生成后证据核对。
- 打包快照 `desktop:sync:check` 仍判红：源码改动未同步快照，发布前跑一次 `npm run desktop:sync`。
- 所有改动**未提交、未推送**，安装包 `0.1.1` 未重建。

## [0.1.1] - 2026-11-10

首个可安装的 Windows 桌面版（`Pseudo Digital Life Project`）：Tauri 壳拉起 Node sidecar、
内置 Node 24、打包快照、首启引导、托盘四项、退出杀进程树、DPAPI 存密钥。
安装与首次配置见 `docs/ops/23-发布-桌面端-首次配置.md`，逐版本说明见
`docs/ops/release-notes-v0.1.1.md`。

## [0.1.0]

命令行与 Web 面板形态：记忆库、衰减、人格六块、情境简报、检索与评测夹具。
