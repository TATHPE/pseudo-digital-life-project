/**
 * 提议（K-2）：让它会**提要求**，而不是只会照做。
 *
 * 一张卡 = 我想做 X · 为什么 · 大概怎么做 · 确切 argv · 影响哪些文件 · 风险。
 * 人看完可以说"不做"，也可以直接照着跑。
 *
 * 三条边界（和 T3 的待确认卡刻意分开）：
 *  ① **提议不执行**。这里只写文件；执行要走 K-3 的会话授权或人自己跑。
 *     `argv` 是**数据**，没人会拿它去 spawn —— 它不是"待确认命令"。
 *  ② **提议会过期地堆积**：不设 15 分钟时效（那是给命令的），但 open 的超过 12 张就不再收，
 *     否则一夜之间能刷出一屏噪音，人只会全部忽略。
 *  ③ **同一件事只留一张**：按归一化标题去重，重复提交只把 seen 加一。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.ts";

export type ProposalStatus = "open" | "accepted" | "rejected";
export type Risk = "low" | "medium" | "high";

export interface Proposal {
  id: string;
  at: string;
  title: string;
  why: string;
  plan: string[];
  /** 确切命令（数据，不执行）。人想跑就自己跑，或者 K-3 授权后由它跑 */
  argv: string[];
  /** 影响的文件（仓库相对路径，只能是 jingjing/ 或 docs/ 下） */
  touches: string[];
  risk: Risk;
  status: ProposalStatus;
  /** 同一件事被提过几次 */
  seen: number;
  result?: string;
  from: string;
}

export const proposalDir = (home: string) => join(home, "pending");
export const PROPOSAL_CAP = 12;
const ID_RE = /^prp_[0-9a-z]{6,40}$/;
const MAX_TITLE = 80;
const MAX_WHY = 400;
const MAX_PLAN = 8;
const MAX_ARGV = 12;
const MAX_TOUCH = 20;
/** argv 的第一个词只收这些 —— 不是"执行白名单"，是"别让一张卡看起来像能做任何事" */
const BINS = new Set(["node", "npm", "git", "python", "py", "ffmpeg", "ffprobe", "jingjing"]);
const ROOTS = ["jingjing/", "docs/"];

export const newProposalId = (now = new Date()): string =>
  `prp_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const pathOf = (home: string, id: string): string => {
  if (!ID_RE.test(id)) throw new Error(`E_PROPOSAL_ID: ${id}`);
  return join(proposalDir(home), id + ".json");
};

/** 归一化标题：去空白与标点，用来判"同一件事" */
export const titleKey = (title: string): string =>
  title.toLowerCase().replace(/[\s，。！？、；：""''（）()【】[\]…—·.,!?:;"'`~@#$%^&*+=|\\/<>-]/g, "");

const oneLine = (s: unknown, max: number): string =>
  String(s ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

/** touches 的闸：只收仓库内相对路径，且必须在 jingjing/ 或 docs/ 下 */
export function normalizeTouches(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : [];
  const out: string[] = [];
  for (const raw of arr.slice(0, MAX_TOUCH)) {
    const p = String(raw ?? "").replace(/\\/g, "/").trim();
    if (!p) continue;
    if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) throw new Error(`E_PROPOSAL_TOUCH_ABS: ${p}`);
    const segs = p.split("/");
    if (segs.some((s) => s === ".." || s === ".")) throw new Error(`E_PROPOSAL_TOUCH_DOTDOT: ${p}`);
    if (!ROOTS.some((r) => p.startsWith(r))) throw new Error(`E_PROPOSAL_TOUCH_ROOT: ${p}（只收 ${ROOTS.join(" / ")} 下的路径）`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** argv 的闸：只做形状校验。它是给人看的命令，不是待执行队列。 */
export function normalizeArgv(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : input ? [input] : [];
  const out = arr.slice(0, MAX_ARGV).map((x) => oneLine(x, 200)).filter(Boolean);
  if (!out.length) return [];
  const bin = out[0]!.replace(/\.(exe|cmd|sh)$/i, "");
  if (!BINS.has(bin)) throw new Error(`E_PROPOSAL_ARGV_BIN: ${out[0]}（只收 ${[...BINS].join(" / ")}）`);
  if (out.some((a) => a.includes("&&") || a.includes("|") || a.includes(";"))) {
    throw new Error("E_PROPOSAL_ARGV_PIPE: 一条卡只放一条命令，别塞管道/串联");
  }
  return out;
}

export function createProposal(
  home: string,
  input: { title: unknown; why: unknown; plan?: unknown; argv?: unknown; touches?: unknown; risk?: unknown; from?: unknown },
  now = new Date(),
): { proposal: Proposal; deduped: boolean } {
  const title = oneLine(input.title, MAX_TITLE);
  if (title.length < 4) throw new Error("E_PROPOSAL_TITLE: 标题太短（至少 4 个字）");
  const why = oneLine(input.why, MAX_WHY);
  if (why.length < 4) throw new Error("E_PROPOSAL_WHY: 得说为什么（至少 4 个字）");

  const plan = (Array.isArray(input.plan) ? input.plan : [])
    .slice(0, MAX_PLAN).map((x) => oneLine(x, 200)).filter(Boolean);
  const argv = normalizeArgv(input.argv);
  const touches = normalizeTouches(input.touches);
  const riskIn = String(input.risk ?? "low");
  const risk: Risk = riskIn === "high" || riskIn === "medium" ? (riskIn as Risk) : "low";

  const open = listProposals(home, { status: "open" });
  const key = titleKey(title);
  const dup = open.find((p) => titleKey(p.title) === key);
  if (dup) {
    const bumped: Proposal = { ...dup, seen: dup.seen + 1 };
    atomicWriteFile(pathOf(home, dup.id), JSON.stringify(bumped, null, 2));
    return { proposal: bumped, deduped: true };
  }
  if (open.length >= PROPOSAL_CAP) {
    throw new Error(`E_PROPOSAL_BACKLOG: 已经有 ${open.length} 张没回应的卡了，先把它们处理掉（jingjing proposal list）`);
  }

  const p: Proposal = {
    id: newProposalId(now),
    at: now.toISOString(),
    title, why, plan, argv, touches, risk,
    status: "open",
    seen: 1,
    from: oneLine(input.from, 20) || "agent",
  };
  const dir = proposalDir(home);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFile(pathOf(home, p.id), JSON.stringify(p, null, 2));
  return { proposal: p, deduped: false };
}

export function listProposals(home: string, opts: { status?: ProposalStatus | "all" } = {}): Proposal[] {
  const dir = proposalDir(home);
  if (!existsSync(dir)) return [];
  const want = opts.status ?? "open";
  const out: Proposal[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("prp_") || !f.endsWith(".json")) continue;
    try {
      const p = JSON.parse(readFileSync(join(dir, f), "utf8")) as Proposal;
      if (want !== "all" && p.status !== want) continue;
      out.push(p);
    } catch { /* 坏文件跳过，不炸整个列表 */ }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export function getProposal(home: string, id: string): Proposal | null {
  try {
    const f = pathOf(home, id);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8")) as Proposal;
  } catch { return null; }
}

export function setProposalStatus(
  home: string, id: string, status: ProposalStatus, result?: string,
): Proposal | null {
  const p = getProposal(home, id);
  if (!p) return null;
  const next: Proposal = { ...p, status, ...(result ? { result: oneLine(result, 400) } : {}) };
  atomicWriteFile(pathOf(home, id), JSON.stringify(next, null, 2));
  return next;
}
