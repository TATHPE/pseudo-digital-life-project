/**
 * Token 估算（零依赖）。
 *
 * 为什么自己估：真实 token 由 provider 的 usage 字段给出（记账用，13 §6），
 * 但**组装前**必须先有预算闸，否则总是"超了才发现"。
 *
 * 标定 2（2026-10-28，tiktoken/cl100k_base，8 个真实样本 = 6 个 persona 文件 + README，最小二乘）：
 *   a = 1.15 tok / 汉字（含全角标点）    c = 0.58 tok / 英文数字**词**    d = 0.72 tok / 其它字符
 *   样本最大偏差 9.3%（README 那种中英混排大文本也只差 0.1%）
 *
 * 为什么从"按字符"改成"按词"：旧系数（1.34/0.24）把 28 个字符的
 * "Pseudo Digital Life Project" 估成 6.7 token，实测只有 4 —— 英文一多就系统性高估，
 * 预算会被虚报的数字白占掉。旧模型在 8 个样本上的最大偏差是 18.7%。
 *
 * 见 test/tokens.test.ts 的标定用例（阈值 ±15%）。
 *
 * 注意：不同 provider 的分词器不同（o200k / Claude 自家），
 * 对中文通常比 cl100k **更省**——所以这个估算**偏保守**，
 * 做预算上限是安全的；真实用量一律以 usage 为准。
 */

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;
/** 英文/数字按**整词**算：cl100k 里 " Digital" 是 1 个 token，不是 8 个 */
const WORD = /[A-Za-z0-9_]+/g;
const WORD_CHAR = /[A-Za-z0-9_]/;

const A_HAN = 1.15;
const C_WORD = 0.58;
const D_OTHER = 0.72;
/** 每条消息的结构开销（role/分隔符），实测约 3–4 */
const MSG_OVERHEAD = 4;

export function estimateTokens(s: string): number {
  if (!s) return 0;
  let han = 0;
  let other = 0;
  for (const ch of s) {
    if (HAN.test(ch)) han++;
    else if (!WORD_CHAR.test(ch)) other++;
  }
  const words = (s.match(WORD) ?? []).length;
  return Math.ceil(A_HAN * han + C_WORD * words + D_OTHER * other) + MSG_OVERHEAD;
}
