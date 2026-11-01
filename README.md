# Pseudo Digital Life Project

跑在本机的"伪数字生命"原型：**记忆 + 衰减 + 人格**（定义与验收口径见 `../docs/0-定义-数字生命.md`）。

> **名字的两层，别搞混：**
> · **项目** = **Pseudo Digital Life Project** —— `tauri.conf.json` 的 `productName`、窗口标题、`<title>` 都用它。
> · **她** = 用户给的名字 —— 默认 `agent.name` 是**预置人格**「鲸鲸」（测试人格），
>   第一次打开引导页/设置里就能改（设置 → 「AGENT · 她的名字」）。
> · 仓库目录 `jingjing` 是历史遗留，**不是产品名**。

**无构建**（Node 24 直接跑 TypeScript，类型剥离）；运行时依赖只有两个：`casbin`（策略）与 `sqlite-vec`（向量扩展，缺了会降级成纯 FTS 并在 `/health` 里报出来）。

> **环境要求：Node ≥ 24**（`node:sqlite` 在 22 还是实验性 API）。
> 摄入 PDF / docx 需要 Python + `markitdown`（`.md / .txt` 不需要）。没装会用 `E_NO_PYTHON` 明说，不静默失败。
> 找解释器的顺序：`JJ_PYTHON` → 项目 `.venv` → PATH 上的 `py -3` / `python3` / `python`。

```bash
npm run check                         # 类型检查 + 499 条测试 + 地图不漂移（CI 入口；GitHub Actions 就跑这条）
npm test                              # 499 条断言（node --test）
npm run ui:test                       # headless Edge 真点真发：48 项交互断言（+3 项空库跳过；面板要在跑）
node src/cli/jingjing.ts migrate      # 建库 + 自检
node src/cli/jingjing.ts remember "重要性应该影响衰减速率"
node src/cli/jingjing.ts search "衰减速率"
node src/cli/jingjing.ts verify       # 三重指纹 + inbox 重放 + 断电检测
node src/cli/jingjing.ts outage 10    # 拔电模拟（半行截断）10 次
node src/cli/jingjing.ts bench 40000 real    # 两阶段检索基准（门：p95 ≤20 ms）
node src/cli/jingjing.ts config       # 角色表 + 隐私校验
node src/cli/jingjing.ts test offline # 真 Ollama 往返，断言全部出站落在回环
node src/cli/jingjing.ts test leak    # 断言：带记忆原文的云端调用 0 次出站
echo <KEY> | node src/cli/jingjing.ts auth set deepseek   # key 存 DPAPI，密文落盘
node src/cli/jingjing.ts auth list    # 只看指纹
node src/cli/jingjing.ts test cloud   # 真调云端 + 记账 + 预算闸
node src/cli/jingjing.ts night        # 夜间整备：抽取 → 冲突消解 → 归并 → 自传
node src/cli/jingjing.ts eval         # 评估：recall / abstain / trap / contract 四道门
node src/cli/jingjing.ts eval --model # 额外跑模型层"编造共同回忆"（花 API 费用）
node src/cli/jingjing.ts redteam      # 红队 21 例（必须全拦）
node src/cli/jingjing.ts templates    # shell.run 能跑的模板（id/档位/参数槽）
node src/cli/jingjing.ts shell git.status                   # T0/T1 只读模板，直接跑
node src/cli/jingjing.ts shell node.run_script --slots '{"script":"a.mjs"}'        # T3：只预览 argv+指纹
node src/cli/jingjing.ts shell node.run_script --slots '{"script":"a.mjs"}' --yes  # T3：确认并执行（一次性令牌）
node src/cli/jingjing.ts verb fs.list '{"path":"workspace"}'   # 手动调能力
node src/cli/jingjing.ts beat --dry-run  # 心跳判定（不写库不发消息）
node src/cli/jingjing.ts serve 7700 --beat  # 面板 + 每 60s 一次心跳
node src/cli/jingjing.ts ingest data/sources   # 摄入：md/txt 直读，pdf/docx/… 走 markitdown（默认仅本地）
node src/cli/jingjing.ts ingest data/sources --shareable  # 同意这些文档进云端简报（默认不）
node src/cli/jingjing.ts docs         # 已摄入的文档与块数
node src/cli/jingjing.ts export       # 搬家：导出一致快照 → exports/<时间>/（校验清单里的 sha256）
node src/cli/jingjing.ts import <dir> --force  # 搬到新 home（旧目录自动改名备份，然后补跑衰减）
docker compose -f docker/compose.yaml up -d  # 容器里跑（数据卷 ./data，只映射宿主回环）
node src/cli/jingjing.ts usage        # 今日花费与按角色/模型拆分
node src/cli/jingjing.ts serve 7700   # 本地面板 http://127.0.0.1:7700
npm run ui:test                       # headless Edge 真点真发（CDP），48 项断言
npm run ui:shot tmp/shot.png          # 截一张图肉眼验收
npm run docs:sync                     # 把上层文档仓单向同步进 docs/（产物别手改）
node src/cli/brief-demo.ts --full     # M1.1：第 1 轮 vs 第 100 轮简报
```

## 模块

| 文件 | 职责 | 文档依据 |
|---|---|---|
| `src/fsx.ts` | 原子写（tmp→fsync→rename→fsync dir）+ 追加行 fsync | `18 §1.2` |
| `src/journal.ts` | inbox：原始事件唯一事实源；重放容忍截断尾行 | `18 §1.1/§1.3` |
| `src/boot.ts` | boot_id + clean 标志 → 三种不连续（power/crash/restart） | `18 §2.1` |
| `src/schema.ts` | 迁移 001（memories/chunks/FTS/vec/audit/outages） | `02 §4` |
| `src/decay.ts` | 拉伸指数 + 四段 stage + 双阈值滞后 + 再巩固 + flashback | `01 §4/§5` |
| `src/store.ts` | remember / tickDecay（**不动锚点**） | `01 §11.1` |
| `src/retrieve.ts` | 两阶段检索（FTS bigram → cosine → MMR） | `02 §7.1` |
| `src/text.ts` | 中文 bigram（`unicode61` 对中文完全失效） | `12 §9.1` |
| `src/embed.ts` | embedding（ollama / fake） | `13 §2` |
| `src/provider.ts` | 角色路由 + `assertLocalOnly` 隐私闸门 + 降级链 | `13 §2`、`19 §0.1` W-A |
| `src/transport.ts` | 真调用层（ollama / anthropic / openai-compatible）+ **fetch 前的守卫** + 出站 span | `13 §2`、`19 §0.1` |
| `src/config.ts` | 角色表默认值与 env 覆盖 | `13 §2` |
| `src/auth.ts` | 凭据存储（DPAPI / libsecret / 0600）+ 指纹显示 | `13 §3` |
| `src/budget.ts` | 记账（含 `cached_tokens`）+ 预算闸 + 成本估算 | `13 §6` |
| `src/web/server.ts` | 单页 + API + SSE；编码闸（拒收非 UTF-8） | `17 §4/§5.1` |
| `src/web/timeline.ts` | 时间轴分组：同日空隙 / 跨天带"距上次" | `17 §1/§4` |
| `src/web/state.ts` | 状态行：一句话而不是仪表盘 | `17 §4.1` |
| `src/agent.ts` | 工具循环：模型 → 工具 → 模型（≤6 轮，工具结果截断） | `11 §3` |
| `src/tools.ts` | 内置 verb（fs/memory/time）+ 路径白名单 + 注册表 | `04 §3` |
| `src/mcp.ts` | MCP stdio 客户端（initialize / tools/list / tools/call） | `11 §3` |
| `src/md.ts` | Markdown → HTML（先转义，代码块优先，链接只放 http(s)） | `17 §5.5` |
| `src/verbs.ts` | 能力目录（T 档/参数/目标）+ `safePath` 真实路径校验 | `04 §3` |
| `src/shell.ts` | **T3**：命令模板（占位符独占 argv 元素）+ 一次性令牌（argv_sha256/cwd/120s/单次）+ 超时杀进程树 + 环境白名单 + 可选容器沙箱 | `04 §4.1/§5.2/§6` |
| `src/confirm.ts` | 待确认卡（面板侧栏）：按指纹去重、15 min 时效、不存令牌 | `04 §4.1` |
| `src/handoff.ts` | 搬家：`VACUUM INTO` 一致快照 + sha256 清单 + 校验后 staging 替换 + 补跑衰减 | `19 §7.4` |
| `src/chunk.ts` | 分块：标题栈 heading_path、代码/表格永不切、400–800 tok、15% 重叠、小块合并 | `02 §5.2` |
| `src/ingest.ts` | 摄入：markitdown（子进程、路径只进 argv）→ 分块 → 索引；sha256 幂等、旧块标 deleted_at | `02 §5.1/§5.3` |
| `src/recall.ts` | P10 召回装配 + **隐私闸门**：只有 shareable 进简报，其余只报个数 | `02 §10.1`、`13 §10` |
| `src/web/static/icon-*.png` | PWA 图标（构建期用 headless Edge 从同一个鲸尾 symbol 渲染） | `19 §7.5` |
| `src/tools.ts` | **唯一工具面**：verb + MCP 全走 execute；点号→下划线别名 | `11 §5.6` |
| `src/policy.ts` | casbin 策略（allow/deny × advise/enforce） | `04 §4` |
| `src/execute.ts` | 策略 → 执行 → 审计，一处不落 | `04 §4` |
| `src/heartbeat.ts` | 心跳：纯函数判定 + 意图审计 + 起草降级 | `01 §10` |
| `src/eval.ts` | 评估：四组用例 + 四道门 + 自动生成 + 两层诱捕 | `01 §13` |
| `src/nightly.ts` | 夜间整备：游标/抽取/冲突消解/归并 | `01 §9` |
| `src/autobio.ts` | 自传：引用由正文反推 + 摘录式兜底 | `01 §9.1` |
| `src/territory.ts` | 领地目录与索引规则 | `16 §3.5` |
| `src/state.ts` | 自我状态：慢变量 + 单轮上限 + 回放 | `01 §8` |
| `src/startup.ts` | 启动自检：断电检测 → 记 outage → 写记忆 → 补算衰减 | `18 §1.3/§2.2` |
| `src/configfile.ts` | `data/config.json`（env > 文件 > 默认） | `13 §2` |
| `src/persona.ts` | 读/写人格文件 + `versions/` 留痕 + **回落到 bundled** | `07 §2`、`18 §4.4` |
| `src/assert.ts` | 越界即抛（替代 `!`，漏了会炸而不是 NaN 传播） | — |
| `src/brief.ts` | 11 槽位情境简报 + 稳定前缀 | `06 §3`、`17 §2` |

## 实测（本机，2026-10-27）

| 项 | 数值 |
|---|---|
| 40k 记忆建库 | 8.9 s（3 次写入/条，含 FTS 与 vec） |
| 暴力向量扫描（vec0, 512 维） | **78 ms** |
| **两阶段检索（真实语料）** | p50 **8.6 ms** / p95 **13.0 ms** ✅ 门（≤20） |
| 两阶段检索（最坏语料：10 模板重复） | p50 11.3 / p95 28.8（只报告，不设门） |
| 简报 token（第 1 轮 / 第 100 轮） | 687 / 1262（预算 2000） |
| 真 `bge-m3` embedding（20 条，512 维） | 575 ms（批量 `/api/embed`） |
| 512 截断 vs 1024：命中/MRR/矩阵相关 | 8-8 / 0.838 / **0.971** |
| `test offline` 往返（embed + 1.5B 一句话） | embed 118 ms + chat 1482 ms，**出站 0 条越界** |
| `test leak`（带记忆原文调云端） | **blocked，0 次出站** |
| `test cloud`（真调 DeepSeek） | 1002 ms，16 in / 1 out，**$0.000005** |
| key 存储 | DPAPI 密文 353 B，`grep` 明文零命中 |
| 面板端到端（真 DeepSeek 流式） | brief 748 tok → 首帧 ~1.1 s → 逐字流；回复里带 `mem:1` 引用 |
| 稳定前缀 hash | `e8749dc2a3b30229`（两轮相同） |

## 五条被工具抓出来的真问题（都已修）

1. **`lastDecayAt` 被 tick 更新 → 记忆会复活**。锚点语义：`w = f(w0, now − 锚点)`，
   普通 tick 只能重算 `weight/stage`，**绝不能移动锚点**；否则下次用 `d=1` 重算出高权重。
2. **`vec0` 主键只收整数**。node:sqlite 把 JS `number` 绑成 REAL → insert 失败，
   而当初那个 `try {} catch {}` 把它吞了，导致库里 40k 条记忆一个向量都没有。
   现在：`BigInt(id)` + 失败写 `meta.vec_error` 并记事件。
3. **`tsc --noEmit` 通过 ≠ Node 能跑**。Node 的类型剥离是 strip-only：
   不支持参数属性（`constructor(public x)`）、`enum`、`namespace`。
   第一次写 `PrivacyError` 用了参数属性，tsc 全绿但运行时 `SyntaxError`。
   → tsconfig 开 **`erasableSyntaxOnly: true`**，让类型检查和运行时用同一套语法标准。
4. **页面 JS 整页挂掉（`
` 被模板字符串展开成真换行）**。
   `page.ts` 里写 `buf.split("

")`，在 TS 模板字符串里被展开成**真换行**，
   于是浏览器收到的 JS 是 `buf.split("` + 换行 + `")` → 整页 `SyntaxError` → **面板完全无法交互**。
   修法：改用 `String.fromCharCode(10, 10)`，彻底不依赖转义。
   **已加回归测试**：把页面 `<script>` 抽出来跑 `node --check`——这类"生成代码"的问题，测试比眼睛可靠。
5. **`embed` 也是"读记忆原文"的角色**。我最初把 `embed` 放进 `EXPRESSION_ROLES`，
   结果 transport 的隐私闸门在第一次 embed 测试就抛 `E_PRIVACY`——
   因为嵌入的输入**就是记忆原文**。已改：`MEMORY_ROLES = {embed, route, extract, salience, conflict}`。

## 做完的与还欠着的

- [x] embedding 走真 Ollama `bge-m3`（`fake` 仍保留给基准与单测）
- [x] **摄入管道** markitdown → 分块（heading_path / 15% 重叠 / 代码与表格不切）→ FTS + 向量（`02 §5`）
- [x] `provider.ts` 角色路由 + `assertLocalOnly`（记忆类角色全 local）
- [x] `transport.ts` 接真 Ollama（`complete` / `embed` 批量）+ 出站 span
- [x] 云端 transport 的真实鉴权（anthropic 走 `x-api-key` + `anthropic-version`，其余走 Bearer）
- [x] `auth.ts`（DPAPI 存 key，只看指纹）/ `budget.ts`（预算闸 + 记账）
- [x] Web 面板 P0（时间轴 / 无「新对话」/ 记忆面板 / SSE）
- [x] 面板内配置 API（provider/model/key → DPAPI）与人格（六个 md + 版本留痕）
- [x] 本地面板写操作守卫（`x-jj` 头 + 同源 Origin）
- [x] 工具循环 + MCP 客户端（实测：markitdown 转 PDF 后回答）
- [x] 三栏骨架（左 wing：她·今天·去处 / 中 stage：对话 / 右卷宗：等你点头·计划·改动·上下文）+ 服务端 Markdown + 工具卡
- [x] 「能力」屏：插件（MCP）/ 技能（SKILL.md）/ 原生工具与命令 / 降级项，一屏摊开
- [x] **M2 完成**：断电检测/记忆/提示、self_state、补算衰减、三种时间措辞
- [x] **M3 大部分**：夜间整备（游标/抽取/冲突/归并）、自传（反推引用+摘录兜底）、领地
- [x] **M3 完成**：夜间整备 / 自传 / 领地 / eval harness（四门全绿）
- [x] **M5 完成**：能力目录 + casbin 策略 + 红队 21 例 + A/B 双槽与自动回滚 + **T3 shell.run**
- [x] **面板可用性**：证据链（召回行 + 可点引用）/ 动作审计 / 搜索 / 面板内摄入 / 记忆纠错 / 停止生成 / 快捷键
- [x] T3 的**面板确认按钮**（侧栏“待确认”卡 → 服务端现签现用令牌）
- [x] **容器沙箱**（`JJ_SHELL_SANDBOX=docker`：`--network=none --read-only --cap-drop=ALL`，引擎不在就拒跑）
- [ ] Job Object / bwrap / 降权 / 低完整性（Windows 上要原生模块）
- [ ] 桌面壳的 release 构建与安装包（现在只有 `target/debug` 的 exe）
- [ ] 卷宗还差三块：计划槽 P9 原文 / `git.status`·`git.diff` 校样 / 文件面板
- [ ] hooks 层（`/health` 里唯一的降级项 `hooks-not-implemented`）

## 图标署名（CC BY 3.0，不可删）

标签页 favicon 与面板头像用的是同一个内联 SVG（`src/web/page.ts` 里的 `#whale` symbol）：

- **Whale Tail** — Lorc，[game-icons.net](https://game-icons.net/1x1/lorc/whale-tail.html)
- 许可：**CC BY 3.0**（https://creativecommons.org/licenses/by/3.0/）
- 改动：无（原样 512×512 单路径，只用 `currentColor` 上色）

CC BY 3.0 要求保留署名 —— **这一节不要删**；要换图标就同时换掉这里。
候选与对比过程见 `tmp/wref/compare5.png`（临时目录，可删）。

## 许可证

MIT（见 `LICENSE`）。版权人：Fez。

> 需要知道的边界：这个程序会读写你本机的文档与记忆。它不会自己连外网（除非你显式配了云端 API key）；
> 标为 `local_only` 的记忆与文档永远不随请求出网（两处装配都有闸门 + 红队覆盖）。
