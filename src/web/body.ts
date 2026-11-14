/**
 * 请求体读取与 JSON 解析（2026-11-14）
 *
 * 以前 18 个写接口都写 `JSON.parse(await readBody(req))`，没有一点防护：
 * 一个不合法的 body 会抛 SyntaxError，被全局 catch 当成 500，
 * 还把 `SyntaxError: Expected property name ...` 原样回给前端。
 * 客户端发错东西是客户端的问题，应该是 400 —— 这里统一成 BadJsonError，
 * 全局处理器认这个类型。
 */
import type { IncomingMessage } from "node:http";

export class BadJsonError extends Error {
  readonly code = "E_BAD_JSON";
  /** true = 压根没发 body（个别接口允许「空 = 全部」）；false = 发了但解析不了 */
  readonly empty: boolean;
  constructor(empty = false) {
    super(empty ? "请求体为空" : "请求体不是合法 JSON");
    this.name = "BadJsonError";
    this.empty = empty;
  }
}

/** 读原始文本（保持原行为：不设上限，超限由调用方管） */
export const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((res) => {
    const c: Buffer[] = [];
    req.on("data", (d) => c.push(d as Buffer));
    req.on("end", () => res(Buffer.concat(c).toString("utf8")));
  });

/** 读并解析 JSON；空体也算不合法（写接口都没有「空体等价 {}」的语义） */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (!raw.trim()) throw new BadJsonError(true);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BadJsonError();
  }
}
