<!-- 自动生成，别在这个文件里改 -->
<!-- 真源：文档仓的 13-模型与API配置方案.md（改完跑 npm run docs:sync） -->
# 模型与 API Key 配置方案

> 版本 v0.2 · 2026-10-27 · 配套：`00 §4`（L0–L4 编队）、`06`（接管与简报）、`11`（MCP/技能）、`02 §4.1`（provisioned 记录）
> 回答两件事：**怎么配**（key 与本地模型放哪、怎么轮换）、**怎么调**（一次任务里谁干什么、失败了怎么办）。

---

## 0. 三条原则

1. **配置里没有秘密，秘密里没有配置。** `config.yaml` 可以进 git；key 只存在于凭据存储；日志与 prompt 里永不出现明文。
2. **按"角色"分配模型，不按"服务商"分配。** 代码里只说 `role: express`，是 Claude 还是本地 4B 由配置决定。这是 `00 §5` "换引擎不换人"的前提。
3. **隐私闸门在代码里，不在提示词里。** `local_only` 的记忆**根本不会**被组装进要发往云端的请求——不是"请忽略"，是"不存在"。

> **配套硬规则（`19 §0.1` W-A）**：凡是**能看到记忆原文**的角色，`kind` 必须是 `local`。
> 目前是 `extract` / `salience` / `route` / **`conflict`**（冲突判定）四个。
> 代码里用 `assertLocalOnly(role, payload)` 守：命中 `local_only` 但角色非 local → 直接抛 `E_PRIVACY`，不降级、不重试。

---

## 1. 三层供给

| 层 | 形态 | 典型用途 | 隐私 |
|---|---|---|---|
| **本地** | Ollama（`127.0.0.1:11434`） | embedding、意图路由、夜间抽取、情绪标定、后置检查 | 不出机 |
| **云端** | HTTPS + API key | 表达（L2）、深度规划（L4）、可选夜间反思 | 只收装配块 |
| **外部 MCP 提供方** | MCP server（`11 §3`） | 第三方能力（搜索、天气、日历） | 结果标 `taint=external` |

---

## 2. 配置文件：无秘密的那一半

`/var/lib/jingjing/config.yaml`（可提交、可 diff、可备份）：

```yaml
version: 1
roles:
  # ── 本地角色 ───────────────────────────────
  embed:
    kind: local
    model: bge-m3            # 或 qwen3-embedding:0.6b-q8
    dim: 1024
    batch: 32
    keep_alive: 30m          # 常驻，避免每次冷启动
  route:                     # L1：意图分类 / 要不要检索（≤32 token 输出）
    kind: local
    model: qwen2.5:1.5b-instruct-q4
    max_tokens: 32
    temperature: 0
    timeout_ms: 800
  extract:                   # L3：夜间抽取 / 归并
    kind: local
    model: qwen2.5:1.5b-instruct-q4
    max_tokens: 800
    timeout_ms: 60000
  salience:                  # 情绪强度与重要性标定
    kind: local
    model: qwen2.5:1.5b-instruct-q4
    max_tokens: 120
  # ── 云端角色 ───────────────────────────────
  express:                   # L2：对话主体
    kind: cloud
    provider: anthropic
    model: claude-sonnet-4-6
    max_tokens: 1024
    cache_prefix: true       # 稳定前缀（06 §3.1）→ 命中缓存 0.1x
    budget: { per_day_usd: 1.50, per_turn_usd: 0.05 }
  plan:                      # L4：周级规划（低频）
    kind: cloud
    provider: anthropic
    model: claude-opus-4-6
    max_tokens: 2048
    budget: { per_week_usd: 0.80 }
  # ── 可选：局域网外借算力（08 §3.3 B 方案）───
  # route:  { kind: local, endpoint: "http://192.168.1.10:11434", model: qwen3:4b-instruct }

privacy:
  allow_cloud_for: [shareable]      # local_only 永不出网
  redact_before_send: true          # 发前再扫一遍邮箱/手机号/路径
budget:
  daily_usd: 2.00
  on_exceed: degrade_to_local       # degrade_to_local | block | notify_only
fallback:
  express: [anthropic, openai, local:qwen3:4b]   # 顺序尝试
```

**为什么 `route`、`extract` 用 1.5B 而不是 4B**：这两个角色的输出很短（≤800 token）、对质量要求低、频率高。1.5B 在 8 GB 卡上约 5–9 tok/s，4B 约 2–4 tok/s——**一次夜间批处理差 3 倍时间**（`08 §1`）。

---

## 3. 秘密：key 放哪、怎么用、怎么换

### 3.1 存储位置（按优先级）

| 平台 | 推荐 | 说明 |
|---|---|---|
| Windows | **DPAPI / Credential Manager**（`cmdkey` 或 PowerShell `ProtectedData`） | 绑定当前用户；进程外不可读 |
| Linux | **libsecret**（`secret-tool`）+ 可选 TPM | 无桌面环境时退化为 0600 文件 |
| 无凭据服务 | `data/secrets/<provider>.secret`（**0600**） | 明确降级，启动时打印警告 |

> 实测（2026-10-27）：Windows 上 `dpapi` 路径产生的是 353 字节密文，`grep` 明文**零命中**；`auth list` 只显示 `(dpapi 受保护)`。
> 也就是说 **key 从不出现在文件、日志、DB 或 argv 里**。

**绝不允许**：写进 SQLite、写进 `config.yaml`、写进 git、写进日志、写进 prompt、写进 `exec_audit` 的 argv。

### 3.2 三个入口（CLI / 面板 / 文件）

| 入口 | 用途 |
|---|---|
| `jingjing auth set <provider>`（stdin） | 首次配置、脚本化 |
| **面板「设置 → 接口」** | 日常改用；`PUT /api/config`，key 走同一个 DPAPI 存储 |
| `data/config.json` | provider / model / baseUrl（**不含 key**） |

面板写入的优先级：**env > `data/config.json` > 内置默认**。key 永远只在凭据存储里，
`GET /api/config` 只回指纹（`sk-3b…6238`），不回显明文。

> 本地面板的写操作要求 `x-jj: 1` 头 + 同源 Origin（`writeGuarded()`）：
> 防的是你浏览的恶意网页偷偷 POST 到 `127.0.0.1:7700` 写 key 或改人格。

### 3.3 命令面（CLI）

```bash
jingjing auth set anthropic        # 交互式输入，不回显、不进 shell history
jingjing auth list                 # 只显示 provider + 指纹前 8 位 + 创建时间
jingjing auth rotate anthropic     # 新 key 验证通过后原子替换；旧 key 保留 24h 兜底
```

实现要点：
- **Windows DPAPI 必须显式 `Add-Type -AssemblyName System.Security`**（PS 5.1 默认不加载，否则报 TypeNotFound）。明文通过**环境变量**传给 PowerShell，不进 argv。
- `set` 从 **stdin 读**（不是 argv，避免 `ps` 泄漏）；读完立刻写凭据存储
- `list` 输出形如 `anthropic  sk-ant-…7f3a  2026-10-27`，**永不全显**
- 首次使用前做一次 **1 token 的探测调用**（验证 key 有效 + 记录模型可用性），失败不写入

### 3.3 key 的最小权限与分账

| 角色 | 建议 |
|---|---|
| `express` / `plan` | 独立的 key，**只开推理权限**（不要开账单/管理权限） |
| 本地模型 | 不需要 key；Ollama 只绑 `127.0.0.1`（`OLLAMA_HOST=127.0.0.1`） |
| MCP 提供方 | 每个 server 一个 key；`trust: external` 的单独记 |
| 测试 | 单独的 key + 硬性日预算，防止 CI 失控 |

**一个 key 只做一件事**：这样吊销时能精确止血，也便于 `02 §4.1` 的 `provisioned` 记录——每个 provider 记 `{provider, model, keyFingerprint, provisionedAt}`，**不记 key 本身**。

---

## 4. 一次任务怎么走（把 L0–L4 串起来）

```
用户输入
  │
  ├─ L0（规则，<5ms）：唤醒词 / 静音判断 / 显式 remember 指令 / 时间差计算
  │     └─ 闲聊短句 → 直接 L1 出话（不检索、不上云）
  │
  ├─ L1 route（本地 1.5B，≤800ms）：要不要检索？要检索什么？
  │     └─ 产出：{ needs_memory: bool, queries: [...], scope }
  │
  ├─ 检索（本地，100ms）：混合召回 + stage 过滤 + confidence 四态（01 §6.2）
  │     └─ 产出：装配块（稳定前缀 + 状态 + 记忆 + cite）
  │
  ├─ 隐私闸门（代码）：删掉所有 local_only 条目 → 若因此空了一切且用户问题依赖它
  │     └─ 改走本地生成（降级），并在回复里声明"这部分我只在本地处理"
  │
  ├─ L2 express（云端）：流式输出
  │     └─ 首字 ≤1.5s（06 §4.2）
  │
  ├─ 后置检查（本地 1.5B）：cite 一致性 / "你之前说过"是否对得上（00 §11）
  │
  └─ 写回（本地）：episode 记忆 + 再巩固 + 用量记账
```

**关键点**：L1 与后置检查**都在本地**，所以"检索决策"和"编造检查"这两件最敏感的事**从不出网**。云端的模型只负责"说得好"。

---

## 5. 失败与降级矩阵

| 情况 | 检测 | 动作 |
|---|---|---|
| 401/403（key 失效） | 响应码 | 切 `fallback.express` 下一个；连续失败 → 降级本地 + 通知用户修 key |
| 429（限流） | 响应码 | 指数退避（1→2→4s，最多 2 次）→ 之后切下一个 provider |
| 超时 > 8s | 计时器 | 先输出"我找一下"（`06 §4.2`），继续等；>20s 降级本地 |
| 内容过滤拒答 | 响应标记 | 一次改写重试（去掉敏感词），仍失败 → 如实告知 |
| 模型下线/改名 | 启动探测 | 启动时 `models.list` 校验，缺失则**拒绝启动并打印差异**（`02 §4.3`） |
| 本地 Ollama 挂了 | 健康检查 | 退回纯 BM25（`02 §9` 降级策略），返回 `degraded:["no_vector"]` |
| 预算超限 | 记账 | `degrade_to_local`：本地出短回复 + 一句话说明 |

**统一要求**：任何降级都要在响应里**显式声明**（`degraded` 字段 + 一句人话），不允许静默变笨。

---

## 6. 成本控制（三个具体手段）

1. **前缀缓存**：`06 §3.1` 的分层让稳定区（~1400 tok）逐字不变 → 缓存读 0.1x。单这一项把每日成本压到 1/5 以下。
2. **角色分层**：把"分类/打标/检查"全放本地 1.5B。按每天 500 次 L1 调用算，本地 0 元 vs 云端约 $0.30–1.20。
3. **预算硬闸**：`per_day_usd` 记账在本地（SQLite `events` 表），超限降级而不是硬失败。

记账格式（每次调用一行）：

```
ts, role, provider, model, in_tokens, cached_tokens, out_tokens, usd, turn_id
```

`cached_tokens` 单独记——否则永远看不出缓存到底有没有生效。

---

## 7. 本地模型的显存预算（8 GB 卡）

| 组合 | 显存 | 可行性 |
|---|---|---|
| `bge-m3`(1.2G) + `1.5B-q4`(1.1G) + 8k ctx(0.4G) | ≈ 2.7 GB | ✅ 常驻 |
| `bge-m3` + `4B-q4`(2.6G) + 8k ctx(1.1G) | ≈ 4.9 GB | ✅ 常驻 |
| `bge-m3` + `4B-q4` + **32k** ctx(4.5G) | ≈ 8.3 GB | ❌ OOM |
| `4B-q4` + `32k`（不加载 embedding） | ≈ 7.1 GB | ⚠️ 需串行 |

结论：**默认 `1.5B` 做 L1/L3，`4B` 仅在需要更强抽取时按需换入**；上下文保持 8k（简报只有 1.5–2k token，`06 §3.1`），不要为了"以防万一"开到 32k。

Ollama 关键参数：

```bash
# 只绑本地，绝不 0.0.0.0（除非显式启用局域网外借，并加防火墙白名单）
OLLAMA_HOST=127.0.0.1:11434
# 模型保活，避免每次冷启动 3–5s
OLLAMA_KEEP_ALIVE=30m
# 并发 1，避免两个模型抢显存
OLLAMA_NUM_PARALLEL=1
```

---

## 8. 安全清单（自查用）

- [ ] `config.yaml` 里没有 key（`grep -ri "sk-\|api_key" config.yaml` 应为空）
- [ ] key 只在凭据存储，且权限 600 / DPAPI 绑定用户
- [ ] 日志与 `exec_audit` 对 key 做脱敏（正则兜底 `sk-[A-Za-z0-9_-]{8,}`）
- [ ] 每个 provider 的 key **只开推理权限**
- [ ] `local_only` 记忆有测试用例：构造一条，验证它从不出现在云端请求体里
- [ ] 启动时做 provider 探测，失败**拒绝启动**而不是静默降级
- [ ] `jingjing auth list` 只显示指纹
- [ ] 预算闸生效：把 `daily_usd` 设为 0.01 跑一轮，应降级而非报错
- [ ] **代码外发按次授权**（2026-10-29 新增维度）：代码与记忆是两种隐私，不能共用一个开关；否则“读项目”会变成绕过 `local_only` 的后门（见 `23 §5.3`）

最后一条是最容易漏、也最能证明"预算真的在管"的测试。

---

## 9. 职责边界与本地模型门槛（2026-10-29 补）

**分工不是“大模型 + 小模型”，是“表达/推理” vs “代谢/判断”。**
对着 `0 §2` 的四条件看，两个模型管的不是同一件事：

| 条件 | 谁在干 | 跟智力有关吗 |
|---|---|---|
| N1 连续性 | 单文件库 + tick 衰减 | **无关**，是代码 |
| N2 自指（改变从前的看法并说清为什么） | **云端** | 有关 |
| N3 代谢（获取 + 丢失） | **本地** | 有关，但只要求**可靠** |
| N4 边界 | 策略 + 容器 | **无关**，是代码 |

> **云端决定“说得好不好”，本地决定“记不记得住、记不记得对”。**

### 9.1 风险不对称（整个判断的枢纽）

- 云端答错 → 当场被发现 → 那轮过去，**除非它被写成记忆**；
- 本地判错 → 写进 `memories` → 可能进 `contract`（**永不衰减**）→ 云端从此**忠实地基于错误前提推理**。

**云端的聪明会放大本地的错误。**

### 9.2 本地模型门槛（按失败后果分级，**不给参数量**）

| 任务 | 门槛 |
|---|---|
| 结构化输出合法 | ≥ 99% |
| 只读工具调用 | ≥ 90%（`smoke-tools` 扩一套只读集） |
| 抽取忠实性 | 100 条人工比对，错误 ≤ 5% |
| 自一致性（同输入两跑一致） | ≥ 90% |
| 冲突判定 | ≥ 85%，且**规则兜底** |
| 有效上下文 | ≥ 16k 有效（装下当天对话 + 已有候选） |
| 夜间吞吐 | 8 小时内消化完当天 |

不及格但只差忠实性/自一致性 → **只能做“提议”，不能做“决定”**：
`本地提议 → 确定性规则过滤 → 生效 + 写 pre-image`。闸门先于模型。

### 9.3 拐点不在参数量

瓶颈是“能看到多少”而非“多聪明”：7B 能看到“已有 3 条相似记忆 + 当天全文”就写不出重复；14B 看不到照样写重复。
**所以 `P0-2`（工具循环）的价值 > 换更大的模型。** 规模判断与完整门槛表见 `docs/22` **G 组**。

### 9.4 配置可管理性（同时补的三条）

本地角色（route/extract/salience/conflict/night/embed）**不在 `FileConfig` 里**，只存在于代码常量 + 进程级 env；`auth` 没有 `remove`；本地端点挂了没有冷却。三条与验收见 `docs/22` **C 组**。

---

## 10. 一句话

**角色化配置（没有秘密） + 凭据存储（没有配置） + 代码里的隐私闸门 + 显式降级。**

四件事做完，"换模型"就是改一行 yaml，"换 provider"就是 `auth set` 一次，而**人格和记忆不动**——这正是 `00 §1` 判据 L5（换引擎不换人）在配置层的落地。
