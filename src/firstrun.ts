/**
 * 试运行 + 第一句话（H-4 第 ⑦⑧ 步）。
 *
 * ⑦ 试运行：**不要"配置成功"**。用假数据跑一轮，让用户先听到 voice、看到抽出来的记忆，
 *    不满意就在封存前随便改（封存前的修改是免费的）。
 * ⑧ 第一句话：封存之后让它自己开口 —— 用户第一次听到 voice，同时验证整条链路是通的。
 */
import { appendEvent, newEventId } from "./journal.ts";
import { join } from "node:path";

export interface SmokeResult {
  reply: string;
  /** 抽取器从"假对话"里抽出的候选（用来看它的判断力，不写库） */
  extracted: string[];
  via: "model" | "template";
  note?: string;
  ms: number;
}

/** 假对话：不进库、不发给人，只用来让模型露一手 */
export const SAMPLE = [
  { role: "user", text: "我妈下周三生日，记得提醒我提前买蛋糕。" },
  { role: "agent", text: "记着了。" },
  { role: "user", text: "还有，以后别叫我「助手」，叫名字就行。" },
];

export const SMOKE_SYSTEM = [
  "你在扮演一个刚被设定好的人格，正在**试运行**。",
  "只用给定的设定说话，不要解释你在做什么，不要提到「设定」「人格」「测试」这些词。",
  "短句，陈述，别客套。",
].join(String.fromCharCode(10));

export const SMOKE_USER = [
  "（试运行。下面是你刚被设定好之后，第一次和人说话。）",
  "对方说：「在吗？今天有点累。」",
  "你就用一句话回他。",
].join(String.fromCharCode(10));

/**
 * 跑一次试运行。
 * `complete` 由调用方注入（面板传云端表达模型；没有就传 null → 用模板并**明说**）。
 */
export async function runSmoke(
  opts: { personaText: string; complete?: (system: string, user: string) => Promise<string> },
): Promise<SmokeResult> {
  const t0 = Date.now();
  if (!opts.complete) {
    return {
      reply: "（没有可用的表达模型，下面这句是模板，不是你的人格）在。",
      extracted: ["承诺：下周三提醒买蛋糕", "边界：别叫「助手」，叫名字"],
      via: "template",
      note: "配好云端 API 后再跑一次，这句话才是它会说的话",
      ms: Date.now() - t0,
    };
  }
  const reply = (await opts.complete(opts.personaText + String.fromCharCode(10, 10) + SMOKE_SYSTEM, SMOKE_USER)).trim();
  return {
    reply: reply.slice(0, 600),
    extracted: SAMPLE.filter((s) => s.role === "user").map((s) => `（试运行不写库）会考虑：${s.text.slice(0, 24)}`),
    via: "model",
    ms: Date.now() - t0,
  };
}

/** ⑧ 第一句话：封存之后让它开口，并把这句话**真的写进 journal** */
export const FIRST_USER = [
  "（这是你被设定好之后的第一次开口。没有前情，没有任务。）",
  "对方什么都没说，只是在等你。",
  "说一句。",
].join(String.fromCharCode(10));

export async function sayFirstWords(
  opts: {
    inboxDir: string;
    personaText: string;
    complete?: (system: string, user: string) => Promise<string>;
    now?: Date;
  },
): Promise<{ text: string; via: "model" | "template"; written: boolean }> {
  const now = opts.now ?? new Date();
  let text: string;
  let via: "model" | "template" = "template";
  if (opts.complete) {
    text = (await opts.complete(opts.personaText + String.fromCharCode(10, 10) + SMOKE_SYSTEM, FIRST_USER)).trim().slice(0, 800);
    via = "model";
  } else {
    text = "（还没有表达模型：这句是占位。配好 API 之后，第一句才是它自己说的。）";
  }
  let written = false;
  try {
    appendEvent(opts.inboxDir, {
      v: 1, id: newEventId(), ts: now.toISOString(), kind: "agent_reply", actor: "agent",
      payload: { text, firstWords: true },
    });
    written = true;
  } catch { /* 写不进也不该让"第一句话"失败 */ }
  void join;
  return { text, via, written };
}
