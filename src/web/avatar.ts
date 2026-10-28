/**
 * 头像框（外观偏好，不是模型配置）
 *
 * 为什么单独一个模块：列表要**同时**被页面（渲染 `<option>`）、服务端（校验 PUT）、
 * 测试（断言两边一致）用到。写三份就会漂——这个项目已经为"两处生成代码不一致"付过学费。
 *
 * 帧本身只有 CSS：`body[data-av="…"] .av`（见 web/page.ts）。这里只管"哪些值合法"。
 */
export const AVATAR_FRAMES = ["plain", "bare", "ring", "cut", "glow"] as const;
export type AvatarFrame = (typeof AVATAR_FRAMES)[number];
export const DEFAULT_AVATAR: AvatarFrame = "plain";

export function isAvatarFrame(x: unknown): x is AvatarFrame {
  return typeof x === "string" && (AVATAR_FRAMES as readonly string[]).includes(x);
}
