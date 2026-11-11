# 开发测试版（桌面那份直读源码，不打包）

> 2026-11-11。**主用形态就是已安装的桌面应用本身**：双击桌面图标，Tauri 窗口照常弹出，
> 但它跑的是仓库 `src/`。不用浏览器、不用新启动器、不用重新打 NSIS 包。
> 正式发布包仍由 `npm run desktop:build` 生成。

## 本机当前配置（已生效）

| 项 | 值 |
|---|---|
| 安装目录 | `D:\Apps\PDLP` |
| 链接 | `D:\Apps\PDLP\app\src` → `D:\LLM\jingjing\src`（Windows 目录 junction） |
| 原快照 | `D:\Apps\PDLP\app\src.release-20261111`（129 文件，完整保留） |
| 额外备份 | `D:\Apps\PDLP\app\src.backup-20261111`（129 文件，复制备份） |
| 壳的 exe | `jingjing-desktop.exe`（11-10 18:46 构建，**未改动**） |
| 运行时 | `D:\Apps\PDLP\node\node.exe`（Node `v24.21.0`，**未改动**） |

原理：壳的 `bundled_app_dir()` 只检查 `app/src/cli/jingjing.ts` 是否存在；链接让这个文件仍在，
所以壳照旧把 `JJ_PROJECT_ROOT` 指向 `D:\Apps\PDLP\app`，但 `app/src` 实际是仓库源码。
exe、node、桌面快捷方式、一次性令牌机制全部不动。

检查链接是否还在（**别用 Python 的 `is_symlink()`**，它不认 junction，会误报 False）：

```powershell
Get-Item 'D:\Apps\PDLP\app\src' | Select-Object LinkType, Target
```

## 改了什么，怎么生效

| 改的文件 | 生效方式 |
|---|---|
| `src/web/ui/*.js` 等静态资源 | **在应用里刷新页面即可**（服务端每次读盘 + `cache-control: no-store`） |
| `src/**/*.ts`（路由、检索、简报…） | **关掉应用再双击图标重开**：安装版壳 spawn 的 node 不带 `--watch`，这点无法在不重编译 exe 的前提下改 |
| `persona/`、配置 | 重启应用；注意 `app/persona` 仍是安装版快照，没做链接 |
| `desktop/src-tauri/src/*.rs` | 只有它能改壳行为，需要重新编译并替换 exe，不属于「不打包」范围 |

## 三条风险

1. **卸载器可能沿链接递归删到仓库 `src`**：NSIS 按文件清单卸载，junction 会被当成普通目录。
   仓库在 git 里可恢复、两份快照也在，但**卸载前务必先按下面回滚成实体目录**。
2. **数据目录仍是真实的**：双击图标不带 `JJ_HOME`，壳走 `install_home()` → Roaming 里的真实记忆库。
   改代码试功能会写真实数据，别在测试时乱删记忆。
3. **覆盖安装 / 重装会把链接冲回快照**：之后要重新做一次链接。

## 回滚成正式版（零删除，纯改名）

```powershell
Rename-Item -LiteralPath 'D:\Apps\PDLP\app\src' -NewName 'src.test-link'
Rename-Item -LiteralPath 'D:\Apps\PDLP\app\src.release-20261111' -NewName 'src'
```

再切回测试版，把两步反过来即可。**不要用 `Remove-Item -Recurse` 删 junction** ——
PowerShell 5.1 会沿链接把仓库源码删掉；纯改名最安全，两份备份也始终留着。

## 备用：命令行启动器（不是主用方式）

`npm run dev:test` / `npm run desktop:dev:test` 是同日先做的一版通用启动器，读仓库源码、隔离数据、
可选 `--watch`；**主用桌面那份时不需要它们**，保留作备用或无安装环境时用。
参数：`-- --no-open` / `-- --port=7800` / `-- --home=tmp/my-home` / `-- --no-watch`。
浏览器形态用 `JJ_NO_DESK_TOKEN=1` 关掉桌面令牌闸门、只绑 `127.0.0.1`；没有 Tauri 壳，
DPAPI 云端密钥读不到，走本地 Ollama。

`desktop/src-tauri/src/main.rs` 里那条「显式 `JJ_PROJECT_ROOT` / `JJ_NODE` 优先」只对**新编译的 exe** 生效；
当前安装的 exe 是旧逻辑，所以本机方案用的是目录链接而不是环境变量。

## 已知限制

- `desktop/bundle-src/` 手工快照的**发布链路自动化仍未做**；正式发版前还得手工同步再打 NSIS。
- 后端 `.ts` 改动需要重启应用，不是「保存即热更新」。
- `app/persona`、`app/package.json`、`app/node_modules` 仍是安装版内容；新增 npm 依赖不会自动可见。

## 验证口径（2026-11-11 实测）

- `LinkType=Junction`，`realpath = D:\LLM\jingjing\src`，壳判据 `app/src/cli/jingjing.ts` 存在。
- 仓库里新建探针文件 → 安装版路径立刻可见；删除后同步消失（129 文件、1,419,365 字节，备份逐字一致）。
- 用安装版 `node.exe` 从 `app/` 跑 `src/cli/jingjing.ts serve 7799`：启动正常、无 Node 22 警告，
  `/health` = `ok:true / schema 12`。
- 仓库 `src/web/ui/` 临时放一个 `.js` → 安装版启动的服务返回 200 且 `cache-control: no-store`，
  证明它读的确实是仓库文件。
- 没有实际双击图标弹窗口（避免干扰）；壳的导航逻辑未改动。
