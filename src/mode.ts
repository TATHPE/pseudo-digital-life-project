/**
 * 自动切档：这一句话该按「聊天」还是「工作」处理（2026-11-07）。
 *
 * 为什么是规则而不是模型：判成工作 = 简报从 2600 涨到 5200 tokens，判错每轮都在多花钱；
 * 规则零成本、可解释、可单测。规则判不出来时**默认聊天**（宁可漏判，不要误判）。
 *
 * 三个判据，按强弱排序：
 *   1. 没有工具（本地兜底）→ 一律聊天：工作档没工具等于空转，还更贵；
 *   2. 明确的工作信号 → 工作；
 *   3. 明确的聊天信号 → 聊天；
 *   4. 都没有 → 粘上一轮（短句不翻档）。
 */

export type Mode = "chat" | "work";

export interface ModeDecision {
  mode: Mode;
  /** 一句人话，给面板/日志看 */
  why: string;
  /** 是不是靠"粘上一轮"定的 */
  sticky: boolean;
}

export interface ModeContext {
  /** 上一轮实际用的档 */
  prev: Mode;
  /** 这一轮有没有工具（本地兜底时为 false） */
  hasTools: boolean;
}

/** 工作信号：祈使动词 + 宾语、路径/命令、多步骤 */
const WORK_VERBS = /(改|写|删|加|跑|执行|装|部署|修|重构|迁移|整理成|导出|生成|替换|更新|提交|推上去|测一下|跑一遍|查一下|看一下|读一下)/;
const PATHS = /([\w\-./]+\.(ts|js|mjs|tsx|json|md|css|html|py|sh|ps1|yml|yaml|toml|lock)\b|^[\w\-.]+\/|\/[a-z]+\/[a-z]+|src\/|docs\/|test\/|tmp\/)/i;
const COMMANDS = /\b(npm|pnpm|yarn|npx|node|cargo|git|docker|pip|python|curl|powershell|pwsh)\b\s+\S/;
const MULTI_STEP = /(先.{0,20}再|再.{0,12}然后|然后.{0,12}(跑|看|改|写)|第一步|第二步)/;

/** 聊天信号：问句、感受、回忆、寒暄 */
const QUESTION = /[?？]\s*$|(吗|呢|吧)\s*[?？]?$/;
const FEELING = /(累|烦|开心|难过|高兴|无聊|困|饿|焦虑|失望|舒服)/;
const RECALL = /(上次|之前|前几天|那时候|还记得|你说过|当时)/;
const GREETING = /^(在吗|在不在|你好|嗨|早上好|晚上好|晚安|谢谢)[。!！?？~s]*$/;
/** 承接用语：不换话题，档位跟着上一轮走 */
const ACK = /^(嗯+|哦|好的?|行|可以|收到|明白|好|ok|OK)[。!！?？~s]*$/;

export function resolveMode(text: string, ctx: ModeContext): ModeDecision {
  const t = String(text ?? "").trim();
  if (!t) return { mode: ctx.prev, why: "空消息，沿用上一轮", sticky: true };

  // 1. 没有工具：工作档没有意义
  if (!ctx.hasTools) {
    return { mode: "chat", why: "这一轮没有工具（本地兜底），工作档只会更贵", sticky: false };
  }

  const workHit = (() => {
    if (COMMANDS.test(t)) return "带命令";
    if (PATHS.test(t)) return "带路径/文件名";
    if (MULTI_STEP.test(t)) return "多步骤";
    // 祈使动词必须有宾语（"记一下" 不算工作，"记一下这个数" 才算）
    if (WORK_VERBS.test(t) && t.length >= 6) return "动词带宾语";
    return "";
  })();

  // 承接语：档位不翻（「好的」不是换话题）
  if (ACK.test(t)) return { mode: ctx.prev, why: "承接上一轮，档位不变", sticky: true };

  const chatHit = (() => {
    if (GREETING.test(t)) return "寒暄";
    if (RECALL.test(t)) return "回忆/追问";
    if (FEELING.test(t)) return "情绪";
    if (QUESTION.test(t) && !workHit) return "问句";
    return "";
  })();

  // 2/3. 双方都有信号时：工作信号优先（"跑一下 npm run check？" 带命令，就该按工作办）；
  if (chatHit === "问句" || chatHit === "寒暄" || chatHit === "情绪") {
    return { mode: "chat", why: "聊天信号：" + chatHit, sticky: false };
  }
  if (workHit) return { mode: "work", why: "工作信号：" + workHit, sticky: false };
  if (chatHit) return { mode: "chat", why: "聊天信号：" + chatHit, sticky: false };

  // 4. 都没命中：粘上一轮
  return { mode: ctx.prev, why: "没有明确信号，沿用上一轮的「" + chinese(ctx.prev) + "」", sticky: true };
}

export function chinese(m: Mode): string {
  return m === "work" ? "工作" : "聊天";
}
