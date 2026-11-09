/**
 * ensurePolicy 的幂等性（2026-11-09 修）：
 * 旧实现拿 "shell.run-T0" 这类键去全文 includes，而 CSV 里写的是
 * `p, allow, T0, shell.run, ...`，永远匹配不上 → 每次启动追加两行；
 * 且补行时用未升级的 cur 写回，会把 fs.* 的语义升级冲掉。
 * 这里的用例守的是「策略文件可以被修好，但绝不能被启动过程改写坏」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePolicy, policyPath, modelPath, DEFAULT_POLICY, loadPolicy } from "../src/policy.ts";

const NL = String.fromCharCode(10);
const H = () => mkdtempSync(join(tmpdir(), "jj-policy-"));
const read = (home: string) => readFileSync(policyPath(home), "utf8");
const rows = (home: string) => read(home).split(NL).map((l) => l.trim()).filter((l) => l.startsWith("p,"));
const count = (home: string, line: string) => rows(home).filter((r) => r === line).length;

const SHELL_T0 = "p, allow, T0, shell.run, shell:*, advise";
const SHELL_T1 = "p, allow, T1, shell.run, shell:*, advise";

test("全新 home：生成默认策略与 model，必需规则各恰好一行", () => {
  const home = H();
  assert.equal(ensurePolicy(home), policyPath(home));
  assert.ok(existsSync(modelPath(home)), "model 也要落盘");
  const expected = DEFAULT_POLICY.split(NL).filter((l) => l.trim().startsWith("p,")).length;
  assert.equal(rows(home).length, expected);
  for (const line of [SHELL_T0, SHELL_T1, "p, allow, T3, shell.exec, shell:exec, enforce",
    "p, allow, T3, script.run, script:*, enforce", "p, allow, T1, git.status, *, advise"]) {
    assert.equal(count(home, line), 1, `缺或多：${line}`);
  }
});

test("回归：重复调用 ensurePolicy 内容逐字不变（旧实现每次追加两行）", () => {
  const home = H();
  ensurePolicy(home);
  const before = read(home);
  ensurePolicy(home);
  ensurePolicy(home);
  ensurePolicy(home);
  assert.equal(read(home), before);
  assert.equal(count(home, SHELL_T0), 1);
  assert.equal(count(home, SHELL_T1), 1);
});

test("历史脏数据：完全重复的策略行被去重，注释与人写的 deny 原样保留", () => {
  const home = H();
  const mine = "p, deny, T2, my.danger, *, enforce";
  writeFileSync(policyPath(home), DEFAULT_POLICY + Array(50).fill(SHELL_T0).join(NL) + NL + mine + NL);
  assert.ok(rows(home).length > 70, "先造出确实很脏的文件");
  ensurePolicy(home);
  assert.equal(count(home, SHELL_T0), 1, "重复行只保留首次出现");
  assert.equal(count(home, mine), 1, "人写的 deny 不能被删");
  assert.ok(read(home).includes("# eft, tier, verb, target, strength"), "注释不能丢");
  const after = read(home);
  ensurePolicy(home);
  assert.equal(read(home), after, "收敛之后再调用必须幂等");
});

test("升级与补齐同时发生：fs.* 放宽结果不再被原始内容冲掉", () => {
  const home = H();
  const legacy = DEFAULT_POLICY
    .replace("p, allow, T1, fs.write, *, enforce", "p, allow, T1, fs.write, workspace/*, enforce")
    .replace("p, allow, T1, git.status, *, advise" + NL, "");
  writeFileSync(policyPath(home), legacy);
  ensurePolicy(home);
  assert.equal(count(home, "p, allow, T1, fs.write, *, enforce"), 1, "升级后的 target 要留下来");
  assert.equal(count(home, "p, allow, T1, fs.write, workspace/*, enforce"), 0);
  assert.equal(count(home, "p, allow, T1, git.status, *, advise"), 1, "缺的规则要补回");
});

test("人写的 deny 视为该 (tier, verb) 已有，不许追加 allow 去覆盖", () => {
  const home = H();
  const deny = "p, deny, T0, shell.run, shell:*, enforce";
  writeFileSync(policyPath(home), DEFAULT_POLICY.replace(SHELL_T0, deny));
  ensurePolicy(home);
  assert.equal(count(home, deny), 1);
  assert.equal(count(home, SHELL_T0), 0);
});

test("策略文件读不出来时仍不抛，model 照常生成", () => {
  const home = H();
  mkdirSync(policyPath(home));   // 用目录顶替文件，readFileSync 会抛，必须被 catch 兜住
  assert.doesNotThrow(() => ensurePolicy(home));
  assert.ok(existsSync(modelPath(home)));
});

test("收敛后的策略仍能被 casbin 加载，授权语义不变", async () => {
  const home = H();
  writeFileSync(policyPath(home), DEFAULT_POLICY + Array(30).fill(SHELL_T0).join(NL) + NL);
  const policy = await loadPolicy(home);
  assert.equal((await policy.authorize("fs.read", "T0", "docs/a.md")).allow, true);
  const t4 = await policy.authorize("shell.admin", "T4", "any");
  assert.equal(t4.allow, false);
  assert.equal(t4.reason, "E_DENIED");
  assert.equal((await policy.authorize("net.fetch", "T2", "https://x")).strength, "enforce");
});
