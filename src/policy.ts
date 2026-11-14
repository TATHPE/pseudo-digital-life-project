/**
 * 策略层（04 §4 / 12 §9.2）：唯一有权说"不"的地方。
 *
 * 用 casbin 是为了把"档位 × 强度 × 路径/目标"写成**数据**（policy.csv），
 * 而不是散在代码里的 if-else——改一条策略就是改一行 CSV，可 diff、可审计。
 *
 * 三个已踩过的坑（12 §9.2 记录）：
 *  ① 自定义函数收不到 r / p 数组，只能传标量字段
 *  ② enforceEx 回传的是整行数组，按位置取值
 *  ③ 内置 keyMatch3 对裸 `*` 会抛异常 → 自己实现 glob
 */
import { newEnforcer, type Enforcer } from "casbin";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";
import type { Tier } from "./types.ts";

export type Strength = "advise" | "enforce";

const MODEL = `
[request_definition]
r = verb, tier, target

[policy_definition]
p = eft, tier, verb, target, strength

[policy_effect]
e = some(where (p.eft == allow)) && !some(where (p.eft == deny))

[matchers]
m = (p.tier == "*" || p.tier == r.tier) && (p.verb == "*" || p.verb == r.verb) && globOk(r.target, p.target)
`;

/** 默认策略：T0/T1 放行（advise），T2 强制确认（enforce），T3 强制，T4 恒拒 */
export const DEFAULT_POLICY = `# eft, tier, verb, target, strength
p, deny, T4, *, *, enforce
p, allow, T0, *, *, advise
p, allow, T1, fs.write, *, enforce
p, allow, T1, fs.mkdir, *, enforce
p, allow, T1, fs.move, *, enforce
p, allow, T1, fs.trash, *, enforce
p, allow, T1, fs.restore, *, enforce
p, allow, T0, time.now, *, advise
p, allow, T0, memory.search, *, advise
p, allow, T1, memory.remember, *, advise
# 提案（提一个想法等你看）：工具表里早就有，测试却把 policy mock 成恒放行，
# 于是「T1 没有通配 allow」这件事一直没暴露 —— doctor --perms 查出真实调用会 E_NO_RULE。
p, allow, T1, proposal.create, *, advise
p, allow, T2, msg.notify, *, enforce
p, allow, T2, mcp__*, *, advise
p, allow, T2, net.fetch, *, enforce
p, allow, T0, project.read, *, advise
p, allow, T0, project.list, *, advise
p, allow, T0, project.search, *, advise
# git 校样：只读（status / diff / log），argv 写死，模型给不了参数
p, allow, T1, git.status, *, advise
p, allow, T1, git.diff, *, advise
p, allow, T0, git.log, *, advise
# 技能：只读
p, allow, T0, skill.list, *, advise
p, allow, T0, skill.read, *, advise
p, allow, T0, shell.templates, *, advise
# 只读模板（git.status / node --version 这类 T0/T1）直接跑：argv 写死在 shell.ts 里，没有参数槽，
# 本来就是"看"。只写 T3 一行的时候，这类模板全被 E_NO_RULE 挡住（钩子与 jingjing shell 都踩到）。
p, allow, T0, shell.run, shell:*, advise
p, allow, T1, shell.run, shell:*, advise
# T3：只能走注册过的模板（target 是 shell:<template>），且每次要一次性令牌
p, allow, T3, shell.run, shell:*, enforce
# 任意 argv：只有「完全权限」窗口能把它跑起来（见 src/grant.ts）
p, allow, T3, shell.exec, shell:exec, enforce
# 跑脚本文件（解释器由 config.host.shell 决定：默认 PowerShell，可换 pwsh / Git Bash）
p, allow, T3, script.run, script:*, enforce
# WSL 之手（2026-11-12）：她自己的 Linux 小房子。自主开关在 config.wsl.autonomous（人开），
# 闸门见 grant.ts；硬禁区与快照见 wsl.ts。
p, allow, T3, wsl.exec, wsl:*, enforce
p, allow, T0, wsl.status, *, advise
# 眼（2026-11-12）：截图 + 视觉理解（屏幕默认只走本地，云闸在 config.vision.cloudEnabled）
p, allow, T1, screen.capture, *, advise
p, allow, T1, vision.see, *, advise
# 自我更新接回路（2026-11-12）：她自己提技能草稿 / 冒烟后上岗（A/B 槽可回滚）
p, allow, T1, skill.propose, *, advise
p, allow, T1, skill.promote, *, enforce
`;

export function policyPath(home: string): string { return join(home, "policy.csv"); }
export function modelPath(home: string): string { return join(home, "policy.model.conf"); }

/** 模型与策略都落盘：casbin 的 newEnforcer 只接受「文件路径 / 适配器」，不接受内存 Model + 路径混搭 */
/**
 * 老库升级时要补的行。**单一事实源就是这一行本身**，不再另写「检测键」：
 * 以前键写成 "shell.run-T0"，而 CSV 里是 `p, allow, T0, shell.run, ...`，
 * includes 永远为假 → 每次启动都追加两行（实测 policy.csv 涨到 447 行 / 421 条 shell.run）。
 */
const REQUIRED_RULES: readonly string[] = [
  "p, allow, T3, shell.exec, shell:exec, enforce",
  "p, allow, T3, script.run, script:*, enforce",
  "p, allow, T1, proposal.create, *, advise",
  "p, allow, T0, shell.run, shell:*, advise",
  "p, allow, T1, shell.run, shell:*, advise",
  "p, allow, T1, git.status, *, advise",
  "p, allow, T1, git.diff, *, advise",
  "p, allow, T0, git.log, *, advise",
  "p, allow, T0, skill.list, *, advise",
  "p, allow, T0, skill.read, *, advise",
  "p, allow, T3, wsl.exec, wsl:*, enforce",
  "p, allow, T0, wsl.status, *, advise",
  "p, allow, T1, screen.capture, *, advise",
  "p, allow, T1, vision.see, *, advise",
  "p, allow, T1, skill.propose, *, advise",
  "p, allow, T1, skill.promote, *, enforce",
];

/** 解析一条 casbin 策略行；注释 / 空行 / 列数不足的行返回 null */
function policyKey(line: string): { tier: string; verb: string } | null {
  const t = line.trim();
  if (!t.startsWith("p,")) return null;
  const cols = t.slice(2).split(",").map((x) => x.trim());
  if (cols.length < 3) return null;
  return { tier: cols[1]!, verb: cols[2]! };
}

export function ensurePolicy(home: string): string {
  mkdirSync(home, { recursive: true });
  const p = policyPath(home);
  if (!existsSync(p)) {
    atomicWriteFile(p, DEFAULT_POLICY);
  } else {
    try {
      const cur = readFileSync(p, "utf8");
      // ① 语义升级（2026-10-31）：fs.* 从 workspace/* 放宽到 *（记忆核心由 coreguard 挡）
      const upgraded = cur.replace(
        /^p, allow, T1, (fs\.(?:write|mkdir|move|trash)), workspace\/\*, enforce$/gm,
        "p, allow, T1, $1, *, enforce",
      );
      // ② 收敛历史脏数据：只去掉**完全相同**的策略行，保留首次出现顺序；
      //    注释、空行原样保留，人写的 deny / 改过 target 的规则一律不动。
      const seen = new Set<string>();
      const deduped = upgraded.split(String.fromCharCode(10)).filter((line) => {
        const t = line.trim();
        if (!t.startsWith("p,")) return true;
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      }).join(String.fromCharCode(10));
      // ③ 按 (tier, verb) 判断是否已存在，而不是拿键去全文 includes。
      //    不看 eft：人写了 deny 也算「这条已有」，绝不追加一条 allow 去覆盖它。
      const have = new Set<string>();
      for (const line of deduped.split(String.fromCharCode(10))) {
        const k = policyKey(line);
        if (k) have.add(`${k.tier}\u0000${k.verb}`);
      }
      const missing = REQUIRED_RULES.filter((line) => {
        const k = policyKey(line);
        return k !== null && !have.has(`${k.tier}\u0000${k.verb}`);
      });
      // 全部改写都基于 upgraded → deduped 这条链，不再拿原始 cur 写回（那会丢掉 ① 的升级）。
      const body = deduped.replace(/\n+$/, "");
      const next = body + (missing.length ? String.fromCharCode(10) + missing.join(String.fromCharCode(10)) : "") + String.fromCharCode(10);
      if (next !== cur) atomicWriteFile(p, next);   // 内容相同就不写，保证幂等
    } catch { /* 补不上就按原样，不阻塞启动 */ }
  }
  const m = modelPath(home);
  if (!existsSync(m)) atomicWriteFile(m, MODEL);
  return p;
}

/** 简单 glob：`*` 通配，其余字面比较（不引入额外依赖，也不受 keyMatch3 的裸 `*` 问题影响） */
export function globOk(target: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const parts = pattern.split("*");
  if (parts.length === 1) return target === pattern;
  let i = 0;
  for (let k = 0; k < parts.length; k++) {
    const seg = parts[k]!;
    if (seg === "") { if (k === parts.length - 1) return true; continue; }
    if (k === 0) { if (!target.startsWith(seg)) return false; i = seg.length; continue; }
    const at = target.indexOf(seg, i);
    if (at < 0) return false;
    i = at + seg.length;
  }
  return pattern.endsWith("*") || target.endsWith(parts[parts.length - 1]!);
}

export interface AuthResult {
  allow: boolean;
  strength: Strength | null;
  rule: string[] | null;
  reason?: string;
}

export interface Policy {
  authorize(verb: string, tier: Tier, target: string): Promise<AuthResult>;
  reload(): Promise<void>;
}

export async function loadPolicy(home: string): Promise<Policy> {
  const file = ensurePolicy(home);
  const model = modelPath(home);
  const build = async (): Promise<Enforcer> => {
    const e = await newEnforcer(model, file);
    e.addFunction("globOk", (t: string, p: string) => globOk(String(t), String(p)));
    return e;
  };
  let enforcer: Enforcer = await build();

  const readRows = (): string[][] => {
    try {
      return readFileSync(file, "utf8").split(String.fromCharCode(10))
        .map((l) => l.trim()).filter((l) => l.startsWith("p,"))
        .map((l) => l.slice(2).split(",").map((x) => x.trim()));
    } catch { return []; }
  };

  const api: Policy = {
    async authorize(verb, tier, target) {
      const [ok, rule] = await enforcer.enforceEx(verb, tier, target);
      if (!ok) {
        // 命中 deny 与"根本没规则"要分开报：前者是策略拒绝，后者是能力没开放
        const denied = readRows().find((r) =>
          r[0] === "deny" && (r[1] === "*" || r[1] === tier) && (r[2] === "*" || r[2] === verb) && globOk(target, r[3] ?? "*"));
        return { allow: false, strength: denied ? ((denied[4] as Strength) ?? "enforce") : null, rule: denied ?? null, reason: denied ? "E_DENIED" : "E_NO_RULE" };
      }
      const row = rule as string[];
      const eft = row[0] === "deny" ? "deny" : "allow";
      const strength = (row[4] as Strength) ?? "enforce";
      if (eft === "deny") return { allow: false, strength, rule: row, reason: "E_DENIED" };
      return { allow: true, strength, rule: row };
    },
    async reload() {
      void readFileSync(file, "utf8");
      enforcer = await build();
    },
  };
  return api;
}
