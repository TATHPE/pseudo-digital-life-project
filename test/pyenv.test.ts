import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolvePython, pythonHint } from "../src/pyenv.ts";

// 只测"选择顺序"，真的 spawn 用注入的 canImport 代替
const rig = (opts: { env?: Record<string, string>; files?: string[]; ok?: string[]; roots?: string[] }) => {
  const files = new Set(opts.files ?? []);
  const ok = new Set(opts.ok ?? []);
  return resolvePython({
    env: opts.env ?? {},
    exists: (p) => files.has(p),
    canImport: (cmd) => ok.has(cmd),
    roots: opts.roots ?? ["/proj"],
  });
};

test("H-1 JJ_PYTHON 优先；但它不可用时不偷偷换别的解释器", () => {
  // 显式指定且可用
  assert.deepEqual(
    rig({ env: { JJ_PYTHON: "C:/py/python.exe" }, files: ["C:/py/python.exe"], ok: ["C:/py/python.exe"] }),
    { cmd: "C:/py/python.exe", args: [], source: "JJ_PYTHON" },
  );
  // 显式指定但不可用 → null（绝不静默回落到别的 python，否则"我指定了却没生效"更难查）
  assert.equal(rig({ env: { JJ_PYTHON: "C:/py/broken.exe" }, files: ["C:/py/broken.exe"], ok: [] }), null);
});

test("H-1 没有 JJ_PYTHON 时用项目 venv（两种平台路径都认）", () => {
  const winPy = join("/proj", ".venv", "Scripts", "python.exe");
  assert.equal(rig({ files: [winPy], ok: [winPy] })?.cmd, winPy);
  assert.equal(rig({ files: [winPy], ok: [winPy] })?.source, "venv");
  const posixPy = join("/proj", ".venv", "bin", "python");
  assert.equal(rig({ files: [posixPy], ok: [posixPy] })?.source, "venv");
});

test("H-1 都没有就报 null（md/txt 不需要 python，不该阻塞）", () => {
  assert.equal(rig({}), null);
  assert.match(pythonHint(), /markitdown/);
  assert.match(pythonHint(), /JJ_PYTHON/);
});

test("H-1 旧的写死路径必须消失（防回潮）", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/ingest.ts", "utf8");
  assert.ok(!src.includes("D:/LLM/.venv"), "ingest.ts 里不能再有写死的 venv 路径");
  assert.ok(!src.includes("D:\\LLM\\.venv"), "反斜杠写法也不许");
});
