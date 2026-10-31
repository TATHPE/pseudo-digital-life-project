# 桌面壳（H-6）· 最小可跑

> 基座：`dieharders/example-tauri-v2-python-server-sidecar`（Apache-2.0）——
> 它已经把「拉起本地服务 → 关窗杀进程」做对了，155 行 Rust。
> 我们只改三件事：sidecar 换 Node、窗口指向内置面板、加托盘/回落。

## 目录

```
desktop/
├─ README.md               ← 你正在看
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ build.rs
│  ├─ tauri.conf.json      ← 窗口直接指 http://127.0.0.1:7700（**不打包前端**）
│  ├─ capabilities/default.json
│  ├─ icons/               ← 放一张 512×512 png 即可，`tauri icon` 生成全套
│  └─ src/
│     ├─ main.rs           ← 全部逻辑（约 200 行）
│     └─ sidecar.rs        ← 拉起 / 探测 / 杀掉（壳只做这四件事）
```

## 它只做四件事（`docs/23 §2.4`）

1. **拉起 Node sidecar**：`node src/cli/jingjing.ts serve 7700`（开发）/ 打包后跑内置的 node 二进制
2. **健康探测**：`GET /health` 不通 → 重启 → **三次失败 → 打开系统浏览器**（逃逸，记忆不丢）
3. **托盘**：暂停/继续心跳 · 打开数据目录 · 导出备份 · 退出
4. **诊断**：崩溃写包（`tauri-plugin-dialog` 给「复制诊断信息」）

**一行业务逻辑都没有。** 删掉壳，`jingjing serve 7700` 仍提供全部能力。

## 构建前置（这台机器**还没有**）

| 需要 | 现状 | 说明 |
|---|---|---|
| Rust **msvc** 工具链 | 只有 `stable-x86_64-pc-windows-gnu` | Tauri 要求 msvc：`rustup toolchain install stable-msvc` |
| MSVC 链接器 | **没装**（无 Visual Studio / Build Tools） | 要装 VS Build Tools 的「使用 C++ 的桌面开发」（约 4–6 GB） |
| WebView2 运行时 | 系统自带（Win11） | 无需处理 |

装完这两样再 `npm run desktop:dev`。**在此之前**，`npm run desktop:check`
可以验壳与 sidecar 的**契约**（拉起 / 探测 / 关掉），不依赖 Rust。

## 与用户面/操作面的关系

| 面 | 谁的 | 管什么 |
|---|---|---|
| 内置面板（`src/web/page.ts`） | 用户 / 鲸鲸 | 记忆、权限、人格、首次配置 |
| **本壳的窗口** | 用户 | 就是上面那个面板，装进原生窗口 |
| pi-web | **不用了**（用户 2026-10-31 决定） | — |
