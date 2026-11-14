# Vendored 前端库（零构建，预构建 UMD）

陪伴视图用 `<script>` 直接加载预构建运行库，不引入 bundler，保持「零构建」。

| 文件 | 包 / 版本 | 许可 | 来源 |
|---|---|---|---|
| `ruic/vendor/mesh-avatar.js` | Mesh Avatar runtime | MIT（© Yuki Shindo） | RuiC-2D `public/vendor/mesh-avatar.js`，许可见同目录 `LICENSE-mesh-avatar.txt` |
| `cubism/pixi.min.js` | pixi.js 6.5.10 | MIT | npm `pixi.js@6` 的 `dist/browser/pixi.min.js` |
| `cubism/pixi-live2d-display.cubism4.min.js` | pixi-live2d-display 0.4.0 | MIT | npm `pixi-live2d-display` 的 `dist/cubism4.min.js`（必须配 PIXI v6） |
| `cubism/live2dcubismcore.min.js` | Live2D Cubism Core | 官方 SDK | Live2D 官方，免费用于个人/小规模；商业分发需遵循 Live2D 许可 |

形象分两种：
- `ruic/`：鲸鱼娘 mesh avatar（rig.json + built/），由 RuiC-2D 用立绘一次性生成，参数驱动口型/眨眼/视线/呼吸。
- 导入的 Live2D 公皮（.model3.json + .moc3 + 贴图）：落在 `<home>/pal/avatars/<id>/`，用 cubism/ 三件套渲染，保留表情/动作/物理。

换形象：设置 · 陪伴里点卡片或导入 zip，前端不用改。
