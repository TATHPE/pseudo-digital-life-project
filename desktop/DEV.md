# 开发测试版（不打包、直接改源码）

> 2026-11-11 新增。给「改一行代码就想看到效果」用的形态，**不是发布物**。
> 正式安装包仍由 `npm run desktop:build` 生成，两者互不干扰。

## 为什么需要它

正式包把 `src/`、`persona/`、`package.json` 拷进 `desktop/bundle-src/app`（手工快照，且被 `.gitignore` 排除），
再连同 `node.exe` 打进 NSIS。改了仓库源码 → 要同步快照 → 重新 `cargo tauri build` → 重装，才能看到。
测试版把这条链整段跳过：**进程直接读仓库 `src/`**。

## 两种形态

| 命令 | 形态 | 编译 | 说明 |
|---|---|---|---|
| `npm run dev:test` | 浏览器窗口 | **零编译** | 直连 `http://127.0.0.1:7799/`，最快 |
| `npm run desktop:dev:test` | Tauri 原生窗口 | 首次增量编译 Rust | 和正式版一样的窗口 / 托盘，之后不再打包 |

两者都：读仓库 `src/`、数据隔离在 `data2test/`、只绑 `127.0.0.1`。

参数跟在 `--` 后面：

```
npm run dev:test -- --no-open             # 不自动开浏览器
npm run dev:test -- --port=7800           # 换端口
npm run dev:test -- --home=tmp/my-home    # 换测试数据目录（相对项目根）
npm run dev:test -- --no-watch            # 关掉后端自动重启
```

## 改了什么，怎么生效

| 改的文件 | 生效方式 |
|---|---|
| `src/web/ui/*.js` 等静态资源 | **刷新浏览器即可**：服务端每次请求读盘 + `cache-control: no-store` |
| `src/**/*.ts`（路由、检索、简报…） | `--watch` 自动重启 node，重启完刷新页面 |
| `desktop/src-tauri/src/*.rs` | 仅桌面形态：重新跑 `npm run desktop:dev:test`（增量编译，不是打 NSIS 包） |
| `persona/`、配置文件 | 刷新或重启，取决于读它的模块 |

## 三条边界

1. **数据隔离**：`JJ_HOME` 默认指向 `data2test/`（已被 `.gitignore` 排除），不碰 `data/`、不碰 Roaming
   里的真实用户数据。
2. **只在本机**：`JJ_BIND=127.0.0.1` 写死。浏览器形态用 `JJ_NO_DESK_TOKEN=1` 关掉「只有桌面端」的
   一次性令牌闸门 —— **这是本地回环专用的开发开关**，不要配 `0.0.0.0`，也不要用这个形态对外提供服务。
   桌面形态保留令牌，壳照常从 `.desk.json` 读。
3. **不碰已安装版**：这两个命令都不写 `D:\Apps\PDLP`、不写 `desktop/bundle-src/`。正式包该怎么打还怎么打。

## 运行时

项目 `engines` 要求 **Node >= 24**（`node:sqlite` 在 22 仍是实验性）。启动器会自动探测：
`JJ_NODE` → `C:\Program Files\nodejs\node.exe` → `desktop/bundle-src/node/node.exe` → 当前 node，
挑第一个 ≥24 的；找不到就报错退出。桌面形态还会把 `~/.cargo/bin` 加进 PATH，以便 `cargo` 找到 `cargo-tauri`。

`desktop/src-tauri/src/main.rs` 里加了一条：**调用方显式设了 `JJ_PROJECT_ROOT` / `JJ_NODE` 时，
不再用包内快照覆盖**。正式安装包不设这两个变量，行为不变。

## 已知限制

- 浏览器形态没有 Tauri 壳，因此 **DPAPI 解密的云端密钥读不到**，云端模型不可用；本地 Ollama（含 embed）正常。
  测试 home 是全新配置，要用本地模型先配一次：
  `JJ_HOME=data2test node --experimental-strip-types src/cli/jingjing.ts models use qwen2.5:7b-instruct`
- 测试 home 是空库，首次打开会进引导页（`/welcome`）。
- 桌面形态首次仍要编译 Rust（几秒到几分钟，取决于缓存）；这跟「每次改 TS 都重打包 NSIS」不是一回事。
- `desktop/bundle-src/` 手工快照**仍然没有自动化**，正式发版前还得手工同步。测试版只是让开发态绕开它。

## 验证口径（2026-11-11）

`npm run dev:test` 实测：首页与 `/health` 均返回 200，`/health` 为 `ok:true / schema 12`，
`/ui/notebook.js` 返回 200 且带 `cache-control: no-store`。
