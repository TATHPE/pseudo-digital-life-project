import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIncoming, segmentsToText, sendPayload, defaultConfig } from "../src/onebot.ts";

const SELF = "10001";
const cfg = (o: Record<string, unknown> = {}) => ({ ...defaultConfig(), selfId: SELF, enabled: true, ...o });

const priv = (text: string, o: Record<string, unknown> = {}) => ({
  post_type: "message", message_type: "private", sub_type: "friend",
  self_id: Number(SELF), user_id: 20002, message_id: 11, time: 1,
  message: [{ type: "text", data: { text } }],
  ...o,
});

const group = (segs: unknown[], o: Record<string, unknown> = {}) => ({
  post_type: "message", message_type: "group", sub_type: "normal",
  self_id: Number(SELF), user_id: 20002, group_id: 30003, message_id: 22, time: 2,
  message: segs,
  ...o,
});

test("OneBot：私聊默认就回，自己发的不回", () => {
  const m = parseIncoming(priv("在吗"), cfg(), SELF);
  assert.ok(m);
  assert.equal(m.kind, "private");
  assert.equal(m.chatId, "20002");
  assert.equal(m.text, "在吗");

  assert.equal(parseIncoming(priv("在吗", { user_id: Number(SELF) }), cfg(), SELF), null, "自己发的");
  assert.equal(parseIncoming(priv("在吗", { sub_type: "self" }), cfg(), SELF), null, "self 子类型");
  assert.equal(parseIncoming(priv("   "), cfg(), SELF), null, "空白不回");
  assert.equal(parseIncoming({ post_type: "meta_event" }, cfg(), SELF), null, "心跳不管");
});

test("OneBot：群聊要显式放行 + @ 她（或约定前缀）", () => {
  const at = { type: "at", data: { qq: SELF } };
  assert.equal(parseIncoming(group([at, { type: "text", data: { text: " 明天天气" } }]), cfg(), SELF), null, "群没白名单不回");

  const g = cfg({ mode: "group", allowGroups: ["30003"] });
  const m1 = parseIncoming(group([at, { type: "text", data: { text: " 明天天气" } }]), g, SELF);
  assert.ok(m1, "被 @ 了要回");
  assert.equal(m1.text, "明天天气");
  assert.equal(m1.atMe, true);

  assert.equal(parseIncoming(group([{ type: "text", data: { text: "明天天气" } }]), g, SELF), null, "没 @ 不插嘴");

  const gp = cfg({ mode: "all", allowGroups: ["30003"], prefix: "鲸鲸，" });
  const m2 = parseIncoming(group([{ type: "text", data: { text: "鲸鲸，明天天气" } }]), gp, SELF);
  assert.ok(m2, "前缀也能触发");
  assert.equal(m2.text, "明天天气", "前缀要去掉");

  assert.equal(parseIncoming(group([at], { group_id: 99999 }), g, SELF), null, "别的群不回");
});

test("OneBot：mode 决定私聊/群聊的边界", () => {
  assert.equal(parseIncoming(priv("hi"), cfg({ mode: "group" }), SELF), null, "mode=group 不管私聊");
  assert.equal(parseIncoming(priv("hi"), cfg({ allowUsers: ["20002"] }), SELF)?.text, "hi", "白名单里的私聊要回");
  assert.equal(parseIncoming(priv("hi"), cfg({ allowUsers: ["30003"] }), SELF), null, "不在白名单不回");
});

test("OneBot：消息段怎么拼（图片给占位，别人的 @ 保留）", () => {
  const r = segmentsToText([
    { type: "at", data: { qq: "555" } },
    { type: "text", data: { text: "看这个" } },
    { type: "image", data: { file: "x.jpg" } },
    { type: "face", data: { id: "1" } },
  ], SELF);
  assert.equal(r.atMe, false);
  assert.ok(r.text.startsWith("@555 看这个"), r.text);
  assert.ok(r.text.includes("[图片]"));
});

test("OneBot：回话动作按私聊/群聊分开", () => {
  const p = parseIncoming(priv("hi"), cfg(), SELF)!;
  const a = sendPayload(p, "在", "e1") as any;
  assert.equal(a.action, "send_private_msg");
  assert.equal(a.params.user_id, "20002");

  const g = cfg({ mode: "group", allowGroups: ["30003"] });
  const gm = parseIncoming(group([{ type: "at", data: { qq: SELF } }, { type: "text", data: { text: "hi" } }]), g, SELF)!;
  const b = sendPayload(gm, "在", "e2") as any;
  assert.equal(b.action, "send_group_msg");
  assert.equal(b.params.group_id, "30003");
});
