/**
 * 权限自查（2026-11-10）：这张表的价值在于**照真实链路判**，不是抄一份能力清单。
 * 所以用例重点守三件事：策略真跑了、闸门顺序没写反、结构问题能被查出来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { doctor, exportDiag } from "../src/doctor.ts";
import { permsReport, formatPerms } from "../src/permcheck.ts";
import { ensurePolicy, policyPath, DEFAULT_POLICY } from "../src/policy.ts";
import { verbs } from "../src/verbs.ts";
import { templateCatalog } from "../src/shell.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-perms-"));

test("默认策略下逐 verb 真判：每个能力都有一行，且没有 E_NO_RULE", async () => {
  const home = H();
  const r = await permsReport({ home });
  assert.ok(r.rows.length >= verbs.length, `只探到 ${r.rows.length} 行，能力表有 ${verbs.length} 个`);
  assert.equal(r.summary.total, r.rows.length);
  assert.equal(r.summary.ready + r.summary.confirm + r.summary.grant + r.summary.blocked + r.summary.probe, r.rows.length);
  // 2026-11-10 修：模型看得见 proposal.create，测试却把 policy mock 成恒放行 → 真实调用一直 E_NO_RULE
  assert.equal(r.rows.find((x) => x.base === "proposal.create")?.verdict, "ready", JSON.stringify(r.rows.filter((x) => x.code === "E_NO_RULE")));
  assert.equal(r.issues.length, 0, r.issues.join("；"));

  // shell.run 的档位由模板决定 → 必须逐个模板探，而不是只写一行 T3
  assert.equal(r.rows.filter((x) => x.base === "shell.run").length, templateCatalog().length);
  assert.ok(r.rows.some((x) => x.verb === "shell.run(node.version)" && x.tier === "T0"));
  assert.ok(r.rows.some((x) => x.verb === "shell.run(node.run_script)" && x.tier === "T3"));

  // 会话级状态：CLI 进程里没有窗口，T3 一律停在 checkGrant
  assert.equal(r.rows.find((x) => x.base === "shell.exec")?.verdict, "grant");
  assert.equal(r.rows.find((x) => x.base === "shell.exec")?.code, "E_NO_GRANT");
  // enforce 只有 T2 才拦人，T1 的 enforce 是「留快照」
  assert.equal(r.rows.find((x) => x.base === "msg.notify")?.verdict, "confirm");
  assert.equal(r.rows.find((x) => x.base === "fs.write")?.verdict, "ready");
});

test("人写一条 deny：表上要写明是策略拒绝，不是能力不存在", async () => {
  const home = H();
  ensurePolicy(home);
  writeFileSync(policyPath(home), readFileSync(policyPath(home), "utf8") + "p, deny, T0, time.now, *, enforce\n");
  const r = await permsReport({ home });
  const row = r.rows.find((x) => x.base === "time.now");
  assert.equal(row?.verdict, "blocked");
  assert.equal(row?.code, "E_DENIED");
  assert.match(row?.why ?? "", /策略显式拒绝/);
});

test("老库升级：policy.csv 缺 proposal.create 时，跑一次自查就补上", async () => {
  const home = H();
  ensurePolicy(home);
  const p = policyPath(home);
  const line = "p, allow, T1, proposal.create, *, advise";
  writeFileSync(p, readFileSync(p, "utf8").replace(line + "\n", ""));
  assert.ok(!readFileSync(p, "utf8").includes(line), "先造出缺行的老库");
  await permsReport({ home });
  assert.ok(readFileSync(p, "utf8").includes(line), "ensurePolicy 的 REQUIRED_RULES 必须补上");
  assert.equal((readFileSync(p, "utf8").match(new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1, "不能补成两行");
});

test("历史遗留死规则只进 warnings，不让 --strict 永远红", async () => {
  const home = H();
  const r = await permsReport({ home });
  assert.ok(r.warnings.some((w) => /fs\.move|net\.fetch/.test(w)));
  assert.equal(r.issues.length, 0);
  assert.match(formatPerms(r), /历史遗留/);
});

test("doctor：默认不跑权限表，--perms 才带；导出多一份脱敏的 perms.json", async () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  const plain = await doctor({ db: d.db, home, skipPreflight: true });
  assert.equal(plain.perms, undefined, "默认体检必须保持 <1 s，不拖这段");
  const rep = await doctor({ db: d.db, home, skipPreflight: true, withPerms: true });
  assert.ok(rep.perms && rep.perms.rows.length > 0);
  assert.ok(formatPerms(rep.perms).includes("权限自查"));

  const ex = exportDiag(rep, home, d.db, { note: `sk-abcdefgh12345678 at ${home}` });
  assert.ok(ex.files.includes("perms.json"));
  for (const f of ex.files) {
    const body = readFileSync(join(ex.dir, f), "utf8");
    assert.ok(!body.includes(home), `${f} 里还有绝对 home 路径`);
    assert.ok(!/sk-[A-Za-z0-9_-]{8,}/.test(body), `${f} 里还有明文 key 形状`);
  }
});

test("探针凑不齐参数 ≠ 能力被禁：单列「探针未就绪」", async () => {
  const home = H();   // 空 workspace，T3 模板要的真实脚本不存在
  const r = await permsReport({ home });
  const probes = r.rows.filter((x) => x.verdict === "probe");
  assert.ok(probes.length > 0, "空 home 上至少该有 T3 模板探不齐参数");
  for (const row of probes) {
    assert.equal(row.verdict, "probe");
    assert.ok(!row.why.includes(home), "why 不许倒出本机绝对路径");
    assert.ok(!row.why.includes(String.fromCharCode(10)), "why 必须单行");
  }
  assert.ok(r.summary.probe > 0);
  assert.equal(r.summary.blocked, 0, "空 home 上不该把探针未就绪算成能力不可用");
});

test("默认策略含 proposal.create 且幂等：ensurePolicy 不追加第二行", () => {
  const home = H();
  ensurePolicy(home);
  const before = readFileSync(policyPath(home), "utf8");
  ensurePolicy(home);
  assert.equal(readFileSync(policyPath(home), "utf8"), before);
  assert.ok(DEFAULT_POLICY.includes("p, allow, T1, proposal.create, *, advise"));
});
