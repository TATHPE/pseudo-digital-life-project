<!-- 自动生成：npm run map（别手改；改了 map:check 会红） -->
# 项目地图（H-3）

> 这张表由 `tools/gen-map.mjs` 从代码里读出来，`npm run map:check` 会**重新生成一遍再比**：
> 只要代码变了而这里没更新，check 就红。**它是防「文档说的和代码不一样」的那道闸。**

## 统计

| 项 | 数量 |
|---|---|
| 源文件（src/**/*.ts） | 93 |
| 错误码 E_* | 186 |
| verbs | 26 |
| CLI 子命令 | 37 |

## 六条纪律落点

| 纪律 | 文件 | 符号 |
|---|---|---|
| 一条执行路径 | `src/execute.ts` | `export async function execute` |
| 没接上 = 没做完 | `tools/ui-test.mjs` | `check(` |
| 闸门先于模型 | `src/nightly.ts` | `export function isNoise` |
| 参数有界 | `src/decayparams.ts` | `RANGES` |
| 内容只是资料 | `src/verbs.ts` | `E_NEEDS_EGRESS` |
| 改功能先列清单 | `AGENTS.md` | `改一个功能先列清单` |
| 写入单入口 | `src/store.ts` | `export function updateMemoryText` |
| L0 字节级不变 | `test/l0-prefix.test.ts` | `PINNED_PREFIX_HASH` |

## 错误码 E_*

| 错误码 | 抛出位置 |
|---|---|
| `E_ABSOLUTE_PATH` | `src/project.ts` |
| `E_AGENDA_DUP` | `src/agenda.ts` |
| `E_AGENDA_EMPTY` | `src/agenda.ts` |
| `E_AGENDA_FULL` | `src/agenda.ts` |
| `E_AGENDA_NO_SOURCE` | `src/agenda.ts` |
| `E_BAD_ACTION` | `src/web/server.ts` |
| `E_BAD_ARG` | `src/plugins.ts` |
| `E_BAD_ARG_VALUE` | `src/toolsmoke.ts` |
| `E_BAD_ARGS` | `src/toolsmoke.ts` |
| `E_BAD_ARGV` | `src/agentguard.ts` `src/execute.ts` `src/shell.ts` `src/verbs.ts` |
| `E_BAD_COMMAND` | `src/plugins.ts` |
| `E_BAD_ENDPOINT` | `src/transport.ts` |
| `E_BAD_IMAGE` | `src/web/server.ts` |
| `E_BAD_KEY` | `src/web/server.ts` |
| `E_BAD_LINK` | `src/web/server.ts` |
| `E_BAD_MODEL` | `src/web/server.ts` |
| `E_BAD_NAME` | `src/plugins.ts` `src/web/server.ts` |
| `E_BAD_PATH` | `src/gitview.ts` `src/web/server.ts` |
| `E_BAD_PRESET` | `src/web/server.ts` |
| `E_BAD_RANGE` | `src/decayparams.ts` |
| `E_BAD_REGEX` | `src/project.ts` |
| `E_BAD_RELEASE_ID` | `src/deploy/slot.ts` |
| `E_BAD_ROLE` | `src/cli/jingjing.ts` `src/web/server.ts` |
| `E_BAD_SENSITIVITY` | `src/web/server.ts` |
| `E_BAD_SLOT` | `src/shell.ts` |
| `E_BAD_STEP` | `src/web/server.ts` |
| `E_BAD_TARGET` | `src/decayparams.ts` |
| `E_BAD_TEMPLATE` | `src/shell.ts` |
| `E_CALL` | `src/toolsmoke.ts` |
| `E_CONFIG` | `src/cli/night.ts` `src/transport.ts` `src/web/server.ts` |
| `E_CONFIG_CORRUPT` | `src/startupcheck.ts` |
| `E_CONTROL_CHAR` | `src/persona.ts` |
| `E_CONVERT` | `src/ingest.ts` |
| `E_COOLDOWN` | `src/transport.ts` |
| `E_CORE_PROTECTED` | `src/verbs.ts` |
| `E_CSRF` | `src/web/server.ts` |
| `E_DECAY_PARAM` | `src/startupcheck.ts` |
| `E_DENIED` | `src/agentguard.ts` `src/execute.ts` `src/policy.ts` `src/tools.ts` |
| `E_DEPLOY_FROZEN` | `src/deploy/watchdog.ts` |
| `E_DEPLOY_NO_REASON` | `src/deploy/slot.ts` |
| `E_DEPLOY_STATE` | `src/deploy/slot.ts` |
| `E_DISABLED` | `src/shell.ts` |
| `E_EMBED` | `src/embed.ts` `src/ingest.ts` `src/reembed.ts` |
| `E_EMBED_COUNT` | `src/transport.ts` |
| `E_EMBED_DOWN` | `src/retrieve.ts` |
| `E_EMBED_EMPTY` | `src/retrieve.ts` |
| `E_EMPTY` | `src/agentguard.ts` `src/ingest.ts` `src/plugins.ts` `src/store.ts` `src/web/server.ts` |
| `E_EMPTY_EMBEDDING` | `src/embed.ts` |
| `E_ENCODING` | `src/ingest.ts` `src/persona.ts` `src/web/server.ts` |
| `E_EXISTS` | `src/plugins.ts` `src/verbs.ts` |
| `E_EXPORT_CORRUPT` | `src/handoff.ts` |
| `E_EXPORT_DIR_NOT_EMPTY` | `src/handoff.ts` |
| `E_EXPORT_INSIDE_HOME` | `src/handoff.ts` |
| `E_EXTRACT` | `src/nightagent.ts` `src/nightly.ts` |
| `E_GEN_NONE` | `src/generation.ts` |
| `E_GEN_REASON` | `src/generation.ts` |
| `E_GIT` | `src/gitview.ts` |
| `E_GIT_TIMEOUT` | `src/gitview.ts` |
| `E_GRANT_ARGV` | `src/grant.ts` |
| `E_GRANT_BECAUSE` | `src/grant.ts` |
| `E_GRANT_COMMAND` | `src/grant.ts` |
| `E_GRANT_FULL_DENY` | `src/grant.ts` |
| `E_GRANT_INLINE_EVAL` | `src/grant.ts` |
| `E_GRANT_META` | `src/grant.ts` |
| `E_GRANT_NEEDS_FULL` | `src/grant.ts` `src/verbs.ts` |
| `E_GRANT_NO_MATCH` | `src/grant.ts` |
| `E_GRANT_PATH` | `src/grant.ts` |
| `E_GRANT_SCOPE` | `src/grant.ts` |
| `E_GRANT_SECRET` | `src/grant.ts` |
| `E_INDEX` | `src/assert.ts` |
| `E_INTERP_BAD_BASIS` | `src/interpret.ts` |
| `E_INTERP_NO_BASIS` | `src/interpret.ts` |
| `E_INTERP_RESTATE` | `src/interpret.ts` |
| `E_INTERP_SHORT` | `src/interpret.ts` |
| `E_IS_DIR` | `src/verbs.ts` |
| `E_MAX_STEPS` | `src/agent.ts` |
| `E_MCP` | `src/mcp.ts` |
| `E_MCP_CLOSED` | `src/mcp.ts` |
| `E_MCP_EXIT` | `src/mcp.ts` |
| `E_MCP_TIMEOUT` | `src/mcp.ts` |
| `E_METADATA_ONLY` | `src/store.ts` |
| `E_MISSING` | `src/assert.ts` |
| `E_MISSING_ARG` | `src/toolsmoke.ts` |
| `E_MODEL` | `src/autobio.ts` `src/eval.ts` `src/provider.ts` `src/transport.ts` |
| `E_NEEDS_CONFIRM` | `src/confirm.ts` `src/execute.ts` `src/posture.ts` |
| `E_NEEDS_EGRESS` | `src/egress.ts` `src/posture.ts` `src/project.ts` `src/verbs.ts` |
| `E_NO_ARGV` | `src/shell.ts` |
| `E_NO_AVATAR` | `src/web/server.ts` |
| `E_NO_CALL` | `src/toolsmoke.ts` |
| `E_NO_CANDIDATES` | `src/agentguard.ts` |
| `E_NO_CAPABILITY` | `src/execute.ts` `src/tools.ts` |
| `E_NO_CMD` | `src/cli/deploy.ts` |
| `E_NO_COMMAND` | `src/plugins.ts` |
| `E_NO_CONVERTER` | `src/ingest.ts` |
| `E_NO_DB` | `src/cli/jingjing.ts` `src/verbs.ts` |
| `E_NO_DOC` | `src/web/page.ts` `src/web/server.ts` |
| `E_NO_DRAFT` | `src/interview.ts` `src/web/server.ts` |
| `E_NO_EMBED_MODEL` | `src/cli/jingjing.ts` |
| `E_NO_EMBEDDER` | `src/verbs.ts` |
| `E_NO_GIT` | `src/gitview.ts` |
| `E_NO_GRANT` | `src/grant.ts` `src/web/server.ts` |
| `E_NO_HOME` | `src/handoff.ts` |
| `E_NO_KEY` | `src/web/server.ts` |
| `E_NO_LINK` | `src/cli/jingjing.ts` |
| `E_NO_MEMORY` | `src/store.ts` `src/web/server.ts` |
| `E_NO_MODEL` | `src/cli/night.ts` |
| `E_NO_PATH` | `src/project.ts` `src/web/server.ts` |
| `E_NO_REASON` | `src/decayparams.ts` |
| `E_NO_RELEASE` | `src/cli/deploy.ts` `src/deploy/slot.ts` `src/deploy/watchdog.ts` |
| `E_NO_ROLE` | `src/cli/jingjing.ts` |
| `E_NO_RULE` | `src/policy.ts` |
| `E_NO_SKILL` | `src/skills.ts` |
| `E_NO_TARGET` | `src/cli/deploy.ts` |
| `E_NO_TEMPLATE` | `src/shell.ts` |
| `E_NO_TRASH` | `src/verbs.ts` |
| `E_NOT_A_REPO` | `src/gitview.ts` |
| `E_NOT_DELETED` | `src/web/server.ts` |
| `E_NOT_DIR` | `src/project.ts` |
| `E_NOT_FILE` | `src/project.ts` |
| `E_NOT_FOUND` | `src/agentguard.ts` `src/plugins.ts` `src/verbs.ts` `src/web/server.ts` |
| `E_NOTHING_TO_DO` | `src/web/server.ts` |
| `E_OLLAMA_DOWN` | `src/cli/jingjing.ts` |
| `E_ORIGIN` | `src/web/server.ts` |
| `E_OUT_OF_PROJECT` | `src/agentguard.ts` `src/project.ts` |
| `E_OUT_OF_RANGE` | `src/decayparams.ts` |
| `E_OUTPUT_TRUNCATED` | `src/web/server.ts` |
| `E_OUTSIDE_HOME` | `src/web/server.ts` |
| `E_PATH_DENIED` | `src/agentguard.ts` `src/project.ts` `src/shell.ts` `src/verbs.ts` |
| `E_PENDING_` | `src/web/server.ts` |
| `E_PENDING_EXPIRED` | `src/web/server.ts` |
| `E_PENDING_ID` | `src/confirm.ts` |
| `E_PENDING_NOT_FOUND` | `src/confirm.ts` `src/web/server.ts` |
| `E_PERSONA_FILE` | `src/persona.ts` |
| `E_PERSONA_TOO_BIG` | `src/persona.ts` |
| `E_POLICY_CORRUPT` | `src/startupcheck.ts` |
| `E_POLICY_MODEL_CORRUPT` | `src/startupcheck.ts` |
| `E_PRESET_READ_ONLY` | `src/grant.ts` |
| `E_PRIVACY` | `src/provider.ts` |
| `E_PROPOSAL_ARGV_BIN` | `src/proposals.ts` |
| `E_PROPOSAL_ARGV_PIPE` | `src/proposals.ts` |
| `E_PROPOSAL_BACKLOG` | `src/proposals.ts` |
| `E_PROPOSAL_ID` | `src/proposals.ts` |
| `E_PROPOSAL_NOT_FOUND` | `src/cli/jingjing.ts` `src/web/server.ts` |
| `E_PROPOSAL_TITLE` | `src/proposals.ts` |
| `E_PROPOSAL_TOUCH_ABS` | `src/proposals.ts` |
| `E_PROPOSAL_TOUCH_DOTDOT` | `src/proposals.ts` |
| `E_PROPOSAL_TOUCH_ROOT` | `src/proposals.ts` |
| `E_PROPOSAL_WHY` | `src/proposals.ts` |
| `E_PROVIDER` | `src/cooldown.ts` `src/transport.ts` |
| `E_READING_CONTRACT` | `src/store.ts` |
| `E_RECEIPT_ID` | `src/notify.ts` |
| `E_RECEIPT_NOT_FOUND` | `src/cli/jingjing.ts` `src/web/server.ts` |
| `E_RELEASE_CORRUPT` | `src/deploy/slot.ts` |
| `E_RELEASE_EXISTS` | `src/deploy/slot.ts` |
| `E_ROLE_MISSING` | `src/provider.ts` |
| `E_SANDBOX_UNAVAILABLE` | `src/shell.ts` |
| `E_SCHEMA_MISMATCH` | `src/startupcheck.ts` |
| `E_SETUP_BUSY` | `src/web/server.ts` |
| `E_SKILL_NAME` | `src/skills.ts` |
| `E_SKILL_READ` | `src/skills.ts` |
| `E_STANDING_BECAUSE` | `src/standing.ts` |
| `E_STANDING_ID` | `src/standing.ts` |
| `E_STANDING_NOT_FOUND` | `src/cli/jingjing.ts` `src/web/server.ts` |
| `E_STANDING_NOTIFY` | `src/standing.ts` |
| `E_STANDING_TEMPLATE` | `src/cli/jingjing.ts` `src/standing.ts` |
| `E_STANDING_WHEN` | `src/standing.ts` |
| `E_TAINT_CONTRACT` | `src/store.ts` |
| `E_TARGET_NOT_EMPTY` | `src/handoff.ts` |
| `E_THREAD_CLOSED` | `src/cli/jingjing.ts` `src/web/server.ts` |
| `E_TIMEOUT` | `src/verbs.ts` |
| `E_TOKEN_EXPIRED` | `src/cli/redteam.ts` `src/shell.ts` |
| `E_TOKEN_MISMATCH` | `src/cli/redteam.ts` `src/shell.ts` |
| `E_TOKEN_UNKNOWN` | `src/shell.ts` |
| `E_TOKEN_USED` | `src/cli/redteam.ts` `src/shell.ts` |
| `E_TOO_BIG` | `src/ingest.ts` `src/plugins.ts` `src/project.ts` `src/verbs.ts` `src/web/server.ts` |
| `E_TOOL` | `src/mcp.ts` `src/tools.ts` |
| `E_UNKNOWN_FIELD` | `src/decayparams.ts` |
| `E_UNKNOWN_KIND` | `src/decayparams.ts` |
| `E_UNKNOWN_PARAM` | `src/decayparams.ts` |
| `E_UNKNOWN_TOOL` | `src/toolsmoke.ts` |
| `E_UNSUPPORTED` | `src/ingest.ts` `src/transport.ts` `src/web/server.ts` |
| `E_UNSUPPORTED_CONTENT` | `src/mcp.ts` |
| `E_UPLOAD` | `src/web/server.ts` |
| `E_VERB` | `src/agentguard.ts` `src/execute.ts` |
| `E_WRITE` | `src/reembed.ts` |
| `E_WRONG_TOOL` | `src/toolsmoke.ts` |

## verbs（能力目录）

| verb | 档位 |
|---|---|
| `doc.list` | T0 |
| `doc.search` | T0 |
| `fs.list` | T0 |
| `fs.mkdir` | T1 |
| `fs.read` | T0 |
| `fs.restore` | T1 |
| `fs.search` | T0 |
| `fs.stat` | T0 |
| `fs.trash` | T1 |
| `fs.write` | T1 |
| `git.diff` | T1 |
| `git.log` | T0 |
| `git.status` | T1 |
| `memory.remember` | T1 |
| `memory.search` | T0 |
| `msg.notify` | T2 |
| `project.list` | T0 |
| `project.read` | T0 |
| `project.search` | T0 |
| `proposal.create` | T1 |
| `shell.exec` | T3 |
| `shell.run` | T3 |
| `shell.templates` | T0 |
| `skill.list` | T0 |
| `skill.read` | T0 |
| `time.now` | T0 |

## CLI 子命令

`migrate` · `remember` · `search` · `verify` · `outage` · `serve` · `config` · `models` · `links` · `threads` · `proposal` · `grant` · `standing` · `persona` · `setup` · `capabilities` · `doctor` · `reembed` · `auth` · `usage` · `test` · `night` · `shell` · `ingest` · `docs` · `forget-doc` · `export` · `verify-export` · `import` · `smoke-tools` · `templates` · `redteam` · `verb` · `beat` · `eval` · `decay` · `bench`

## 源文件

| 文件 | 干什么 |
|---|---|
| `src/agenda.ts` | 她自己的惦记（H-a）—— 人性缺的第一块。 |
| `src/agent.ts` | 工具循环（agent loop）：模型 → 工具 → 模型 … → 回答。 |
| `src/agentguard.ts` | Agent 回路的三条硬规矩（C-1 / C-3 / C-2）。 |
| `src/assert.ts` | 越界即抛（比 `!` 安全：漏了会炸而不是 NaN 悄悄传播） */ |
| `src/auth.ts` | 凭据存储（13 §3） |
| `src/autobio.ts` | 自传（01 §9.1）：一天一条，第一人称，只能引用当日记忆 id。 |
| `src/boot.ts` | 断电/停机感知（18 §2） |
| `src/brief.ts` | 情境简报（06 §3 / 17 §2） |
| `src/budget.ts` | 记账与预算闸（13 §6）：cached_tokens 必须单独记，否则看不出缓存有没有生效 */ |
| `src/capabilities.ts` | 能力自述（B-0） |
| `src/chunk.ts` | 分块（02 §5.2）——**召回上限在这一步就定了**，后面怎么调都补不回来。 |
| `src/cli/brief-demo.ts` | M1 第一个可执行产物：渲染第 1 轮与第 100 轮的简报，打印槽位与 token 预算。 |
| `src/cli/deploy.ts` | !/usr/bin/env node |
| `src/cli/eval.ts` | CLI：eval —— 跑评估（19 §0.1 W-B）。 |
| `src/cli/jingjing.ts` | !/usr/bin/env node |
| `src/cli/night.ts` | CLI：night —— 跑一次夜间整备（抽取 + 冲突消解 + 归并 + 自传）。 |
| `src/cli/redteam.ts` | 红队用例（04 §10）：14 条攻击，全部要拦。可执行、可回归。 |
| `src/commands.ts` | CLI 子命令表（B-0 用）。它必须与 `src/cli/jingjing.ts` 的 switch 分支一致 —— |
| `src/config.ts` | 角色配置（13 §2） |
| `src/configfile.ts` | 可持久化的配置（13 §2）：env > data/config.json > 默认值 |
| `src/confirm.ts` | 待确认清单（04 §4.1 的"人那一侧"） |
| `src/cooldown.ts` | 云端失败冷却（D-2） |
| `src/coreguard.ts` | 记忆核心的**结构性保护**（用户 2026-10-31 定的边界）： |
| `src/db.ts` | import { DatabaseSync } from "node:sqlite"; |
| `src/decay.ts` | 记忆动力学（01 §4/§5）——全项目唯一"写完之后不用改"的模块。 |
| `src/decayparams.ts` | 衰减参数的可调边界（E-4） |
| `src/deploy/fingerprint.ts` | 三重指纹（02 §4.3 / §6，18 §1.3）：schema / tool / embed。 |
| `src/deploy/slot.ts` | A/B 双槽（18 §4.3 / §4.5，99 §5.1） |
| `src/deploy/smoke.ts` | 冒烟 20 项（18 §4.3 / §4.5，99 §5.1） |
| `src/deploy/watchdog.ts` | 看门狗 + 自动回滚（18 §4.3 / §4.5，99 §5.1） |
| `src/doctor.ts` | 体检（D-6） |
| `src/egress.ts` | H-7：代码外发的**按次授权**。 |
| `src/embed.ts` | Embedding（13 §2 role: embed） |
| `src/embedindex.ts` | 索引身份（C-2） |
| `src/eval.ts` | 评估（19 §0.1 W-B / 01 §13）：唯一能证明"它变好了"的东西。 |
| `src/execute.ts` | 执行入口（04 §4）：**策略 → 执行 → 审计**，一个都不能少。 |
| `src/firstrun.ts` | 试运行 + 第一句话（H-4 第 ⑦⑧ 步）。 |
| `src/fsx.ts` | 原子写 + fsync（18 §1.2） |
| `src/generation.ts` | 设定封存的**分代**（H-5）。 |
| `src/gitview.ts` | git 校样（只读）：把"她改了什么"摊开给人看。 |
| `src/grant.ts` | 会话式授权（K-3）：**窗口内**可以用模型给的 argv，窗口外回到 6 个模板。 |
| `src/handoff.ts` | 搬家协议（19 §7.4 / 09 §5）：**quiesce → export → 校验 → import → 补跑** |
| `src/heartbeat.ts` | 心跳与主动性（01 §10）。 |
| `src/ingest.ts` | 摄入管道（02 §5.1 转换 → §5.2 分块 → §5.3 幂等） |
| `src/interpret.ts` | 记忆的「意义层」（H-b）—— 人性缺的第二块。 |
| `src/interview.ts` | 人格访谈（H-4 第 ⑥ 步）。 |
| `src/journal.ts` | inbox：原始事件的唯一事实源（18 §1.1） |
| `src/links.ts` | 记忆之间的线（J-5）：抽检与"一句话拆线"。 |
| `src/mcp.ts` | 最小 MCP stdio 客户端（11 §3 方向 B）。 |
| `src/md.ts` | 极简 Markdown → HTML（够用、可测、零依赖；所有文本先转义） */ |
| `src/memoryonly.ts` | 「本地模型只管理记忆」这条边界，写成**结构**（用户 2026-10-31 再次确认）。 |
| `src/nightagent.ts` | 夜间整理的「工具循环」抽取器（P0-2） |
| `src/nightly.ts` | 夜间整备（01 §9）：消化 inbox → 抽取 → 冲突消解 → 归并。 |
| `src/notify.ts` | 回执通道（D-3 的前置，`docs/25 §4`）。 |
| `src/ollama.ts` | Ollama 探测（C-4）：一次 /api/tags + 两个最小调用探针。 |
| `src/persona.ts` | import { readFileSync, mkdirSync, existsSync, readdirSync } from "node |
| `src/plugins.ts` | 插件（MCP）与技能的**增删**（2026-11-01，用户："现在只能看，等于借来的手脚是死数据"）。 |
| `src/policy.ts` | 策略层（04 §4 / 12 §9.2）：唯一有权说"不"的地方。 |
| `src/posture.ts` | 默认姿态（用户 2026-10-31 的判断）： |
| `src/preflight.ts` | 本地端点前置检查（C-3） |
| `src/project.ts` | 项目读取（K-1） |
| `src/proposals.ts` | 提议（K-2）：让它会**提要求**，而不是只会照做。 |
| `src/provider.ts` | 角色路由（13 §2）+ 隐私闸门（19 §0.1 W-A） |
| `src/pyenv.ts` | 找 MarkItDown 用的 Python（H-1） |
| `src/recall.ts` | 召回装配（17 §2 的 P10 槽位该放什么） |
| `src/reembed.ts` | 重建向量索引（C-2） |
| `src/retrieve.ts` | 两阶段检索（02 §7.1 实测修订 / 12 §9.1） |
| `src/schema.ts` | M0 schema（02 §4 + 18 §1 的 outage/审计） */ |
| `src/setup.ts` | 首次配置事务（H-4）。 |
| `src/setupsteps.ts` | 引导步骤的执行（H-4 的第 2–4 步）。 |
| `src/shell.ts` | T3 受限命令执行（04 §5.2 模板 / §4.1 一次性令牌 / §6 宿主层） |
| `src/skills.ts` | 技能（SKILL.md）—— docs/11 的第二优先。 |
| `src/standing.ts` | 常驻指令（D-3）：有范围的预授权 + 调度。 |
| `src/startup.ts` | 启动自检（18 §1.3 / §2.2）：断电检测 → 记 outage → 写一条记忆 → 补算衰减。 |
| `src/startupcheck.ts` | 启动前配置校验（D-5） |
| `src/state.ts` | 自我状态（01 §8）：慢变量，不是每次对话随机生成的情绪标签。 |
| `src/store.ts` | 记忆读写（M0 最小面）：remember / 载入候选 / 批量衰减 */ |
| `src/surface.ts` | 浮现时机（J-4） |
| `src/territory.ts` | 领地（16 §3.5）：它自己的那块磁盘。 |
| `src/text.ts` | 中文 FTS5 必须用 bigram（12 §9.1 实测：unicode61 对中文完全失效） */ |
| `src/threads.ts` | 线索层（借自衔枝 Twig 的 thread 概念，但**不新建表**）。 |
| `src/tokens.ts` | Token 估算（零依赖）。 |
| `src/tools.ts` | 工具面（给模型看）——现在只有**一条**执行路径： |
| `src/toolsmoke.ts` | 工具调用冒烟（P0-1） |
| `src/transport.ts` | 真正的模型调用层（13 §2 / 19 §0.1 W-A） |
| `src/types.ts` | export type Tier = "T0" / "T1" / "T2" / "T3" / "T4"; |
| `src/verbs.ts` | 能力目录（04 §3）：鲸鲸能碰到的东西**只有这张表里的**。 |
| `src/web/desk.ts` | 桌面端的**启动令牌**（2026-11-01：软件只有桌面端，不提供浏览器入口）。 |
| `src/web/page.ts` | 单页（零前端依赖、零构建）。 |
| `src/web/server.ts` | 本地 Web 面板（17 §4）：127.0.0.1:7700，零前端依赖，SSE 流式。 |
| `src/web/state.ts` | 状态行（17 §4.1）：一句话，不是数字仪表盘 */ |
| `src/web/timeline.ts` | 时间轴渲染（17 §4）：**没有"会话"，只有时间；空白要可见** */ |
| `src/web/welcome.ts` | 首次配置引导页（`/welcome`）。 |
