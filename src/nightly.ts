/**
 * 闲时整理（01 §9）：消化 inbox → 抽取 → 冲突消解 → 归并。
 *
 * 设计取舍：
 *  · 抽取用**本地模型**（role=extract，W-A：能看到记忆原文的角色必须 local）
 *  · 冲突判定优先用**确定性规则**（可测、可解释）；模型判定只用于可选分支
 *  · 游标存 meta.nightly_cursor_ts：断电/重跑都不会重复消化
 *  · 宁缺毋滥：模型给出 0 条是正常结果，不追问
 */
import type { DatabaseSync } from "node:sqlite";
import { readEvents, type Event } from "./journal.ts";
import { remember, tickDecay } from "./store.ts";
import type { Embedder } from "./embed.ts";
import { NIGHTLY_KINDS, type Layer } from "./decay.ts";
import { readMeta } from "./embedindex.ts";

export interface Candidate {
  kind: string;
  layer: Layer;
  subject: string;
  text: string;
  salience: number;
  reason: string;
}

export type Verdict = "duplicate" | "supersede" | "refine";

export interface NightlyDeps {
  db: DatabaseSync;
  inboxDir: string;
  home: string;
  embedder: Embedder | null;
  /** 调本地模型做抽取（非流式）。返回模型原始文本 */
  extract: (prompt: string) => Promise<string>;
  /**
   * **纯文本**补全（不带工具 schema），只给「她对你的理解」那一层用。
   * 说明：extract 是带工具的抽取器，小模型拿到工具会去调工具而不是回一句话。
   */
  complete?: (prompt: string) => Promise<string>;
  /** 每个窗口多少条事件（P1-1a：长上下文会稀释注意力，默认 20） */
  windowSize?: number;
  /**
   * E-7：对**同一批**事件重复巩固几轮（默认 1，上限 5）。
   * 用途只有一个：能不能回答「再巩固一次会不会更好」。
   * 判据是收敛 —— 最后一轮没有新增、没有新反证；不是「跑得越多越好」。
   * 来源：Google《Language Models Need Sleep》用轮次单调性证明巩固有效，我们没有这个度量。
   */
  rounds?: number;
  /** 打分者的名字（E-3）：写进 scored_by，让“这条为什么重”能查 */
  scoredBy?: string;
  /**
   * 降级：有值就**不抽**，但仍算衰减（E-6）。
   * 为什么要这条：energy 的唯一恢复点在 `night` 末尾的 advance({night:true})，
   * 而以前缺模型在更早的地方就 return 2 了 —— 于是每聊 50 句 energy 掉一整格，永远回不来。
   * 不可达 ≠ 失败：能做的部分照做，不能做的部分说清楚。
   */
  skipExtract?: string;
  /** 冲突判定的可选模型分支（模糊带）。不给就纯规则 */
  verdict?: (a: { oldText: string; newText: string }) => Promise<Verdict>;
  now?: Date;
  maxItems?: number;
  fuzzyThreshold?: number;
}

export interface NightlyReport {
  scanned: number;
  candidates: number;
  added: number;
  noop: number;
  superseded: number;
  refined: number;
  /** P1-2：被跨层合并掉的条数（同一件事在 narrative / contract 各出现一次） */
  merged: number;
  /** 写前反证：命中了反面证据的条数（建 contradicts 边，交人去判） */
  contradicted: number;
  /** E-7：每轮（同一批事件重复巩固）的数字 */
  rounds: Array<{ n: number; candidates: number; added: number; noop: number; merged: number; superseded: number; contradicted: number }>;
  /** E-7：收敛 = 最后一轮没有新增、没有新反证（这批事件已经榨干了）。只跑 1 轮时为 null */
  converged: boolean | null;
  decayed: number;
  cursorFrom: string | null;
  cursorTo: string | null;
  ms: number;
  notes: string[];
}

/**
 * 留痕（2026-11-03）：每夜跑完写一条 events，成功失败都写。
 *
 * 用户的原话：「本地 LLM 在我这里完全未知，我根本就不知道它在干什么」。
 * 查下来是真的：events 表里 night / extract / decay_run 全是 0 ——
 * 报告只出现在 CLI 的 stdout 里，没人跑 CLI 就等于没发生过。
 *
 * 只存数字与结论，不存正文（正文已经在 memories 里了）。
 */
function recordNight(
  db: DatabaseSync,
  report: NightlyReport,
  now: Date,
  failed: boolean,
): void {
  try {
    const payload = {
      scanned: report.scanned,
      candidates: report.candidates,
      added: report.added,
      merged: report.merged,
      superseded: report.superseded,
      refined: report.refined,
      contradicted: report.contradicted,
      decayed: report.decayed,
      rounds: report.rounds.length,
      converged: report.converged,
      ms: report.ms,
      cursorTo: report.cursorTo,
      notes: report.notes.slice(0, 5),
    };
    db.prepare("INSERT INTO events(ts,kind,actor,target,payload,ok) VALUES(?,?,?,?,?,?)").run(
      now.toISOString(), "night", "system", "nightly", JSON.stringify(payload), failed ? 0 : 1,
    );
  } catch { /* 留痕失败不该拖垮整备 */ }
}

/** 记一笔“今晚没抽”（/health 的 degraded 读它）。成功跑完就清掉。 */export function noteNightlySkip(db: DatabaseSync, reason: string, now: Date): void {
  db.prepare("INSERT INTO meta(key,value) VALUES('nightly_skipped',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`${now.toISOString()} ${reason}`);
}

export function clearNightlySkip(db: DatabaseSync): void {
  db.prepare("DELETE FROM meta WHERE key='nightly_skipped'").run();
}

/**
 * 原话（J-2）：从当晚的真实对话里找最像这条记忆的那一句。
 *
 * 为什么不让模型自己交“原话”：那就不是原话了，是模型再写一遍。
 * 这里用字面重合挑，且只接受**逐字子串**（宁缺毋滥：挑不出就存 null）。
 */
export function pickQuote(events: readonly Event[], memoryText: string): string | null {
  const target = new Set(bigramsFor(memoryText));
  if (!target.size) return null;
  let best: { text: string; score: number } | null = null;
  for (const e of events) {
    const t = String((e.payload as { text?: string })?.text ?? "").trim();
    if (!t || t.length > 120) continue;          // 原话要短，长段落不算“那一句”
    const b = bigramsFor(t);
    let hit = 0;
    for (const x of b) if (target.has(x)) hit++;
    const score = hit / Math.max(1, Math.min(b.length, target.size));
    // 阈值 0.28：实测「不要叫他助手，直接叫名字」与原话「以后别叫我「助手」，叫名字就行」重合 0.30，
    // 0.34 会漏。原话取自 journal 逐字，放宽的代价只是“贴得稍不切题”，不会变成编造。
    if (score >= 0.28 && (!best || score > best.score)) best = { text: t, score };
  }
  return best ? best.text.slice(0, 120) : null;
}

function bigramsFor(s: string): string[] {
  const out: string[] = [];
  const t = s.replace(/[\s，。！？、；：""''（）()【】\[\]…—]/g, "");
  for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2));
  return out;
}

/**
 * 建边之前先过黑名单（J-5）：人拆过的线**永不自动接回**。
 * 黑名单存在 meta.links_blocked："src:dst:rel" 一行一个。
 */
export function linkIfNew(
  db: DatabaseSync, src: number, dst: number, rel: string, weight: number, why: string, now: Date,
): boolean {
  const key = `${src}:${dst}:${rel}`;
  const blocked = String(readMeta(db, "links_blocked") ?? "");
  if (blocked.split(String.fromCharCode(10)).includes(key)) return false;
  db.prepare(
    `INSERT INTO memory_links(src_id,dst_id,rel,weight,why,created_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(src_id,dst_id,rel) DO UPDATE SET weight=excluded.weight`,
  ).run(src, dst, rel, weight, String(why || "").slice(0, 20), now.toISOString());
  return true;
}



/**
 * 抽取提示（P1-1a）。
 *
 * 改版原因（实测）：原来的长规则列表 + 88 条事件上下文 → qwen2.5:7b 直接回 []；
 * 同一批尾部对话用"短提示 + 一个例子"却能抽出 2 条。
 * 结论：7B 对**例子**敏感、对规则列表不敏感，且长上下文会稀释注意力。
 */
export const EXTRACT_PROMPT = (transcript: string): string => [
  "你是记忆抽取器。读下面的对话，只输出 JSON 数组（不要解释、不要代码围栏）。",
  '每条：{"kind":"episode|thought|preference_hard|fact_hard|promise|boundary","layer":"narrative|contract","subject":"≤8字","text":"一句话","salience":0.9,"reason":"为什么值得记"}',
  "",
  "只记**她经历/被告知的**；你读到的书/文档不算她的经历（那要走 reading，不是这里）。",
  "值得记：承诺 / 边界 / 硬事实（→contract）、稳定偏好、重要经历、想通了的事。",
  "不值得记：寒暄、测试句、系统提示、重复的话、一次性的闲聊。",
  "最多 3 条；没有值得记的就输出 []。",
  "",
  "例①（值得记）：",
  "对话：用户：以后别叫我助手，叫名字就行",
  '输出：[{"kind":"boundary","layer":"contract","subject":"称呼","text":"不要叫他助手，直接叫名字","salience":0.9,"reason":"明确的称呼边界"}]',
  "",
  "例②（不值得记）：",
  "对话：用户：在吗  鲸鲸：在。",
  "输出：[]",
  "",
  "对话：",
  transcript,
].join(String.fromCharCode(10));

/** 宽松解析：容忍 ```json 围栏、前后废话、单条对象 */
export function parseCandidates(raw: string, cap = 5): Candidate[] {
  const t = raw.replace(/```[a-zA-Z]*/g, "").trim();
  const first = t.indexOf("[");
  const last = t.lastIndexOf("]");
  let arr: unknown = [];
  if (first >= 0 && last > first) {
    try { arr = JSON.parse(t.slice(first, last + 1)); } catch { arr = []; }
  } else {
    const o1 = t.indexOf("{");
    const o2 = t.lastIndexOf("}");
    if (o1 >= 0 && o2 > o1) {
      try { arr = [JSON.parse(t.slice(o1, o2 + 1))]; } catch { arr = []; }
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: Candidate[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = String(o.text ?? "").trim();
    if (!text || text.length > 200) continue;
    const layer: Layer = o.layer === "contract" ? "contract" : "narrative";
    out.push({
      kind: String(o.kind ?? (layer === "contract" ? "promise" : "episode")).slice(0, 24),
      layer,
      subject: String(o.subject ?? "").slice(0, 16),
      text,
      salience: Math.max(0, Math.min(1, Number(o.salience ?? 0.3) || 0.3)),
      reason: String(o.reason ?? "").slice(0, 120),
    });
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 噪声行（P1-1a）：这些进了上下文只会稀释注意力。
 * 只看**文本本身**，不看事件类型——噪声的特征在文字里。
 *
 * 阈值取 4 而不是 6：中文 4–5 字就可能是完整信息（"我住在杭州"），
 * 实测 6 会把它误杀，连带把真记忆一起丢掉。
 */
export function isNoise(text: string): boolean {
  const t = String(text ?? "").trim();
  if (t.length < 4) return true;
  if (/^进程被杀|^断电|^关机|其间无经历|信号中断/.test(t)) return true;
  if (/用三个字回答|用两个字回答|说一句就行/.test(t)) return true;
  if (/^(在|好|嗯|行|来了来了|记住了)[。！]?$/.test(t)) return true;
  return false;
}

/** 把事件切成若干窗口（每段单独问一次模型）：长上下文会稀释注意力 */
export function segmentEvents<T>(items: readonly T[], max = 20): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += max) out.push(items.slice(i, i + max));
  return out;
}

const PUNCT = /[\s，。！？、；：""''（）()【】\[\]…—]/g;const normalize = (s: string): string => s.toLowerCase().replace(PUNCT, "");

/**
 * 层强弱（P1-2）：contract 永不衰减、参与动作闸门 → 同一件事只该以 contract 存在。
 * 跨层重复时**保留强的、吞掉弱的**，而不是两份都留着把计数撑大。
 */
const LAYER_RANK: Record<Layer, number> = { narrative: 1, contract: 2 };

/**
 * 字符二元组 Jaccard：判断"是不是同一件事"，而不是"同一个话题"。
 * 光看 cosine 不够：bge-m3 里「生日买蛋糕」和「生日那天吵架」能到 0.9，但它们是两件事。
 */
export function bigramSim(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = normalize(s);
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    if (!out.size && t) out.add(t);
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / (A.size + B.size - hit);
}

/**
 * 极性：这句话是肯定还是否定。用来判"是不是反面证据"。
 * 只做字面判定（不调模型）：漏掉一些说法可以接受，把两件无关的事判成矛盾才是灾难。
 */
const NEGATIVE = /不|没|别|取消|改成|不再|拒绝|讨厌|不想|停止|忘了/;
export const polarity = (text: string): "neg" | "pos" => (NEGATIVE.test(text) ? "neg" : "pos");

/**
 * 写前反证（借自衔枝的"反证搜索"，这里用规则而不是 HyDE）：
 * 写入前先找**同一话题但极性相反**的既有记忆。
 *   · 向量 ≥ 0.75（同一话题，比"同一件事"的 0.92 松）
 *   · 字面 ≥ 0.2（防止只靠向量的假近邻）
 *   · 极性相反
 * 命中不是自动否决，而是建一根 contradicts 边、双方信心各降 0.1，然后**进抽检卡给人看** ——
 * 「两条都留、同时呈现」是文档 02 §8.2 的原则，这里只负责把它变成看得见的东西。
 */
function findCounterEvidence(
  db: DatabaseSync,
  vec: Float32Array,
  text: string,
): { id: number; text: string; cos: number; sim: number } | null {
  const mine = polarity(text);
  const rows = db
    .prepare(`SELECT id, text, embedding FROM memories
              WHERE status='active' AND embedding IS NOT NULL AND valid_to IS NULL
              ORDER BY id DESC LIMIT 500`)
    .all() as Array<{ id: number; text: string; embedding: Uint8Array }>;
  let best: { id: number; text: string; cos: number; sim: number } | null = null;
  for (const r of rows) {
    if (polarity(r.text) === mine) continue;        // 同极性不构成反证
    const old = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
    const cos = cosine(vec, old);
    if (cos < 0.75) continue;
    const sim = bigramSim(r.text, text);
    if (sim < 0.2) continue;
    if (!best || cos > best.cos) best = { id: r.id, text: r.text, cos, sim };
  }
  return best;
}

/**
 * 找"同一件事"：槽位键是 `layer|subject`，所以两处都撞不见 ——
 *   · 同内容落到不同层（contract 的承诺 + narrative 的经历）
 *   · 模型给同一件事起了不同 subject（"生日" vs "生日提醒"）
 * 这里按**向量 + 二元组双重判定**，只扫最近 500 条 active。
 * 注意：embedding 单独相似不够（同一个话题会被压得很近），必须再过字面闸门。
 */
function findSameThing(
  db: DatabaseSync,
  vec: Float32Array,
  text: string,
  threshold: number,
): { id: number; layer: Layer; text: string; cos: number; sim: number } | null {
  const rows = db
    .prepare(`SELECT id, layer, text, embedding FROM memories
              WHERE status='active' AND embedding IS NOT NULL
              ORDER BY id DESC LIMIT 500`)
    .all() as Array<{ id: number; layer: string; text: string; embedding: Uint8Array }>;
  let best: { id: number; layer: Layer; text: string; cos: number; sim: number } | null = null;
  for (const r of rows) {
    const old = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
    const cos = cosine(vec, old);
    if (cos < threshold) continue;
    const sim = bigramSim(r.text, text);
    if (sim < 0.35) continue;                     // 同一个话题 ≠ 同一件事
    if (!best || cos > best.cos) best = { id: r.id, layer: r.layer as Layer, text: r.text, cos, sim };
  }
  return best;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += (a[i] ?? 0) * (b[i] ?? 0);
  return d; // 两边都已 L2 归一化
}

export async function runNightly(deps: NightlyDeps): Promise<NightlyReport> {
  const t0 = Date.now();
  const now = deps.now ?? new Date();
  const notes: string[] = [];
  const cap = deps.maxItems ?? 5;
  const th = deps.fuzzyThreshold ?? 0.92;

  const cursorRow = deps.db.prepare("SELECT value FROM meta WHERE key='nightly_cursor_ts'").get() as { value?: string } | undefined;
  const cursorFrom = cursorRow?.value ?? null;

  const { events } = readEvents(deps.inboxDir);
  const fresh: Event[] = events.filter(
    (e) => (e.kind === "utterance" || e.kind === "agent_reply") && (!cursorFrom || e.ts > cursorFrom),
  );

  const report: NightlyReport = {
    scanned: fresh.length,
    candidates: 0,
    added: 0,
    noop: 0,
    superseded: 0,
    merged: 0,
    contradicted: 0,
    rounds: [],
    converged: null,
    refined: 0,
    decayed: 0,
    cursorFrom,
    cursorTo: fresh.length ? fresh[fresh.length - 1]!.ts : cursorFrom,
    ms: 0,
    notes,
  };

  if (deps.skipExtract) {
    // 只算衰减 + 记一笔，游标**不动**（等模型到位再把这段 digest 掉，否则直接丢了）
    report.cursorTo = cursorFrom;
    report.decayed = tickDecay(deps.db, now);
    notes.push(`SKIPPED: ${deps.skipExtract}`);
    noteNightlySkip(deps.db, deps.skipExtract, now);
    report.ms = Date.now() - t0;
    // 留痕（2026-11-03）：缺模型也得记一条 —— 否则「它今晚没干活」在历史里是隐形的，
    // 用户只会觉得「这个功能从来没启动过」（他确实是这么问的）。
    recordNight(deps.db, report, now, true);
    return report;
  }

  if (!fresh.length) {
    report.decayed = tickDecay(deps.db, now);
    clearNightlySkip(deps.db);
    report.ms = Date.now() - t0;
    report.notes.push("没有新事件可整理（游标之后是空的）");
    // 留痕：点了按钮、跑了、但没有新东西 —— 这也是一条真实结果，不能什么都不说。
    recordNight(deps.db, report, now, false);
    return report;
  }

  // P1-1a：先把噪声剔掉（短句 / 测试句 / 断电提示），再**分段**问。
  // 实测：88 条原始事件 → 模型回 []；同样的尾部用短提示 + 分段能抽出东西。
  const rounds = Math.min(5, Math.max(1, Math.round(deps.rounds ?? 1)));
  // 本轮开跑前库里最大的 id：这一轮里新写进去的条目记在水位线之上。
  // 用它在 supersede 分支里拦住“自己取代自己”（第二轮把第一轮刚写的那条取代了 ——
  // 真机跑 E-7 时就是这样：第 2 轮 added=0 但 superseded=1，同一批里 ping-pong）。
  const runFloorId = Number((deps.db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM memories").get() as { m: number }).m ?? 0);
  // 抽取失败要能影响**整个** run（游标不推进），所以旗子放在循环外，每轮开头复位
  let extractFailed = false;
  for (let round = 1; round <= rounds; round++) {
    // 每一轮都**重新读同一批**事件（游标要等所有轮结束才动）——
    // 第二轮的作用是让去重/合并/反证这些闸门有机会把第一轮写进去的东西再判一次。
    const textOf = (e: Event) => String((e.payload as { text?: string })?.text ?? "");
    const usable = fresh.filter((e) => !isNoise(textOf(e)));
    const dropped = fresh.length - usable.length;
    if (dropped) notes.push(`NOISE: 跳过 ${dropped} 条噪声`);

    const windows = segmentEvents(usable, deps.windowSize ?? 20);
    let cands: Candidate[] = [];
    for (const [i, win] of windows.entries()) {
      const transcript = win
        .map((e) => `${e.kind === "utterance" ? "用户" : "鲸鲸"}：${textOf(e)}`)
        .join(String.fromCharCode(10));
      try {
        const raw = await deps.extract(EXTRACT_PROMPT(transcript));
        const got = parseCandidates(raw, cap);
        notes.push(`WINDOW ${i + 1}/${windows.length}: ${win.length} 条 → ${got.length} 条候选`);
        for (const c of got) {
          // 跳窗口去重（同一句话被两段都抽到）
          if (!cands.some((x) => x.layer === c.layer && normalize(x.text) === normalize(c.text))) cands.push(c);
        }
      } catch (e) {
        // 抽取失败 ≠ 今天没什么可记的：**游标不能推进**，否则这批对话永久丢掉
        extractFailed = true;
        notes.push(`E_EXTRACT: ${String(e).slice(0, 120)}`);
        break;
      }
    }
    cands.splice(cap);   // 总量上限：宁缺毋滥
    report.candidates = cands.length;



    const before = { added: report.added, noop: report.noop, merged: report.merged,
      superseded: report.superseded, contradicted: report.contradicted };
    for (const c of cands) {
      const vec = deps.embedder ? (await deps.embedder.embed([c.text]))[0] ?? null : null;

      // 同层同主题的既有记忆（subject 归一化后作为"槽位"）
      const key = `${c.layer}|${normalize(c.subject)}`;
      const same = deps.db
        .prepare(`SELECT id,text,embedding FROM memories
                  WHERE status='active' AND layer=? AND normalized_key=? LIMIT 20`)
        .all(c.layer, key) as Array<{ id: number; text: string; embedding: Uint8Array | null }>;

      let verdict: Verdict | null = null;
      let target: number | null = null;

      for (const s of same) {
        if (normalize(s.text) === normalize(c.text)) { verdict = "duplicate"; target = s.id; break; }
        if (vec && s.embedding) {
          const old = new Float32Array(s.embedding.buffer, s.embedding.byteOffset, s.embedding.byteLength / 4);
          const cos = cosine(vec, old);
          if (cos >= th) {
            verdict = deps.verdict ? await deps.verdict({ oldText: s.text, newText: c.text }) : "supersede";
            target = s.id;
            break;
          }
          if (cos >= 0.75) { verdict = "refine"; target = s.id; }
        }
      }

      // P1-2：同槽位撞不见时，再按"同一件事"跨层找一次。
      // 真实案例："下周三生日提醒买蛋糕" 被抽成 contract/promise 和 narrative/promise 两份，
      // 因为槽位键带 layer，两份都留下了 —— 计数虚高，检索时也会重复浮现。
      if (!verdict && vec) {
        const cross = findSameThing(deps.db, vec, c.text, th);
        if (cross && LAYER_RANK[c.layer] > LAYER_RANK[cross.layer]) {
            // 新的是强层（contract）→ 覆盖掉旧的弱层版本
            verdict = "supersede";
            target = cross.id;
            notes.push(`MERGE↑ ${c.layer}>${cross.layer} 覆盖 #${cross.id}（cos ${cross.cos.toFixed(2)} 字面 ${cross.sim.toFixed(2)}）`);
        } else if (cross) {
          // 弱层版本或同层另一个槽位 → 不插，只抬旧条 confidence（同一件事不该有第二份）
          deps.db.prepare("UPDATE memories SET confidence=MIN(1,confidence+0.05), updated_at=? WHERE id=?")
            .run(now.toISOString(), cross.id);
          report.merged++;
          const arrow = c.layer === cross.layer ? "=" : "<";
          notes.push(`MERGE${arrow} ${c.layer}${arrow}${cross.layer} 吞掉（#${cross.id} 已有）：${c.text.slice(0, 18)}`);
          continue;
        }
      }

      if (verdict === "duplicate" && target != null) {
        deps.db.prepare("UPDATE memories SET confidence=MIN(1,confidence+0.05), updated_at=? WHERE id=?")
          .run(now.toISOString(), target);
        report.noop++;
        notes.push(`NOOP ${c.text.slice(0, 20)}`);
        continue;
      }

      // 写前反证：先看有没有"同一话题、极性相反"的既有记忆
      const counter = vec ? findCounterEvidence(deps.db, vec, c.text) : null;

      const id = remember(deps.db, {
        layer: c.layer,
        kind: c.kind,
        subject: c.subject || null,
        text: c.text,
        importance: c.layer === "contract" ? 5 : Math.round(2 + c.salience * 3),
        salience: c.salience,
        sensitivity: "shareable",           // 聊天来源 → 已出过网（19 §0.1）
        sourceKind: "extract",
        sourceRef: c.reason.slice(0, 80),
        // 原话（J-2）：**从 journal 里逐字取**，不采信模型转述 —— 否则“原话”又变成模型写的
        quote: pickQuote(fresh, c.text) ?? null,
        scoredBy: deps.scoredBy ?? "extract",
        embedding: vec,
        now,
      });
      // 归一化键（源里叫 normalized_key，store 负责写 text_bigram；这里补 key）
      deps.db.prepare("UPDATE memories SET normalized_key=? WHERE id=?").run(key, id);
      if (counter) {
        // 两条都留、都降一点信心，建一根 contradicts —— 然后它会自己出现在抽检卡上
        linkIfNew(deps.db, id, counter.id, "contradicts", 0.6,
          `反证：极性相反（cos ${counter.cos.toFixed(2)} / 字面 ${counter.sim.toFixed(2)}）`.slice(0, 60), now);
        for (const mid of [id, counter.id]) {
          deps.db.prepare("UPDATE memories SET confidence=MAX(0.3, confidence-0.1) WHERE id=?").run(mid);
        }
        report.contradicted++;
        notes.push(`COUNTER #${counter.id}：${counter.text.slice(0, 24)} ↔ ${c.text.slice(0, 24)}`);
      }

      if (verdict === "supersede" && target != null && target > runFloorId) {
        // 想取代的是**这一轮刚写的**条目 → 当作重复：不归档、不建边，只抬信心
        deps.db.prepare("UPDATE memories SET confidence=MIN(1,confidence+0.05), updated_at=? WHERE id=?")
          .run(now.toISOString(), target);
        report.noop++;
        notes.push(`SELF-SUPERSEDE→NOOP ${c.text.slice(0, 18)}`);
      } else if (verdict === "supersede" && target != null) {
        deps.db.prepare("UPDATE memories SET superseded_by=?, status='archived', updated_at=? WHERE id=?")
          .run(id, now.toISOString(), target);
        linkIfNew(deps.db, id, target, "supersedes", 1, "同一件事的新说法", now);
        report.superseded++;
        notes.push(`SUPERSEDE ${c.text.slice(0, 20)}`);
      } else if (verdict === "refine" && target != null) {
        linkIfNew(deps.db, id, target, "derived_from", 0.8, (c.reason || c.subject || "同一段经历").slice(0, 20), now);
        report.refined++;
        report.added++;
      } else {
        report.added++;
      }
    }


    // 失败的那一轮不记成一轮：它没告诉我们任何关于收敛的信息
    if (extractFailed) break;
    report.rounds.push({
      n: round, candidates: cands.length,
      added: report.added - before.added,
      noop: report.noop - before.noop,
      merged: report.merged - before.merged,
      superseded: report.superseded - before.superseded,
      contradicted: report.contradicted - before.contradicted,
    });
    if (extractFailed) break;
    const last = report.rounds[report.rounds.length - 1]!;
    // 收敛：这一轮什么都没学到（也没有新反证）→ 再跑也是空转，停
    if (round > 1 && last.added === 0 && last.contradicted === 0) { report.converged = true; break; }
    if (last.candidates === 0) { if (round > 1) report.converged = true; break; }
  }
  if (rounds > 1 && report.converged === null && !extractFailed) report.converged = false;
  if (extractFailed) {
    report.cursorTo = cursorFrom;                       // 失败就留在原地，下轮重试
    noteNightlySkip(deps.db, "抽取失败（见 notes.E_EXTRACT）", now);
    report.decayed = tickDecay(deps.db, now);
    report.ms = Date.now() - t0;
    recordNight(deps.db, report, now, true);   // 失败也留痕：不然只剩静默
    return report;
  }
  if (report.cursorTo) {
    deps.db.prepare("INSERT INTO meta(key,value) VALUES('nightly_cursor_ts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(report.cursorTo);
  }
  report.decayed = tickDecay(deps.db, now);
  // 三段侵蚀（学 whale-card）：衰减之后再看谁已经低到该「忘掉细节」了。
  // 顺序要紧：先重算权重，再决定侵蚀 —— 否则用的是上一轮的旧权重。
  try {
    const { tickErosion } = await import("./erosion.ts");
    const er = tickErosion(deps.db, now);
    if (er.eroded || er.archived) report.notes.push("ERODE: 侵蚀 " + er.eroded + " 条 / 归档 " + er.archived + " 条");
  } catch { /* 侵蚀失败不拖垮整备 */ }
  // ── 她对你的理解（2026-11-03）：这一层之前**从来没有被写入过** ──
  // interpret.ts 的机制写得很完整（必须带 basis、不许复述、改看法要 supersede），
  // 但 writeInterpretation 全仓只有定义、没有调用方 → 简报 P13 永远是空的。
  // 只在「这一轮真的学到了新东西」时才提炼：没有新记忆就没有新理解，省一次模型调用。
  if (!deps.skipExtract && (report.added > 0 || report.merged > 0 || report.refined > 0)) {
    try {
      const { refineInterpretations } = await import("./interpretnight.ts");
      // 优先用纯文本通道；没有就退回 extract（会差一些，但不会崩）
      const ir = await refineInterpretations(deps.db, { complete: deps.complete ?? deps.extract, now });
      report.notes.push("INTERP: 写 " + ir.written + (ir.replaced ? "（其中改写 " + ir.replaced + "）" : "") + (ir.skipped.length ? " · " + ir.skipped.slice(0, 2).join("；") : ""));
    } catch (e) {
      report.notes.push("INTERP: 失败 " + String((e as Error)?.message ?? e).slice(0, 80));
    }
  }

  clearNightlySkip(deps.db);
  report.ms = Date.now() - t0;
  recordNight(deps.db, report, now, report.notes.some((n) => n.startsWith("E_")));
  return report;
}
