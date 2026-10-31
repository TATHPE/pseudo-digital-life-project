/**
 * 启动前配置校验（D-5）
 *
 * 为什么要有它：配置坏了现在的表现是**假装没事**——
 *  · `config.json` 解不开 → `readFileConfig` 的 catch 返回 `{}`，用户的设置静默消失；
 *  · `policy.csv` 写坏 → 等到某次调用才在 casbin 里炸，前端只看到一次失败的动作；
 *  · schema 不匹配 → `selfCheck` 记一条 note，但没人真的停下。
 *
 * 所以这里在**任何命令跑起来之前**做一次结构校验：
 *  · 致命的（配置解不开、策略写坏、库 schema 不对）→ 打印原因并 **exit 78**；
 *  · 非致命的（衰减参数越界、端点不可达）→ 只警告，照常跑。
 *
 * 为什么是 78：systemd 有 `RestartPreventExitStatus=78`；docker 没有等价物，
 * 但 compose 用 `on-failure:5` 也能在 5 次后停住，日志留得住现场（否则崩溃循环把日志冲干净）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDecayConfig } from "./decayparams.ts";

export interface StartupProblem {
  code: string;
  detail: string;
  /** true = 拒绝启动（exit 78）；false = 只警告 */
  fatal: boolean;
  fix?: string;
}

export const EXIT_CONFIG = 78;

/** 只做**结构**检查：不连端点、不加载模型、不改库 */
export function checkConfig(home: string): StartupProblem[] {
  const out: StartupProblem[] = [];

  // ① config.json：解不开就是解不开，不许静默回到默认值
  const cfgFile = join(home, "config.json");
  if (existsSync(cfgFile)) {
    try {
      const j = JSON.parse(readFileSync(cfgFile, "utf8")) as unknown;
      if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("顶层不是对象");
    } catch (e) {
      out.push({
        code: "E_CONFIG_CORRUPT", fatal: true,
        detail: `config.json 解析失败：${String((e as Error).message).slice(0, 120)}`,
        fix: `修好它，或删掉让它回到默认值：${cfgFile}`,
      });
    }
  }

  // ② policy.csv / policy.model.conf：按结构判（不启动 casbin）
  const pol = join(home, "policy.csv");
  if (existsSync(pol)) {
    const bad = readFileSync(pol, "utf8").split(String.fromCharCode(10))
      .map((l, i) => ({ l: l.trim(), i: i + 1 }))
      .filter((x) => x.l && !x.l.startsWith("#"))
      .filter((x) => {
        const f = x.l.split(",").map((s) => s.trim());
        return f[0] !== "p" || f.length < 6 || !/^T[0-4]$/.test(f[2] ?? "") || !["enforce", "advise"].includes(f[5] ?? "");
      });
    if (bad.length) {
      out.push({
        code: "E_POLICY_CORRUPT", fatal: true,
        detail: `policy.csv 有 ${bad.length} 行结构不对（第 ${bad.slice(0, 3).map((b) => b.i).join("/")} 行）`,
        fix: "每行应为：p, allow|deny, T0..T4, verb, target, enforce|advise —— 或删掉 policy.csv 让它按默认重建",
      });
    }
  }
  const model = join(home, "policy.model.conf");
  if (existsSync(model)) {
    const m = readFileSync(model, "utf8");
    for (const sec of ["[request_definition]", "[policy_definition]", "[policy_effect]", "[matchers]"]) {
      if (!m.includes(sec)) {
        out.push({ code: "E_POLICY_MODEL_CORRUPT", fatal: true, detail: `policy.model.conf 缺 ${sec}`, fix: "删掉它，会按内置 MODEL 重建" });
        break;
      }
    }
  }

  // ③ schema：这里只读 meta，不迁移（迁移是 `migrate` 的活）
  const dbFile = join(home, "memory.db");
  if (existsSync(dbFile)) {
    try {
      // 延迟 import，避免 CLI 启动路径上无条件拉 node:sqlite
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(dbFile, { readOnly: true });
      const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined;
      db.close();
      const want = (require("./schema.ts") as { SCHEMA_VERSION: number }).SCHEMA_VERSION;
      if (row?.value && String(want) !== row.value) {
        out.push({
          code: "E_SCHEMA_MISMATCH", fatal: true,
          detail: `库是 schema ${row.value}，代码是 ${want}`,
          fix: "跑 `jingjing migrate`（会拒绝在更老的库上启动，避免写坏数据）",
        });
      }
    } catch { /* 库打不开：让 openDb 去报，别在这里抢戏 */ }
  }

  // ④ 衰减参数：越界只警告（②参数类的越界由 setDecayParam 拒，这里是"文件被手改坏"）
  try {
    for (const p of loadDecayConfig(home).problems) {
      out.push({ code: "E_DECAY_PARAM", fatal: false, detail: p, fix: "jingjing decay --reset" });
    }
  } catch { /* ignore */ }

  return out;
}

/** 让人照着做的一行 */
export function describeProblems(ps: readonly StartupProblem[]): string {
  return ps.map((p) => `${p.fatal ? "✗" : "!"} [${p.code}] ${p.detail}${p.fix ? `\n    → ${p.fix}` : ""}`)
    .join(String.fromCharCode(10));
}
