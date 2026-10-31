# Trianon（第三方，MIT）· 桌面工作台界面

> 出处：https://github.com/qimingjiu/Trianon
> 作者：shuoshuo · 许可：MIT（见同目录 `LICENSE`）· 取用日期：2026-11-01
> 取用方式：**整块搬过来**（`dist/trianon.html` 原样，未改动一行）

## 为什么搬它

我们的内置面板是"给聊的界面"：单列对话 + 记忆卡片，**看不到它干了什么**。
Trianon 把 AI 编程智能体的工作台拆成了该有的形状：

- 右栏「Dossier」三签：**Plan / Changes / Context**
- **审批便条**（要你点头的动作贴成一张便条）
- **校样 diff**（改动像校对稿摊开）
- **回合总结**（一轮干了什么压成一条）
- **引擎状态三态**：启动 / 断线 / 崩溃
- 终端票根、内置浏览器、文件面板与 `@` 引用、搜索、收藏

## 现状（诚实）

| 事实 | 值 |
|---|---|
| 形态 | 单文件 HTML，**10,044,017 字节 / 10,661 行** |
| 数据 | **全是 mock**（示例对话、示例文件树、虚构人名路径） |
| 后端 | 无。它不连任何东西 |
| 视觉 | 洛可可 / 雾蓝银蓝奶白 —— **与我们「黑底白细线 + 青色只给回话气泡」的铁律冲突** |
| 上游构建 | `build.py` + Pillow + fontTools + uharfbuzz（改它需要这套 Python 依赖） |

所以这一步只做一件事：**先让它跑起来、能看、能点**。
- 我们自己的服务通过 `GET /desk` 提供它（同源，不联网）
- 桌面壳的窗口指向 `/desk`
- 它是**离线自包含**的：断网也能打开

## 下一步（还没做）

把 mock 换成真数据。需要接的（都是现成 API）：

| Trianon 的块 | 我们的数据源 |
|---|---|
| 对话 / 工具卡 / 回合总结 | `/api/say`（SSE：`delta` / `tool` / `tool_result` / `notice`） |
| Plan | 简报里的计划槽（P9）+ agenda（惦记） |
| Changes（校样 diff） | `git.diff` / `git.status` 模板（T1，只读） |
| Context | `/api/memories`、`/api/capabilities`、检索依据 |
| 审批便条 | `/api/pending`（已在，`confirm` / `reject`） |
| 引擎状态 | `/health`（`ok` / `degraded`）+ 壳的探测 |
| 搜索 / 文件面板 | `/api/search`、`project.list` / `project.read` |
| 模型选择 | `/api/models` |

## 归属要求（MIT 底线）

- 保留 `LICENSE` 与作者署名（本文件即署名）
- 界面里助手气泡右下角那句很淡的 `for 妁妁 only` 是作者的个人签名 —— **不删**，
  这是她做这套东西的理由，删掉比留着更失礼。
- 我们改动的地方要在 `CHANGES.md` 里记账（还没开始改）
