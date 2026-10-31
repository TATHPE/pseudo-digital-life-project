import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { doctor, exportDiag, redact } from "../src/doctor.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-doctor-"));

test("D-6 doctor：结构检查（不连网），degraded 只做提示不拦退出", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const rep = await doctor({ db: d.db, home, skipPreflight: true });
  assert.equal(rep.ok, true, JSON.stringify(rep.checks));
  assert.ok(rep.checks.some((c) => c.name === "db" && c.ok));
  assert.ok(rep.checks.some((c) => c.name === "config" && c.ok));
  assert.ok(rep.checks.some((c) => c.name === "index"));
  assert.ok(!rep.degraded.includes("panel-not-serving"), "CLI 语境不该把'面板没在服务'算成缺口");
});

test("D-6 doctor：策略写坏时 config 这一项就红", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  writeFileSync(join(home, "policy.csv"), "p, allow, T9, x, *, enforce\n");
  const rep = await doctor({ db: d.db, home, skipPreflight: true });
  assert.equal(rep.ok, false);
  assert.match(rep.checks.find((c) => c.name === "config")!.detail, /E_POLICY_CORRUPT/);
});

test("D-6 导出脱敏：home 变 <home>、sk- 被抹、不打包 secrets", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const rep = await doctor({ db: d.db, home, skipPreflight: true });
  const ex = exportDiag(rep, home, d.db, { note: `key sk-abcdefgh12345678 at ${home}` });
  assert.ok(ex.bytes > 0);
  for (const f of ex.files) {
    const body = readFileSync(join(ex.dir, f), "utf8");
    assert.ok(!body.includes(home), `${f} 里还有绝对 home 路径`);
    assert.ok(!/sk-[A-Za-z0-9_-]{8,}/.test(body), `${f} 里还有明文 key 形状`);
  }
  assert.ok(!readdirSync(ex.dir).some((f) => f.includes("secret")));
});

test("D-6 redact：两种斜杠都能替换", () => {
  assert.equal(redact("D:\LLM\jingjing\data", "D:\LLM\jingjing\data"), "<home>");
  assert.equal(redact("D:/LLM/data/x", "D:/LLM/data"), "<home>/x");
  assert.equal(redact("sk-1234567890abcdef", "x"), "<redacted-key>");
});
