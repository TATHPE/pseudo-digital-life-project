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
# T3：只能走注册过的模板（target 是 shell:<template>），且每次要一次性令牌
p, allow, T3, shell.run, shell:*, enforce
# 任意 argv：只有「完全权限」窗口能把它跑起来（见 src/grant.ts）
p, allow, T3, shell.exec, shell:exec, enforce
`;

export function policyPath(home: string): string { return join(home, "policy.csv"); }
export function modelPath(home: string): string { return join(home, "policy.model.conf"); }

/** 模型与策略都落盘：casbin 的 newEnforcer 只接受「文件路径 / 适配器」，不接受内存 Model + 路径混搭 */
/** 老库升级时要补的行：只在「该 verb 一行都没有」时追加，不覆盖人写的 deny */
const REQUIRED_RULES: Array<[string, string]> = [
  ["shell.exec", "p, allow, T3, shell.exec, shell:exec, enforce"],
  ["git.status", "p, allow, T1, git.status, *, advise"],
  ["git.diff", "p, allow, T1, git.diff, *, advise"],
  ["git.log", "p, allow, T0, git.log, *, advise"],
  ["skill.list", "p, allow, T0, skill.list, *, advise"],
  ["skill.read", "p, allow, T0, skill.read, *, advise"],
];

export function ensurePolicy(home: string): string {
  mkdirSync(home, { recursive: true });
  const p = policyPath(home);
  if (!existsSync(p)) atomicWriteFile(p, DEFAULT_POLICY);
  else {
    try {
      const cur = readFileSync(p, "utf8");
      // 语义升级（2026-10-31）：fs.* 从 workspace/* 放宽到 *（记忆核心由 coreguard 挡）
      const upgraded = cur.replace(
        /^p, allow, T1, (fs\.(?:write|mkdir|move|trash)), workspace\/\*, enforce$/gm,
        "p, allow, T1, $1, *, enforce",
      );
      if (upgraded !== cur) atomicWriteFile(p, upgraded);
      const cur2 = upgraded;
      const missing = REQUIRED_RULES.filter(([verb]) => !cur2.includes(verb)).map(([, line]) => line);
      if (missing.length) {
        atomicWriteFile(p, cur.replace(/\n?$/, String.fromCharCode(10)) + missing.join(String.fromCharCode(10)) + String.fromCharCode(10));
      }
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
