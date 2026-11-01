// 生成桌面图标：**白色圆角方块 + 深色鲸尾**（照 DeepSeek Harness 那个样式）
//
// 为什么要自己画：原来的 icon.png/ico 是 build 时随手出的，不是这个形状；
// 用户明确要"像这样"：浅色圆角底 + 深色 logo，任务栏/桌面一眼认得出来。
//
// 做法：把 page.ts 里那个 #whale symbol 的 path 抽出来，塞进一个 SVG，
// 用 Edge headless 截成 1024 PNG，再用 Pillow 缩放并写 ICO（多尺寸）。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ICONS = join(ROOT, "desktop", "src-tauri", "icons");
const TMP = join(ROOT, "tmp", "icon-build");
mkdirSync(TMP, { recursive: true });
mkdirSync(ICONS, { recursive: true });

const PAGE = readFileSync(join(ROOT, "src", "web", "page.ts"), "utf8");
const m = PAGE.match(/<symbol id="whale" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/);
if (!m) throw new Error("在 page.ts 里找不到 #whale symbol");
const body = m[2];
const pathMatch = body.match(/d="([^"]+)"/);
if (!pathMatch) throw new Error("whale symbol 里没有 path d=");
const d = pathMatch[1];

// 白底圆角方块 + 深色鲸尾。留 18% 内边距（图标太满在小尺寸下会糊）。
const R = 512 * 0.22;              // 圆角半径（≈ iOS/macOS 的比例）
const PAD = 512 * 0.18;
const scale = (512 - PAD * 2) / 512;
const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512">',
  '<defs><clipPath id="r"><rect x="0" y="0" width="512" height="512" rx="' + R + '" ry="' + R + '"/></clipPath></defs>',
  '<rect x="0" y="0" width="512" height="512" rx="' + R + '" ry="' + R + '" fill="#f5f6f8"/>',
  '<g clip-path="url(#r)">',
  '<g transform="translate(' + PAD + ',' + PAD + ') scale(' + scale + ')" fill="#1b1d21">',
  '<path d="' + d + '"/>',
  "</g></g></svg>",
].join("");

const svgPath = join(TMP, "icon.svg");
writeFileSync(svgPath, svg, "utf8");

// 用 Edge headless 截图（本机有，且不引入新依赖）
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const png1024 = join(TMP, "icon-1024.png");
const profile = join(TMP, "edge-profile");
const r = spawnSync(EDGE, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--user-data-dir=${profile}`, "--window-size=1024,1024",
  `--screenshot=${png1024}`, `file:///${svgPath.replace(/\\/g, "/")}`,
], { stdio: "ignore", timeout: 60_000 });
if (!existsSync(png1024)) throw new Error("截图失败（Edge headless）：" + (r.error?.message ?? ""));

// 用 Pillow 缩放出各尺寸并写 ICO
const py = [
  "import sys",
  "from PIL import Image",
  `src = sys.argv[1]; out_ico = sys.argv[2]; out_png = sys.argv[3]`,
  "im = Image.open(src).convert('RGBA')",
  "im = im.resize((512, 512), Image.LANCZOS)",
  "im.save(out_png)",
  "im.save(out_ico, sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])",
  "print('ok')",
].join("\n");
const pyPath = join(TMP, "mk.py");
writeFileSync(pyPath, py, "utf8");
const icoPath = join(ICONS, "icon.ico");
const pngPath = join(ICONS, "icon.png");
const p = spawnSync("D:/LLM/.venv/Scripts/python.exe", [pyPath, png1024, icoPath, pngPath], { encoding: "utf8" });
if (p.status !== 0) throw new Error("Pillow 失败：" + (p.stderr || p.stdout || "").slice(0, 400));

console.log("图标已生成：");
console.log("  " + icoPath);
console.log("  " + pngPath);
