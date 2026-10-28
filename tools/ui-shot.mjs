/** 截一张面板的图（headless Edge），用来肉眼验收。用法：node tools/ui-shot.mjs [out.png] [w] [h] */
import { spawnSync } from "node:child_process";
const out = (process.argv[2] ?? "tmp/shot.png").split("\\").join("/");
const w = process.argv[3] ?? "1440", h = process.argv[4] ?? "940";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const r = spawnSync(EDGE, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--virtual-time-budget=6000", `--window-size=${w},${h}`,
  `--screenshot=${out}`, "http://127.0.0.1:7700/",
], { stdio: "ignore" });
console.log(r.status === 0 ? `saved ${out}` : `failed (${r.status})`);
