/**
 * Token 估算（零依赖）。
 *
 * 为什么自己估：真实 token 由 provider 的 usage 字段给出（记账用，13 §6），
 * 但**组装前**必须先有预算闸，否则总是"超了才发现"。
 *
 * 标定（2026-10-27，tiktoken/cl100k_base，5 个真实样本，最小二乘）：
 *   a = 1.34 tok / 汉字（含全角标点）      b = 0.24 tok / 其它字符
 *   样本误差：-3.4% ~ +11.5%
 * 见 test/tokens.test.ts 的标定用例（阈值 ±15%）。
 *
 * 注意：不同 provider 的分词器不同（o200k / Claude 自家），
 * 对中文通常比 cl100k **更省**——所以这个估算是**偏保守**的，
 * 做预算上限是安全的；真实用量一律以 usage 为准。
 */

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;

const A_HAN = 1.34;
const B_OTHER = 0.24;
/** 每条消息的结构开销（role/分隔符），实测约 3–4 */
const MSG_OVERHEAD = 4;

export function estimateTokens(s: string): number {
  if (!s) return 0;
  let han = 0;
  let other = 0;
  for (const ch of s) {
    if (HAN.test(ch)) han++;
    else other++;
  }
  return Math.ceil(A_HAN * han + B_OTHER * other) + MSG_OVERHEAD;
}
