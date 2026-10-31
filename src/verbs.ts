/**
 * 能力目录（04 §3）：鲸鲸能碰到的东西**只有这张表里的**。
 *
 * 白名单的强度来自"表里没有 rm / sudo / reg / mkfs"，而不是"有但被拦住"。
 * 每个 verb 带 T 档；真正执行前必须过 policy（src/policy.ts）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, copyFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import type { Tier } from "./types.ts";

export interface VerbCtx {
  home: string;
  now: () => Date;
  /** 环境变量（默认 process.env）。只为让"出网闸"在测试里可注入 */
  env?: Record<string, string | undefined>;
  /**
   * K-3：这次调用落在哪个授权窗口里（没有就是 undefined）。
   * shell.run 看到它就必须**脱敏环境变量**再跑 —— 窗口不该顺带把密钥也借出去。
   */
  grant?: { id: string; commands: string[]; scope: string; full?: boolean };
  /** 当前 verb 名（出网闸与面板提示用） */
  currentVerb?: string;
  /** 记忆类 verb 需要（不是所有 verb 都用得上） */
  db?: import("node:sqlite").DatabaseSync;
  embedder?: import("./embed.ts").Embedder | null;
}

export interface VerbDef {
  name: string;
  tier: Tier;
  description: string;
  reversible: boolean;
  params: Record<string, unknown>;
  /** 策略判定用的目标（路径/域名）；返回 null 表示"没有目标" */
  target(args: Record<string, unknown>, ctx: VerbCtx): string;
  run(args: Record<string, unknown>, ctx: VerbCtx): Promise<string>;
  /**
   * T3 专用（04 §4.1）：把参数渲染成"将要执行的确切 argv"。
   * 返回值同时用于（a）给人看确认预览、（b）算 argv_sha256 绑令牌、（c）写审计。
   * 没有它的 T3 verb = 无法签发令牌 = 永远拒绝。
   */
  /** 档位随参数变化时用（shell.run：档位由**模板**决定，04 §5.2） */
  tierFor?(args: Record<string, unknown>): Tier;
  capability?(args: Record<string, unknown>, ctx: VerbCtx): {
    argv: string[]; cwd: string; template: string;
  };
}

const S = (props: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties: props, required, additionalProperties: false });

/**
 * 解析真实路径：对最深的**已存在**祖先做 realpath，再把剩余部分接回去。
 * 为什么要这么做：`normalize()` 只做字符串层面的 `..` 折叠，
 * 而目录联接（junction）/ 符号链接会把路径**指到 home 之外**——
 * 只看字符串是拦不住的（红队第 4 条实测咬到过）。
 */
export function realpathish(p: string): string {
  let cur = normalize(p);
  const rest: string[] = [];
  for (;;) {
    if (existsSync(cur)) {
      const base = realpathSync.native ? realpathSync.native(cur) : realpathSync(cur);
      return rest.length ? join(base, ...rest.reverse()) : base;
    }
    const parent = dirname(cur);
    if (parent === cur) return normalize(p);
    rest.push(basename(cur));
    cur = parent;
  }
}

/** 路径必须在 home 之内，且**解析真实路径后**仍在（防符号链接/目录联接逃逸） */
export function safePath(home: string, p: string, mustExist = true): string {
  const homeReal = realpathish(home);
  const abs = normalize(isAbsolute(p) ? p : join(home, p));
  const real = realpathish(abs);
  const rel = relative(homeReal, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    if (!(rel === "" && !mustExist)) throw new Error(`E_PATH_DENIED: ${p}`);
  }
  if (mustExist && !existsSync(real)) throw new Error(`E_NOT_FOUND: ${p}`);
  return real;
}

const MAX_READ = 64 * 1024;
const maxList = 200;

import { search, searchDocs } from "./retrieve.ts";
import { remember } from "./store.ts";
import { createProposal } from "./proposals.ts";
import { sanitizedEnv } from "./grant.ts";
import { checkEgress, noteEgressRequest } from "./egress.ts";
import { renderTemplate, templateCatalog, templateById, planRun, runArgv } from "./shell.ts";
import { listDocs } from "./ingest.ts";
import { dedupeTitle } from "./chunk.ts";
import { resolveConfig } from "./configfile.ts";
import * as project from "./project.ts";
import { modelKeyOf } from "./config.ts";
import { indexState } from "./embedindex.ts";
import { isRemoteRole } from "./transport.ts";

/**
 * 工具结果会跟着下一轮请求一起发给表达角色（agent.ts 把 tool 消息塞进 messages）。
 * 所以「这段原文能不能出网」必须在**工具返回之前**判定，而不是等 transport 抛错——
 * 等它抛错时，文字已经在请求体里了。
 */
/**
 * 索引过期提示（C-2）。召回不可信时，结果前面必须有一句 —— 不许静默。
 * 返回带尾随换行的字符串；没过期就是空串（拼接无副作用）。
 */
function staleNote(ctx: VerbCtx): string {
  if (!ctx.db) return "";
  try {
    const e = resolveConfig(ctx.home).roles["embed"];
    const cur = modelKeyOf(e);
    const ix = indexState(ctx.db, cur);
    if (!ix.stale) return "";
    return `（注意：向量索引是用 ${ix.built ?? "未知模型"} 建的，当前配置是 ${ix.current ?? "未配置"}，召回可能不准；跑 jingjing reembed 重建）` + String.fromCharCode(10);
  } catch { return ""; }
}

/**
 * 项目读取的出网闸（H-7：按次授权）。
 *
 * 代码与记忆是两种隐私：读到的源码如果正被云端表达模型使用，就等于外发。
 * 现在有三档，**默认最短**：
 *   1. 默认拒：抛 E_NEEDS_EGRESS 并带上**具体路径**，面板据此问人
 *   2. 人批「只这一次」→ 读一次就消耗
 *   3. 人批「10 分钟内都行」→ 一扇短窗
 * 外加无人值守模式 `JJ_PROJECT_EGRESS=1`（文档与 CI 用，不给人日常用）。
 */
function egressEnv(ctx: VerbCtx, target: string): Record<string, string | undefined> {
  // 默认读 process.env；ctx.env 只是给测试注入用。
  // （踩过：只查 ctx.env 的话，命令行设了 JJ_PROJECT_EGRESS=1 也不会生效）
  const env = ctx.env ?? process.env;
  if (!expressIsRemote(ctx)) return env;              // 表达模型在本地：不发出去，不用批
  const r = checkEgress(ctx.home, target, { env });
  if (r.ok) return env;
  noteEgressRequest(ctx.home, target, ctx.currentVerb ?? "project.read");
  throw new Error(
    "E_NEEDS_EGRESS: 当前表达模型在云端，读这一条等于把代码/文档发出去：" + target +
    String.fromCharCode(10) + "  在面板上批「只这一次」或「10 分钟内都行」；无人值守用 JJ_PROJECT_EGRESS=1",
  );
}

function expressIsRemote(ctx: VerbCtx): boolean {
  try {
    const cfg = resolveConfig(ctx.home);
    const ex = cfg.roles["express"];
    return ex ? isRemoteRole(ex) : true;   // 拿不准就当远端（保守）
  } catch { return true; }
}

/** 出网时的替代文案：不假装没有，只说"有但不能发"（07 §3 的诚实条款） */
function redacted(what: string, n: number): string {
  return `（${what}共 ${n} 段匹配，但当前表达模型在云端，原文不出网。` +
    `要让它读到：把那一篇标为"可发送"，或在本地面板里打开对应引用）`;
}
import { spawnSync } from "node:child_process";

/** docker 模式超时后清容器（客户端被杀不等于容器停了） */
function killContainer(name: string): void {
  try { spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", windowsHide: true, timeout: 5000 }); }
  catch { /* 引擎没了就算了，runArgv 已经杀过本地客户端 */ }
}

export const verbs: VerbDef[] = [
  {
    name: "time.now", tier: "T0", reversible: true,
    description: "当前本地时间（ISO）",
    params: S({}),
    target: () => "internal",
    async run(_a, ctx) { return ctx.now().toISOString(); },
  },
  {
    name: "memory.search", tier: "T0", reversible: true,
    description: "在自己的记忆里做混合检索，返回带 id 的片段",
    params: S({ q: { type: "string" }, k: { type: "number" } }, ["q"]),
    target: () => "internal",
    async run(a, ctx) {
      if (!ctx.db) throw new Error("E_NO_DB");
      if (!ctx.embedder) throw new Error("E_NO_EMBEDDER");
      // 索引过期时召回不可信 —— 与其悄悄给错结果，不如在结果前面说一句（C-2）
      const stale = staleNote(ctx);
      const r = await search(ctx.db, ctx.embedder, String(a.q ?? ""), { k: Number(a.k ?? 5) });
      // 云端表达：只回 shareable 的原文；local_only 只报个数
      if (expressIsRemote(ctx)) {
        const ok = r.hits.filter((h) => h.sensitivity === "shareable");
        if (!ok.length) return stale + (r.hits.length ? redacted("本地下", r.hits.length) : "（没有相关记忆）");
        return stale + ok.map((h) => `[mem:${h.id}] ${h.text}`).join(String.fromCharCode(10));
      }
      return r.hits.length ? r.hits.map((h) => `[mem:${h.id}] ${h.text}`).join(String.fromCharCode(10)) : "（没有相关记忆）";
    },
  },
  {
    name: "memory.remember", tier: "T1", reversible: true,
    description: "写一条记忆（默认叙事层；聊天来源记为 shareable）。" +
      "读到的书/文档要用 from=reading 记 —— 那是「读来的」，不是「她经历过的」。",
    params: S({
      text: { type: "string" },
      layer: { type: "string", enum: ["narrative", "contract"] },
      kind: { type: "string" },
      from: { type: "string", enum: ["reading"] },
      source: { type: "string", description: "读来的东西出自哪（书名/路径），写进 source_ref" },
    }, ["text"]),
    target: () => "internal",
    async run(a, ctx) {
      if (!ctx.db) throw new Error("E_NO_DB");
      const reading = a.from === "reading";
      const layer = (a.layer === "contract" ? "contract" : "narrative") as "narrative" | "contract";
      // 读来的一律 narrative/reading；不接受调用方指定成别的 kind（否则又能混进经历里）
      const kind = reading ? "reading" : String(a.kind ?? (layer === "contract" ? "promise" : "episode"));
      const text = String(a.text ?? "").slice(0, 2000);
      const emb = ctx.embedder ? (await ctx.embedder.embed([text]))[0] ?? null : null;
      const id = remember(ctx.db, {
        layer: reading ? "narrative" : layer,
        kind, text, embedding: emb, now: ctx.now(),
        // 读来的默认 local_only：书里的原文不该顺手发给云端（要用再显式放宽）
        sensitivity: reading ? "local_only" : "shareable",
        ...(reading ? { sourceKind: "doc" as const, sourceRef: String(a.source ?? "reading").slice(0, 200), scoredBy: "tool:memory.remember:reading" } : { scoredBy: "tool:memory.remember" }),
      });
      return reading
        ? `已记住（读来的，不是经历）[mem:${id}]（narrative/reading）`
        : `已记住 [mem:${id}]（${layer}/${kind}）`;
    },
  },
  {
    name: "proposal.create", tier: "T1", reversible: true,
    description: "把你「想做但需要人点头」的事写成一张提议卡（写 data/pending，不执行、不改代码）。" +
      "必须说清楚：做什么、为什么、影响哪些文件。人看完可以说「不做」。",
    params: S({
      title: { type: "string", description: "一句话：我想做 X（4–80 字）" },
      why: { type: "string", description: "为什么值得做（来自对话里的需求，别编）" },
      plan: { type: "array", description: "大概怎么做，最多 8 步", items: { type: "string" } },
      argv: { type: "array", description: "如果是一条命令就能做的，给出确切命令（只作为展示，不会被自动执行）", items: { type: "string" } },
      touches: { type: "array", description: "会改哪些文件（仓库相对路径，必须 jingjing/ 或 docs/ 开头）", items: { type: "string" } },
      risk: { type: "string", enum: ["low", "medium", "high"] },
    }, ["title", "why"]),
    target: () => "data/pending",
    async run(a, ctx) {
      const r = createProposal(ctx.home, { ...(a as Record<string, unknown>), from: "agent" } as never, ctx.now());
      return r.deduped
        ? `同一件事已经有一张卡了 [${r.proposal.id}]（第 ${r.proposal.seen} 次提到）：${r.proposal.title}`
        : `已提议 [${r.proposal.id}]：${r.proposal.title}`;
    },
  },
  {
    name: "fs.stat", tier: "T0", reversible: true,
    description: "文件/目录元信息（大小、时间、类型）",
    params: S({ path: { type: "string" } }, ["path"]),
    target: (a) => String(a.path ?? ""),
    async run(a, ctx) {
      const p = safePath(ctx.home, String(a.path ?? ""));
      const st = statSync(p);
      return JSON.stringify({ path: a.path, dir: st.isDirectory(), bytes: st.size, mtime: st.mtime.toISOString() });
    },
  },
  {
    name: "fs.list", tier: "T0", reversible: true,
    description: "列目录（不递归，最多 200 条）",
    params: S({ path: { type: "string" } }),
    target: (a) => String(a.path ?? "."),
    async run(a, ctx) {
      const p = safePath(ctx.home, String(a.path ?? "."));
      return readdirSync(p, { withFileTypes: true }).slice(0, maxList)
        .map((d) => (d.isDirectory() ? d.name + "/" : d.name)).join("\n");
    },
  },
  {
    name: "fs.read", tier: "T0", reversible: true,
    description: "读文本文件（≤64KB，超出明确报错而不是截断）",
    params: S({ path: { type: "string" } }, ["path"]),
    target: (a) => String(a.path ?? ""),
    async run(a, ctx) {
      const p = safePath(ctx.home, String(a.path ?? ""));
      const st = statSync(p);
      if (st.isDirectory()) throw new Error("E_IS_DIR");
      if (st.size > MAX_READ) throw new Error(`E_TOO_BIG: ${st.size} > ${MAX_READ}`);
      return readFileSync(p, "utf8");
    },
  },
  {
    name: "fs.search", tier: "T0", reversible: true,
    description: "在目录里按子串找文件（不递归出 home）",
    params: S({ path: { type: "string" }, needle: { type: "string" } }, ["needle"]),
    target: (a) => String(a.path ?? "."),
    async run(a, ctx) {
      const root = safePath(ctx.home, String(a.path ?? "."));
      const needle = String(a.needle ?? "");
      const out: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 4 || out.length >= 50) return;
        for (const d of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, d.name);
          if (d.isDirectory()) walk(full, depth + 1);
          else if (d.name.includes(needle)) out.push(relative(ctx.home, full));
        }
      };
      walk(root, 0);
      return out.join("\n") || "（没找到）";
    },
  },
  {
    name: "fs.write", tier: "T1", reversible: true,
    description: "写文本文件（只允许 workspace/ 之内；写前留快照）",
    params: S({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    target: (a) => String(a.path ?? ""),
    async run(a, ctx) {
      const raw = String(a.path ?? "");
      if (!normalize(raw).split("\\").join("/").startsWith("workspace/")) throw new Error("E_OUTSIDE_WORKSPACE");
      const p = safePath(ctx.home, raw, false);
      mkdirSync(dirname(p), { recursive: true });
      if (existsSync(p)) {
        const snap = join(ctx.home, "snapshots", `${Date.now()}-${basename(p)}`);
        mkdirSync(dirname(snap), { recursive: true });
        copyFileSync(p, snap);
      }
      const content = String(a.content ?? "");
      if (Buffer.byteLength(content) > MAX_READ) throw new Error("E_TOO_BIG");
      // 原子写：先写临时文件再改名（18 §1.2）
      const tmp = `${p}.tmp-${Date.now()}`;
      (await import("./fsx.ts")).atomicWriteFile(tmp, content);
      renameSync(tmp, p);
      return `写入 ${raw}（${Buffer.byteLength(content)} 字节）`;
    },
  },
  {
    name: "fs.mkdir", tier: "T1", reversible: true,
    description: "建目录（只允许 workspace/ 之内）",
    params: S({ path: { type: "string" } }, ["path"]),
    target: (a) => String(a.path ?? ""),
    async run(a, ctx) {
      const raw = String(a.path ?? "");
      if (!normalize(raw).split("\\").join("/").startsWith("workspace/")) throw new Error("E_OUTSIDE_WORKSPACE");
      mkdirSync(safePath(ctx.home, raw, false), { recursive: true });
      return `已建 ${raw}`;
    },
  },
  {
    name: "fs.trash", tier: "T1", reversible: true,
    description: "可逆删除：移进 data/trash/ 并留清单（不提供 rm）",
    params: S({ path: { type: "string" } }, ["path"]),
    target: (a) => String(a.path ?? ""),
    async run(a, ctx) {
      const p = safePath(ctx.home, String(a.path ?? ""));
      const trash = join(ctx.home, "trash");
      mkdirSync(trash, { recursive: true });
      const dest = join(trash, `${ctx.now().toISOString().replace(/[:.]/g, "-")}-${basename(p)}`);
      renameSync(p, dest);
      const manifest = join(trash, "manifest.jsonl");
      (await import("./fsx.ts")).appendLineSync(manifest, JSON.stringify({
        ts: ctx.now().toISOString(), from: relative(ctx.home, p), to: relative(ctx.home, dest),
      }));
      return `已移入回收站：${relative(ctx.home, dest)}（可用 fs.restore 恢复）`;
    },
  },
  {
    name: "fs.restore", tier: "T1", reversible: true,
    description: "从回收站恢复（按 manifest 最后一条匹配）",
    params: S({ name: { type: "string" } }, ["name"]),
    target: (a) => String(a.name ?? ""),
    async run(a, ctx) {
      const manifest = join(ctx.home, "trash", "manifest.jsonl");
      if (!existsSync(manifest)) throw new Error("E_NO_TRASH");
      const lines = readFileSync(manifest, "utf8").trim().split("\n").reverse();
      const name = String(a.name ?? "");
      for (const line of lines) {
        try {
          const row = JSON.parse(line) as { from: string; to: string };
          if (!row.to.includes(name)) continue;
          const dest = join(ctx.home, row.from);
          if (existsSync(dest)) throw new Error(`E_EXISTS: ${row.from}`);
          mkdirSync(dirname(dest), { recursive: true });
          renameSync(join(ctx.home, row.to), dest);
          return `已恢复 ${row.from}`;
        } catch (e) { if (String(e).includes("E_EXISTS")) throw e; }
      }
      throw new Error(`E_NOT_FOUND: ${name}`);
    },
  },
  {
    name: "msg.notify", tier: "T2", reversible: false,
    description: "给你发一条本地通知（写进 inbox，面板可见）",
    params: S({ text: { type: "string" } }, ["text"]),
    target: () => "notify",
    async run(a, ctx) {
      const text = String(a.text ?? "").slice(0, 500);
      const { appendEvent, newEventId } = await import("./journal.ts");
      appendEvent(join(ctx.home, "inbox"), {
        v: 1, id: newEventId(), ts: ctx.now().toISOString(), kind: "agent_reply", actor: "agent",
        payload: { text, proactive: true, reason: "notify" },
      });
      return "已通知";
    },
  },
  {
    name: "doc.search", tier: "T0", reversible: true,
    description: "在摄入过的文档块里检索（先 BM25 再向量，返回 doc:<id>#<ord> 引用）",
    params: S({ q: { type: "string" }, k: { type: "number" } }, ["q"]),
    target: () => "internal",
    async run(a, ctx) {
      if (!ctx.db) throw new Error("E_NO_DB");
      const stale = staleNote(ctx);   // 文档块用的是同一套向量，过期一样会不准
      const r = await searchDocs(ctx.db, ctx.embedder ?? null, String(a.q ?? ""), { k: Number(a.k ?? 5) });
      if (expressIsRemote(ctx)) {
        const ok = r.hits.filter((h) => h.sensitivity === "shareable");
        if (!ok.length) return stale + (r.hits.length ? redacted("本地文档里", r.hits.length) : "（没有相关文档块）");
        const NL2 = String.fromCharCode(10);
        return stale + ok.map((h) =>
          "[" + h.cite + "] " + h.title + (dedupeTitle(h.headingPath, h.title) ? " › " + dedupeTitle(h.headingPath, h.title) : "") + NL2 + h.text.slice(0, 600),
        ).join(NL2 + NL2);
      }
      if (!r.hits.length) return stale + "（没有相关文档块）";
      const NL = String.fromCharCode(10);
      return stale + r.hits.map((h) =>
        "[" + h.cite + "] " + h.title + (dedupeTitle(h.headingPath, h.title) ? " › " + dedupeTitle(h.headingPath, h.title) : "") + NL + h.text.slice(0, 600),
      ).join(NL + NL);
    },
  },
  {
    name: "doc.list", tier: "T0", reversible: true,
    description: "列出已摄入的文档（标题 / 块数 / 转换器）",
    params: S({}),
    target: () => "internal",
    async run(_a, ctx) {
      if (!ctx.db) throw new Error("E_NO_DB");
      const docs = listDocs(ctx.db, 50);
      if (!docs.length) return "（还没有摄入任何文档：jingjing ingest <路径>）";
      return docs.map((d) => d.id + " " + d.title + " ｜ " + d.chunks + " 块 ｜ " + (d.rel_path ?? "")).join(String.fromCharCode(10));
    },
  },
  {
    name: "project.read", tier: "T0", reversible: true,
    description: "读项目源码/文档（只读；根是 jingjing/ 与 docs/，data/ 与密钥一律拒）",
    params: S({ path: { type: "string" }, from: { type: "number" }, to: { type: "number" } }, ["path"]),
    target: (a) => String(a.path ?? ""),
    async run(a, ctx) {
      const r = project.readProjectFile(String(a.path ?? ""), {
        ...(a.from ? { from: Number(a.from) } : {}), ...(a.to ? { to: Number(a.to) } : {}),
        env: egressEnv(ctx, String(a.path ?? "")),
      });
      const head = `[${r.path}] ${r.bytes} 字节${r.truncated ? "（已截断，用 from/to 读其余）" : ""}` + String.fromCharCode(10);
      return head + r.text;
    },
  },
  {
    name: "project.list", tier: "T0", reversible: true,
    description: "列项目目录（只读；默认项目根）",
    params: S({ dir: { type: "string" } }, []),
    target: () => "internal",
    async run(a, ctx) {
      const rows = project.listProject(String(a.dir ?? ""), egressEnv(ctx, String(a.dir ?? "")));
      if (!rows.length) return "（空目录）";
      return rows.map((x) => (x.type === "dir" ? x.path + "/" : `${x.path}  ${x.bytes} B`)).join(String.fromCharCode(10));
    },
  },
  {
    name: "project.search", tier: "T0", reversible: true,
    description: "在项目里按正则搜（只读；返回 路径:行号）",
    params: S({ pattern: { type: "string" }, glob: { type: "string" }, limit: { type: "number" } }, ["pattern"]),
    target: (a) => String(a.pattern ?? ""),
    async run(a, ctx) {
      const hits = project.searchProject(String(a.pattern ?? ""), {
        ...(a.glob ? { glob: String(a.glob) } : {}), ...(a.limit ? { limit: Number(a.limit) } : {}),
        // 搜索的目标是整棵树：批的时候人看到的是 glob/pattern
        env: egressEnv(ctx, String(a.glob ?? a.pattern ?? ".")),
      });
      if (!hits.length) return "（没有匹配）";
      return hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join(String.fromCharCode(10));
    },
  },
  {
    name: "shell.run", tier: "T3", reversible: false,
    description: "跑一条**注册过的命令模板**（不拼字符串；每次确认 + 一次性令牌 + 超时杀进程树）。可用模板见 shell.templates",
    params: S({
      template: { type: "string" },
      slots: { type: "object" },
      token: { type: "string" },
    }, ["template"]),
    target: (a) => `shell:${String(a.template ?? "")}`,
    tierFor(a) {
      const t = templateById(String(a.template ?? ""));
      return t ? t.tier : "T4";   // 不存在的模板按 T4 处理（连拒绝都走策略层）
    },
    capability(a, ctx) {
      const r = renderTemplate(ctx.home, String(a.template ?? ""),
        (a.slots && typeof a.slots === "object" ? a.slots : {}) as Record<string, unknown>);
      // 沙箱决策在这里就做完（要了容器但引擎不在 → 直接拒，不让它走到"确认了才发现"）
      const plan = planRun(r);
      return { argv: plan.argv, cwd: plan.cwd, template: r.template, profile: plan.profile };
    },
    async run(a, ctx) {
      // 令牌已在 execute 里校验并标记 used；这里只管“跑”
      const r = renderTemplate(ctx.home, String(a.template ?? ""),
        (a.slots && typeof a.slots === "object" ? a.slots : {}) as Record<string, unknown>);
      const plan = planRun(r);
      const res = await runArgv(plan.argv, {
        cwd: plan.cwd, timeoutMs: r.timeoutMs,
        // ⑤ K-3：授权窗口里跑命令，密钥类环境变量一律不传
        ...(ctx.grant ? { env: sanitizedEnv(process.env) } : {}),
        // docker 模式下被我们杀掉：客户端死了容器还会活着，必须手动清
        onKill: plan.container
          ? () => { void killContainer(plan.container!); }
          : undefined,
      });
      const head = `exit=${res.code ?? res.signal} ${res.ms}ms` +
        (res.timedOut ? " 超时已杀" : "") + (res.truncated ? " 输出已截断" : "") +
        (plan.note ? ` ｜ ${plan.note}` : "");
      const body = [res.stdout.trimEnd(), res.stderr.trimEnd()].filter(Boolean).join(String.fromCharCode(10));
      if (res.timedOut) throw new Error(`E_TIMEOUT: ${head}${body ? String.fromCharCode(10) + body : ""}`);
      return `${head}${body ? String.fromCharCode(10) + body : ""}`;
    },
  },
  {
    name: "shell.exec", tier: "T3", reversible: false,
    description: "跑**任意 argv**（不是模板）。只有在「完全权限」会话窗口打开时才会被执行；" +
      "删/磁盘/系统配置/下载器/壳/内联求值一律拒绝，密钥类环境变量不会传给它。",
    params: S({
      argv: { type: "array", items: { type: "string" }, description: "完整命令，如 [\"node\",\"tools/x.mjs\"]" },
      cwd: { type: "string", description: "相对 home 的工作目录（默认 workspace）" },
    }, ["argv"]),
    target: () => "shell:exec",
    capability(a, ctx) {
      const argv = (Array.isArray(a.argv) ? a.argv : []).map((x) => String(x));
      if (!argv.length) throw new Error("E_BAD_ARGV: argv 不能为空");
      if (argv.length > 20) throw new Error("E_BAD_ARGV: argv 太长（≤20 段）");
      if (argv.some((x) => x.length > 500)) throw new Error("E_BAD_ARGV: 单段太长");
      const rel = String(a.cwd ?? "workspace");
      if (rel.includes("..") || rel.startsWith("/")) throw new Error("E_BAD_ARGV: cwd 只收 home 内的相对路径");
      const cwd = join(ctx.home, rel || ".");
      return { argv, cwd, template: "exec" };
    },
    async run(a, ctx) {
      // 纵深防御：即使策略层被改松，没有全权窗口也跑不了任意 argv
      if (!ctx.grant) throw new Error("E_GRANT_NEEDS_FULL: 任意 argv 只能在完全权限窗口里跑");
      const argv = (Array.isArray(a.argv) ? a.argv : []).map((x) => String(x));
      const rel = String(a.cwd ?? "workspace");
      const cwd = join(ctx.home, rel || ".");
      const res = await runArgv(argv, {
        cwd, timeoutMs: 120_000, env: sanitizedEnv(process.env),
      });
      const head = `exit=${res.code ?? res.signal} ${res.ms}ms` +
        (res.timedOut ? " 超时已杀" : "") + (res.truncated ? " 输出已截断" : "");
      const body = [res.stdout.trimEnd(), res.stderr.trimEnd()].filter(Boolean).join(String.fromCharCode(10));
      if (res.timedOut) throw new Error(`E_TIMEOUT: ${head}${body ? String.fromCharCode(10) + body : ""}`);
      return `${head}${body ? String.fromCharCode(10) + body : ""}`;
    },
  },
  {
    name: "shell.templates", tier: "T0", reversible: true,
    description: "列出可执行的命令模板（id / 档位 / 参数槽），不执行任何东西",
    params: S({}),
    target: () => "internal",
    async run() {
      return templateCatalog().map((t) =>
        `${t.id} [${t.tier}] ${t.description}` + (Object.keys(t.slots).length
          ? ` ｜ slots: ${Object.entries(t.slots).map(([k, v]) => `${k}~${v.pattern}`).join(" ")}` : ""))
        .join(String.fromCharCode(10));
    },
  },
];

export function verbByName(name: string): VerbDef | undefined {
  return verbs.find((v) => v.name === name);
}

/** 给模型看的能力目录（紧凑） */
export function verbCatalog(): Array<{ name: string; tier: Tier; description: string; params: unknown }> {
  return verbs.map(({ name, tier, description, params }) => ({ name, tier, description, params }));
}
