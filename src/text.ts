/** 中文 FTS5 必须用 bigram（12 §9.1 实测：unicode61 对中文完全失效） */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export function bigrams(text: string): string[] {
  const out: string[] = [];
  const runs = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) ?? [];
  for (const run of runs) {
    const chars = [...run];
    if (chars.length === 1) { out.push(chars[0]!); continue; }
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
  }
  // 英文/数字整词保留（下划线算词内字符）
  for (const w of text.match(/[A-Za-z0-9_]{2,}/g) ?? []) out.push(w.toLowerCase());
  return out;
}

/** 索引与查询用同一套切分，保证两侧对齐 */
export function bigramText(text: string): string {
  return bigrams(text).join(" ");
}

/** FTS5 查询串：OR 连接（保召回），特殊字符按空格切掉 */
export function ftsQuery(text: string): string {
  const terms = bigrams(text).filter((t) => t.length >= 1);
  const uniq = [...new Set(terms)].slice(0, 64);
  return uniq.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export const isHan = (ch: string) => HAN.test(ch);
