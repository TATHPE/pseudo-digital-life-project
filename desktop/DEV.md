# 开发测试版（桌面那份直读源码，不打包）

> 2026-11-14 23:31 重建。**唯一形态就是桌面应用本身**：双击桌面图标，Tauri 窗口照常弹出，
> 但它跑的是仓库 `src/`。不用浏览器、不用新启动器、不用重新打 NSIS 包。
> 正式发布包仍由 `npm run desktop:build` 生成。

**不挂任何后台服务**：这个方案只是磁盘上的一个目录链接，不新增进程、不新增端口、不新增计划任务。
只有双击图标时，壳才像正式版一样拉起它自己的 node sidecar；关掉应用，进程就一起退。
浏览器直连 / `cargo tauri dev` 启动器（含 `--watch`）已按用户要求整体删除，不要再加回来。

## 本机当前配置（2026-11-14 23:31 生效）

| 项 | 值 |
|---|---|
| 测试版目录 | `D:\Apps\PDLP` |
| 链接 | `D:\Apps\PDLP\app\src` → `D:\LLM\jingjing\src`（Windows 目录 junction，全目录**仅此一处**链接） |
| 壳的 exe | `D:\Apps\PDLP\jingjing-desktop.exe`，**2026-11-14 21:45 最新编译**（8,582,144 B，sha256 `a04293e3…`），含启动可靠性修复与 P2/C 组壳逻辑 |
| 运行时 | `D:\Apps\PDLP\node\node.exe`（Node `v24.21.0`） |
| 其它载荷 | `app/persona`、`app/node_modules`、`app/package*.json`、`app/bundle-manifest.json` 来自 `desktop/bundle-src/app` 快照 |
| 卸载器 | **刻意不放 `uninstall.exe`** —— 本版不是 NSIS 安装的，没有卸载器就不会误点后沿 junction 递归删源码 |
| 数据目录 | 外部 `D:\Pseudo Digital Life Project\data`，由 `%APPDATA%\life.pseudolife.desktop\where.json` 指向；**不随测试版目录变动** |
| 桌面快捷方式 | `C:\Users\Fez\Desktop\Pseudo Digital Life Project.lnk` → `D:\Apps\PDLP\jingjing-desktop.exe`（**原有的，未改动**；重建同路径后自动复活） |

原理：壳的 `bundled_app_dir()` 只检查 `<resource_dir>/app/src/cli/jingjing.ts` 是否存在；junction 让这个文件仍在，
壳就把 `JJ_PROJECT_ROOT` 指向 `D:\Apps\PDLP\app`、`JJ_NODE` 指向 `D:\Apps\PDLP\node\node.exe`，
而 `app/src` 实际是仓库源码。**最新编译的 exe 已支持 `JJ_PROJECT_ROOT` / `JJ_NODE` 显式优先**（`main.rs:239-245`），
所以将来也可以不改目录、只用环境变量指到别处。

检查链接是否还在（**别用 Python 的 `is_symlink()`**，它不认 junction，会误报 False）：

```powershell
Get-Item 'D:\Apps\PDLP\app\src' -Force | Select-Object LinkType, Target
```

## 改了什么，怎么生效

| 改的文件 | 生效方式 |
|---|---|
| `src/web/ui/*.js` 等静态资源 | **在应用里刷新页面即可**（服务端每次读盘 + `cache-control: no-store`） |
| `src/**/*.ts`（路由、检索、简报…） | **关掉应用再双击图标重开**：壳不会监视文件变化，这点无法在不重编译 exe 的前提下改 |
| `persona/`、配置 | 重启应用；注意 `app/persona` 仍是打包快照，没做链接 |
| `desktop/src-tauri/src/*.rs` | 只有它能改壳行为，需要重新编译并替换 exe，不属于「不打包」范围 |

## 三条风险

1. **删除目录前必须先解除 junction**：任何递归删除（`Remove-Item -Recurse`、NSIS 卸载器、资源管理器直接删且系统跟进链接时）
   都可能顺着 `app/src` 把仓库 `D:\LLM\jingjing\src` 一起删掉。删除姿势见下节，先跑只读守卫：
   `npm run uninstall:guard -- "D:\Apps\PDLP"`（退出码 1 就是先别动）。策略见 `../docs/ops/26-更新与卸载策略.md`。
2. **数据目录仍是真实的**：双击图标不带 `JJ_HOME`，壳走 `install_home()` → `where.json` → 真实记忆库。
   改代码试功能会写真实数据，别在测试时乱删记忆。
3. **覆盖安装 / 重装会把链接冲回快照**：之后要重新做一次 junction（用 `New-Item -ItemType Junction`）。

## 删除 / 重建测试版的正确姿势

删除（2026-11-14 实测通过，仓库源码 170 文件前后不变）：

```powershell
# 1) 只读检查
npm run uninstall:guard -- "D:\Apps\PDLP"
# 2) 只摘链接本身，绝不递归 —— 目标目录不受影响
[System.IO.Directory]::Delete('D:\Apps\PDLP\app\src')
# 3) 验证仓库源码完好，再把整个目录移入回收站（不要直接 rm）
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
  'D:\Apps\PDLP',
  [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
  [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
```

重建（本次用的就是这套，全部来自仓库现有产物，不重新打包）：

```bash
cd /d/LLM/jingjing
mkdir -p "/d/Apps/PDLP/app" "/d/Apps/PDLP/node"
cp -f desktop/src-tauri/target/release/jingjing-desktop.exe "/d/Apps/PDLP/"
cp -r desktop/bundle-src/app/node_modules desktop/bundle-src/app/persona "/d/Apps/PDLP/app/"
cp -f desktop/bundle-src/app/package*.json desktop/bundle-src/app/bundle-manifest.json "/d/Apps/PDLP/app/"
cp -f desktop/bundle-src/node/node.exe "/d/Apps/PDLP/node/"
```
```powershell
New-Item -ItemType Junction -Path 'D:\Apps\PDLP\app\src' -Target 'D:\LLM\jingjing\src'
```

## 已知限制

- 发布快照已自动化：Tauri 构建前跑 `tools/sync-desktop.ts --if-needed`，快照已一致就跳过，不产生千文件旧快照
  （2026-11-14 修复，见 `tools/sync-desktop.ts` 的 `syncIfNeeded`）。
- 后端 `.ts` 改动需要重启应用，不是「保存即热更新」；这是「不挂后台服务」的必然代价。
- `app/persona`、`app/package.json`、`app/node_modules` 仍是打包快照；新增 npm 依赖不会自动可见。
- 本版**没有卸载器**，开始菜单 / 「应用和功能」里不会出现卸载项；要清理就按上面的删除姿势手工处理。

## 验证口径（2026-11-14 23:31 实测）

- exe 与 `desktop/src-tauri/target/release/jingjing-desktop.exe` 的 SHA-256 逐字一致；`node.exe --version` = `v24.21.0`。
- `LinkType=Junction`，`Target=D:\LLM\jingjing\src`，经链接可见 170 个文件、仓库侧也是 170；`app/src/cli/jingjing.ts` 存在（壳的判据）。
- 内置 Node 跑 `--experimental-strip-types --check app/src/cli/jingjing.ts` 通过。
- 全目录扫描只有 1 个 reparse point；桌面 `.lnk` 的目标 `D:\Apps\PDLP\jingjing-desktop.exe` 存在。
- `where.json` 仍指向 `D:\Pseudo Digital Life Project`，真实数据目录完好未动。
- **没有实际双击启动 GUI 窗口**（避免干扰桌面）；壳的导航逻辑未改动。
