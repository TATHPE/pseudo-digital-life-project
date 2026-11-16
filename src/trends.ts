/**
 * 记忆趋势（阶段 5，2026-11-15）：把「近 N 天新增 / 累计 / 衰减」算成能直接画图的结构。
 *
 * 三条硬约束写在文件头，因为它们决定的是**接口形状**，不只是实现细节：
 *
 * 1. **不画「权重随日期变化」**。库里只有每条记忆**当前**的 weight，没有逐日快照。
 *    按天取平均，等于把「今天算出来的值」按到过去每一天上——那是编造历史。
 *    所以衰减曲线的横轴是**记忆年龄**（这条记了多久），不是日期；这个才是真实可算的。
 * 2. **切日必须用 localtime**。created_at 存的是 UTC ISO（now().toISOString()），
 *    直接 substr(0,10) 会让本地 20:00 之后写入的记忆落到第二天（UTC+8）。
 *    单测锁了这条：UTC 16:30 必须算成本地次日。
 * 3. **断片必须能单列**。outage 占 active 的九成，混进趋势会把真实增长压成一条平线。
 *    默认排除，但把被排除的条数如实返回——不假装它们不存在。
 *
 * 与决策 4 的关系：决策 4 限定的是**资源页**只做当前快照（不引入历史采样与时间序列存储）。
 * 这里没有新增任何采样：全部由 memories 表已有的 created_at / w0 / weight 现算。
 * 资源页那份快照仍然只读、不留历史。
 */
import type { DatabaseSync } from "node:sqlite";

/** 与记忆页共用同一口径：断片是「关于机器」的记忆，不是关于人的。 */
export const OUTAGE_SQL =
  "(ifnull(source_ref,'')='startup' OR text LIKE '进程被杀%' OR text LIKE '我睡了%' OR text LIKE '断电%' OR text LIKE '关机%')";

export interface TrendOptions {
  /** 回看天数，默认 30；夹在 1–180 */
  days?: number;
  /** 注入「现在」，便于测试固定时间 */
  now?: Date;
  /** 是否把断片算进趋势，默认 false（排除） */
  includeOutage?: boolean;
}

export interface TrendDay {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  /** 当天新增（不含后来被忘掉的） */
  created: number;
  contract: number;
  narrative: number;
  /** 当天新增里，断片占几条（默认口径下已排除，这里是「被排除了多少」） */
  outage: number;
  /** 截至当天结束的 active 累计 */
  cumulative: number;
}

export interface DecayBucket {
  label: string;
  lo: number;
  hi: number | null;
  n: number;
  avgW0: number;
  avgWeight: number;
  /** 平均保留率 avgWeight / avgW0；1 = 一点没掉，0.05 基本到底了 */
  keep: number;
}

export interface KindDecay {
  kind: string;
  n: number;
  avgW0: number;
  avgWeight: number;
  keep: number;
}

export interface MemoryTrend {
  days: number;
  from: string;
  to: string;
  daily: TrendDay[];
  decay: DecayBucket[];
  byKind: KindDecay[];
  summary: {
    /** 当前 active 总数（与筛选口径一致） */
    activeNow: number;
    createdInWindow: number;
    /** 窗口开始之前就已存在的条数：累计曲线的起点 */
    beforeWindow: number;
    /** 窗口内新增、但后来被忘掉的（不画进曲线，单独报） */
    deletedInWindow: number;
    /** 窗口内新增的断片数（默认口径下不计入曲线） */
    outageInWindow: number;
    fading: number;
    dormant: number;
    /** 全体 active 的平均保留率 */
    avgKeep: number;
  };
  notes: string[];
}

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 与 recall/decay 一致的 3 位小数，避免 0.30000000000000004 这种数字跑到界面上 */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** 保留率：w0 为 0（历史脏数据）时给 1，别让它变成 Infinity 把整条曲线拉爆 */
const keepOf = (avgW0: number, avgWeight: number): number => (avgW0 > 0 ? round3(avgWeight / avgW0) : 1);

/** 年龄分桶：给人看的是「多老的记忆大概掉到多少」，桶边界取常用刻度 */
const BUCKETS: Array<{ label: string; lo: number; hi: number | null }> = [
  { label: "今天", lo: 0, hi: 1 },
  { label: "1–2 天", lo: 1, hi: 3 },
  { label: "3–6 天", lo: 3, hi: 7 },
  { label: "7–13 天", lo: 7, hi: 14 },
  { label: "14–29 天", lo: 14, hi: 30 },
  { label: "30 天以上", lo: 30, hi: null },
];

export function memoryTrend(db: DatabaseSync, opts: TrendOptions = {}): MemoryTrend {
  // NaN 会让 Math.max/min 一路传染成 NaN —— 直接静默返回一条空曲线（界面白屏）。
  // 非法值回落到默认 30 天，不是夹成 1 天：1 天看着像正常结果，30 天才像"你没传"。
  const rawDays = Math.round(Number(opts.days ?? 30));
  const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(180, rawDays)) : 30;
  const now = opts.now ?? new Date();
  const includeOutage = opts.includeOutage === true;
  // 断片排除是「在过滤条件上加一项」，不是「查完再减」——少了这一步，累计曲线会被断片撑成陡坡
  const scope = includeOutage ? "1=1" : `NOT ${OUTAGE_SQL}`;

  // 窗口按**本地零点**算：用 new Date(y, m, d) 构造，不会跨时区漂
  const startD = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const from = ymd(startD);
  const to = ymd(now);

  // ① 每日新增
  const rows = db.prepare(
    `SELECT date(created_at,'localtime') AS d,
            count(*) AS n,
            sum(CASE WHEN layer='contract' THEN 1 ELSE 0 END) AS contract,
            sum(CASE WHEN layer='narrative' THEN 1 ELSE 0 END) AS narrative,
            sum(CASE WHEN ${OUTAGE_SQL} THEN 1 ELSE 0 END) AS outage
       FROM memories
      WHERE date(created_at,'localtime') BETWEEN ? AND ?
        AND status <> 'deleted'
        AND ${scope}
      GROUP BY d`,
  ).all(from, to) as Array<{ d: string; n: number; contract: number; narrative: number; outage: number }>;

  const byDate = new Map<string, { created: number; contract: number; narrative: number; outage: number }>();
  for (const r of rows) {
    byDate.set(String(r.d), {
      created: Number(r.n) || 0,
      contract: Number(r.contract) || 0,
      narrative: Number(r.narrative) || 0,
      outage: Number(r.outage) || 0,
    });
  }

  // ② 窗口起点之前就有的条数 = 累计曲线的起点
  const beforeRow = db.prepare(
    `SELECT count(*) AS n FROM memories
      WHERE date(created_at,'localtime') < ? AND status <> 'deleted' AND ${scope}`,
  ).get(from) as { n: number } | undefined;
  const beforeWindow = Number(beforeRow?.n) || 0;

  // ③ 逐日补零：没有记忆的那天也必须有 0，
  //    否则折线会把「11-03 → 11-09」直接连起来，看起来像那天有数据
  const daily: TrendDay[] = [];
  let cum = beforeWindow;
  for (let i = 0; i < days; i++) {
    const d = new Date(startD.getFullYear(), startD.getMonth(), startD.getDate() + i);
    const key = ymd(d);
    const hit = byDate.get(key);
    const created = hit?.created ?? 0;
    cum += created;
    daily.push({
      date: key,
      created,
      contract: hit?.contract ?? 0,
      narrative: hit?.narrative ?? 0,
      outage: hit?.outage ?? 0,
      cumulative: cum,
    });
  }

  // ④ 被忘掉的：窗口内新增、现在 status='deleted'
  const delRow = db.prepare(
    `SELECT count(*) AS n FROM memories
      WHERE date(created_at,'localtime') BETWEEN ? AND ? AND status='deleted' AND ${scope}`,
  ).get(from, to) as { n: number } | undefined;
  const deletedInWindow = Number(delRow?.n) || 0;

  // ⑤ 断片在窗口内有多少（不管当前口径是否排除，都如实报）
  const outRow = db.prepare(
    `SELECT count(*) AS n FROM memories
      WHERE date(created_at,'localtime') BETWEEN ? AND ? AND status <> 'deleted' AND ${OUTAGE_SQL}`,
  ).get(from, to) as { n: number } | undefined;
  const outageInWindow = Number(outRow?.n) || 0;

  // ⑥ 衰减：横轴是**年龄**，不是日期
  //    created_at 是 UTC，差值才是真实天数；这里**不要**套 localtime —— 只算间隔，跟时区无关。
  //    2026-11-16 修：年龄基准原来写死 `julianday('now')`，和函数入参 `now` 不是同一个时刻 ——
  //    测试传固定 now 时会在跨天后错位（今天刚记的被算成 1 天前），界面上也是同一个毛病。
  //    改成把 now 当参数传进去，只认调用方给的时刻。
  const live = db.prepare(
    `SELECT weight, w0, kind, CAST(julianday(?) - julianday(created_at) AS INT) AS age
       FROM memories
      WHERE status='active' AND w0 > 0 AND ${scope}`,
  ).all(now.toISOString()) as Array<{ weight: number; w0: number; kind: string; age: number }>;

  const acc = BUCKETS.map((b) => ({ ...b, n: 0, w0: 0, w: 0 }));
  const kindAcc = new Map<string, { n: number; w0: number; w: number }>();
  let sumW0 = 0;
  let sumW = 0;
  for (const m of live) {
    const age = Number(m.age) || 0;
    const w0 = Number(m.w0) || 0;
    const w = Number(m.weight) || 0;
    sumW0 += w0;
    sumW += w;
    const b = acc.find((x) => age >= x.lo && (x.hi === null || age < x.hi));
    if (b) {
      b.n += 1;
      b.w0 += w0;
      b.w += w;
    }
    const k = String(m.kind || "unknown");
    const cur = kindAcc.get(k) ?? { n: 0, w0: 0, w: 0 };
    cur.n += 1;
    cur.w0 += w0;
    cur.w += w;
    kindAcc.set(k, cur);
  }

  const decay: DecayBucket[] = acc.map((b) => {
    const avgW0 = b.n ? b.w0 / b.n : 0;
    const avgWeight = b.n ? b.w / b.n : 0;
    return {
      label: b.label,
      lo: b.lo,
      hi: b.hi,
      n: b.n,
      avgW0: round3(avgW0),
      avgWeight: round3(avgWeight),
      keep: b.n ? keepOf(avgW0, avgWeight) : 0,
    };
  });

  const byKind: KindDecay[] = [...kindAcc.entries()]
    .map(([kind, v]) => {
      const avgW0 = v.w0 / v.n;
      const avgWeight = v.w / v.n;
      return { kind, n: v.n, avgW0: round3(avgW0), avgWeight: round3(avgWeight), keep: keepOf(avgW0, avgWeight) };
    })
    .sort((a, b) => b.n - a.n);

  // ⑦ 现状计数
  const cnt = (sql: string): number => Number((db.prepare(sql).get() as { n: number } | undefined)?.n) || 0;
  const activeNow = cnt("SELECT count(*) AS n FROM memories WHERE status='active'");
  const fading = cnt("SELECT count(*) AS n FROM memories WHERE status='active' AND stage='fading'");
  const dormant = cnt("SELECT count(*) AS n FROM memories WHERE status='active' AND stage='dormant'");
  const createdInWindow = daily.reduce((s, d) => s + d.created, 0);

  const notes = [
    `切日按本地日期：库里存 UTC，直接取前 10 位会让本地 20:00 后写入的落到第二天。`,
    `衰减曲线横轴是「记忆年龄」不是日期 —— 库里只有当前权重、没有逐日快照，按日期画就是编历史。`,
    includeOutage
      ? `断片（进程被杀/断电等）已**计入**本次统计。`
      : `断片（进程被杀/断电等）默认**不计入**：窗口内另有 ${outageInWindow} 条，混进来会把真实增长压平。`,
    `窗口内另有 ${deletedInWindow} 条新增后又被忘掉，不画进曲线（累计只算还在的）。`,
  ];

  return {
    days,
    from,
    to,
    daily,
    decay,
    byKind,
    summary: {
      activeNow,
      createdInWindow,
      beforeWindow,
      deletedInWindow,
      outageInWindow,
      fading,
      dormant,
      avgKeep: sumW0 > 0 ? round3(sumW / sumW0) : 0,
    },
    notes,
  };
}
