/** 截一张面板的图（headless Edge），用来肉眼验收。
 *  用法：node tools/ui-shot.mjs [out.png] [url] [w] [h]
 *  url 省略就截 127.0.0.1:7700（也兼容旧写法 [out] [w] [h]） */
import { spawnSync } from "node:child_process";
const out = (process.argv[2] ?? "tmp/shot.png").split("\\").join("/");
let rest = process.argv.slice(3);
let url = "http://127.0.0.1:7700/";
if (rest[0] && (rest[0].startsWith("http") || rest[0].startsWith("file:"))) url = rest.shift();
const w = rest[0] ?? "1440", h = rest[1] ?? "940";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const r = spawnSync(EDGE, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  `--user-data-dir=${process.env.TEMP || "/tmp"}/jj-edge-${Date.now()}`, "--hide-scrollbars",
  "--virtual-time-budget=6000", `--window-size=${w},${h}`,
  `--screenshot=${out}`, url,
], { stdio: "ignore" });
console.log(r.status === 0 ? `saved ${out} (${url})` : `failed (${r.status})`);
