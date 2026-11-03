/**
 * 自我更新三件套（2026-11-03）。按 `docs/18 §4.3` 的流程，落到我们能实现的那部分：
 *
 *   提议 → 草稿区 → 冒烟 → 上 A/B 槽 → 失败自动回滚 → 连续失败冻结 24h
 *
 * **只做 ③ 技能**（docs/18 的分类）：④ 核心代码永不自改（可复现性），
 * ② 参数已经由 `decayparams.ts` 的白名单管住了。技能是她能自己长出来的"手脚"。
 *
 * 三条硬边界：
 *  1. **草稿不等于生效**：`skills/_drafts/` 不进 `scanSkills`（那样它就不会进简报索引），
 *     必须在面板/CLI 上显式 promote —— 和插件的"待生效"是同一个诚实原则。
 *  2. **A/B 槽是目录改名**：`skills/<id>` → `skills/<id>.prev` → 新的顶上去。
 *     两步 rename 在同一个盘上是原子的（Windows 也一样）。
 *  3. **失败要留痕，而且会冻结**：连续 2 次冒烟失败 → `meta.self_update_frozen_until` +24h。
 *     没有冻结，一个总失败的技能会把每轮都拖进重试。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ID_RE, skillsDir } from "./plugins.ts";
import { scanSkills, splitFrontmatter } from "./skills.ts";

export const MAX_DRAFT_BYTES = 64 * 1024;
/** 连续失败几次冻结自我更新 */
export const FREEZE_AFTER = 2;
/** 冻结多久 */
export const FREEZE_MS = 24 * 60 * 60 * 1000;
const FROZEN_KEY = "self_update_frozen_until";
const FAILS_KEY = "self_update_fail_count";

const draftsDir = (home: string): string => join(skillsDir(home), "_drafts");
const prevDir = (home: string, id: string): string => join(skillsDir(home), id + ".prev");
const versionsDir = (home: string): string => join(home, "versions");

export interface Draft {
  id: string;
  bytes: number;
  /** 为什么想加它（她自己的说法） */
  because: string;
  /** 依据：哪几条记忆逼出来的 */
  evidence: string[];
  at: string;
}

interface DraftMeta { because?: string; evidence?: string[]; at?: string }

function readMeta(home: string, id: string): DraftMeta {
  try {
    return JSON.parse(readFileSync(join(draftsDir(home), id, "meta.json"), "utf8")) as DraftMeta;
  } catch { return {}; }
}

/**
 * 写一份草稿。**不生效**：`scanSkills` 只扫 `skills/`，不扫 `skills/_drafts/`。
 */
export function proposeSkill(
  home: string,
  input: { id?: string; content?: string; because?: string; evidence?: string[] },
  now = new Date(),
): { ok: true; id: string } | { ok: false; code: string; why: string } {
  const id = String(input.id ?? "").trim();
  if (!ID_RE.test(id)) return { ok: false, code: "E_BAD_NAME", why: "目录名只能是小写字母/数字/_/-（1–40 字符）" };
  const content = String(input.content ?? "");
  if (!content.trim()) return { ok: false, code: "E_EMPTY", why: "内容是空的" };
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_DRAFT_BYTES) return { ok: false, code: "E_TOO_BIG", why: "超过 64KB" };
  const because = String(input.because ?? "").trim();
  // 为什么必须有：没有理由的技能，人没法判断要不要留（docs/18 §4.4）
  if (because.length < 6) return { ok: false, code: "E_NEED_WHY", why: "写清为什么想加它（至少 6 个字）：没有理由的技能不该存在" };

  const dir = join(draftsDir(home), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf8");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({
    because: because.slice(0, 300),
    evidence: (input.evidence ?? []).slice(0, 5),
    at: now.toISOString(),
  }, null, 2), "utf8");
  return { ok: true, id };
}

export function listDrafts(home: string): Draft[] {
  const dir = draftsDir(home);
  if (!existsSync(dir)) return [];
  const out: Draft[] = [];
  for (const id of readdirSync(dir).sort()) {
    const file = join(dir, id, "SKILL.md");
    if (!existsSync(file)) continue;
    const m = readMeta(home, id);
    let bytes = 0;
    try { bytes = Buffer.byteLength(readFileSync(file, "utf8"), "utf8"); } catch { /* ignore */ }
    out.push({ id, bytes, because: String(m.because ?? ""), evidence: m.evidence ?? [], at: String(m.at ?? "") });
  }
  return out;
}

export function dropDraft(home: string, id: string): { ok: boolean; why?: string } {
  if (!ID_RE.test(String(id ?? ""))) return { ok: false, why: "E_BAD_NAME" };
  const dir = join(draftsDir(home), id);
  if (!existsSync(dir)) return { ok: false, why: "E_NOT_FOUND" };
  rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

/** 冒烟：不启动进程也能判的基本项（技能是纯文本说明书，不会被执行） */
export function smokeDraft(home: string, id: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const file = join(draftsDir(home), id, "SKILL.md");
  if (!existsSync(file)) return { ok: false, problems: ["草稿不存在"] };
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return { ok: false, problems: ["读不出来"] }; }

  const { meta, body } = splitFrontmatter(raw);
  // ① 前端格式：必须有名字与一句说明（简报索引只取这两样，没有它们进不了索引）
  if (!meta.name && !id) problems.push("缺 name");
  if (!String(meta.description ?? "").trim()) problems.push("缺 description（简报里只放这一句）");
  if (!body.trim()) problems.push("正文是空的");

  // ② 正文里**直接**写死了一条密钥/令牌的样子：技能会被读进模型上下文，这种东西不能进
  if (/(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/.test(raw)) {
    problems.push("正文里像是有密钥/令牌 —— 技能会进模型上下文，不能带");
  }

  // ③ 同名不是冲突：那是「升级」—— promote 会把旧版移到 skills/<id>.prev（A/B 槽），
  //    所以这里**故意不检查**重名。曾经加过这条检查，结果第二次 promote 永远失败（测试抓到）。
  void scanSkills;

  return { ok: problems.length === 0, problems };
}

function recordVersion(home: string, what: string, why: string, evidence: string[], rollback: string, now: Date): string {
  const dir = versionsDir(home);
  mkdirSync(dir, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  let n = 1;
  while (existsSync(join(dir, day + "-" + n + ".md"))) n++;
  const file = join(dir, day + "-" + n + ".md");
  const text = [
    "# " + day + "-" + n,
    "",
    "改了什么：" + what,
    "因为：" + (why || "（没写）"),
    evidence.length ? "依据：" + evidence.join(", ") : "依据：（没有）",
    "回滚：" + rollback,
    "",
  ].join(String.fromCharCode(10));
  writeFileSync(file, text, "utf8");
  return file;
}

function metaGet(db: DatabaseSync, key: string): string | null {
  try {
    const r = db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value?: string } | undefined;
    return r?.value ?? null;
  } catch { return null; }
}
function metaSet(db: DatabaseSync, key: string, value: string): void {
  try {
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  } catch { /* 记不上不影响主流程 */ }
}

/** 现在是不是冻结期 */
export function frozenUntil(db: DatabaseSync, now = new Date()): string | null {
  const v = metaGet(db, FROZEN_KEY);
  if (!v) return null;
  return Date.parse(v) > now.getTime() ? v : null;
}

/**
 * 草稿 → 生效（A/B 槽）。
 *
 * 顺序：冒烟 → 旧版本改名成 `.prev` → 草稿改名成正式 → 写 versions 记录。
 * 冒烟不过就直接拒绝（并且累计失败次数，够两次就冻结）。
 */
export function promoteDraft(
  home: string, db: DatabaseSync, id: string, now = new Date(),
): { ok: boolean; code?: string; why?: string; version?: string; rollback?: string } {
  if (!ID_RE.test(String(id ?? ""))) return { ok: false, code: "E_BAD_NAME", why: "目录名不合法" };
  const frozen = frozenUntil(db, now);
  if (frozen) return { ok: false, code: "E_FROZEN", why: "自我更新冻结中（到 " + frozen.slice(0, 16) + "）：连续失败太多次，先别动" };

  const smoke = smokeDraft(home, id);
  if (!smoke.ok) {
    const n = Number(metaGet(db, FAILS_KEY) ?? 0) + 1;
    metaSet(db, FAILS_KEY, String(n));
    if (n >= FREEZE_AFTER) {
      const until = new Date(now.getTime() + FREEZE_MS).toISOString();
      metaSet(db, FROZEN_KEY, until);
      metaSet(db, FAILS_KEY, "0");
      return { ok: false, code: "E_FROZEN", why: "冒烟第 " + n + " 次失败 → 冻结 24 小时（到 " + until.slice(0, 16) + "）" };
    }
    return { ok: false, code: "E_SMOKE", why: smoke.problems.join("；") };
  }

  const target = join(skillsDir(home), id);
  const bak = prevDir(home, id);
  const draft = join(draftsDir(home), id);
  try {
    // ① 旧版本让位（存在才动）
    if (existsSync(target)) {
      if (existsSync(bak)) rmSync(bak, { recursive: true, force: true });
      renameSync(target, bak);
    }
    // ② 新版本顶上（rename 草稿目录；先拷 SKILL.md，meta 留在草稿里做记录）
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), readFileSync(join(draft, "SKILL.md"), "utf8"), "utf8");
  } catch (e) {
    // 回头把旧版本放回去
    if (existsSync(bak) && !existsSync(target)) { try { renameSync(bak, target); } catch { /* ignore */ } }
    return { ok: false, code: "E_INSTALL", why: String((e as Error).message ?? e).slice(0, 160) };
  }

  const m = readMeta(home, id);
  const version = recordVersion(
    home,
    "启用技能 " + id,
    m.because ?? "",
    m.evidence ?? [],
    existsSync(bak) ? "把 skills/" + id + ".prev 改回 skills/" + id + "（旧版本还在）" : "删掉 skills/" + id + " 即可",
    now,
  );
  metaSet(db, FAILS_KEY, "0");
  dropDraft(home, id);
  return { ok: true, version, rollback: existsSync(bak) ? "skills/" + id + ".prev" : "无（这是第一版）" };
}

/** 回滚：把 `.prev` 换回正式位（A/B 槽的 B 方向） */
export function revertSkill(
  home: string, db: DatabaseSync, id: string, why = "", now = new Date(),
): { ok: boolean; code?: string; why?: string; version?: string } {
  if (!ID_RE.test(String(id ?? ""))) return { ok: false, code: "E_BAD_NAME", why: "目录名不合法" };
  const target = join(skillsDir(home), id);
  const bak = prevDir(home, id);
  if (!existsSync(bak)) return { ok: false, code: "E_NO_PREV", why: "没有上一版可回滚（skills/" + id + ".prev 不存在）" };
  // 当前这版也留着，别把证据删了：改成 .bad-<时间>
  if (existsSync(target)) {
    const bad = join(skillsDir(home), id + ".bad-" + now.toISOString().slice(11, 19).replace(/:/g, ""));
    try { renameSync(target, bad); } catch { rmSync(target, { recursive: true, force: true }); }
  }
  renameSync(bak, target);
  const version = recordVersion(home, "回滚技能 " + id, why || "冒烟/观察失败", [], "再 promote 一次就会把它换回来", now);
  return { ok: true, version };
}

/** 版本记录（最近的几条，面板上用） */
export function recentVersions(home: string, limit = 10): Array<{ file: string; text: string }> {
  const dir = versionsDir(home);
  if (!existsSync(dir)) return [];
  const out: Array<{ file: string; text: string }> = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort().reverse().slice(0, limit)) {
    try { out.push({ file: f, text: readFileSync(join(dir, f), "utf8") }); } catch { /* ignore */ }
  }
  return out;
}
