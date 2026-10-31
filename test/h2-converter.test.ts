import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToMarkdown } from "../src/ingest.ts";
import { resolvePython, resolvePythonCached, _resetPyProbe, converterStatus, warmConverter } from "../src/pyenv.ts";
import { openDb } from "../src/db.ts";
import { capabilities } from "../src/capabilities.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-h2-"));
/** 一个"明确指定了但用不了"的解释器：模拟没装 Python 的机器 */
const BROKEN: Record<string, string | undefined> = { JJ_PYTHON: "C:/definitely/not/python.exe" };

test("H-2 markitdown 可选：没有 Python 时 .md / .txt 照用", () => {
  const home = H();
  const md = join(home, "note.md");
  writeFileSync(md, "# 标题" + String.fromCharCode(10) + "正文", "utf8");
  const txt = join(home, "note.txt");
  writeFileSync(txt, "纯文本", "utf8");

  const a = convertToMarkdown(md, BROKEN);
  assert.equal(a.converter, "passthrough", "md 不该走 Python");
  assert.match(a.markdown, /正文/);
  assert.equal(convertToMarkdown(txt, BROKEN).converter, "passthrough");
});

test("H-2 没有 Python 时 PDF 给**可读降级**，不是一句 E_NO_PYTHON", () => {
  const home = H();
  const pdf = join(home, "doc.pdf");
  writeFileSync(pdf, "%PDF-1.4 fake", "utf8");
  let err = "";
  try { convertToMarkdown(pdf, BROKEN); } catch (e) { err = String((e as Error).message); }
  assert.match(err, /E_NO_CONVERTER/, "要有专门的错误码");
  assert.match(err, /\.md/, "要说清哪些格式还能用");
  assert.match(err, /pip install markitdown/, "要给出照做就能好的补救办法");
});

test("H-2 converterStatus：没有转换器时 available=false 且带 hint", async () => {
  const saved = process.env.JJ_PYTHON;
  try {
    process.env.JJ_PYTHON = "C:/definitely/not/python.exe";
    _resetPyProbe();
    assert.equal(resolvePython(), null, "指定了但用不了 → null（不偷偷换别的解释器）");
    await warmConverter();
    const st = converterStatus();
    assert.equal(st.available, false);
    assert.ok(st.passthrough.includes(".md"));
    assert.ok(st.needsPython.includes(".pdf"));
    assert.ok(String(st.hint).includes("markitdown"));
  } finally {
    if (saved === undefined) delete process.env.JJ_PYTHON; else process.env.JJ_PYTHON = saved;
    _resetPyProbe();
  }
});

test("H-2 探测有缓存：同一进程里第二次不再 spawn", () => {
  _resetPyProbe();
  const a = resolvePythonCached();
  const t0 = performance.now();
  const b = resolvePythonCached();
  const ms = performance.now() - t0;
  assert.deepEqual(a, b);
  assert.ok(ms < 20, `第二次应当走缓存，实测 ${ms.toFixed(1)}ms`);
});

test("H-2 能力表里能看见转换器状态（而不是等人 ingest 了才发现）", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const saved = process.env.JJ_PYTHON;
  try {
    process.env.JJ_PYTHON = "C:/definitely/not/python.exe";
    _resetPyProbe();
    const c = await capabilities({ db: d.db, home });
    assert.ok(c.converter, "capabilities 要带 converter 字段");
    assert.equal(c.converter?.available, false);
    assert.ok(c.degraded.includes("converter-unavailable"), "要进 degraded：" + c.degraded.join(","));
    assert.ok(c.notes.some((n) => /PDF/.test(n)), "notes 里要说明哪些格式受影响");
  } finally {
    if (saved === undefined) delete process.env.JJ_PYTHON; else process.env.JJ_PYTHON = saved;
    _resetPyProbe();
  }
});
