/**
 * 衰减参数的可调边界（E-4）
 *
 * `18 §4.1` 把参数归为 **②参数类**：它可以调，但必须**有界**。
 * 之前 `KIND_PARAMS` / 双阈值 / γ / α 全是代码常量——唯一改法是改源码，
 * 于是“调一下半衰期”这件事既没有边界、也没有痕迹。
 *
 * 四条纪律：
 *  1. **白名单 + 范围**：只有这里列出的字段能改，且必须落在范围内；越界直接拒（不夹取）。
 *  2. **不许自动改**：`setDecayParam()` 必须带 `because`，否则拒。
 *  3. **每次改都 bump 版本号 + 留审计**（`meta.decay_params_version` + `data/decay/changes.jsonl`），
 *     改完还要重算现有记忆（那是 `decay --recompute` 的事，不隐式发生）。
 *  4. **默认值仍来自代码**：配置文件只是覆盖，删掉就回到 `KIND_PARAMS`。
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { KIND_PARAMS, T, RECONSOLIDATION, ACCESS, paramsFor, setKindOverrides, type DecayParams } from "./decay.ts";
import { readFileConfig } from "./configfile.ts";
import { atomicWriteFile } from "./fsx.ts";

export type FieldName = "halfLifeDays" | "beta" | "floor";
export interface FieldRule { min: number; max: number; /** true=允许 Infinity（契约层） */ allowInfinity?: boolean }

/** 每个 kind 允许调的字段与范围 */
export const RANGES: Record<FieldName, FieldRule> = {
  halfLifeDays: { min: 1, max: 3650, allowInfinity: true },
  beta: { min: 0.5, max: 1.0 },
  floor: { min: 0, max: 0.5 },
};

/** 全局参数（不在 kind 表里的那几个） */
export const GLOBAL_RANGES: Record<string, FieldRule> = {
  "T.activeIn": { min: 0.2, max: 0.95 },
  "T.activeOut": { min: 0.15, max: 0.9 },
  "T.fadingIn": { min: 0.05, max: 0.8 },
  "T.fadingOut": { min: 0.01, max: 0.75 },
  "RECONSOLIDATION.gamma": { min: 0, max: 0.3 },
  "ACCESS.alpha": { min: 0, max: 0.5 },
  "ACCESS.cap": { min: 1, max: 2 },
};

export interface DecayOverride { kind: string; field: FieldName; value: number }
export interface DecayConfig {
  kinds: Record<string, Partial<DecayParams>>;
  globals: Record<string, number>;
}

/** 运行期覆盖表：decay.paramsFor 会先查它，再回落 KIND_PARAMS */
let overrides: DecayConfig = { kinds: {}, globals: {} };

export function setDecayOverrides(c: DecayConfig | null): void {
  overrides = c ?? { kinds: {}, globals: {} };
  setKindOverrides(overrides.kinds);
  // 全局参数直接写进导出对象（T / γ / α 是 const 对象，字段可写）
  if (c) {
    for (const [k, v] of Object.entries(c.globals)) {
      const [obj, field] = k.split(".") as ["T" | "RECONSOLIDATION" | "ACCESS", string];
      const target = obj === "T" ? T : obj === "RECONSOLIDATION" ? RECONSOLIDATION : ACCESS;
      (target as unknown as Record<string, number>)[field] = v;
    }
  }
}

export function currentOverrides(): DecayConfig { return overrides; }

/**
 * 生效参数：**直接问 decay.paramsFor**（单一事实源）。
 * 以前这里自己再拼一次 `{...base, ...overrides.kinds[kind]}`，和 decay.ts 里的
 * kindOverrides 是两套状态 —— 谁调用一次 `setKindOverrides()`，CLI 的显示就和运行时脱节。
 */
export function effectiveParams(kind: string): DecayParams {
  return paramsFor(kind);
}

export function checkRange(field: FieldName, value: number): string | null {
  const r = RANGES[field];
  if (!Number.isFinite(value)) {
    if (value === Infinity && r.allowInfinity) return null;
    return `E_BAD_RANGE: ${field}=${value}（必须是有限数${r.allowInfinity ? "或 Infinity" : ""}）`;
  }
  if (value < r.min || value > r.max) return `E_OUT_OF_RANGE: ${field}=${value} 超出 [${r.min}, ${r.max}]`;
  return null;
}

export function checkGlobalRange(key: string, value: number): string | null {
  const r = GLOBAL_RANGES[key];
  if (!r) return `E_UNKNOWN_PARAM: ${key}（白名单里没有）`;
  if (!Number.isFinite(value) || value < r.min || value > r.max) {
    return `E_OUT_OF_RANGE: ${key}=${value} 超出 [${r.min}, ${r.max}]`;
  }
  return null;
}

/** 从 config.json 读覆盖；非法值不生效，只报问题（不静默采纳） */
export function loadDecayConfig(home: string): { cfg: DecayConfig; problems: string[] } {
  const f = readFileConfig(home) as { decay?: { kinds?: Record<string, Record<string, number>>; globals?: Record<string, number> } };
  const problems: string[] = [];
  const kinds: Record<string, Partial<DecayParams>> = {};
  const globals: Record<string, number> = {};
  for (const [kind, fields] of Object.entries(f.decay?.kinds ?? {})) {
    if (!Object.hasOwn(KIND_PARAMS, kind)) { problems.push(`E_UNKNOWN_KIND: decay.kinds.${kind}`); continue; }
    for (const [field, value] of Object.entries(fields ?? {})) {
      if (!["halfLifeDays", "beta", "floor"].includes(field)) { problems.push(`E_UNKNOWN_FIELD: ${kind}.${field}`); continue; }
      const err = checkRange(field as FieldName, Number(value));
      if (err) { problems.push(err); continue; }
      kinds[kind] = { ...(kinds[kind] ?? {}), [field]: Number(value) };
    }
  }
  for (const [key, value] of Object.entries(f.decay?.globals ?? {})) {
    const err = checkGlobalRange(key, Number(value));
    if (err) { problems.push(err); continue; }
    globals[key] = Number(value);
  }
  return { cfg: { kinds, globals }, problems };
}

/** 启动/CLI 入口调用：读配置并**生效**；有问题就打印并忽略（不静默） */
export function applyDecayConfig(home: string, log: (s: string) => void = () => {}): string[] {
  const { cfg, problems } = loadDecayConfig(home);
  setDecayOverrides(cfg);
  for (const p of problems) log(`⚠ 衰减参数未生效：${p}`);
  return problems;
}

/**
 * 改一个参数：必须带 because，越界拒，成功后 bump 版本 + 追加审计。
 * 这是**唯一**的写入路径（面板/CLI 都走它），不允许别处直接改 config。
 */
export interface SetParamResult { ok: boolean; version?: number; error?: string; wrote?: string }

export function setDecayParam(
  home: string, target: string, value: number, because: string, now = new Date(),
): SetParamResult {
  const reason = because.trim();
  if (!reason) return { ok: false, error: "E_NO_REASON: 改参数必须说明为什么（--because）" };

  let kinds: Record<string, Partial<DecayParams>> = {};
  let globals: Record<string, number> = {};
  const loaded = loadDecayConfig(home);
  kinds = { ...loaded.cfg.kinds };
  globals = { ...loaded.cfg.globals };

  if (target.includes(".") && !["T.", "RECONSOLIDATION.", "ACCESS."].some((p) => target.startsWith(p))) {
    // kind.field
    const [kind, field] = target.split(".");
    if (!kind || !field) return { ok: false, error: `E_BAD_TARGET: ${target}` };
    if (!Object.hasOwn(KIND_PARAMS, kind)) return { ok: false, error: `E_UNKNOWN_KIND: ${kind}` };
    if (!["halfLifeDays", "beta", "floor"].includes(field)) return { ok: false, error: `E_UNKNOWN_FIELD: ${field}` };
    const err = checkRange(field as FieldName, value);
    if (err) return { ok: false, error: err };
    kinds[kind] = { ...(kinds[kind] ?? {}), [field]: value };
  } else {
    const err = checkGlobalRange(target, value);
    if (err) return { ok: false, error: err };
    globals[target] = value;
  }

  const version = decayVersion(home) + 1;
  writeDecayBlock(home, { kinds, globals, version });
  setDecayOverrides({ kinds, globals });
  audit(home, { at: now.toISOString(), target, value, because: reason, version });
  return { ok: true, version, wrote: target };
}

/**
 * 整块替换 config.json 的 decay 段。
 * 为什么不用 writeFileConfig：它对嵌套对象是**合并**语义，于是"清空 kinds"永远清不掉
 * （实测 --reset 之后参数还在）。decay 段只由这里写，谁也别拼。
 */
function writeDecayBlock(home: string, block: { kinds: Record<string, unknown>; globals: Record<string, number>; version: number }): void {
  const cur = readFileConfig(home) as Record<string, unknown>;
  atomicWriteFile(join(home, "config.json"), JSON.stringify({ ...cur, decay: block }, null, 2) + String.fromCharCode(10));
}

export function bumpVersion(home: string): number {
  // 版本号存在 config.json 里（跟参数同源，搬家时一起走）
  const d = (readFileConfig(home) as { decay?: { version?: number; kinds?: Record<string, unknown>; globals?: Record<string, number> } }).decay;
  const next = (d?.version ?? 1) + 1;
  writeDecayBlock(home, { kinds: d?.kinds ?? {}, globals: d?.globals ?? {}, version: next });
  return next;
}

export function decayVersion(home: string): number {
  return (readFileConfig(home) as { decay?: { version?: number } }).decay?.version ?? 1;
}

export function resetDecayParams(home: string): number {
  const v = decayVersion(home) + 1;
  writeDecayBlock(home, { kinds: {}, globals: {}, version: v });
  setDecayOverrides({ kinds: {}, globals: {} });
  setKindOverrides({});
  audit(home, { at: new Date().toISOString(), target: "*", value: null, because: "恢复默认参数", version: v });
  return v;
}

/** 审计：一行一条，和记忆同目录（搬家时一起走） */
function audit(home: string, entry: Record<string, unknown>): void {
  const dir = join(home, "decay");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "changes.jsonl"), JSON.stringify(entry) + String.fromCharCode(10));
  } catch { /* 审计失败不阻断，verify 里能看出来 */ }
}

export function readAudit(home: string, limit = 20): Array<Record<string, unknown>> {
  const f = join(home, "decay", "changes.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split(String.fromCharCode(10)).filter(Boolean)
    .slice(-limit).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return { raw: l }; } });
}
