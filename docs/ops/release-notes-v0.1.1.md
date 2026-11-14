# v0.1.1 发布说明

> 构建日期：2026-11-10 · 目标平台：Windows x64 · 标识符：`life.pseudolife.desktop`
> 本文件补齐于 2026-11-14（`docs/ops/23` §1.4 早就引用了它，此前一直缺失）。

## 这一版是什么

第一个**可安装**的桌面版：把 `jingjing serve` 装进一个原生窗口，双击图标就能用，
不用开终端、不用手动起服务。壳只做四件事——拉起 sidecar、健康探测、托盘、退出时杀进程树；
业务全在 Node 侧，删掉壳 `jingjing serve 7700` 仍提供全部能力。

| 项 | 值 |
|---|---|
| 安装包 | NSIS，`Pseudo Digital Life Project_0.1.1_x64-setup.exe` |
| 运行时 | 内置 Node **v24.21.0**（`engines: >=24`，不用系统 Node） |
| 数据目录 | 默认 `D:\Pseudo Digital Life Project\data`，**在安装目录之外** |
| 密钥 | Windows DPAPI 加密，换机器解不开 |
| 更新 | **不做静默自动更新**，见 `docs/ops/26-更新与卸载策略.md` |

## 装之前 / 装之后

1. 安装路径**不能带空格**（`docs/ops/23` §1.5 踩过）。
2. 首次打开会走四步引导；跳过引导后，只有本机装了对话模型才能说话。
3. 想确认自己装的是哪版：打开面板访问 `/api/version`，会返回版本、Node、平台与更新策略。
4. 卸载不会删数据目录；但**卸载前请先跑一次** `npm run uninstall:guard -- "<安装目录>"`，
   它会检查有没有 junction（开发测试版会把 `app/src` 链到仓库，NSIS 可能沿链接递归删源码）。

## 校验安装包

发布方在构建完成后生成清单：

```bash
npm run release:check                 # 六处版本号 + 发布说明 + 快照无链接
npm run desktop:build -- --bundles nsis
npm run release:manifest              # 扫描 NSIS 产物，写出 release.json（SHA-256 + 大小）
```

拿到安装包的一方：

```bash
npm run release:verify -- release.json
```

哈希或大小对不上就**别装**，重新下载。清单只是一份可核对的元数据，客户端不会自动打开它、
也不会自动下载任何东西。

## 已知边界（如实列出）

- 开机冷启动偶发「找不到服务」：84 次启动里 2 次失败，第二次点开正常。
  根因是外部 MCP 冷加载卡住启动关键路径 + 壳超时后误杀进程，**已在源码里修好，
  但尚未打进这个安装包**（见 `CHANGELOG.md` 的 Unreleased）。
- 难用例 20 条里 17 条正确；「该拒答却答了」还剩 2 条，属本地模型校准边界。
- `memory.db` 是明文 SQLite；密钥用 DPAPI 封着。
- WSL 能力没有真机验收；Linux CI 流水线未跑过（改动尚未推送）。
- 没有自动更新、没有系统集成（除托盘）、单机单人。

## 从源码到这个包

完整步骤见 `docs/ops/23-发布-桌面端-首次配置.md` §1.5：改六处版本号 →
`desktop:sync` → `desktop:sync:check` → 构建 → 装一遍再验 → 生成发布说明与清单。
