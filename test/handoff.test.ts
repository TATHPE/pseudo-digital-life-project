import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { remember } from "../src/store.ts";
import { appendEvent, newEventId } from "../src/journal.ts";
import { seedPersona } from "../src/persona.ts";
import { exportHome, verifyExport, importHome, defaultExportDir, INCLUDE } from "../src/handoff.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-handoff-"));

/** 一个"活过一阵"的 home：记忆 + 契约 + inbox + 人格 + 一个文件 */
function livedHome(home: string): void {
  mkdirSync(join(home, "workspace"), { recursive: true });
  mkdirSync(join(home, "inbox"), { recursive: true });
  seedPersona(home);
  const d = openDb(join(home, "memory.db"));
  const t0 = new Date("2026-10-01T10:00:00Z");
  remember(d.db, { layer: "narrative", kind: "episode", text: "杭州三月的天气适合搬家", importance: 4, now: t0 });
  remember(d.db, { layer: "narrative", kind: "episode", text: "两阶段检索先出候选再算向量", importance: 3, now: t0 });
  remember(d.db, { layer: "contract", kind: "promise", text: "不要在工作时段主动打扰", importance: 5, now: t0 });
  d.db.close();
  appendEvent(join(home, "inbox"), { v: 1, id: newEventId(), ts: "2026-10-01T10:00:00Z", kind: "utterance", actor: "user", payload: { text: "要搬家了" } });
  appendEvent(join(home, "inbox"), { v: 1, id: newEventId(), ts: "2026-10-01T10:01:00Z", kind: "agent_reply", actor: "agent", payload: { text: "我记住这个地方了" } });
  writeFileSync(join(home, "workspace", "note.md"), "工作区里的东西也要跟走");
  writeFileSync(join(home, "config.json"), JSON.stringify({ ui: { avatar: "ring" } }));
  // 不该被带走的
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeFileSync(join(home, "secrets", "deepseek.secret"), "DPAPI-CIPHERTEXT");
  mkdirSync(join(home, "tokens"), { recursive: true });
  writeFileSync(join(home, "tokens", "cap_x.json"), "{}");
}

function stats(home: string) {
  const d = openDb(join(home, "memory.db"));
  try {
    return {
      memories: (d.db.prepare("SELECT count(*) c FROM memories WHERE status='active'").get() as any).c as number,
      contracts: (d.db.prepare("SELECT count(*) c FROM memories WHERE layer='contract' AND status='active'").get() as any).c as number,
      texts: (d.db.prepare("SELECT text FROM memories ORDER BY id").all() as any[]).map((r) => r.text).join("|"),
      schema: (d.db.prepare("SELECT value v FROM meta WHERE key='schema_version'").get() as any).v as string,
    };
  } finally { d.db.close(); }
}

test("导出：库是一致快照（单文件、无 -wal），清单带 sha256 与统计", () => {
  const home = H();
  livedHome(home);
  const out = join(H(), "exp");
  const r = exportHome(home, out, new Date("2026-10-28T12:00:00Z"));

  assert.ok(existsSync(join(out, "memory.db")));
  assert.ok(!existsSync(join(out, "memory.db-wal")), "WAL 应被折叠进 memory.db");
  assert.equal(r.manifest.counts.memories, 3);
  assert.equal(r.manifest.counts.contracts, 1);
  assert.equal(r.manifest.files["memory.db"]!.bytes > 0, true);
  assert.ok(r.manifest.files["workspace/note.md"], "工作区要跟走");
  assert.ok(r.manifest.files["persona/core.md"], "人格要跟走");
  assert.ok(r.manifest.files["inbox/" + readdirSync(join(home, "inbox"))[0]!], "inbox 要跟走");

  // secrets / tokens 一定不在
  assert.ok(!Object.keys(r.manifest.files).some((f) => f.startsWith("secrets/")), "secrets 不能出门");
  assert.ok(!Object.keys(r.manifest.files).some((f) => f.startsWith("tokens/")));
  assert.ok(r.manifest.excluded.some((e) => e.path.startsWith("secrets")));

  const v = verifyExport(out);
  assert.equal(v.ok, true, v.problems.join(","));
});

test("搬家三次零差异（记忆/契约/人格/工作区/时间轴都在）", () => {
  const a = H();
  livedHome(a);
  const before = stats(a);
  const personaBefore = readFileSync(join(a, "persona", "core.md"), "utf8");

  let cur = a;
  for (let i = 0; i < 3; i++) {
    const exp = join(H(), `exp${i}`);
    exportHome(cur, exp);
    const next = join(H(), `home${i}`);
    mkdirSync(next, { recursive: true });
    const r = importHome(exp, next, { force: true });
    assert.equal(r.ok, true);
    assert.equal(r.counts.memories, 3);

    const now = stats(next);
    assert.equal(now.memories, before.memories, `第 ${i + 1} 次搬家记忆数变了`);
    assert.equal(now.contracts, before.contracts);
    assert.equal(now.texts, before.texts, "记忆正文必须逐字一致");
    assert.equal(readFileSync(join(next, "persona", "core.md"), "utf8"), personaBefore);
    assert.equal(readFileSync(join(next, "workspace", "note.md"), "utf8"), "工作区里的东西也要跟走");
    cur = next;
  }
  assert.ok(existsSync(join(cur, ".clean_shutdown")), "搬家后第一次启动不该被当成断电");
});

test("导入：缺文件/被改一个字节/清单外文件/路径越界，全部拒收", () => {
  const home = H();
  livedHome(home);
  const exp = join(H(), "exp");
  exportHome(home, exp);

  // ① 改一个字节
  const db = join(exp, "memory.db");
  const buf = readFileSync(db);
  buf[buf.length - 100] = (buf[buf.length - 100]! + 1) % 256;
  writeFileSync(db, buf);
  const v1 = verifyExport(exp);
  assert.equal(v1.ok, false);
  assert.ok(v1.problems.some((p) => p.includes("memory.db")), v1.problems.join(","));
  assert.throws(() => importHome(exp, join(H(), "t1"), { force: true }), /E_EXPORT_CORRUPT/);

  // ② 重新导一份，测"清单外文件"与"路径越界"
  const exp2 = join(H(), "exp2");
  exportHome(home, exp2);
  writeFileSync(join(exp2, "sneaky.txt"), "我没在清单里");
  const v2 = verifyExport(exp2);
  assert.equal(v2.ok, false);
  assert.ok(v2.problems.some((p) => p.includes("sneaky.txt")));
  rmSync(join(exp2, "sneaky.txt"));

  const m = JSON.parse(readFileSync(join(exp2, "manifest.json"), "utf8"));
  m.files["../../escape.txt"] = { sha256: "0".repeat(64), bytes: 1 };
  writeFileSync(join(exp2, "manifest.json"), JSON.stringify(m));
  const v3 = verifyExport(exp2);
  assert.equal(v3.ok, false);
  assert.ok(v3.problems.some((p) => p.includes("越界")), v3.problems.join(","));
});

test("导入：目标非空必须显式 --force，且旧目录被改名备份（不静默覆盖）", () => {
  const home = H();
  livedHome(home);
  const exp = join(H(), "exp");
  exportHome(home, exp);

  const target = join(H(), "target");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "old.txt"), "原来的东西");
  assert.throws(() => importHome(exp, target), /E_TARGET_NOT_EMPTY/);
  // 拒绝的时候不能动人家一针一线
  assert.equal(readFileSync(join(target, "old.txt"), "utf8"), "原来的东西");

  const r = importHome(exp, target, { force: true, now: new Date("2026-10-28T12:00:00Z") });
  assert.match(String(r.backup), /\.bak-/);
  assert.ok(r.backup && existsSync(join(r.backup, "old.txt")), "旧内容应在备份里");
  assert.ok(!existsSync(join(target, "old.txt")), "新 home 是导出内容");
  assert.equal(stats(target).memories, 3);
});

test("导入后补跑：衰减跳一步，权重不会停在导出那一刻", () => {
  const home = H();
  livedHome(home);
  const exp = join(H(), "exp");
  exportHome(home, exp);
  const target = join(H(), "moved");
  mkdirSync(target, { recursive: true });
  importHome(exp, target, { force: true, now: new Date("2026-11-28T12:00:00Z") }); // 一个月后

  const d = openDb(join(target, "memory.db"));
  try {
    const rows = d.db.prepare("SELECT text, weight FROM memories WHERE layer='narrative'").all() as any[];
    assert.ok(rows.length >= 2);
    // 一个月没被提到的叙事记忆应该掉下来了（契约层不衰减）
    assert.ok(rows.every((r) => r.weight < 0.55), JSON.stringify(rows));
    const c = d.db.prepare("SELECT weight FROM memories WHERE layer='contract'").get() as any;
    assert.equal(c.weight, 1);
  } finally { d.db.close(); }
});

test("导出目录默认在 home **之外**（exports/ 同辈），且不会把自己卷进去", () => {
  const home = H();
  livedHome(home);
  const out = defaultExportDir(home, new Date("2026-10-28T12:34:56Z"));
  assert.match(out.split("\\").join("/"), /exports\/2026-10-28-12-34-56$/);
  assert.ok(!out.startsWith(home), "导出目录必须在 home 之外，否则会把自己卷进去");

  const r = exportHome(home, out);
  assert.ok(!Object.keys(r.manifest.files).some((f) => f.startsWith("exports/")), "不该把 exports 自己装进去");
  rmSync(out, { recursive: true, force: true });
  void INCLUDE;
});

test("导出：目录联接/软链一律跳过并记在清单里（红队 #4 的 workspace/up 就是这种）", () => {
  const home = H();
  livedHome(home);
  let made = false;
  try {
    symlinkSync(join(home, ".."), join(home, "workspace", "up"), "junction");
    made = true;
  } catch { /* 平台不允许就只验「不顺着链接拷」这句 */ }

  const out = join(H(), "exp");
  const r = exportHome(home, out);
  if (made) {
    assert.ok(r.skipped.some((s) => s.includes("workspace/up")), `skipped=${JSON.stringify(r.skipped)}`);
    assert.ok(r.manifest.skipped?.some((s) => s.includes("workspace/up")));
    assert.ok(!Object.keys(r.manifest.files).some((f) => f.startsWith("workspace/up/")), "不能顺着联接拷出去");
    assert.ok(!Object.keys(r.manifest.files).some((f) => f.includes("src/")), "仓库源码不该出现在导出里");
  }
  assert.equal(verifyExport(out).ok, true);
});

test("导出：拒绝把导出目录放进 home 里（会自己拷自己），也拒绝非空目标", () => {
  const home = H();
  livedHome(home);
  assert.throws(() => exportHome(home, join(home, "exports", "x")), /E_EXPORT_INSIDE_HOME/);
  assert.throws(() => exportHome(home, home), /E_EXPORT_INSIDE_HOME/);

  const busy = join(H(), "busy");
  mkdirSync(busy, { recursive: true });
  writeFileSync(join(busy, "already.txt"), "上一家的东西");
  assert.throws(() => exportHome(home, busy), /E_EXPORT_DIR_NOT_EMPTY/);
});
