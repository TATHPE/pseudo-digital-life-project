# 交接文档（HANDOFF）

> 2026-10-29 最后更新 · 给"下一个我"或下一个人看。
> 你不需要读 3000 行设计文档才能接手——**先把这份读完，再按 §2 跑三条命令验证**。

---

## 0. 一句话现状

**鲸鲸（`D:\LLM\jingjing`）是一个能跑、能测、能自检、能回滚、能跑命令、能接通云端的 L3 原型**，
但**记忆整理（夜间整备）是停的** —— 1.5B 调不动工具（2026-10-28 已删），替代模型还没选定（§6.1）。

```
245 条测试全绿 ｜ 0 error TS ｜ 红队 21/21 ｜ 面板 20/20（桌面+手机）｜ 冒烟 20/20
代码 10767 行（src，57 个文件）+ 3762 行（test，25 个文件）｜ schema v8 ｜ 32 次提交
记忆 44 条 ｜ 文档 2 篇 / 30 块（全部有向量）｜ 已发布 20261028-200120-m4nc
面板跑在 127.0.0.1:7700（PID 13608）
```

**接手第一件事只有一件**：把「本地整理模型」定下来（§6.1）。
在那之前，`night` 会明确告诉你"缺模型"并退出 2；**面板对话、检索、工具、发布都不受影响**。

### 当前能力边界（一眼看全）

| 能力 | 状态 | 说明 |
|---|---|---|
| 面板对话 | ✅ | `express` = DeepSeek 云端（实测 789 ms）；云端失败会自动降级到本地模型并**明确标注** `notice` |
| 文档摄入（markitdown → 分块 → FTS+向量） | ✅ | 真 PDF 26 块 / 5.5 s；面板侧栏可加，带候选下拉 |
| 检索（两阶段 + 引用） | ✅ | p50 8.6 ms；召回行可见、`mem:`/`doc:` 引用可点 |
| 工具调用（T0–T3） | ✅ | 21 条红队全拦；T3 一次性令牌 + 杀进程树；`smoke-tools` 能验模型会不会调工具 |
| A/B 槽 + 自动回滚 | ✅ | 注入 `exit(1)` 版本 → 0.2 s 回 A 槽 |
| 容器 / 搬家 / 手机 PWA | ✅ | 镜像 2m44s；`export/import` 搬家 3 次零差异 |
| 记账 | ✅ | 聊天/心跳的真实 token 都入 `usage` 表（今天修：之前只有 CLI 会记） |
| 断电感知 / 衰减 / 心跳 | ✅ | 与模型无关，照常工作 |
| **记忆整理（夜间整备）** | ❌ **停** | 本地没有能调工具的模型；`night` 退出码 2 |

---

## 0.1 2026-10-28 → 10-29 这一轮改了什么

按提交顺序（都在 `jingjing/` 仓库里，`git log` 可查）：

| commit | 事 |
|---|---|
| `1db9e59` | 摄入管道：markitdown → 分块（heading_path/重叠/代码表不切）→ FTS + 向量 |
| `7319f92` | 文档块接进 P10，**闸门建在装配处**（`src/recall.ts`）：只有 shareable 进简报 |
| `e81de32` `9ec2b90` | 配色纠正：结构用白、青色退回强调色；加顶部仪表带 + 底部 ticker |
| `0f6d14c` | 配色定稿：**全站唯一保留青色的地方 = 鲸鲸的回话气泡** |
| `239598a` | 标签页标题改 `Pseudo Digital Life Project` |
| `0420492` | ⚠️ 回退：项目名**不是**人格名（人格仍是「鲸鲸」） |
| `e606054` | 视图切换：`#jump` 只属于对话、切回对话保住滚动位置、接口表单说清怎么填 |
| `f549280` | 「点开看全部」原来不是控件；`/api/audit` 补 `total` |
| `3f233e8` | 侧栏选中态：点一个文档，其他同类也跟着被框 |
| `e803d43` | 「回到最新」改成 CSS 强制（非对话视图不可能出现） |
| `1de96e5` | **云端失败 → 本地兜底真正接上**（`fallbackChain` 当时是死代码） |
| `81e7373` | **聊天/心跳的 token 从来没入账**（「今日花费」是假读数） |
| `492d521` | **「允许进云端」原本基本没用**：工具结果把 local_only 原文带出网了 |
| `4c12e46` | **P0-1 工具调用冒烟** `jingjing smoke-tools`（+11 条测试） |
| `2aabc1b` | 删 1.5B 后，`night` 给可读出路（退出码 2），不再抛 404 |
| `0754202` | 删树莓派分支（`docs/99`）；修「过期契约还在喂给模型」 |
| `6350548` `9fda65c` | 侧栏改成黑底 + 白框格子；修「进设置总在最底」；分区标题改标签条（+3 条 ui:test） |

### 0.1.1 2026-10-30 这一轮（E-6 / C-5 / C-1 / E-1 / D-1）

| commit | 事 |
|---|---|
| `4e536a0` | **E-6 + C-5**：`night` 缺模型时**降级而不是停摆**（衰减 + `advance({night:true})` 照做，游标不动，退出 0，`/health` 报 `nightly-skipped`）；`defaultConfig` 不再把已删的 `qwen2.5:1.5b-instruct` 当默认值 |
| `b305df2` | **C-1**：`auth remove` + 面板 `key:null` 清除密钥；顺带修掉三个一路挖出来的：**一次失败的聊天能打死整个面板**（`ERR_HTTP_HEADERS_SENT`）、**降级 notice 被 agent 循环吞掉**、**空模型报 ollama 原文** |
| `63c4412` | **E-1 + D-1**：kind 枚举与参数表对齐（4 种不再静默回落）+ 未知 kind 留痕；`taint` 终于参与决策（契约层拒收 external、注入侧 quarantine、再巩固不加权） |
| `94ffb44` | eval：空库时 recall 组等于没测，不许报「全部门通过」 |
| `87f6dc3` | **C-4**：本地模型升格为一等配置（`models list/use/doctor`、`config.json.local`、面板 ENDPOINT/LOCAL 两块）；`jingjing config` 终于显示**生效值+来源** |
| `6914f12` | 点设置闪 PowerShell：DPAPI 加 `windowsHide` + 按 mtime 缓存解密结果 + `secrets()` 进程内复用（1904ms → 3ms） |
| `58b7cc2` | **H-1**：去掉写死的 `D:/LLM/.venv`（改为 `JJ_PYTHON`→项目 venv→`py -3`/`python3` 探测，只认能 import markitdown 的）；`engines >=24` + 启动警告；README 更新（295 测试/两个依赖/Node≥24） |
| `0c75048` | **E-4 + E-5**：衰减参数白名单+范围+理由+版本号（`decay --params/--set/--reset`）；模型只能改元数据（`updateMemoryText` 只收 `human:*`，pre-image 含旧正文） |
| `af73459` | **E-2 + E-3**：`w0` 由 importance 推导（0.35–0.83，第一次有权重方差；`decay --reweight` 给旧数据补方差，默认 dry-run）；schema v10 加 `scored_by`（human/extract/rule/tool 各自署名） |
| `ed4563b` | **C-3**：端点前置检查收成一处（5 分钟按端点缓存、并发去重、不可达≠失败）；`/health` 出 `ollama-unreachable`；顺带修“embed 已配就假装聊天角色没事”的假绿 |
| `101e6df` | **J 组（浮现）**：`reinforce` 接上（想起就加固）、关系一跳召回、原话层（schema v9）、关系 why+止期+黑名单、浮现时机（每日≤2）、`jingjing links` 抽检与一句话拆线 |
| `a55af03` | **C-2**：换 embedding 后 `jingjing reembed` 重建索引；「索引过期」在 `/health`、`/api/models`、`models doctor`、`memory.search` 四处可见；顺带修 serve 启动用 defaultConfig 而不是 resolveConfig |
| `c6a725f` | **P0-2**：夜间抽取接上**只读**工具循环（先 `memory.search` 核对再交 JSON）；白名单在**执行侧**也校验；顺带修掉「抽取失败也推进游标 = 数据永久丢失」 |

测试 **295 条全绿**；`redteam` 21/21；`deploy smoke` 20/20（人格指纹 `b7942f824e56a2b4`）。

**这一轮最贵的两条教训**（都是"清空数据/拔掉 key 之后才看得见"的）：
1. **一次失败的聊天就能打死面板**：`deps.getChat()` 在 `try` 外面，而 SSE 头已经发了 → 外层 `json(500)` 抛 `ERR_HTTP_HEADERS_SENT` → 进程退出。**任何 SSE 路由的外层 catch 都必须判 `res.headersSent`。**
2. **"模型没说" ≠ "没什么可说"**：抽取报错时返回空串，上层就会把它当成"今天没什么可记的"并推进游标 —— 实测 38 条对话被一次永久跳过。**失败必须抛，游标必须留在原地。**
3. **"没有能力"必须变成一行状态，不是一个滑向 0 的数字**：energy 唯一的恢复点在 `night` 末尾，而 `night` 缺模型时提前 `return 2`；于是每聊 50 句掉一整格，顶栏慢慢变成"有点累"，无人知晓。

**三个"看起来有其实没有"的坑**（这一轮最重要的教训，细节见 §5）：
1. `fallbackChain` 写了但**从没被调用** → 没 key 时聊天直接 401，而 banner 写着"仅本地推理"；
2. 记账只发生在 CLI，**聊天一条都不记** → 「今日花费」永远 $0，预算闸形同虚设；
3. 隐私闸门只挡了**简报**那一路，**工具结果**把 local_only 原文整段发给了云端。

---

## 0.2 明天（或下半场）的推荐顺序

1. **先跑一遍自检**（§2），确认环境没退化：`npm run check` / `eval` / `redteam` / `deploy smoke`。
2. **拉模型**（用户已定：**两个都拉** `qwen2.5:7b-instruct` + `qwen3:8b`，约 2 小时）。拉之前先关掉一批浏览器标签（空闲内存 4.9 GB）。
   → ✅ 不阻塞的活已经做完了：P0-2（工具循环）、C-4（models 命令）、C-1（清 key）、C-2（reembed）。
3. **两个模型各过一道门**：`jingjing models use <名>` → `jingjing smoke-tools --n 10`（各要 ≥7/10）→ 选一个当默认。
4. **再跑 3 个历史案例回放**（P0-2 的验收：人工比对 10 条，错误 ≤2）。
5. **过门才真跑**：`jingjing night`，看 `out.tools` 里它到底查了什么、写了什么。

> 为什么这个顺序：**P0-2 和下载可以并行**。只等下载就浪费一小时；
> 只写代码又会让“模型行不行”继续悬着。两件事同时做，一小时后两边都往前走。

---

## 1. 五分钟上手

```bash
cd /d/LLM/jingjing

npm run check      # 类型检查 + 245 条测试（CI 入口，必须先全绿）
npm run ui:test    # headless Edge 真点真发，20 项断言（含"输入框在视口内"）
node src/cli/jingjing.ts serve 7700        # 面板 → http://127.0.0.1:7700
node src/cli/jingjing.ts serve 7700 --beat # 同上 + 每 60s 一次心跳（默认不开）
```

**依赖前置**（都已装好，换机器才需要）：
Python 3.12 + `D:\LLM\.venv`（markitdown）、Node ≥22.6、Ollama（**现在只剩 `bge-m3`，本地 chat 模型一个都没有**——见 §6.1）、Edge（`ui:test` 用）。

**API key**：DeepSeek，存于 `data/secrets/deepseek.secret`（Windows DPAPI 密文，`grep` 明文零命中）。
`GET /api/config` 只回指纹（`sk-3b…6238`）。⚠️ **这个 key 曾在对话里明文出现过，建议轮换一次**（轮换后 `echo <新key> | node src/cli/jingjing.ts auth set deepseek`）。

---

## 2. 自检命令（先跑这个再改代码）

```bash
cd /d/LLM/jingjing
npm run check                                   # 期望：0 error TS / 245 tests pass
node src/cli/jingjing.ts eval                   # 期望：recall 1.0 / abstainF1 1.0 / 编造率 0 / 契约 1
node src/cli/jingjing.ts redteam                # 期望：21/21
node src/cli/deploy.ts smoke                    # 期望：冒烟 20/20
```

其余可用命令：

| 命令 | 用途 |
|---|---|
| `jingjing smoke-tools [--model X] [--n 10]` | **工具调用冒烟**：换模型前先验它会不会调工具（≥70% 才合格） |
| `jingjing night` | 夜间整备（**现在会因缺模型退出 2**，见 §6.1） |
| `jingjing beat --dry-run` | 心跳判定（不写库不发消息），看它"为什么想说/不说" |
| `jingjing verb fs.list '{"path":"workspace"}'` | 手动调能力（走策略 + 审计） |
| `jingjing templates` | 列出 `shell.run` 能跑的模板（id / 档位 / 参数槽） |
| `jingjing shell git.status` | 跑 T0/T1 只读模板（不用确认） |
| `jingjing shell node.run_script --slots '{"script":"a.mjs"}'` | T3：**只预览**要执行的 argv + 指纹 |
| `jingjing shell node.run_script --slots '…' --yes` | 现场确认：签发一次性令牌并执行 |
| `jingjing eval --model` | 额外跑模型层"编造共同回忆"检查，**会花 API 费用** |
| `deploy status` | 当前槽位 / 历史 / 失败计数 / 是否冻结 / 每版完整性 |
| `deploy install --because "…"` | 把 live home 打成一版（**没有理由会拒绝**） |
| `deploy promote --id <id>` | 冒烟 20 项 → 切槽 → 应用（冻结期内拒绝） |
| `deploy rollback` | 手动回滚到最近一次跑通过的版本 |
| `deploy mutate` | **回滚演练**：注入"启动即崩"的版本，看它自己切回去 |
| `npm run ui:shot tmp/shot.png http://127.0.0.1:7700/` | 截图肉眼验收（可指定 URL） |
| `node tools/ui-test.mjs http://127.0.0.1:7700/` | 桌面尺寸跑同一套交互断言（20 项） |
| `UI_VIEWPORT=390x844 node tools/ui-test.mjs http://127.0.0.1:7700/` | 同上，但手机尺寸（走 CDP 真机尺寸，不是 `--window-size`） |
| `GET /api/audit` / `/api/search?q=` / `/api/usage` | 面板用的三个只读接口（动作审计 / 混合检索 / 今日花费） |
| `tailscale serve --bg 7700` | 手机访问：https 由 Tailscale 提供，面板仍只绑回环 |
| `jingjing ingest <路径> [--shareable]` | 摄入文档（md/txt 直读；pdf/docx/… 走 markitdown）。**默认 local_only，不会进云端简报** |
| `jingjing docs` | 列出已摄入的文档与块数（面板侧栏 DOCS 也能看） |
| `jingjing forget-doc <doc_id>` | 忘掉一篇文档（块标 deleted_at，FTS 行真删） |
| `jingjing export` | 导出一致快照（`VACUUM INTO` + sha256 清单）→ `exports/<时间>/` |
| `jingjing verify-export <dir>` | 只校验，不导入（搬家前先跑这个） |
| `jingjing import <dir> [--force]` | 校验 → staging → 换进来 → 补跑衰减（旧目录自动备份） |
| `docker compose -f docker/compose.yaml up -d` | 容器里跑（数据卷在 `./data`；只映射宿主回环） |

---

## 3. 代码结构（57 个模块，按职责分组）

```
存储与检索   schema.ts  db.ts  store.ts  retrieve.ts  text.ts  embed.ts  fsx.ts  journal.ts
摄入         chunk.ts（分块）  ingest.ts（markitdown → 块 → 索引）  recall.ts（P10 装配 + 隐私闸门）
记忆动力学   decay.ts  nightly.ts  autobio.ts  territory.ts  startup.ts  boot.ts
状态与人格   state.ts  persona.ts  config.ts  configfile.ts
模型与路由   provider.ts  transport.ts  tokens.ts  budget.ts  auth.ts
执行与安全   verbs.ts  policy.ts  execute.ts  shell.ts  confirm.ts  tools.ts  mcp.ts
发布与回滚   deploy/fingerprint.ts  deploy/slot.ts  deploy/watchdog.ts  deploy/smoke.ts  cli/deploy.ts
搬家与容器   handoff.ts  docker/Dockerfile  docker/compose.yaml
主动性       heartbeat.ts
评估         eval.ts  toolsmoke.ts（工具调用冒烟）  cli/eval.ts  cli/redteam.ts
界面         web/server.ts  web/page.ts  web/timeline.ts  web/state.ts  md.ts  brief.ts  agent.ts
             面板能力：证据链（召回行+可点引用）/ 动作审计 / 搜索 / 文档摄入 / 记忆纠错 /
             停止生成 / 待确认角标/标题闪 / 版本与冻结 / 今日花费 / 回到最新 / 快捷键
入口         cli/jingjing.ts  cli/night.ts
```

数据库表（`data/memory.db`，schema **v8**）：
`documents / chunks / chunks_fts / memories / memories_fts / vec_memories / memory_links / self_state / intents / outages / usage / exec_audit / events / meta`

发布目录（`data/deploy/`）：
```
releases/<id>/manifest.json   三重指纹 + 每个文件的 sha256 + 为什么改
releases/<id>/persona/*.md    载荷（人格 = ② 参数类；**不含核心代码，也不含 policy.csv**）
releases/<id>/record.md       「我变了」的记录
current -> releases/<id>      装饰软链（不是事实源）
state.json                    ← 事实源：active/prev/applied/history/failures/freeze/lastAttempt/lastHealthy
```

**执行路径只有一条**（这条很关键，别再分裂）：
```
模型 → tool → execute() → policy(casbin) → verb → shell.run → runArgv(argv) → exec_audit
```

T3 的确认不走布尔许可，走令牌：
```
无令牌 → E_NEEDS_CONFIRM（附确切 argv）→ 人确认 → 签发令牌（绑 argv_sha256+cwd/120s/单次）→ 立即用掉 → 执行
         ↑ 同时落一张待确认卡（data/pending/，15 min）：面板侧栏就能点“确认执行”
```
令牌文件在 `data/tokens/cap_*.json`（用过会留 `used_at`，所以能区分 E_TOKEN_USED 与 E_TOKEN_UNKNOWN）。
待确认卡在 `data/pending/pnd_*.json`（按指纹去重：模型重试十次也只有一张卡）。

**发布路径也只有一条**（同理）：
```
install → smoke(20) → promote → activate → applyRelease → bootAttempt → markHealthy
                                                    ↓ 窗口内没健康
                                              watchdog → rollback → 冻结
```

---

## 4. 已经验证过的事实（别重复验证）

| 事实 | 数值/结论 |
|---|---|
| 两阶段检索 40k 真实语料 | p50 **8.6 ms** / p95 **13 ms**（暴力 vec0 是 78 ms，1024 维时 155–195 ms） |
| 中文 FTS5 | `unicode61` 对中文**完全失效**，必须 bigram（已实现） |
| 512 维 vs 1024 维 | 相似度矩阵相关 **0.971**，MRR 持平 → 512 够用 |
| 上下文预算 | 第 1 轮 687 tok / 第 100 轮 1262 tok（预算 2000，恒定） |
| 记忆体积 | 5 年 ≈ **229 MB**（向量占 71%），日增 125 KB |
| 冷启动 | 130 ms（`verify` 全流程），常驻 RSS 67 MB |
| 断电 | 10 次模拟零丢失；坏行隔离到 `inbox/quarantine/` |
| 编造率 | 0（trap 4/4，检索层 + 模型层都过） |
| 契约不腐 | 100%（w=1、stage=active） |
| 回滚速度 | 注入 `exit(1)` 版本 → **0.2 s** 回 A 槽（真起子进程；观察窗口压到 1.5 s） |
| 冒烟成本 | 20 项 / 300 ms、零网络、库只读 |
| T3 注入面 | 分号/管道/`$()`/反引号/空格/`..` 全部 `E_BAD_ARGV`（一条进不去） |
| T3 令牌 | 改一字节 `E_TOKEN_MISMATCH`、120s 后 `E_TOKEN_EXPIRED`、重放 `E_TOKEN_USED` |
| 面板确认 | 侧栏卡 → 点“确认执行” → 381 ms 跑完，时间轴里出现“已按你的确认执行”+ 输出；拒绝则不执行且不能反悔 |
| 沙箱闸 | 设 `JJ_SHELL_SANDBOX=docker` 但引擎未启动 → `E_SANDBOX_UNAVAILABLE`（不静默降级）；`JJ_SHELL_ALLOW_DIRECT=1` 才能降，且结果行里写明 |
| 超时杀树 | `node(parent) → node(grandchild)` 写心跳文件；超时后文件大小不再长（孙子死了） |
| 容器 | 镜像 2m44s 构建；`/health` 200；删容器重建后 `memories` 不变；进程自退时 `RestartCount` 持续上涨 |
| 搬家 | 导出 61 文件 / 2.4 MB；搬家 3 次记忆逐字一致；改 1 字节 → `E_EXPORT_CORRUPT` |
| 摄入 | 真 PDF → **26 块 / 13967 tok / 5.5 s**（含 embedding）；同样内容重跑秒回 `skipped` |
| 隐私闸门（文档） | 默认 `local_only` 的文档块 **0 条**进简报，只报个数（“另有 N 段本地文档未发送”）；面板标“可发送”后立即出现，带 `doc:<id>#<ord>` 引用 |
| **工具调用冒烟（闸本身）** | deepseek-chat 跑 3 用例 × 3 轮 = **9/9 = 100%**，p50 763 ms，约 $0.0035。同一套 prompt/schema/校验下它满分，证明闸不是坏的 |
| 工具调用冒烟（不装模型时） | `jingjing smoke-tools` 先查 `/api/tags`：缺模型时人话报错 + **退出码 2**，不会用 10 轮红 404 冒充“模型不会调工具” |
| 云端失败兜底 | 关掉网络/设错 key → 聊天回一条带 `notice` 的本地结果（不静默降级）；**已开始输出后半途失败不切换** |
| 记账真实性 | 一轮聊天记下 `in 1833 / out 2 / $0.000497`；修前聊天一条不记（「今日花费」恒为 $0） |
| 过期契约 | 已关闭的承诺（如“提醒吃药”）不再进检索：`openContracts()` + 检索层 `julianday(valid_to)` |

---

## 5. 踩过的坑（**按这个顺序读，能省一天**）

### 5.1 Windows 编码 / bash 反引号（本项目最高频的事故源，6 次）

| # | 场景 | 症状 | 修法 |
|---|---|---|---|
| 1 | markitdown 输出重定向 | 写成 GBK，中文全乱 | 用户环境变量 `PYTHONUTF8=1`（已设） |
| 2 | 写文档时 `\7`/`\b`/`\v` | 变成 BEL/退格/垂直制表 | 全库扫控制字符（已清） |
| 3 | PowerShell DPAPI | `TypeNotFound` 静默退化到明文文件 | `Add-Type -AssemblyName System.Security` |
| 4 | Web 请求体 GBK | 乱码写进记忆 | 解出 `U+FFFD` → 400 `E_ENCODING` 拒收 |
| 5 | 模板字符串里的 `\n` | **整页 JS SyntaxError，面板完全点不动** | 用 `String.fromCharCode(10)`，永不写反斜杠 |
| 6 | **在 bash 里用 node -e 拼含反引号的内容** | 反引号被 bash 当命令替换执行了（到今天已 **6 次**；最贵的一次误拉了 4.7 GB 的 7B 模型，另几次把文档写残） | 写文件一律用 write / edit 工具，别用 node -e 或 heredoc 拼正文；必须在字符串里放反引号就用 `String.fromCharCode(96)` |

> **规则：在生成代码（HTML/JS/SQL 字符串）里不要用反斜杠转义。** 换行用 `String.fromCharCode(10)`，路径用正斜杠，正则里的 `\/` 用 `.split(BS).join()` 代替。

### 5.1.1 PowerShell 7（2026-10-31 装，`pwsh 7.6.9`）

- **已设成默认终端**（2026-10-31）：Windows Terminal 的 `defaultProfile` → PowerShell 7；
  VS Code 的 `terminal.integrated.defaultProfile.windows` → PowerShell。两处都备份了 `*.bak-<时间戳>`。
- **没有**去遮蔽 `powershell.exe`（改 PATH 让它指向 7）：那会让 `src/auth.ts` 的 DPAPI 和一堆只在 5.1 上能跑的脚本一起失效。
  安装包自带的 WindowsApps 别名已经让 `pwsh` 在任何新开终端里可用。
- WT 里 profile 的 commandline 写的是 `pwsh.exe`（走 PATH），**不是**完整路径：
  `%LOCALAPPDATA%` 下的那个是符号链接，指向受保护的 `Program Files` 子目录，node 的 `existsSync` 返回 false，写死容易踩空。
- 验证方式（可重复）：起一个 WT 窗口 → `tasklist /FI "IMAGENAME eq pwsh.exe"` 里出现 `pwsh.exe`（不是 `powershell.exe`）→ 关掉。


- 装法：`winget install --id Microsoft.PowerShell --source winget`（284 MB，装在 `C:\Program Files\WindowsApps`）。
- **坑：pwsh 把输出接到管道时按控制台代码页（936/GBK）编码，中文全乱。** 必须在 profile 里设 `[Console]::OutputEncoding`/`$OutputEncoding` = UTF8，否则 `pwsh -Command "鲸鲸" | ...` 出来是乱码。
- **profile 不在 `C:\Users\Fez\Documents`**：这台机器的 Documents 被重定向到 `D:\文档`，真实路径是 `D:\文档\PowerShell\Microsoft.PowerShell_profile.ps1`。用 `pwsh -Command '$PROFILE'` 查，别猜。
- PSReadLine 的设置要加守卫（`-not [Console]::IsInputRedirected`）：非交互调用没有 console，会抛 `PSReadLine can not be used`。
- 项目代码**仍然用 `powershell`（5.1）** 跑 DPAPI（`src/auth.ts` 的 `ps()`）：`Add-Type -AssemblyName System.Security` 是 5.1 必需、7 已内置；base64 交换与编码无关，且解密结果有 mtime 缓存（3 ms），换 pwsh 没有收益。


### 5.1.2 Git Bash 编码统一（2026-10-31）

改了三处，目标是让**子进程**也是 UTF-8（bash 自己靠 `LC_CTYPE=C.UTF-8` 早就没问题，乱码出在它调用的原生程序上）：

| 文件/设置 | 内容 | 为什么 |
|---|---|---|
| `~/.bashrc`（新建） | `LANG=C.UTF-8`、`LC_CTYPE=C.UTF-8`、`PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`、`LESSCHARSET=utf-8`、`[ -t 1 ]` 时 `chcp.com 65001` | 用 `C.UTF-8` 而不是 `zh_CN.UTF-8`：工具输出保持英文，`grep pass/fail` 这类校验脚本才稳；中文文件名不受影响。**不设 `LC_ALL`**（会把排序锁成 C，`sort`/`ls` 行为变） |
| `~/.bash_profile`（新建） | 只 source `.bashrc` | Git Bash 的**登录** shell 读 `.bash_profile`，不建这个文件的话双击打开的窗口根本不会加载 `.bashrc` |
| `git config --global` | `core.quotepath=false`、`i18n.logOutputEncoding=utf-8`、`i18n.commitEncoding=utf-8`、`gui.encoding=utf-8` | 否则中文文件名在 `git status` 里是 `\344\270\255` 这种八进制转义 |

**实测（真控制台，可复现）**：WT 里起 `cmd.exe` 先记基线 → 936；再让 `cmd` 调 `bash.exe -lic script`（加载 `.bashrc`）→ 65001。
脚本 `tmp/verify.cmd` + `tmp/chcp-test.sh` 就是干这个的（已删；方法记在这）。

> **量代码页时的坑**：`{ ... } > file` 会把整块的 stdout 重定向，块内 `[ -t 1 ]` 于是为假 ——
> 我第一版脚本因此报 `tty=no`，差点得出"chcp 没生效"的错误结论。要先 `t=$( [ -t 1 ] && echo yes )` 存起来再重定向。

### 5.2 时间与比较

- 库里可能同时存在 `...Z`（`toISOString`）与 `...+08:00`（本地时区）→ **字符串比较会判错**（`18:07+08:00` 字典序大于 `10:13Z`，于是"承诺到期"永远不触发）。用 `julianday()`，周年用 `strftime('%m-%d', created_at, 'localtime')`。

### 5.3 工具与模型 API

- **函数名必须 `^[a-zA-Z0-9_-]+$`**：`fs.read` 会被 DeepSeek 400 拒绝。策略/审计用点号，schema 用下划线别名（`tools.ts` 的 `apiName()`）。症状是"工具突然全没了"，很难往命名上想。
- **`vec0` 主键只收整数**：`node:sqlite` 把 JS `number` 绑成 REAL → insert 失败。必须 `BigInt(id)`，且失败要写 `meta.vec_error` 而不是静默 catch。
- **casbin 三个坑**：`newEnforcer(Model, path)` 不支持内存 Model + 路径（模型要落盘）；`priority(p.eft)` 缺 priority 字段会静默不匹配（改 deny-overrides）；`enforceEx` 在 deny 时 explain 为空（要自己扫 CSV 区分 `E_DENIED`/`E_NO_RULE`）。

### 5.4 安全

- **`normalize()` 不是安全边界**：目录联接（junction）能把路径指到 home 之外。必须 `realpathish()`（对最深的已存在祖先做 realpath 再接回剩余路径）。红队 #4 一开始"假通过"（目标文件不存在 → `E_NOT_FOUND`），补真文件后才暴露泄漏。

### 5.5 记忆语义

- **`lastDecayAt` 是锚点，不是"上次 tick 时间"**：普通 tick 绝不能移动它，否则下次用 `d=1` 重算 → **记忆复活**（0.19 变回 0.55）。只有再巩固可以移动，且必须同时改 `w0`。
- **敏感度跟随来源**：聊天里说的 → `shareable`（本来已作为用户消息出网）；磁盘/文档摄入 → `local_only`。
- **自传用 1.5B 会编**（实测写出"空气中充满了冷气"）。现在：引用由**正文 bigram 反推**（不信模型自报），拿不到就退化成 `MODE: digest` 摘录式。想写得好用 `JJ_MODEL_NIGHT` 指定 ≥3B。

### 5.6 前端

- **HTTP 200 ≠ 页面能用**：`ui:test` 必须查 `#composer` 的 `getBoundingClientRect().bottom <= innerHeight`（flex 子项 `min-height:auto` 会把输入框挤出视口，`overflow:hidden` 后直接看不见）。
- **Chromium 里设了 `scrollbar-width`/`scrollbar-color` 就会忽略 `::-webkit-scrollbar*`**：于是"改完颜色又退回系统滚动条 + 箭头按钮"。标准属性只给 Firefox（`@supports (-moz-appearance:none)`）。
- 面板会缓存：`/` 与 `/api/*` 全部 `cache-control: no-store`。

### 5.7 发布与回滚（2026-10-28 新增，4 个坑都是实测咬到的）

| # | 坑 | 症状 | 修法 |
|---|---|---|---|
| 1 | **回滚后不杀旧进程** | 已作废的版本还在跑，还把文件写回去了 | 看门狗判定回滚时立刻 `SIGTERM`（2 s 后 `SIGKILL`），不能让“不被信任的进程”继续活着 |
| 2 | **旧进程退出码 0 给新状态“洗白”** | 回滚已经把槽位改到 A，旧进程退出 0 时又把 B 标成 healthy（`failStreak` 清零） | `markHealthy` 前重读 `state.json`，`active` 变了就不记；不骂不跳过 = 下一轮永远回不了 A |
| 3 | **软链不能当事实源** | Windows 建目录软链要管理员/开发者模式；悬空的 `current` 直接“启动即挂” | 事实源 = `state.json`（能原子写）；软链尽力而为，读的时候只读 state |
| 4 | **冒烟对着 live home 打分 = 什么都没测** | 给 B 版评分时若读 home/persona，它永远是 A 的内容，20/20 白给 | `runSmoke({ release })` 必须从 `releases/<id>/` 读载荷；测试里要有一条“把 B 改坏 → 真的变红” |

另一个隐蔽的“假通过”：`meta.embed_model` 一直没人写，`coreFp.embed` 永远是 `unset`，于是“指纹一致”是自己和自己比。现在 `serve` 启动时写 `ollama:bge-m3`（换模型/换量化就变）。**加任何字段前先问：这个值真的会变吗？**

### 5.8 T3 受限执行（2026-10-28 新增，4 个坑）

| # | 坑 | 症状 | 修法 |
|---|---|---|---|
| 1 | **占位符嵌在 argv 元素中间** | 模板写 `--eval=console.log({x})`，槽值就能拼出代码 | 占位符必须**独占整个** argv 元素，否则 `E_BAD_TEMPLATE`；槽值绝不会被拼进别的字符串 |
| 2 | **整个 verb 恒为 T3** | `git status` 这种只读命令也要每次确认，人就会被逼到关闭机制 | `tierFor(args)`：档位跟**模板**走；`policy.csv` 里 T1/T3 是两行，可分别开关 |
| 3 | **用完就把令牌文件删了** | 删了就分不清 `E_TOKEN_UNKNOWN` 与 `E_TOKEN_USED`，排障时看不出“是被重放拦下的” | 不删，改写 `used_at`；过期后再由 `sweepTokens` 清 |
| 4 | **POSIX 上只 kill(pid)** | 孙子进程变成孤儿继续跑 | `detached: true` 建独立进程组，超时 `kill(-pid)`；Windows 用 `taskkill /F /T`。测法：让孙子每 50ms 写一个心跳文件，超时后文件不再变大 |

另外两个容易忘的点：
- **槽值首字符不许是 `-`**：否则目标程序会把它当选项（`node -e …` 就是这么来的）。
- **环境传白名单而不是黑名单**：`*_KEY`/`*_TOKEN` 不传下去，就不会“忘了删某一条”。

### 5.9 确认与沙箱（同一批，2 个坑）

| # | 坑 | 症状 | 修法 |
|---|---|---|---|
| 1 | **docker 客户端被杀 ≠ 容器停了** | 超时 `taskkill` 了 `docker run` 进程，容器还在后台跑（它已被 `--rm` 交给 daemon） | `--name jj-<digest>-<rand>` + `runArgv({ onKill })` 里 `docker rm -f`；超时与输出爆炸两处都要调 |
| 2 | **“沙箱没起来就悄悄直跑”** | 开着 `JJ_SHELL_SANDBOX=docker` 但引擎挂了，结果命令在无隔离下跑了，没人知道 | 拒跑（`E_SANDBOX_UNAVAILABLE`）；只能显式 `JJ_SHELL_ALLOW_DIRECT=1` 降级，且 `host_profile` 写 `direct(...)(降级)`、结果行里也写 |

面板确认那半边只有一条要注意：**令牌绝不下发到浏览器**。页面只发 `{action:"confirm"}`，服务端拿卡里的 argv 现签现用。
否则“确认一次”就等于把令牌交给了页面，可被重放。

### 5.10 容器与搬家（2026-10-28 新增，4 个坑）

| # | 坑 | 症状 | 修法 |
|---|---|---|---|
| 1 | **容器内绑 127.0.0.1** | 容器“起来了”但宿主访问不到（容器的回环不是宿主的回环） | 容器内 `JJ_BIND=0.0.0.0`，compose 只把 0.0.0.0 映射到**宿主回环** `127.0.0.1:7700` —— 两步合起来才既可达又不裸露 |
| 2 | **`docker kill` 不触发重启策略** | 以为在测自愈，其实容器被当“手动停止”，`restart: unless-stopped` 不该管 | 测法是让进程**自己**退出（`exit 1`）然后看 `RestartCount`；否则永远测不到 |
| 3 | **`cpSync` 会顺着目录联接拷出去** | `data/workspace/up`（红队 #4 建的联接 → `data/..`）让导出把整个仓库拷进去，还把自己卷进去无限递归，最后死在 MAX_PATH | 手写 `copyTree` 跳过 `isSymbolicLink()` 并记进 manifest 的 `skipped`；导出目录**必须在 home 之外**（`E_EXPORT_INSIDE_HOME`） |
| 4 | **`renameSync(home, staging)` 在 Windows 上 EPERM** | 目标 home 已存在（哪怕空目录）就失败 | 非空 → 先改名成 `home.bak-<ts>`；空目录 → 先删再换 |

另外一个“看上去是坑其实不是”：容器里崩几次会多出几条“进程被杀 N 分钟（其间无经历）”——那是断电感知在容器里**正常工作**（`outages` 也有对应行），不是 bug。

### 5.11 摄入管道（2026-10-28 新增，4 个坑）

| # | 坑 | 症状 | 修法 |
|---|---|---|---|
| 1 | **`\n` 又一次坑了页面代码** | 在 `page.ts` 的模板字符串里写 `"\n…（截断）"`，被展开成真换行，整页 JS 语法错误——`ui:test` 与 `node --check` 同时红 | 用 `String.fromCharCode(10)`。**这条已经栽过 6 次了，见 §5.1 第 5 条** |
| 2 | **"小于 80 token 就合并"会毁掉章节边界** | 每条 `## 小节` 只有一两句话时，全被合并成一块，`heading_path` 只剩下第一节的，章节名再也召不回来 | 只合并「同章节内的小尾巴」与「开头不像句子的小碎片（目录/标题串）」；内容具体但短的章节**保留** |
| 3 | **超长段落（单块 > 800 tok）走的是另一条分支** | 那条分支原来不做重叠，切出来就是硬边界 | `packSentences` 之后逐块 `overlapTail(prevPiece)` 再拼 |
| 4 | **红队会留下待确认卡** | `redteam` 有 T3 用例，跑完面板侧栏冒出两张 `node rt-a.mjs`，像是它自己想去执行什么 | 演练结束只清理**这轮**产生的卡（按 `created_at >= began`），标 `rejected` 并写原因 |

**测试样例的一个陷阱**：块级 sha256 去重会把「同一句话重复 40 遍」真的去成两块。写测试时要么用变化句子，要么就断言 `dropped >= 1`——别以为分块器坏了。

**已知限制**：部分 PDF 经 markitdown 会丢词间空格（`Largelanguagemodelagents…`），英文召回变差；中文不受影响。真源与规范化 markdown 都在 `data/markdown/`，换转换器时可整库重建。

### 5.16 点设置会闪 PowerShell（2026-10-30，3 个坑叠一起）

| # | 坑 | 症状 | 修法 |
|---|---|---|---|
| 1 | `execFileSync("powershell", …)` 没传 `windowsHide: true` | 每次解密都新建一个控制台窗口 | 加上这个选项（**任何 Windows 上起控制台程序的调用都该加**） |
| 2 | DPAPI 解密**没缓存** | DPAPI 只能起 PowerShell 解，一次 ~600ms；`/api/config` 里 `get()` 调两次（hasKey + 指纹）、`getChat()` 把 3 个 provider 全读一遍 | 按「文件路径 + mtime」缓存；`set`/`clear` 主动失效 |
| 3 | `secrets()` 每个请求都 `createStore()` | 连“这台机器能不能用 DPAPI”的探测也每次都跑一个进程 | 进程内复用一个 store |

实测：一次 `/api/config` **1904 ms → 334 ms（冷）→ 3 ms（缓存后）**。

**为什么不能干脆不用 DPAPI**：key 进环境变量会污染进程环境/崩溃转储/子进程；写原生插件直调 DPAPI 要编译和 prebuilt。现在的取舍是「DPAPI 文件 + 进程内缓存 + windowsHide」，代价是**每个进程启动后第一次读 key 仍要 ~330ms**（只是看不见）。Linux 上走 `libsecret`，没有这个问题。

### 5.12 手机端 / PWA（2026-10-28 新增，3 个坑）

| # | 坑 | 症状 | 修法 |
|---|---|---|---|
| 1 | **写操作守卫只认回环 Origin** | 手机通过 Tailscale 打开：页面能看，但发消息 / 改设置 / 确认命令**全是 403** | 改成「回环 **或** Origin 的 host == `Host` 头」；跨站仍拒、`x-jj` 头仍要（跨站发不出自定义头，预检不放行） |
| 2 | **抽屉没有开关** | `aside` 在 ≤860px 是 `translateX(-102%)`，但 header 上没有按钮能叫它出来 → 手机上 SESSIONS/DOCS/MEMORY/TOOLS/CONFIG **全部不可达**（我一开始就以为是"看不到 DOCS"） | header 左侧加 `≡`；抽屉改**实底**（原来的半透明会让聊天内容透出来）+ `box-shadow:0 0 0 100vmax` 当遮罩 |
| 3 | **遮罩用伪元素 `z-index:-1` 等于没写** | 伪元素被 `aside` 自己的背景盖住，点外面也看不到变暗 | 改用 `box-shadow` 巨大扩散，天然在元素之后、内容之上 |

另外两件事：

- **`--window-size` 在 Windows 上会被 DPI 缩放**（390×844 变成 510×701）。要真机尺寸必须用 CDP 的 `Emulation.setDeviceMetricsOverride`——`ui:test` 里 `UI_VIEWPORT=390x844` 就是走这条。
- **图标是构建期真渲染的 PNG**（headless Edge 渲染同一个鲸尾 symbol 到 512/192/180），不是运行时画；manifest 里每个图标都有测试断言「真能取到、真是 PNG」。iOS 不认 SVG 图标，所以必须有 PNG。


### 5.13 面板可用性那一批（2026-10-28，3 个坑）

| # | 坑 | 症状 | 修法 |
|---|---|---|---|
| 1 | **`hidden` 属性能被类里的 `display` 压掉** | `#pendbadge` 是 `<span class="badge" hidden>`，而 `.badge{display:inline-flex}` 是作者样式、`[hidden]{display:none}` 是 UA 样式 → **角标永远显示**（没人待确认也挂个 0/1） | 全局 `[hidden]{display:none !important}`，并且角标同时设 `style.display`。**任何"默认隐藏 + 类里写 display"的组件都会中这一枪** |
| 2 | **多行 `<textarea>` 没写 `height`** | 输入框自己撑成一大块（约 150px），把时间轴挤掉一半 | `#m { height:42px; min-height:42px; max-height:180px }` + `fitComposer()` 随内容长高；`.wrap { align-items:flex-end }` |
| 3 | **本地单行 `<input>` 换成 `<textarea>` 时漏了 `flex:1`** | 选择器还写着 `form#composer input`，textarea 不在里面 | 改成 `form#composer input, form#composer textarea { flex:1; min-width:0 }` |

另外两条工具层面的：

- **headless Edge 的 CDP 端口有时起不来**：默认 profile 被占用时新实例会附着到已有进程，调试端口就不开。所有脚本都加 `--user-data-dir=<临时目录>` 后稳定。
- **`UI_VIEWPORT` 必须走 CDP 的 `Emulation.setDeviceMetricsOverride`**：`--window-size` 在 Windows 上会被 DPI 缩放（390×844 → 510×701）。

### 5.14 配色铁律（2026-10-29 定稿，**别“优化”回去**）

- **全站只有一处青色：鲸鲸的回话气泡**。用户气泡是琥珀色，被拒/出错是红色。
- 其余一切（侧栏、边框、标题、按钮、表格、标签）都是**黑底 + 白线 + 粗白字**。
- 侧栏条目是“格子”：`border:1px solid var(--line-dim)`，hover 变 `--ink`，选中加 `inset 2px 0 0 var(--ink)`。
- 有人把青色加回按钮/标题，就白修了——`ui:test` 里有断言盯着这件事。

### 5.15 “看着像全局”的状态（2026-10-29，1 个真 bug）

「进设置总在最底」不是 CSS 的问题：`show()` 里有几个**只在函数内看来像全局**的状态，切视图时把 `scrollTop` 带过去了。修法是把“视图切换”与“滚动位置”分开管（只有对话视图保存/恢复位置，其余一律回顶）。
同类风险：`#jump`（回到最新）**只能属于对话视图**，已用 CSS 强制（非对话视图下不渲染）。


## 6. 下一个项目清单（2026-10-29 更新）

> 排序原则：**先补"让它能自己整理记忆"这条断掉的腿**，再谈搬家和外围。
> 每条都写了"为什么现在做"和"做完怎么验"；标 🔒 的需要你先拍板。
> **K 组（权力与会话式授权）回答的是：“如果它的权力要和人在一起时一样，它需要的不是更多权限，是在场本身。”**
> **J 组（浮现：把三处死代码接上）来自一篇 QQ 机器人样本，对照见 `docs/03 §11`；`01 §4.2` 的“再巩固”公式实测从未生效。**
> **下一件事做什么** → `docs/22-待办与技术债.md`（只放还活着的条目；已完成条目与它们的“为什么”在 `jingjing` 的 `git log`）。
> **发布 · 桌面端 · 首次配置 · 设定封存 · 诊断索引** 的设计稿在 `docs/23-发布-桌面端-首次配置.md`。

### 6.0 立刻可做（不依赖任何新硬件/新下载）

| # | 任务 | 为什么 | 验收 |
|---|---|---|---|
| **P0-1** ✅ | **工具调用冒烟** `jingjing smoke-tools`（已做，245 测试） | 所有"本地整理"的前提；1.5B 就是栽在这一步且上线才发现 | 同一提示 10 次×3 用例，合法 `tool_calls` ≥ 70%；对照实测：DeepSeek **9/9 (100%, p50 763ms)** |
| P0-2 | **`night` 接上工具循环** | 整理要模型自己查（现在是纯抽取，没有 tools） | 3 个历史案例回放，人工比对 10 条错误 ≤2 |

> **P0-2 不需要模型在场就能开工**：循环、提示、断言都可以先写，用假 `chat` 跑测试（`test/toolsmoke.test.ts` 就是这个套路）。
> 等 7B 到位（§6.1）再拿真模型验三个历史案例即可。这件事和“拉不拉模型”**可以并行**。

### 6.1 🔒 等拍板：本地整理模型怎么来（**接手第一件事**）

**推荐：`qwen2.5:7b-instruct`（q4_K_M，4.7 GB）。** 理由：

| 判据 | 情况 |
|---|---|
| 必须会调工具 | Qwen2.5 是显式按 tool calling 训的（1.5B 同家族但太小）；这是这条线以上最便宜的一档 |
| 中文 | 记忆原文是中文，Qwen 系中文原生（Llama-3.1-8B 中文反而弱一档） |
| 进得了 8 GB 显存 | 3070 Laptop **空闲 7.9 GB**：7B q4 = 4.7 GB + 32k KV ≈ 1.8 GB = 6.5 GB，全在显存 |
| 能与 bge-m3 共存 | 4.7 + 1.2 = 5.9 GB < 8 GB |
| 网络是瓶颈 | 实测 ~1.5 MB/s、registry 时快时慢 → **~50–60 分钟**；D 盘余 239 GB |

⚠️ 拉之前先关一批程序：**系统空闲内存只剩 4.9 GB**（共 15.4 GB），加载峰值会碰一下内存。
⚠️ **两个都拉**（用户定的）：4.7 GB + 5.2 GB ≈ 10 GB，D 盘余 239 GB 够；按当前网速约 2 小时。

⚠️ **用户已定（2026-10-30）：拉的时候 `qwen2.5:7b-instruct` 和 `qwen3:8b` 都要拉**，两个都跑 `smoke-tools` 再选默认。
⚠️ **拉之前别把 1.5B 拉回来**：`night` 报的「缺模型」曾经指向已删的 `qwen2.5:1.5b-instruct`（C-5 已修默认值）。

| 选项 | 大小 / 耗时 | 判断 |
|---|---|---|
| **A. `qwen2.5:7b-instruct`** | 4.7 GB / ~50 min | ✅ 首选 |
| A'. `qwen3:8b` | ~5.2 GB / ~60 min | 次选：推理更强但**默认开 thinking**，做 agent 要先关（`/no_think`） |
| A''. `qwen2.5:3b-instruct` | 1.9 GB / ~20 min | 便宜探路，但 3B 大概率是**边界值**；边界值 = 30% 脏写进长期记忆 |
| B. 买 x86 迷你主机 16 GB | 花钱 | 终态（6–15 W 常开）；到货前整理仍停 |
| C. 夜间整理改用云端 DeepSeek | 立刻可用 | **记忆原文出网**，要显式废掉 `13 §10` 约束 |

**拉完之后的三步（照做就行）：**

```bash
ollama pull qwen2.5:7b-instruct

# 1) 先过闸，不合格就不要它（期望 ≥7/10；DeepSeek 的对照是 9/9 = 100%）
jingjing smoke-tools --model qwen2.5:7b-instruct --n 10

# 2) 过了再把 5 个本地角色切过去（JJ_MODEL_DEFAULT 管 route/extract/salience/conflict/night）
export JJ_MODEL_DEFAULT=qwen2.5:7b-instruct
jingjing night
```

不过就换 `qwen3:8b`（关 thinking）；再不过说明本机这一档吃不下，得走 B 或 C。

### 6.2 记忆整理的完整形态（P0-1/2 之后）

| # | 任务 | 验收 |
|---|---|---|
| P1-1 | 抽取：inbox → `memories`（含 `kind/layer/重要度`），走**工具**而不是一次性长 prompt | 3 个历史案例回放，人工比对 10 条，错误 ≤2 |
| P1-2 | 冲突消解：同一 `subject/normalized_key` 的新旧记忆走 `superseded_by` + `valid_to` | 「我说我吃了药」这类能正确关闭承诺（参考本次修的 `openContracts`） |
| P1-3 | 归并：重复记忆合并，保留可追溯的 `memory_links` | 40 条真实数据跑一遍，人工抽查无信息丢失 |
| P1-4 | 夜间花销上限（本地 0 元 / 云端按 token） | `jingjing night` 打印本轮耗时与成本 |

⚠️ **动 P1-1/P1-2 之前先看 `docs/22 §2` 的两条约束**：① `taint` 已经参与决策（契约层拒收 external、注入侧隔离、再巩固不加权）；② **模型只能改元数据，改不了正文**（`updateMemoryText` 只收 `human:*`，且留 pre-image）。这两道闸门就是防“把读到的外部内容写成硬事实”的。

### 6.3 M6 收尾（已验 5/5，剩"常驻"这一步）

| # | 任务 | 备注 |
|---|---|---|
| P2-1 | 本机常开（不合盖）+ `deploy supervise` 接管面板 | 验证"常驻"有没有价值，零成本 |
| P2-2 | 通知/自愈的可观测：`/health` 接一个外部探针（或 cron 打日志） | 现在只有容器内 healthcheck |

### 6.4 长期空白（明确没做的，按价值排）

| # | 项 | 价值 | 前置 |
|---|---|---|---|
| P3-1 | **`ingest` 接入对话**：文档块现在要模型主动 `doc.search`，没进简报 P10 | 高 | 需要一个会调工具的模型 |
| P3-2 | 技能自我生成（L4 = 技能+参数，核心永不自改） | 高 | A/B 槽已有，缺生成器 |
| P3-3 | 参数自调优（β / 半衰期 / 阈值打白名单） | 中 | decay.ts 现在是常量 |
| P3-4 | 自传写成叙述（现在是 digest 摘录） | 中 | 要 ≥3B 的模型 |
| P3-5 | 心跳的 day/week 节拍（现在只有 60 s tick） | 中 | — |
| P3-6 | 面板记忆编辑的"批量/合并" | 低 | 单条已支持 |
| P3-7 | `promptfoo` 进 CI | 低 | eval 已覆盖大部分 |

### 6.5 技术债 / 已知坑（不影响功能，但会咬人）

| # | 债 | 说明 |
|---|---|---|
| D-1 | **`node -e` / bash 里拼带反引号的内容** | 到今天已 **6 次**事故（最贵一次误拉 4.7 GB；刚才写这份文档时又中一次，命令里的 `jingjing night` 被当成命令执行）。**一律用 `write`/`edit` 工具**，非要在字符串里放反引号就用 `String.fromCharCode(96)` |
| D-2 | **`hidden` 属性被类里的 `display` 压掉** | 已全局修，但同类写法要小心 |
| D-3 | **`show()` 里"看似全局"的状态** | 侧栏选中态/滚动位置/「回到最新」都栽过，已改成"实例 + CSS 双保险" |
| ~~D-4~~ | **`docs/` 不在 git** | **已修（2026-10-30）**：`D:/LLM` 是独立仓库（`2510dfd`），`jingjing/` 保留自己的历史 |
| D-5 | 面板上看不出整理已停 | 部分修：`/health` 的 `degraded` 与 ENERGY 悬停已说明；侧栏仍无专门入口 |

---

## 7. 待拍板的决策（都不阻塞编码）

| # | 问题 | 默认值（不定就用它） |
|---|---|---|
| D-A | 云端 L2 用哪家 | DeepSeek（已接），可换 anthropic/openai |
| D-B | embedding 维度 | **512**（已验证几乎无损） |
| D-C | 常驻主机 | **x86 迷你主机 16 GB**（有 GPU 更好）；现在先用本机不合盖（`09 §4.3`）。Pi 已出局 |
| D-D | 自传模型 | 跟 `JJ_MODEL_NIGHT` 一致（→ digest）；**现在无模型**，随 D-K 一起定 |
| D-E | 心率默认开不开 | **不开**（`serve --beat` 手动开） |
| D-F | 自我更新范围 | 只开技能+参数，**核心代码永不自改**（`18 §4.2`）；发布不能带 `policy.csv` 与核心代码 |
| D-G | 回滚观察窗口 | **10 min**（`JJ_DEPLOY_DEADLINE_MS` 可压）；冻结 24 h（`JJ_DEPLOY_FREEZE_MS`） |
| D-H | `shell.run` 默认开不开 | **开，但每次确认**（T3）；`JJ_SHELL=off` 是总闸；要完全禁就把 `policy.csv` 里的 T3 行删了 |
| D-I | T3 要不要默认进容器 | **不默认**（`JJ_SHELL_SANDBOX=docker` 手动开）：容器需要对应镜像，且会让 M6 的“引擎在不在”变成硬依赖 |
| D-J | outage 记忆（"关机 N 分钟"）要不要降权/折叠 | **不动**（2026-10-28 拍板）。它们是真事件，删或藏就是对自己的过去说谎；面板刷屏是**视图**问题，要改就在 MEMORY 列表加折叠，别动记忆本身 |
| D-K | 本地整理模型 | **推荐 `qwen2.5:7b-instruct`**（q4_K_M 4.7 GB，进 3070 的 8 GB 显存；理由与备选见 §6.1）。2026-10-28 删了 1.5B，现在本地一个 chat 模型都没有 |

---

## 8. 环境备忘（本机）

```
D:\LLM\.venv                  Python 3.12 + markitdown（转换子进程）
D:\LLM\jingjing\data\         memory.db / inbox / persona / policy.csv / eval / life / secrets
OLLAMA_MODELS=D:\ollama\models
已拉模型                      `bge-m3`（1.16G，只做 embedding）；**本地 chat 模型一个都没有**（2026-10-28 删了 1.5B）
硬件                          Ryzen 9 5900HX（8C/16T）｜ RAM 15.4 GB（**空闲仅 4.9 GB**）｜ RTX 3070 Laptop **8 GB 显存（空闲 7.9 GB）**
网络                          到 registry.ollama.ai 实测 ~1.5 MB/s 且时快时慢（7B 约 50–60 min）
面板                          127.0.0.1:7700（只绑回环；结束进程：netstat -ano | grep 7700 → taskkill /F /PID）
```

**跑过的坑位清理**：`data/policy.csv` 与 `policy.model.conf` 是生成物，改了 `DEFAULT_POLICY` 要删掉重建。

---

## 9. 文档地图（22 份，按需要读，别通读）

| 想知道什么 | 读 |
|---|---|
| 这个项目到底在做什么（四条件 / L0–L4 / 四层分解） | `docs/0-定义-数字生命.md` |
| 衰减、四段生命周期、再巩固、睡眠、心跳 | `docs/01-记忆动力学.md` |
| 表结构、分块、两阶段检索、MCP 契约 | `docs/02-存储与索引层.md` |
| 能力目录、T0–T4、红队、双平台执行层 | `docs/04-执行层与权限分级.md` |
| 人格怎么构建、不谄媚、拒绝与修复 | `docs/07-鲸鲸的人性构建.md` |
| 上下文恒定预算、为什么没有"会话"、界面三处区别 | `docs/17-界面与上下文.md` |
| 断电保护/感知、自我更新范围 | `docs/18-断电与自我更新.md` |
| **计划表（M0–M7 + 验收门 + 决策点）** | `docs/19-项目计划.md` |
| 为什么要 TS 而不是 Rust、必须补 tsc | `docs/21-语言与技术栈选择.md` |
| 9 篇论文中文导读 / 15 篇记忆真实性导读 | `记忆系统/论文中文导读*.md` |

---

## 10. 给接手者的五条建议

**搬到 `jingjing/AGENTS.md` 了**（常驻说明书，比交接文档长命）。那五条纪律、色板铁律、
危险动作清单、代码地图，都在那边；这里只说一条：

> **先跑 `npm run check`，再动代码。** 它是 90% 回归面的入口。

---

## 11. 当前进程状态（2026-10-30 18:30，数据已重置 + 四件修完）

面板在跑：`127.0.0.1:7700`（PID 随重启变化；用 `netstat -ano | grep 7700` 查）。
`/health` → `{ok:true, schema:"8", release:null, memories:1, degraded:["nightly-skipped"]}`。
（`degraded` 里那条是 **E-6 新增的诚实读数**：夜间整备因缺模型被跳过 —— 以前这种情况面板上一片安静，只有 energy 慢慢滑到 0。）
（那 1 条记忆是断电感知写的「进程被杀 N 分钟」—— **每次 kill 面板都会留一条**，所以反复重启之后不可能保持“完全空库”。这是设计，不是残留。）

**数据已回到初始态（2026-10-29 22:40 清空测试数据）**：

- 旧数据完整备份在 `data.bak-20261029-224031/`（7.9 MB，**已进 .gitignore**）；恢复：删掉 `data/` 再 `mv data.bak-20261029-224031 data`。
- **清掉了**：`memory.db`（47 条记忆 / 3 篇文档 / 31 块 / 879 条审计 / 21 条 usage / 43 条 outage / 89 条 self_state）、`inbox/`、`sources/`、`markdown/`、`snapshots/`、`trash/`、`pending/`、`tokens/`、`life/`、`eval/`、`deploy/`（4 个 release）、`workspace/`（含红队留下的目录联接 `up -> D:\LLM\jingjing`）。
- **保住了**：`secrets/`（DPAPI 里的 DeepSeek key）、`config.json`、`mcp.json`、`persona/`、`policy.csv`、`policy.model.conf`、`avatars/`。
  保留这几样的理由：没了 key 面板就一条都答不出来（本地没有 chat 模型）；`policy.csv` 是权限面，不该因清空数据而静默放松。

**清空顺手抓到并修掉的两个 bug**（已 `npm run check` 245 绿）：

| bug | 症状 | 修法 |
|---|---|---|
| 空时间轴占位卡住 | `#chat:empty::before` 画“正在读取时间轴…”，而空库时 `#chat` **永远是空的** → 初始状态看起来像卡住 | 空库时渲染 `.empty` 空状态（“还没有任何经历 · 说一句试试”，并明说“夜里整理需要本地模型”） |
| `ui:test` 假设库里有记忆 | 干净库上固定红 2 项（`记忆项可点` / `记忆详情打开了`）；另 `发送后有新内容` 比较的是文本长度，占位比回复长时会误红 | 空库时 **⏭ skip**（不算绿也不算红），发送那条改比较**消息条数** |

`data/deploy/` 现在不存在 → `release: null`；要重新开始用发布流程就跑 `deploy install --because "初始状态"`。
Docker 引擎已拉起，镜像 `jingjing:dev` 仍可用；`exports/` 里那份旧导出**没动**（它引用的旧库仍可从 `data.bak` 重建）。

**现在“不绿”的地方只有一处**：`jingjing night` 退出码 2（缺本地 chat 模型）。面板对话照常用（云端 DeepSeek）。

⚠️ **`energy` 只靠夜间恢复**：唯一恢复点是 `night` 末尾的 `advance({night:true})`。缺模型时 `night` 会**降级但仍然推进**（E-6），所以 energy 不会滑到 0；但 `degraded` 里会一直挂着 `nightly-skipped`，ENERGY 那格的 hover 会写明“夜间未运行”。

如果你不想让面板继续跑：

```bash
for pid in $(netstat -ano | grep ":7700" | grep -i listen | awk '{print $5}' | sort -u); do taskkill //F //PID $pid; done
```

如果你想让面板受看门狗保护地跑（崩了自动回上一版）：

```bash
node src/cli/deploy.ts supervise -- node src/cli/jingjing.ts serve 7700
```
