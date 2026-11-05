/**
 * OneBot 11 适配器（2026-11-05）：把 QQ 消息接进来，把她的回话发出去。
 *
 * 为什么只做 OneBot 11：NapCat / LLOneBot / Lagrange 说的都是这一个协议，
 * 一个适配器同时覆盖它们；微信那一侧没有统一协议，先不碰。
 *
 * 分工：
 *   · 这个文件只做**纯逻辑**（解析事件、决定要不要回、拼动作），不碰网络 —— 所以能单测
 *   · 真正的连接与重连在 src/bridge.ts
 *
 * 安全边界（默认最保守，要全放开会一条条加）：
 *   · 只回私聊（mode=private）
 *   · 群里必须先 @她（mode=group），且群号要在 allowGroups 里
 *   · 自己发的消息、`message_sent` 事件、空文本一律不回
 */

export interface ObConfig {
  /** 开没开 */
  enabled?: boolean;
  /** OneBot 11 的正向 WebSocket 地址，如 ws://127.0.0.1:3001 */
  ws?: string;
  /** NapCat 里配的 access_token（可选；会拼到 ?access_token=） */
  accessToken?: string;
  /** 她自己的 QQ 号（用来过滤自己发的消息、判断有没有被 @） */
  selfId?: string;
  /** private = 只回私聊；group = 只回群里 @ 她的；all = 两者都回 */
  mode?: "private" | "group" | "all";
  /** 私聊白名单：空 = 谁都回；有值 = 只回这些人 */
  allowUsers?: string[];
  /** 群白名单：**必须**显式列出，不发群消息 */
  allowGroups?: string[];
  /** 群里除了 @ 还认的前缀，如 "鲸鲸，" */
  prefix?: string;
}

export interface Incoming {
  kind: "private" | "group";
  /** 私聊是对方的 QQ 号，群聊是群号 */
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  atMe: boolean;
}

export function defaultConfig(): ObConfig {
  return { enabled: false, ws: "ws://127.0.0.1:3001", accessToken: "", selfId: "", mode: "private", allowUsers: [], allowGroups: [], prefix: "" };
}

/** 把 OneBot 的 message 段数组拼成纯文本：文本照抄，@ 记下来，其余类型给个占位 */
export function segmentsToText(segments: unknown, selfId: string): { text: string; atMe: boolean } {
  if (typeof segments === "string") return { text: segments, atMe: false };
  if (!Array.isArray(segments)) return { text: "", atMe: false };
  let text = "";
  let atMe = false;
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as { type?: string; data?: Record<string, unknown> };
    if (s.type === "text") { text += String(s.data?.text ?? ""); continue; }
    if (s.type === "at") {
      const qq = String(s.data?.qq ?? "");
      if (selfId && qq === selfId) { atMe = true; continue; }
      text += "@" + qq + " ";
      continue;
    }
    if (s.type === "image") { text += "[图片] "; continue; }
    if (s.type === "face") { text += "[表情] "; continue; }
    // 其余（语音/视频/文件/回复…）忽略：不猜内容
  }
  return { text: text.replace(/[ \t]+/g, " ").trim(), atMe };
}

/**
 * 一条事件值不值得处理。不值得就返回 null（这是全部"要不要回"的判断点，方便测）。
 */
export function parseIncoming(ev: unknown, cfg: ObConfig, selfId: string): Incoming | null {
  if (!ev || typeof ev !== "object") return null;
  const e = ev as Record<string, unknown>;
  if (e.post_type !== "message") return null;          // 通知/请求/心跳都不管
  if (e.message_type !== "private" && e.message_type !== "group") return null;
  const self = String(e.self_id ?? selfId ?? "");
  const userId = String(e.user_id ?? "");
  if (!userId) return null;
  if (self && userId === self) return null;            // 自己发的
  if (e.sub_type === "self" || e.sub_type === "group_self") return null;
  if (selfId && userId === selfId) return null;

  const parsed = segmentsToText(e.message, selfId || self);
  const atMe = parsed.atMe;
  const mode = cfg.mode ?? "private";
  const isGroup = e.message_type === "group";
  const chatId = isGroup ? String(e.group_id ?? "") : userId;
  if (!chatId) return null;

  // 白名单
  if (!isGroup) {
    if (mode === "group") return null;
    const allow = (cfg.allowUsers ?? []).map(String);
    if (allow.length && !allow.includes(userId)) return null;
  } else {
    if (mode === "private") return null;
    const allow = (cfg.allowGroups ?? []).map(String);
    if (!allow.length || !allow.includes(chatId)) return null;   // 群必须显式放行
  }

  let text = parsed.text;
  const prefix = String(cfg.prefix ?? "");
  if (isGroup) {
    // 群里：要么 @ 她，要么用约定前缀开头；否则是在群聊里人跟人说话，不插嘴
    if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length).trim();
    else if (!atMe) return null;
  }
  if (!text) return null;
  if (text.length > 4000) text = text.slice(0, 4000);

  return {
    kind: isGroup ? "group" : "private",
    chatId, userId,
    messageId: String(e.message_id ?? e.time ?? ""),
    text, atMe,
  };
}

/** 回话要发的动作（OneBot 11 的 HTTP/WS 同一个 schema） */
export function sendPayload(msg: Incoming, text: string, echo: string): Record<string, unknown> {
  return msg.kind === "group"
    ? { action: "send_group_msg", params: { group_id: msg.chatId, message: text }, echo }
    : { action: "send_private_msg", params: { user_id: msg.chatId, message: text }, echo };
}

/** 群消息里 @ 对方（可选：让她回答时带 @） */
export function atSegment(userId: string): Record<string, unknown> {
  return { type: "at", data: { qq: userId } };
}
