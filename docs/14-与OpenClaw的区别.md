<!-- 自动生成，别在这个文件里改 -->
<!-- 真源：D:/LLM/docs/14-与OpenClaw的区别.md（改完跑 npm run docs:sync） -->
# 鲸鲸 vs OpenClaw：差在哪，还要不要自己做

> 版本 v0.2 · 2026-10-27 · 事实来源：`openclaw/openclaw` README（113 KB 快照，`research/openclaw.md`）+ GitHub Search API 快照
> 结论会改主意，先说结论：**OpenClaw 把"身体和外壳"做到了工业化；鲸鲸只有"记忆与人格"这一个差异点，而且必须承认——`04` 那套权限哲学和它撞车了。**

---

## 1. OpenClaw 是什么（按它的自述，不加揣测）

| 事实 | 数据 |
|---|---|
| 仓库 | `openclaw/openclaw`，**393,197★**，MIT，TypeScript，最近 push 2026-10-27 |
| 定位 | *"Your assistant, on your devices, in your chats"* / *"The AI that really does things. Any OS. Any Platform."* |
| 交互面 | Discord / iMessage / Slack / Teams / Telegram / WhatsApp **+20 多个渠道**；macOS、iOS、Android、Windows、Linux 原生应用 |
| 架构 | **一个 Gateway**（本地控制平面：会话、工具、事件、渠道连接）+ Control UI / CLI / TUI |
| 数据 | *"State, memory, and credentials live on your hardware"*；默认只做每日版本检查，可关 |
| 扩展 | **模型与 agent harness（Claude / Codex / 本地模型）是可插拔的 plugin**；tools / skills / plugins 三层；**ClawHub 注册中心** |
| 生态 | `VoltAgent/awesome-openclaw-skills` **53,374★**（5,400+ 技能）；`openclaw/clawhub` **9,535★**；`awesome-openclaw-usecases` 31,643★ |
| 治理 | OpenClaw Foundation（501(c)(3)），无付费版、无托管服务、无 token |
| 安全哲学 | **"trusted gateway, untrusted execution, policy enforced by code"** |

最后那一条需要停一下——**这就是 `04` 的整篇文档**：可信的网关、不可信的执行、策略由代码强制。我们在第 04 号文档里花 350 行推导出来的东西，是它的架构基石，而且它已经在生产里跑了。

---

## 2. 维度对照（只列有实质差别的）

| 维度 | OpenClaw | 鲸鲸 | 谁强 |
|---|---|---|---|
| **交互面** | 20+ 聊天平台 + 五平台原生应用 + 语音 | MCP 客户端 / 薄壳（未实现） | **它，压倒性** |
| **Gateway / 控制平面** | 现成，会话/工具/事件/渠道 | 自建 `jingjingd`（未实现，`09`） | **它** |
| **权限哲学** | policy enforced by code | `04` T0–T4 + advise/enforce | **平**（撞车，见 §3） |
| **技能生态** | 5,400+ 技能 + 注册中心 | 只有设计（`11 §4`） | **它** |
| **模型/harness 可换** | 一等公民（插件） | 一等公民（角色化配置 `13`） | **平** |
| **记忆** | **核心（不是插件位那么简单）**：`memory-core` 内置引擎（每 agent 一个 SQLite，400 token/80 overlap 分块，hybrid × 指数时间衰减（30 天半衰期）× importance 加权 + MMR）<br>+ 分层文件（`USER.md` / `MEMORY.md` / `memory/YYYY-MM-DD.md` / `DREAMS.md`）<br>+ 条目级溯源（`owner/agent/untrusted/system`）+ supersession key<br>+ 凌晨 3 点自动 deepening（`0 3 * * *`，minScore 0.75）<br>+ `plugins.slots.memory` **可整套替换** | 核心命题：双层（契约/叙事）、拉伸指数 `β`、四段 `stage` + 双阈值滞后、再巩固写回、强线索唤醒 | **它占 80%，我们只剩形状** |
| **时间感** | 有 recency 衰减（排序用），无"状态变量" | `01 §8` 内感受 + `L1` 连续性判据 | **我方，但窄** |
| **遗忘** | 有：衰减是**排序乘数**（daily notes 30 天半衰期，`MEMORY.md`/`USER.md` 永不过期）；无：分阶段、无唤醒 | `01 §4/§5` 显式、可调、可测、可唤醒 | **我方，差在形状** |
| **自我叙事** | 有 `DREAMS.md`（dream diary + REM 摘要：`What Happened / Reflections / Possible Lasting Updates`）——**这几乎就是自传** | `01 §9.1` 一天一条、只能引用当日记忆 | **平**（它已做） |
| **主动性** | cron-jobs 是一等公民；但未定义"为什么主动" | `01 §10` 每日配额 + 必须可解释 | 各有所长 |
| **人格工程** | 未发现（`USER.md` 是偏好与风格指令，不是人格机制） | `07` 整套：立场带代价、voice 样本、不谄媚、修复协议 | **我方** |
| **防编造** | 有 `minScore` 门槛与 provenance 隔离；**未发现**四态 confidence / cite 后置检查 / 诱捕 eval | `00 §11` 全套 + 评估口径 | **我方** |
| **成熟度** | 数十万星、基金会、每日发版 | 0 行代码、13 份文档 | **它** |

**一句话总结这张表**：**它已经不只“身体与外壳”了——它连海马体都有，而且做了八成分。我们的机会不在“重新做一个记忆系统”，而在“换掉它的衰减形状与自我层”。**

---

## 3. 必须承认的五件事（读完 `docs/` 后从三件改到五件）

**① 我们的“权限哲学”不是创新。** `04` 的 trusted-gateway / untrusted-execution / policy-in-code，是 OpenClaw 的架构基石。好消息是方向被 39 万星验证了；坏消息是**这一层没有差异化价值**。

**② 我们的“技能与插件”策略需要修正。** `11 §0` 那条“不要做成 harness 的插件”针对的是**长尾 harness**（pi extension、DSH bundle）。OpenClaw 不是长尾——平台级 harness 的 plugin 接口是它的产品承诺。已加限定（`11 §0`）。

**③ “记忆插件”这个位置不止有人占，它有个正式名字。**

> *“Provided by the bundled `memory-core` plugin. **`plugins.slots.memory` selects `memory-core` by default.** Other memory plugins expose their own CLI namespaces.”*

也就是说：**记忆引擎是一个可抽换的 slot**。这对我们是好消息——插口不是我们想象的“加工具”，而是“**换引擎**”。

**④ 我们以为只有我们在做的事，它已经做了：**

| 我们文档里的设计 | OpenClaw 的对应物 |
|---|---|
| `02 §7.1` hybrid × 衰减 × importance + MMR | 完全一致，连顺序都一样 |
| `02 §8.2` 冲突消解与 `superseded_by` | 条目级 `supersession key`，夜间 deepening 做 additions/merges/supersessions |
| `02 §4.1` 溯源记录 | 条目级 provenance 存于 SQLite（**并且刻意不存 Markdown，防止“召回文本改写自己的可信度”**——这正是论文 2607.29167 的治法） |
| `01 §9` 夜间整备 | 凌晨 3 点 deepening（`0 3 * * *`，minScore 0.75、minRecallCount 3） |
| `01 §9.1` 自传 | `DREAMS.md` + REM 摘要（`What Happened / Reflections / Possible Lasting Updates`） |

**⑤ 但它确实缺三样，而且这三样恰好是我们想做的：**

1. **衰减的形状**：它是“排序乘数 + 30 天半衰期 + 文件级永不过期”。没有 `β`、没有 `stage` 四段、没有双阈值滞后、没有强线索唤醒、没有再巩固写回。
2. **条目级的两层不变量**：“永不过期”是按**文件**分的（`MEMORY.md`/`USER.md`），不是按**条目**。所以一条放进 `MEMORY.md` 的旧偏好会永远保持同样权重——没有“该淡了”的机制。
3. **人格与防编造**：没有不谄媚机制、没有四态 `confidence`、没有 cite 后置检查、没有诱捕 eval。

---

## 4. 所以差在哪（一句话版）

> **OpenClaw 是"一个人的手和嘴"，鲸鲸想做的"一个人的记忆和性格"。**
> 前者可以同时服务一万个用户，后者只服务一个人——这就是为什么它的架构里没有衰减，而有衰减的我们没法做成通用产品。

具体三条：

1. **它面向"渠道"**：任何一个聊天软件里的入口。→ 它的记忆需求是"会话内 + 跨会话检索"，不需要"三个月前那句话该淡了"。
2. **它面向"通用助手"**：帮所有人干活。→ 人格必须是可配置的（skill/prompt 层），不能是核心机制。
3. **它面向"可信"**：policy in code、无遥测、无付费。→ 它的取舍都在**边界**上，不在**内部动力学**上。

我们的三条恰好反过来：单用户、只服务一个人、内部动力学就是产品本身。

---

## 5. 战略选项（这次真的要选）

| 选项 | 做法 | 得到 | 失去 | 适合 |
|---|---|---|---|---|
| **A 做它的记忆插件** | 把 `01`+`02` 实现成 OpenClaw 的 memory provider plugin + 一组 skills；body/harness/渠道全交给它 | 立刻拥有 20+ 渠道、五平台应用、5400 技能、成熟 gateway；我们只写差异层（衰减/自传/防编造） | "这是一个独立产品"的叙事；受它的 plugin API 约束；它改 API 要跟 | **想尽快让鲸鲸"活在自己生活里"** |
| **B 自建薄壳** | 按 `09` 自建 `jingjingd` + MCP + 简单 UI | 完全自主；可做任何实验（如改衰减参数、A/B 人格） | 所有工程工作自己扛；没有渠道；技能生态从零 | **目标是研究记忆动力学本身** |
| **C 双轨** | 核心（memory/dynamics/persona）做成**独立的 MCP server**，既能被自建薄壳用，也能被 OpenClaw 用 | 两边都不放弃；`11 §1` 的三向接入正好支持 | 需要同时维护两套"装配块"适配 | 时间充裕、想留后路 |

**我的判断**：**C 起步，倾向 A。** 理由：

- `02 §9` + `11 §3` 的设计已经让"核心即 MCP server"成立——这是 C 的技术前提，且成本几乎为零（本来就要写 MCP server）。
- 一旦核心是 MCP server，**"装进 OpenClaw"就只是写一个 plugin 壳**（几十行 + 一份 manifest），而不是重写。这就是 C 的价值。
- 而 `00 §1` 的五条判据（连续性、衰减、主动、自叙、换引擎不换人）**在 OpenClaw 里目前没有实现**——这是差异点，也是唯一值得做的事。
- **body 和渠道是最贵、最没有差异化的部分。** 我们已经在 `04` 里花了两天推演权限，结论撞车了——这说明这部分应该买，不该造。

**唯一让我犹豫的是**：OpenClaw 的记忆机制没在 README 里写清楚（只承诺"memory lives on your hardware"）。在决定 A 之前，必须先读它的 `docs/` 里 memory 与 plugin SDK 的真实接口，否则可能发现"它的记忆模型和我们的衰减模型不兼容"。

---

## 6. 决定 A 之前必须先查的四件事

| # | 要查什么 | 为什么决定成败 |
|---|---|---|
| 1 | memory 是 core 概念还是纯 plugin 位？有无 provider 接口？ | 如果它自己有 memory 抽象，我们得**适配**而不是**替代** |
| 2 | plugin 能否接管"每次请求的上下文组装"（而不只是提供工具） | 我们的衰减与装配块是**请求级**的，只能"加工具"的插件位做不了 |
| 3 | 是否允许替换 agent harness（它说可以） | 决定我们是插件还是 harness |
| 4 | 多实例/单实例语义 | 记忆不能分叉（`09 §3`），如果它按设备多实例，我们要额外加单点锁 |

这四条不查清就动手，风险是"写了两个月发现插不进去"——比现在什么都不写更糟。

---

## 7. 能不能当它的「大脑」？——先改一个词

**不能，也不该这么说。**

| 说法 | 对应什么 | 谁已经在做 |
|---|---|---|
| “大脑”（推理与表达） | 模型 + agent 循环 + 工具调度 | **OpenClaw 已经有了**，而且「模型与 harness 可换」正是它的核心卖点 |
| **“海马体 + 自我模型”** | 记忆库、衰减时钟、装配块、自传、人格约束、防编造 | **无人做**，这才是我们的位置 |

把鲸鲸叫“大脑”会带来两个实际危害：

1. **承诺了我们做不到的东西**——模型路由、工具循环、渠道适配，全是它在做且做得比我们好。
2. **把验收标准带偏**——变成“它够不够聪明”，而根文档 `0 §4` 的判据是**连续性**，不是智力。

一句话：**大脑可以换（它本来就是插拔的），而“记得你”不能换。我们卖的是后者。**

---

## 8. 嵌入深度阶梯：同一个目标，三种插手位置

如果要做成 OpenClaw 插件，**能做到什么程度取决于能插到多深**。三级阶梯：

| 深度 | 接入方式 | 能实现的生命度 | 代价 / 风险 |
|---|---|---|---|
| **D1 工具级** | 注册 MCP tools（`search` / `remember` / `cite` / `context`），它的 agent 自己决定调 | **L1**（有记忆，但**装配权在它手里**） | 最小；但衰减、简报、自传只能“事后影响”，拿不到请求级时机 |
| **D2 上下文级** | 在**每次请求前**注入/替换 memory block（06 §3 的简报） | **L2–L3**（衰减、时间感、自传、防编造都在这一层） | 需要“请求级上下文钩子”——**这是成败关键** |
| **D3 harness 级** | 直接替换 agent harness（它说可以） | **L3+** | 相当于把鲸鲸搬到它下面；自建 daemon 的独立性没了，且要跟上它的循环语义 |

### 8.1 为什么 D1 不够（这是最容易被误判的一点）

我们的核心机制全是**请求级**的，不是工具级的：

- 衰减与 `stage` 要在**组装前**决定“这一条该不该浮现”（`01 §5/§6`）
- 简报的稳定前缀要**逐字不变**才能命中缓存（`06 §4.1`）
- `confidence` 四态与“Earned abstain”要在**生成前**就确定（`01 §6.2`）
- 后置检查要在**生成后**跑一遍（`00 §11`）

工具级插件做不到任何一条：它能回答“查什么”，但**它的 agent 决定查不查、查几条、怎么塞进上下文**。结果就是：**鲸鲸变成“一个可以查的数据库”，而不是“决定此刻想起什么的那个东西”。**

### 8.2 但“插件 ≠ 不需要 daemon”

即使 D2 成功，**衰减、心跳、自传仍然是时间驱动的，与请求无关**。一个只在“有请求时被调用”的插件，夜里什么都没发生。

所以必须有一个常驻调度。两种形式，得看它的插件能不能注册定时任务：

| 情形 | 做法 |
|---|---|
| 插件能注册 cron/scheduler | 跟随它的 gateway 常驻，最省事（但寿命受它重启影响） |
| 不能 | **我们自己的 daemon 仍在**，只把“渠道与 UI”外包给 OpenClaw |

结论：**做成插件省的是渠道、UI、会话管理；省不了常驻进程。** 这一点如果误判，会得到“平时很好用、周末回来发现它少了一周”的东西。

### 8.3 职责不重叠原则

| 层 | OpenClaw | 鲸鲸插件 | 重叠？ |
|---|---|---|---|
| 渠道 / 原生应用 | ✅ | — | 不重叠，纯收益 |
| 会话 / 工具循环 / 模型路由 | ✅ | — | 不重叠，纯收益 |
| 权限（policy in code） | ✅ | 只声明 T 档，不自建 | 它已成体系，**别再写一遍** |
| skills / 插件生态 | ✅（5,400+） | — | 不重叠 |
| **记忆库 + 衰减 + 装配块** | — | ✅ | **唯一差异点** |
| **自传 / 时间感 / 人格约束** | — | ✅ | **唯一差异点** |
| **防编造后置检查** | — | ✅ | **唯一差异点** |

写代码前对着这张表自问：**这一行如果两边都能做，就不要做。** 这正是 `03 §7.3` 那条“像人的部分自己写，像工具的部分能用就用”的具体版。

---

## 9. 四个必须先查的接口（决定 D1 / D2 / D3）

把 §6 那四条具体化成可查的问题，**每一个都能用一小时阅读得到答案**：

| # | 问题 | 若答“否”，后果 |
|---|---|---|
| 1 | 有没有**请求级上下文钩子**（不是工具，是 pre-request / prompt contributor）？ | **D2 不可能** → 最高只能 L1 → 放弃插件路线，回到自建薄壳 |
| 2 | memory 是 core 概念还是纯 plugin 位？有无 **provider 接口**？ | 有的话要**适配**而不是**替代**；可能要写两套（它的 + 我们的） |
| 3 | 插件能否注册 **cron / 定时任务**？ | 不能 → 仍需自建 daemon（`§8.2`） |
| 4 | 会话/实例语义：单 gateway 单实例？多设备会不会分叉记忆？ | 会分叉 → 必须加单点锁（`09 §3`），或禁止多实例 |

**第 1 条是生死线。** 其余三条只影响工作量。

---

## 10. 一句话

**我们不是它的大脑，是它的海马体——而它恰好缺这个。**

大脑（推理与表达）它已经能换，换得比我们好；**但"决定此刻想起什么"和"记得你说过什么"没人做，也换不了。**

**OpenClaw 证明了一件事：把 AI 放进你的生活里，工程量大得超乎想象，而且已经有 39 万人在做。**
**它没有证明的是：它记得你。**

所以鲸鲸的定位应该更窄、更狠：**不做助手，做那个"记得你、会淡忘、有自己脾气"的东西**——然后把"怎么说话、怎么说给手机听"全部外包。

---

## 11. 实测：四个接口的答案（2026-10-27，读 docs.openclaw.ai 全文 29.6 MB）

方法：`https://docs.openclaw.ai/llms-full.txt`（29,618,858 字符，官方给 LLM 用的全站导出）+ `llms.txt` 索引 + 若干页 `.md`。没装、没 clone。

### Q1 有没有请求级上下文钩子？→ ✅ **有，而且比我们要的还细**

非内置插件可用的会话钩子（需 `plugins.entries.<id>.hooks.allowConversationAccess=true`）：

```
before_model_resolve     ← 在解析 provider/model 之前（无 messages）
agent_turn_prepare
before_prompt_build      ← 关键：注入 prependContext / systemPrompt /
                            prependSystemContext / appendSystemContext，
                            还可用 toolsAllow 逐轮收窄工具面
before_agent_reply · llm_input · llm_output
before_agent_run · before_agent_finalize · agent_end · session_end
```

还有 `agent:bootstrap`（"Workspace bootstrap resolution **before context injection**; awaited"）。

**结论**：我们 `06 §3` 的情境简报、`01 §5/§6` 的 stage 过滤与四态 confidence、`00 §11` 的后置检查——**全部能在 `before_prompt_build` + `llm_output` 里落地**。`14 §8` 的 D2（上下文级）**成立**。

### Q2 memory 是 core 还是插件位？→ ✅ **两者都是**（这是最好的答案）

- **core 内置引擎**：per-agent SQLite；`MEMORY.md`/`USER.md`/`memory/*.md` 分块 400 token / 80 overlap；`hybrid relevance × recency decay × importance` + MMR；条目级 provenance（`owner/agent/untrusted/system`），**刻意存在 Markdown 之外**。
- **可抽换 slot**："`plugins.slots.memory` selects `memory-core` by default. Other memory plugins expose their own CLI namespaces."
- 还有 `memory-admission-policy`、`memory-and-state-lifecycle` 这类内部边界（见其 codeql 边界表）。

**结论**：我们不是"加一个工具"，而是可以**整块替换记忆运行时**。

### Q3 插件能否注册定时任务？→ ✅ 有 cron 体系，但插件侧要确认

- `automation/cron-jobs/*` 是完整一等公民（schedules / payloads / delivery / webhooks / managing）。
- 记忆引擎的 deepening 自带 `0 3 * * *`（凌晨 3 点），阈值 `minScore 0.75 / minRecallCount 3 / minUniqueQueries 3`，`recencyHalfLifeDays 14`、`maxAgeDays 30`。
- 插件入口有 `gateway:startup` / `gateway:shutdown` / `gateway:pre-restart` 三个生命周期钩子，可用来自建调度。

**结论**：夜间任务不需要我们额外起 daemon；`plugin ≠ 需要独立常驻进程`。

### Q4 单实例 / 多设备会不会分叉？→ ⚠️ **未确认**

- 全文检索 `single instance`、`instance lock` 命中 0 次（`network-runtime-boundary` 里出现过 `gateway lock`，是网络边界语境）。
- Gateway 是"一个进程"，但**多设备/多 Gateway 指向同一 workspace 时的并发写语义没写**。

**结论**：这是唯一悬着的一条，属于"接入前必须实测"。

---

## 12. 修正后的结论：插口是 `plugins.slots.memory`，不是"插件"

四个答案里三个是 **YES**，方向从"能不能"变成"怎么插"。而且最深的插口比我们预想的深：

| 方案 | 插在哪 | 我们要写的东西 | 评价 |
|---|---|---|---|
| 工具级 | MCP tools | 全栈记忆 | ❌ 已有 `memory-core`，重复造 |
| 普通插件 | `before_prompt_build` | 简报 + 后置检查 + 衰减层 | ✅ 可做，但和 `memory-core` 打架 |
| **记忆运行时** | **`plugins.slots.memory`** | **一个完整的 memory engine** | ✅ **正解**：整块接管，不重叠、不打架 |
| harness 替换 | agent harness | 整个循环 | ❌ 又回到自建 |

**所以我们真正该写的东西缩小成三件**（都不是"再做一个记忆系统"）：

1. **一个 memory runtime**：接口按它的 slot 定义，内核用我们的 `decay.ts`（拉伸指数 `β` + 四段 stage + 双阈值滞后 + 再巩固写回 + flashback）。
2. **一个 `before_prompt_build` 钩子**：我们的简报分层（缓存前缀）、四态 `confidence`、`local_only` 物理剔除。
3. **一个 `llm_output` 钩子**：cite 后置检查 + 诱捕 eval 的在线版。

其余（渠道、会话、工具循环、模型路由、skills、权限、备份）**全部不写**。

---

## 13. 一句话（最终版）

**它不是"身体"，我们已经错了两次：第一次以为它只是外壳，第二次以为它没有记忆。读完 29 MB 文档才发现——它连海马体都有，而且做了八成分。**

**但它的记忆没有形状。** 它知道该给旧东西降权，不知道"该淡到什么程度、什么时候该想起来、以及为什么有些事永远不能淡"。

**这就是我们唯一该写的那一万行。**

---

## 14. 追加实测：它有没有"用本地大模型管记忆"？→ **有，而且 `bge-m3` 被点名**

结论先说：**不是"有个插件能做"，而是它的内置路径就支持"全本地闭环"。** 四个模型槽位全可指向本地。

| 槽位 | 配置键 | 本地支持 | 证据 |
|---|---|---|---|
| **嵌入** | `memory.search.provider` / `.model` | `ollama`、`local`（本地 GGUF）、`lmstudio`、`openai-compatible` | 文档原话：*"Ollama supports models such as **`bge-m3`** and `nomic-embed-text`"* |
| **托管本地嵌入** | `@openclaw/llama-cpp-provider` | 装并托管 `llama-server` + GGUF；或接你自己已有的 llama-server | `openclaw plugins install @openclaw/llama-cpp-provider`；doctor 有专门检查 `memory-core/managed-local-embedding-setup` |
| **固化（改写 `MEMORY.md`）** | 跟随 agent 默认模型 | ✅ 默认就是"agent 用哪个模型，就用哪个模型做 consolidation" | *"Gated candidates, together with the current `MEMORY.md`, go to a **consolidation model turn**"* |
| **Dreaming / 自传** | `plugins.entries.memory-core.config.dreaming.model` | ✅ 可显式覆盖 | *"tool-free background completion uses the workspace agent's default model **unless `dreaming.model` is configured**"* |
| **Active Memory（深挖子 agent）** | `plugins.entries.active-memory.config.model` | ✅ 可覆盖 | *"Optional blocking sub-agent model ref; when unset, inherits the current session model"* |

### 14.1 一份"全本地"配置（键名来自文档，装好需按版本核对）

```json5
{
  memory: { search: { provider: "ollama", model: "bge-m3" } },
  plugins: { entries: {
    "memory-core": {
      subagent: { allowModelOverride: true,
                  allowedModels: ["ollama/qwen2.5:1.5b-instruct"] },
      config: { dreaming: { enabled: true, frequency: "0 3 * * *",
                            model: "ollama/qwen2.5:1.5b-instruct" } }
    },
    "active-memory": { config: { model: "ollama/qwen2.5:1.5b-instruct" } }
  }}
}
```

注意：`dreaming.model` **必须**配 `subagent.allowModelOverride: true`，否则不生效（文档明文警告）。

### 14.2 它在这块的工程质量，比我们文档写的更细

三处值得抄：

1. **重写幅度闸**：consolidation 若删掉的既有条目超过某个比例，整次重写被拒；append 压缩只允许删「机器生成的晋升段」。→ 我们的 `01 §8.3` 只写了"不删原件"，没写比例闸。
2. **失败不静默换模型**：只对"模型不可用"重试一次；**信任/allowlist 失败直接降级并留痕，不换模型**。→ 正是我们 `02 §4.3` 那条"静默失效最危险"。
3. **本地/远端策略分明**：显式指定远端 provider 时**不**回退 FTS-only；`provider: "none"` 才是"我就要纯词法"。→ 我们 `02 §9` 的降级策略可以照抄这个区分。

### 14.3 这条发现把我们的范围又砍了一半

既然"本地模型管记忆"已经是内置能力（连 `bge-m3` 都是文档推荐），那**写一个完整的 memory runtime 是过度工程**。修正 `§12` 的结论：

| 方案 | 工作量 | 评价 |
|---|---|---|
| 写完整 memory runtime | 2000+ 行 | ❌ 重造已有的东西（嵌入/固化/dreaming/provenance 全有） |
| **钩子优先** | **500–1000 行** | ✅ **推荐**：用它的 `memory-core`，只补它没有的"形状" |
| 什么都不写，直接用 | 0 | 备选：先按 `15` 跑三十天实验再定 |

**"钩子优先"具体补三件**（都落在它的 hook 上）：

1. `before_prompt_build` —— 拿 `memory_search` 的结果，按**我们的**衰减模型重排（`β` 拉伸指数、四段 `stage`、双阈值滞后、flashback 唤醒），替换掉它的 `recency × importance` 排序，再按简报预算注入。
2. `llm_output` —— cite 一致性与"假记忆"后置检查；不符则按四态 `confidence` 降级改写。
3. `dreaming` 之后 —— 把它的 REM 摘要按我们的自传格式重写一遍（引用当日记忆 id），并写契约层不变量校验。

**这三件事，全部是"在它的时间线上插一段"，不是"替换它的器官"。**

---

## 15. 补：本文没比过的六个面（2026-10-29）

前面比对的是**架构**（记忆形状 / 权限哲学 / 技能生态 / plugins.slots.memory）。
但有三类东西压根没进过这份文档：**模型配置的运维面、UI 与管理面、权重与参数**。重新对了一遍（事实源 `research/oc-llms-full.txt`），结论是：

**它把这三类都做好了，而鲸鲸三条都在缺。**

| 面 | 它有什么 | 鲸鲸的现状 | 该抄哪一半 |
|---|---|---|---|
| **模型配置** | `models` 一整套：providers/profiles/auth/order/status；`models auth logout` 会**清干净所有引用**（空 `auth.order` 会把整家 provider 禁用这个坑它想到了）；本地端点不可达记 `skipped` 并缓存 5 min | 本地角色不在持久层；`auth` 无 `remove`；端点挂了每轮重试 | 抄**清引用纪律** + `skipped` 语义；不抄 profile/order 状态机 |
| **运维面** | catch-up 五条规则（不重放 / 跳过成功轮 / `skipMissedJobs` / 1 个/次 / 2 min 延迟）；配置无效退 **78** | 只有 60 s tick；compose `restart: unless-stopped` 无阀门 | 抄**规格**（D-4）与退出码（D-5） |
| **自主边界** | **standing orders**：范围化的长期授权，注入每个 session | T3 是一次性令牌 → 自主性结构封顶 | 只记录形状（D-3），不放宽 T3 |
| **记忆投毒** | 四道防线：来源不可伪造 / 按层隔离 / **taint 随归并传播** / pre-image 轨迹；“no amount of recall frequency promotes untrusted content” | `taint` 列**零逻辑**，默认 `trusted` | **全抄（D-1）**：结构性排除，不是分数惩罚 |
| **权重与参数** | 有 `index identity` 警告 + `memory index --force`；参数与派生索引分层 | 47 条记忆 `w0` 全 0.55；`kind` 枚举与参数表对不齐；换 embed 会静默变差 | 抄 `index identity`（C-2）；权重本身它也没做好多少，不必拄 |
| **UI 与管理面** | Control UI = 独立 Vite+Solid SPA；光侧栏迭代 **100+ PR**；命令面板 / 骨架屏 / 保留草稿 / 批量 | 1467 行内联 page.ts；无 undo、无批量、无插件/技能入口 | **只抄三条纪律**（Ctrl+K / undo / 列表三件套），**不抄工程形态** |

### 15.1 一条元判断

它这三类东西之所以做得好，是因为它们**都是它产品的主干**（模型可插拔、多平台分发、大量并发用户）。
鲸鲸的用户数是 **1**。**照搬它的功能面 = 把半径拉到 100 倍，收益是 0。**

所以此后的判断句固定为：

> **只抄纪律（清引用 / `skipped` / 结构性排除 / index identity / 不重放），不抄结构（profile / order / cooldown / SPA）。**

详版在 `docs/22` 的 **C（模型配置）/ D（运维与投毒）/ E（权重）/ F（界面）/ G（本地与云端分工）**。
