# 桌面壳（H-6）· 最小可跑

> 基座：`dieharders/example-tauri-v2-python-server-sidecar`（Apache-2.0）——
> 它已经把「拉起本地服务 → 关窗杀进程」做对了，155 行 Rust。
> 我们只改三件事：sidecar 换 Node、窗口指向内置面板（带一次性令牌）、加托盘。
> 2026-11-01 起：**真崩了只弹报错**（不回落浏览器、不做自修）；只是启动慢则一直等。

## 目录

```
desktop/
├─ README.md               ← 你正在看
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ build.rs
│  ├─ tauri.conf.json      ← 首帧指 assets/index.html（黑底预热页），就绪后带令牌导航
│  ├─ capabilities/default.json
│  ├─ icons/               ← 放一张 512×512 png 即可，`tauri icon` 生成全套
│  └─ src/
│     ├─ main.rs           ← 启动握手 / 托盘 / 错误页
│     └─ sidecar.rs        ← 拉起 / 持续探测 / 杀进程树 / 日志落盘
```

## 它只做四件事（`docs/23 §2.4`）

1. **拉起 Node sidecar**：`serve 0`（端口由 OS 分配），打包后跑内置的 node 二进制
2. **持续探测**：读 `data/.desk.json` 拿端口 + 令牌，TCP 能连才换页；**只区分「慢」和「子进程真退了」**。
   慢就一直等（冷开机十几秒也照等，8 秒给提示、30 秒给排障页但继续等、5 分钟兜底），
   真失败才把窗口换成错误页 —— 不回落浏览器、不自修
3. **托盘**：暂停/继续心跳 · 打开数据目录 · 导出备份 · 退出
4. **诊断**：壳写 `data/logs/shell.log`，sidecar 的 stdout/stderr 写 `data/logs/serve.log`
   （每次启动把上一份轮转成 `serve.prev.log`）

**启动硬规则**：sidecar 句柄必须**先**交给全局状态再探测 —— 否则失败分支的
`Drop → stop() → taskkill /T /F` 会把刚要监听的 node 杀掉（2026-11-14「开机第一次点必弹
『找不到服务』、第二次才正常」的根因）。

**一行业务逻辑都没有。** 删掉壳，`jingjing serve 7700` 仍提供全部能力。

## 构建前置（2026-11-14 复核：本机已具备）

| 需要 | 现状 | 说明 |
|---|---|---|
| Rust **msvc** 工具链 | ✅ `stable-x86_64-pc-windows-msvc` | 在 `%USERPROFILE%\.cargo\bin`，不一定在 PATH |
| MSVC 链接器 | ✅ 可用 | `cargo test` 已成功链接 |
| WebView2 运行时 | 系统自带（Win11） | 无需处理 |

复核命令（Git Bash）：

```
PATH="/c/Users/Fez/.cargo/bin:$PATH" cargo check --manifest-path desktop/src-tauri/Cargo.toml
PATH="/c/Users/Fez/.cargo/bin:$PATH" cargo test   --manifest-path desktop/src-tauri/Cargo.toml
npm run desktop:check        # 壳与 sidecar 的契约（拉起 / 探测 / 关掉），不依赖 Rust
```

`npm run desktop:dev` / `npm run desktop:build` 由此可跑。改了 Rust 源码后，
**必须重建 exe 才会生效**（安装版 `jingjing-desktop.exe` 是编译产物）；只改 `app/src/*.ts`
则桌面端直读源码，重开软件即可。

## 与用户面/操作面的关系

| 面 | 谁的 | 管什么 |
|---|---|---|
| 面板（`src/web/page.ts`） | 用户 / **她** | 记忆、权限、人格、首次配置（引导页 `/welcome`） |
| **本壳的窗口** | 用户 | 就是上面那个面板，装进原生窗口 |
| pi-web | **不用了**（用户 2026-10-31 决定） | — |
| Trianon | **已删除**（2026-11-01）：只抄了它的信息架构 | — |

## 名字的两层（别搞混）

- **项目名 = Pseudo Digital Life Project**：`tauri.conf.json` 的 `productName`、窗口 `title`、页面 `<title>`。
- **她的名字 = 用户取的**：`config.json` 的 `agent.name`，默认是**预置人格**「鲸鲸」。设置 → 「AGENT · 她的名字」可改。
- 仓库目录 `jingjing`、Cargo 包名 `jingjing-desktop` 是历史遗留，不是产品名。

## 只有桌面端（2026-11-01）

sidecar 绑**随机端口** + 一次性令牌（`data/.desk.json`），壳读到后导航 `/?k=<token>`；
没令牌的页面请求一律 403 —— 所以**浏览器知道端口也打不开**。
子进程真退了就**把窗口换成错误页**（不回落浏览器）；只是启动慢则持续等待，就绪后自动进入。
