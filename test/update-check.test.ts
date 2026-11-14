/**
 * /api/update-check 与设置页「版本与更新 / 复制诊断摘要」的测试（2026-11-14）。
 * 守住 docs/ops/26 §1：只读 GET，不联网 / 不下载 / 不安装 / 不写数据目录。
 * HTTP 用例走现有骨架 createWebServer，用 releaseRoot 指向临时目录，三种清单状态都能确定复现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { appVersion, checkLocalUpdate, UPDATE_POLICY, type ReleaseManifest } from "../src/release.ts";
import { createWebServer } from "../src/web/server.ts";
import { openDb } from "../src/db.ts";

const NO_MANIFEST = "没有本地发布清单";
const POLICY_CN = "人工校验覆盖安装，不会自动更新";

const tmp = () => mkdtempSync(join(tmpdir(), "jj-upcheck-"));

/** 造一个必比当前版本高的三段 semver（当前版本不是 semver 时退回一个够大的值）。 */
function newerVersion(current: string): string {
  const p = current.split(".").map(Number);
  if (p.length === 3 && p.every(Number.isFinite)) return `${p[0]}.${p[1]}.${(p[2] ?? 0) + 1}`;
  return "999.0.0";
}

/** 一份「有新版」的清单：带 notes / 下载地址 / 产物哈希，供前端纯文本展示。 */
function newerManifest(current: string): ReleaseManifest {
  return {
    version: newerVersion(current),
    releasedAt: "2026-11-14T00:00:00.000Z",
    minNode: ">=24",
    changelog: "CHANGELOG.md",
    notes: "修了开机启动",
    downloadUrl: "https://example.invalid/jj.exe",
    artifacts: [{ name: "jj.exe", sha256: "a".repeat(64), size: 123 }],
  };
}

const putManifest = (dir: string, manifest: unknown) =>
  writeFileSync(join(dir, "release.json"), JSON.stringify(manifest), "utf8");

const clean = (dir: string) => rmSync(dir, { recursive: true, force: true });

// fetch 规范禁用了一批端口（web.test.ts 里踩过），listen(0) 撞上就重来。
const BLOCKED_PORTS = new Set([0, 6665, 6666, 6667, 6668, 6669, 10080]);

async function listenSafe(srv: { listen(p: number, h: string, cb: () => void): unknown; address(): unknown; close(cb: () => void): unknown }): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    await new Promise<void>((r) => { srv.listen(0, "127.0.0.1", () => r()); });
    const port = (srv.address() as AddressInfo).port;
    if (!BLOCKED_PORTS.has(port)) return port;
    await new Promise<void>((r) => { srv.close(() => r()); });
    if (attempt > 8) throw new Error(`E_BAD_PORT: 连续撞到禁用端口 ${port}`);
  }
}

/** 起一台真服务，把 release.json 的查找根目录指到临时目录（不碰仓库根目录）。 */
async function start(releaseRoot: string) {
  const dir = tmp();
  const d = openDb(join(dir, "m.db"));
  const srv = createWebServer({
    db: d.db, inboxDir: join(dir, "inbox"), home: dir, releaseRoot,
    getTransport: () => { throw new Error("测试不该真调模型"); },
    getEmbedder: () => null,
    getConfig: () => ({ ollama: "", roles: { express: { provider: "deepseek", model: "x" } } }),
  });
  const port = await listenSafe(srv);
  return { srv, base: `http://127.0.0.1:${port}` };
}

/* ── 纯函数：checkLocalUpdate(root) ───────────────────────────── */

test("checkLocalUpdate：无 release.json → hasUpdate:false + 中文说明", () => {
  const root = tmp();
  try {
    const r = checkLocalUpdate(root);
    assert.equal(r.hasUpdate, false);
    assert.equal(r.notice, NO_MANIFEST);
    assert.equal(r.current, appVersion());
    assert.equal(r.policy, UPDATE_POLICY);
    assert.equal(r.notes, "");
    assert.equal(r.downloadUrl, null);
    assert.equal(r.sha256, null);
  } finally { clean(root); }
});

test("checkLocalUpdate：有新版清单 → hasUpdate:true，给出去哪下 + 哈希，不带说明", () => {
  const root = tmp();
  try {
    const mf = newerManifest(appVersion());
    putManifest(root, mf);
    const r = checkLocalUpdate(root);
    assert.equal(r.hasUpdate, true);
    assert.equal(r.notice, null);
    assert.equal(r.current, appVersion());
    assert.equal(r.latest, mf.version);
    assert.equal(r.policy, UPDATE_POLICY);
    assert.equal(r.notes, "修了开机启动");
    assert.equal(r.downloadUrl, "https://example.invalid/jj.exe");
    assert.equal(r.sha256, "a".repeat(64));
  } finally { clean(root); }
});

test("checkLocalUpdate：坏清单（JSON 解析失败 / version 非法）都降级", () => {
  const root = tmp();
  try {
    writeFileSync(join(root, "release.json"), "{ 坏的 json", "utf8");
    const a = checkLocalUpdate(root);
    assert.equal(a.hasUpdate, false);
    assert.equal(a.notice, NO_MANIFEST);

    writeFileSync(join(root, "release.json"), JSON.stringify({ version: "not-a-version", notes: "x" }), "utf8");
    const b = checkLocalUpdate(root);
    assert.equal(b.hasUpdate, false);
    assert.equal(b.notice, NO_MANIFEST);
  } finally { clean(root); }
});

test("checkLocalUpdate：清单正常但已最新 → hasUpdate:false 且 notice 为 null（不误报没清单）", () => {
  const root = tmp();
  try {
    putManifest(root, { ...newerManifest(appVersion()), version: appVersion() });
    const r = checkLocalUpdate(root);
    assert.equal(r.hasUpdate, false);
    assert.equal(r.notice, null);
    assert.equal(r.downloadUrl, null);
  } finally { clean(root); }
});

test("checkLocalUpdate 只读：不写文件、不改动清单", () => {
  const root = tmp();
  try {
    const body = JSON.stringify(newerManifest(appVersion()));
    writeFileSync(join(root, "release.json"), body, "utf8");
    checkLocalUpdate(root);
    assert.deepEqual(readdirSync(root).sort(), ["release.json"]);
    assert.equal(readFileSync(join(root, "release.json"), "utf8"), body);
  } finally { clean(root); }
});

/* ── HTTP：GET /api/update-check ──────────────────────────────── */

test("GET /api/update-check：无 release.json → 200 + hasUpdate:false + 中文说明", async () => {
  const root = tmp();
  const { srv, base } = await start(root);
  try {
    const r = await fetch(`${base}/api/update-check`);
    assert.equal(r.status, 200);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j.hasUpdate, false);
    assert.equal(j.notice, NO_MANIFEST);
    assert.equal(j.current, appVersion());
    assert.equal(j.policy, "manual-verified");
    assert.equal(j.notes, "");
    assert.equal(j.downloadUrl, null);
    assert.equal(j.sha256, null);
  } finally { srv.close(); clean(root); }
});

test("GET /api/update-check：有新版清单 → 200 + notes / downloadUrl / sha256 齐全", async () => {
  const root = tmp();
  const mf = newerManifest(appVersion());
  putManifest(root, mf);
  const { srv, base } = await start(root);
  try {
    const r = await fetch(`${base}/api/update-check`);
    assert.equal(r.status, 200);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j.hasUpdate, true);
    assert.equal(j.notice, null);
    assert.equal(j.latest, mf.version);
    assert.equal(j.notes, "修了开机启动");
    assert.equal(j.downloadUrl, "https://example.invalid/jj.exe");
    assert.equal(j.sha256, "a".repeat(64));
    // 响应只给信息，不夹带任何"自动下载 / 安装"的动作字段
    assert.equal(j.install, undefined);
    assert.equal(j.download, undefined);
  } finally { srv.close(); clean(root); }
});

test("GET /api/update-check：坏清单 → 200 + hasUpdate:false + 中文说明", async () => {
  const root = tmp();
  writeFileSync(join(root, "release.json"), "不是 JSON", "utf8");
  const { srv, base } = await start(root);
  try {
    const r = await fetch(`${base}/api/update-check`);
    assert.equal(r.status, 200);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j.hasUpdate, false);
    assert.equal(j.notice, NO_MANIFEST);
  } finally { srv.close(); clean(root); }
});

test("GET /api/update-check 是只读端点：非 GET 不命中", async () => {
  const root = tmp();
  const { srv, base } = await start(root);
  try {
    const r = await fetch(`${base}/api/update-check`, { method: "POST", headers: { "x-jj": "1" } });
    assert.notEqual(r.status, 200, "POST 不该命中 /api/update-check");
  } finally { srv.close(); clean(root); }
});

test("既有 GET /api/version 未被破坏：版本来自 package.json、策略是人工校验", async () => {
  const root = tmp();
  const { srv, base } = await start(root);
  try {
    const r = await fetch(`${base}/api/version`);
    assert.equal(r.status, 200);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j.version, appVersion());
    assert.equal(j.updatePolicy, "manual-verified");
    assert.match(String(j.node), /^v\d+/);
  } finally { srv.close(); clean(root); }
});

/* ── 设置页接线与「只展示」约束 ───────────────────────────────── */

test("设置页接线：版本与更新卡片 / 检查更新 / 复制诊断摘要，且下载地址只作文本", () => {
  const js = readFileSync(new URL("../src/web/ui/notebook.js", import.meta.url), "utf8");
  const tpl = readFileSync(new URL("../src/web/notebook.ts", import.meta.url), "utf8");
  const st = readFileSync(new URL("../src/web/routes/status.ts", import.meta.url), "utf8");

  // 卡片数据来自 /api/version，不硬编码版本号；策略翻成中文人话
  assert.ok(js.includes("'/api/version'"), "设置页要读 /api/version");
  assert.ok(js.includes("html += sec('版本与更新'"), "要有版本与更新卡片");
  assert.ok(js.includes('id="cf-upcheck"'), "要有检查更新按钮");
  assert.ok(js.includes("'/api/update-check'"), "检查更新要读新端点");
  assert.ok(js.includes(POLICY_CN), "manual-verified 要显示为中文");
  assert.ok(js.includes('id="cf-diagcopy"'), "要有复制诊断摘要按钮");
  assert.ok(js.includes("fetch('/health')"), "诊断摘要要读健康端点");
  assert.ok(js.includes("navigator.clipboard") && js.includes("execCommand('copy')"), "剪贴板要有兜底与成功/失败提示");
  assert.ok(tpl.includes("#cf-upout"), "长哈希要能换行");

  // 只展示：下载地址是纯文本，不给链接 / 下载按钮 / 打开窗口 / 安装动作
  assert.ok(!/href=['"][^'"]*downloadUrl/.test(js), "downloadUrl 不能变成 <a href> 下载链接");
  assert.ok(!js.includes("window.open("), "不能自动打开下载地址");
  assert.ok(!/location\.(href|assign|replace)\s*=/.test(js), "不能跳转到下载地址");

  // 端点只读：路由块里只有 checkLocalUpdate，没有任何联网 / 写文件 / 装动作
  const at = st.indexOf('if (req.method === "GET" && url.pathname === "/api/update-check")');
  assert.ok(at >= 0, "要找得到 /api/update-check 路由");
  const block = st.slice(at, at + 300);
  assert.ok(block.includes('req.method === "GET"'), "只认 GET");
  assert.ok(block.includes("checkLocalUpdate"), "走纯函数");
  for (const bad of ["fetch(", "createWriteStream", "writeFile", "execFile", "exec(", "spawn("]) {
    assert.ok(!block.includes(bad), `端点不该出现 ${bad}`);
  }
});
