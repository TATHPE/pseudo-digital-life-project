/**
 * 查询改写 / 别名归一（E-10，2026-11-02）
 *
 * 为什么要这一层：库里明明有「记住下周三为用户**妈妈**买蛋糕」，用户问「我**妈**生日那件事」
 * 就是 0 命中 —— bigram 索引只认字面，`我妈` 不在库里出现（库里写的是`妈妈`）。
 * docs/24 的实测里，失败案例有一半是这类"口语 vs 书面"的滑动。
 *
 * 三条边界（这层最容易做歪，所以先写死）：
 *  1. **只做别名/近义归一，不做联想**。「我妈 → 妈妈」是同一件事的两种说法；
 *     「生日 → 蛋糕」是猜，不写。猜出来的命中在 abstain 用例上会立刻翻脸。
 *  2. **有界**：一条查询最多产出 `MAX_VARIANTS` 条变体，每个别名最长 8 字，替换次数上限 6。
 *  3. **不花钱、不联网、不调模型**：一张人写的表 + 字符串替换。进不了闸门问题。
 *
 * 词表从哪儿来：docs/24 的失败用例 + 常见中文口语/书面滑动。**新增一词要能说清是哪条用例逼出来的**，
 * 否则它会变成调参（"为了让这 3 条绿"而加词）。
 */

/** 别名 → 库里更可能出现的写法（口语/缩写/同义 → 书面；顺序：长词在前） */
export const ALIASES: ReadonlyArray<readonly [string, string]> = [
  // ── 家庭成员的口语简称 ──
  ["我妈", "妈妈"],
  ["我爸", "爸爸"],
  ["我哥", "哥哥"],
  ["我姐", "姐姐"],
  ["我弟", "弟弟"],
  ["我妹", "妹妹"],
  ["我老婆", "妻子"],
  ["我老公", "丈夫"],
  ["我家那位", "伴侣"],
  ["娃", "孩子"],
  ["小孩", "孩子"],
  // ── 称呼（h-recall-2 逼出来的：库里是「不要叫我助手」，问的是「怎么称呼」）──
  ["称呼", "叫"],
  ["怎么称呼", "怎么叫"],
  ["叫法", "叫"],
  // ── 崩溃/中断（h-recall-3 逼出来的：库里写「进程被杀」，问的是「程序挂掉」）──
  ["程序挂掉", "进程被杀"],
  ["程序崩了", "进程被杀"],
  ["挂了", "被杀"],
  ["挂掉", "被杀"],
  ["崩了", "被杀"],
  ["断电", "信号中断"],
  ["停电", "信号中断"],
  ["程序", "进程"],
  // ── 记忆本身的说法 ──
  ["记一下", "记住"],
  ["记下来", "记住"],
  ["别忘了", "记住"],
  ["提醒我", "提醒"],
  // ── 钱/用量 ──
  ["花了多少", "费用"],
  ["花了多少钱", "费用"],
  ["用了多少", "用量"],
];

/** 一条查询最多几条变体（原句 + 归一 + 替换），再多多半只是噪声 */
export const MAX_VARIANTS = 3;
/** 每个别名替换最多几次（防止一句话被改得面目全非） */
const MAX_REPLACE = 6;

/**
 * 别名归一：把口语换成库里更可能的写法。
 * 长别名优先（"怎么称呼" 先于 "称呼"），避免被短词先吃掉。
 */
export function normalizeQuery(q: string): string {
  let out = q;
  const sorted = [...ALIASES].sort((a, b) => b[0].length - a[0].length);
  let budget = MAX_REPLACE;
  for (const [from, to] of sorted) {
    if (budget <= 0) break;
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
    budget--;
  }
  return out;
}

/**
 * 生成变体：原句一定在第一位（原查询永远是主力，改写只是补充）。
 * 去重、去掉空串与超长。
 */
export function queryVariants(q: string): string[] {
  const base = q.trim();
  if (!base) return [];
  const out = [base];
  const push = (s: string) => {
    const t = s.trim();
    if (!t || t.length > 64) return;
    if (out.includes(t)) return;
    if (out.length >= MAX_VARIANTS) return;
    out.push(t);
  };

  const norm = normalizeQuery(base);
  push(norm);

  // 第三种：只替换**一个**最长别名（保留更多原句信息，可能比全归一更贴库里的写法）
  if (out.length < MAX_VARIANTS) {
    const hits = ALIASES
      .filter(([from]) => base.includes(from))
      .sort((a, b) => b[0].length - a[0].length);
    if (hits.length > 1) {
      const [from, to] = hits[0]!;
      push(base.split(from).join(to));
    }
  }
  return out;
}
