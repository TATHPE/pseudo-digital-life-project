/**
 * 陪伴形象与背景（2026-11-13）：内置 + 用户自定义，设置页里点一下就换。
 *
 * 为什么单独一个模块：形象/背景是「素材」，不是模型配置 —— 它们落在 <home>/pal/，
 * 跟 config.json 里的选择（pal.avatar / pal.bg）分开存；删素材不会动配置，
 * 配置指向不存在的素材时自动退回内置，界面不会白屏。
 *
 * 形象包 = RuiC-2D 导出的 .yxavatar / .zip（rig.json + built/）。这里自带一个最小 ZIP 读取器
 * （只认 store/deflate），不引第三方解压依赖，也不调系统解压命令。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { atomicWriteFile } from "./fsx.ts";
import { readFileConfig, writeFileConfig } from "./configfile.ts";

export const BUILTIN_AVATAR_ID = "whale";
export const BUILTIN_BG_IDS = ["ocean", "room"] as const;
export const MAX_BG_BYTES = 8 * 1024 * 1024;
/** 形象包上限：Live2D 公皮（4096 贴图×5 + moc3）压缩后就有 ~120MB，给到 160MB */
export const MAX_AVATAR_BYTES = 160 * 1024 * 1024;

export interface PalAvatar {
  id: string; name: string; base: string; thumb: string; builtin: boolean;
  /** mesh = RuiC-2D 单图绑定；cubism = 现成 Live2D 模型（.model3.json） */
  kind: "mesh" | "cubism";
  /** cubism 的模型入口（相对 base） */
  entry?: string;
}
export interface PalBackground { id: string; name: string; url: string | null; builtin: boolean }
export interface PalState { avatar: string; bg: string; avatars: PalAvatar[]; backgrounds: PalBackground[] }

export const palRoot = (home: string) => join(home, "pal");
const avatarDir = (home: string, id: string) => join(palRoot(home), "avatars", id);
const bgDir = (home: string) => join(palRoot(home), "bg");

/** 素材 id 只允许小写字母数字与连字符：它会被拼进 URL 和路径，不给穿越留口子 */
export function slugId(x: unknown): string {
  const s = String(x ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "item";
}

function imageExt(buf: Buffer): "png" | "jpg" | "webp" | null {
  if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

export function listAvatars(home: string): PalAvatar[] {
  const out: PalAvatar[] = [{
    id: BUILTIN_AVATAR_ID, name: "鲸鱼娘（内置）", base: "/static/pal/ruic/",
    thumb: "/static/pal/ruic/built/preview.png", builtin: true, kind: "mesh",
  }];
  const root = join(palRoot(home), "avatars");
  if (!existsSync(root)) return out;
  for (const id of readdirSync(root).sort()) {
    const dir = join(root, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
      let meta: { name?: string; kind?: string; entry?: string; thumb?: string } = {};
      try { meta = JSON.parse(readFileSync(join(dir, "pal.json"), "utf8")); } catch { /* 旧包没侧车 */ }
      const kind = meta.kind === "cubism" ? "cubism" : "mesh";
      if (kind === "cubism") {
        if (!meta.entry || !existsSync(join(dir, meta.entry))) continue;
      } else if (!existsSync(join(dir, "rig.json")) || !existsSync(join(dir, "built", "layers.json"))) continue;
      const thumb = meta.thumb && existsSync(join(dir, meta.thumb)) ? `/pal/avatars/${id}/${meta.thumb}` : (kind === "mesh" ? `/pal/avatars/${id}/built/base.png` : "");
      out.push({
        id, name: String(meta.name || id), base: `/pal/avatars/${id}/`, thumb, builtin: false, kind,
        ...(kind === "cubism" ? { entry: meta.entry } : {}),
      });
    } catch { /* 坏目录跳过，不让一个坏包拖垮整页 */ }
  }
  return out;
}

export function listBackgrounds(home: string): PalBackground[] {
  const out: PalBackground[] = [
    { id: "ocean", name: "海洋（内置）", url: null, builtin: true },
    { id: "room", name: "房间（内置）", url: "/static/pal/bg/room.png", builtin: true },
  ];
  const dir = bgDir(home);
  if (!existsSync(dir)) return out;
  let auto = 0;
  for (const f of readdirSync(dir).sort()) {
    const m = f.match(/^([a-z0-9-]+)\.(png|jpg|webp)$/);
    if (!m) continue;
    let name = "";
    try { name = String(JSON.parse(readFileSync(join(dir, `${m[1]}.json`), "utf8")).name || ""); } catch { /* 没写名字 */ }
    // 旧上传（没有名字侧车）且 id 是一串哈希：给个给人看的名字，别顶着一串十六进制
    if (!name) name = /^[0-9a-f]{16,}$/i.test(m[1]!) ? `自定义背景 ${++auto}` : m[1]!;
    out.push({ id: m[1]!, name, url: `/pal/bg/${f}`, builtin: false });
  }
  return out;
}

/** 当前选择；指向已删掉的素材时退回内置（界面永远有东西可显示） */
export function palState(home: string): PalState {
  const avatars = listAvatars(home);
  const backgrounds = listBackgrounds(home);
  const cfg = readFileConfig(home).pal ?? {};
  const avatar = avatars.some((a) => a.id === cfg.avatar) ? String(cfg.avatar) : BUILTIN_AVATAR_ID;
  const bg = backgrounds.some((b) => b.id === cfg.bg) ? String(cfg.bg) : "ocean";
  return { avatar, bg, avatars, backgrounds };
}

export function setPal(home: string, patch: { avatar?: string; bg?: string }): PalState {
  const avatars = listAvatars(home);
  const backgrounds = listBackgrounds(home);
  const next: { avatar?: string; bg?: string } = {};
  if (patch.avatar !== undefined) {
    if (!avatars.some((a) => a.id === patch.avatar)) throw new Error("E_NO_AVATAR");
    next.avatar = patch.avatar;
  }
  if (patch.bg !== undefined) {
    if (!backgrounds.some((b) => b.id === patch.bg)) throw new Error("E_NO_BG");
    next.bg = patch.bg;
  }
  writeFileConfig(home, { pal: next });
  return palState(home);
}

/** 存一张自定义背景：查文件头（不是只看扩展名），≤8MB。
 *  名字给人看：原文件名是一串哈希/纯编号时（微信/浏览器缓存常见），换成「自定义背景 N」，
 *  免得设置页和右上按钮上顶着一串 32 位十六进制。 */
export function saveBackground(home: string, fileName: string, buf: Buffer): PalBackground {
  const ext = imageExt(buf);
  if (!ext) throw new Error("E_BAD_IMAGE");
  if (buf.byteLength > MAX_BG_BYTES) throw new Error("E_TOO_BIG");
  const id = slugId(fileName.replace(/\.(png|jpe?g|webp)$/i, ""));
  mkdirSync(bgDir(home), { recursive: true });
  for (const e of ["png", "jpg", "webp"]) rmSync(join(bgDir(home), `${id}.${e}`), { force: true });
  atomicWriteFile(join(bgDir(home), `${id}.${ext}`), buf);
  const raw = String(fileName).replace(/\.(png|jpe?g|webp)$/i, "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  const n = listBackgrounds(home).filter((b) => !b.builtin).length;
  const name = !raw || /^[0-9a-f]{16,}$/i.test(raw) || /^[0-9a-f-]{20,}$/i.test(raw) ? `自定义背景 ${n}` : raw;
  atomicWriteFile(join(bgDir(home), `${id}.json`), Buffer.from(JSON.stringify({ name }, null, 2) + "\n", "utf8"));
  return { id, name, url: `/pal/bg/${id}.${ext}`, builtin: false };
}

export function removeBackground(home: string, id: string): boolean {
  if ((BUILTIN_BG_IDS as readonly string[]).includes(id)) return false;
  let hit = false;
  for (const e of ["png", "jpg", "webp"]) {
    const p = join(bgDir(home), `${slugId(id)}.${e}`);
    if (existsSync(p)) { rmSync(p, { force: true }); hit = true; }
  }
  rmSync(join(bgDir(home), `${slugId(id)}.json`), { force: true });
  if (hit && readFileConfig(home).pal?.bg === id) writeFileConfig(home, { pal: { bg: "ocean" } });
  return hit;
}

export function removeAvatar(home: string, id: string): boolean {
  if (id === BUILTIN_AVATAR_ID) return false;
  const dir = avatarDir(home, slugId(id));
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  if (readFileConfig(home).pal?.avatar === id) writeFileConfig(home, { pal: { avatar: BUILTIN_AVATAR_ID } });
  return true;
}

/**
 * 最小 ZIP 读取器：只认 store(0) / deflate(8)，够读 RuiC-2D 导出包与 Live2D 公皮包。
 * 上限：400 个条目 / 解压后 256MB；单条 >64MB 的直接跳过不解压（公皮包里的 PSD 就是这种，
 * 我们不需要它，也不该为它吃一百多 MB 内存）。
 */
export function unzip(buf: Buffer): Array<{ name: string; data: Buffer }> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("E_NOT_ZIP");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; data: Buffer }> = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error("E_BAD_ZIP");
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nlen);
    off += 46 + nlen + elen + clen;
    if (name.endsWith("/")) continue;
    if (usize > 64 * 1024 * 1024) continue;   // PSD 之类的大块头：不要
    if (out.length >= 400) throw new Error("E_TOO_MANY");
    total += usize;
    if (total > 256 * 1024 * 1024) throw new Error("E_TOO_BIG");
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error("E_BAD_ZIP");
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const raw = buf.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new Error("E_ZIP_METHOD");
    out.push({ name, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) });
  }
  return out;
}

/** 导入形象包：自动识别两种格式。
 *  · Live2D 公皮（含 .model3.json + .moc3 + 贴图）→ kind=cubism，保留表情/动作/物理；
 *  · RuiC-2D 导出（rig.json + built/）→ kind=mesh。
 *  别的（播放器、录音、PSD、授权 txt）一律不要。 */
export function importAvatar(home: string, name: string, zip: Buffer): PalAvatar {
  if (zip.byteLength > MAX_AVATAR_BYTES) throw new Error("E_TOO_BIG");
  const entries = unzip(zip).map((e) => ({ name: e.name.replace(/\\/g, "/"), data: e.data }));
  const model = entries.find((e) => /\.model3\.json$/i.test(e.name));
  if (model) return importCubism(home, name, entries, model);
  return importMesh(home, name, entries);
}

/** Live2D Cubism 公皮：以 .model3.json 所在目录为根，剥掉外层包装目录 */
function importCubism(home: string, name: string, entries: Array<{ name: string; data: Buffer }>, model: { name: string; data: Buffer }): PalAvatar {
  const slash = model.name.lastIndexOf("/");
  const prefix = slash >= 0 ? model.name.slice(0, slash + 1) : "";
  const keep = entries.filter((e) => {
    if (!e.name.startsWith(prefix)) return false;
    const rel = e.name.slice(prefix.length);
    if (!rel || rel.startsWith("/") || rel.includes("..") || rel.includes("__MACOSX") || rel.split("/").some((p) => p.startsWith("._"))) return false;
    return /\.(moc3|png|jpe?g|webp|json)$/i.test(rel);
  });
  const rel = (n: string) => n.slice(prefix.length);
  const entry = rel(model.name);
  // 模型声明的 moc 与贴图必须真的在包里，否则是个坏包
  let decl: {
    FileReferences?: {
      Moc?: string; Textures?: string[];
      Motions?: Record<string, Array<{ File?: string }>>;
      Expressions?: Array<{ Name?: string; File?: string }>;
    };
  };
  try { decl = JSON.parse(model.data.toString("utf8")); } catch { throw new Error("E_BAD_AVATAR"); }
  const moc = decl.FileReferences?.Moc;
  if (!moc || !keep.some((e) => rel(e.name) === moc)) throw new Error("E_BAD_AVATAR");
  for (const t of decl.FileReferences?.Textures ?? []) {
    if (!keep.some((e) => rel(e.name) === t)) throw new Error("E_BAD_AVATAR");
  }
  const id = "u-" + Math.random().toString(16).slice(2, 10);
  const dir = avatarDir(home, id);
  mkdirSync(dir, { recursive: true });
  let total = 0;
  for (const e of keep) {
    total += e.data.byteLength;
    if (total > 120 * 1024 * 1024) throw new Error("E_TOO_BIG");
    const target = join(dir, rel(e.name));
    mkdirSync(join(target, ".."), { recursive: true });
    atomicWriteFile(target, e.data);
  }
  // 公皮的 model3.json 常常不引用 Animation/Exp3（VTube 靠目录扫描），或只引了一部分。
  // 这里把包里所有 .motion3/.exp3 合并进 FileReferences：保留模型自带的正确引用，
  // 再用 Cubism 标准格式（Motions 是 {group:[{File}]}，Expressions 是 [{Name,File}]）
  // 补齐未被引用的项——否则表情/动作按钮会缺项，点了那些文件也不生效。
  try {
    const motions = keep.filter((e) => /\.motion3\.json$/i.test(rel(e.name)));
    const exps = keep.filter((e) => /\.exp3\.json$/i.test(rel(e.name)));
    const fr = (decl.FileReferences ??= {});
    // —— 动作：保留原分组，补齐未引用的（Motions 每项必须是 {File}，pixi 才读得到）——
    const usedMotion = new Set<string>();
    fr.Motions = fr.Motions || {};
    for (const arr of Object.values(fr.Motions)) for (const m of (arr || []) as Array<{ File?: string }>) if (m && m.File) usedMotion.add(m.File);
    for (const e of motions) {
      const f = rel(e.name);
      if (usedMotion.has(f)) continue;
      const grp = /idle/i.test(f) ? "Idle" : "Tap";
      fr.Motions[grp] ??= [];
      fr.Motions[grp]!.push({ File: f });
    }
    // —— 表情：保留原引用，补齐未引用的 ——
    const usedExpr = new Set<string>((fr.Expressions || []).map((x: { File?: string }) => x && x.File).filter(Boolean) as string[]);
    fr.Expressions = fr.Expressions || [];
    for (const e of exps) {
      const f = rel(e.name);
      if (usedExpr.has(f)) continue;
      fr.Expressions.push({ Name: f.replace(/\.exp3\.json$/i, "").split("/").pop(), File: f });
    }
    atomicWriteFile(join(dir, entry), Buffer.from(JSON.stringify(decl, null, 2) + "\n", "utf8"));
  } catch { /* 补引用失败不影响模型本体 */ }
  // 缩略图：优先模型同名预览 png，否则第一张贴图
  const base = entry.replace(/\.model3\.json$/i, "");
  const preview = keep.find((e) => rel(e.name) === base + ".png") ?? keep.find((e) => /texture_00\.png$/i.test(rel(e.name)));
  const thumb = preview ? rel(preview.name) : "";
  const display = cleanName(name) || cleanName(base) || "新形象";
  atomicWriteFile(join(dir, "pal.json"), Buffer.from(JSON.stringify({ name: display, kind: "cubism", entry, thumb, addedAt: Date.now() }, null, 2) + "\n", "utf8"));
  return { id, name: display, base: `/pal/avatars/${id}/`, thumb: thumb ? `/pal/avatars/${id}/${thumb}` : "", builtin: false, kind: "cubism", entry };
}

function cleanName(x: unknown): string {
  return String(x ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
}

/** RuiC-2D 单图绑定包：只收 rig.json / built/**（png+json） */
function importMesh(home: string, name: string, entries: Array<{ name: string; data: Buffer }>): PalAvatar {
  const keep = entries.filter((e) => {
    const n = e.name;
    if (n.startsWith("/") || n.includes("..") || n.split("/").length > 4) return false;
    return /\.(png|json)$/i.test(n) && (n === "rig.json" || n.startsWith("built/"));
  });
  const need = ["rig.json", "built/layers.json", "built/base.png"];
  for (const n of need) if (!keep.some((e) => e.name === n)) throw new Error("E_BAD_AVATAR");
  let rig: unknown;
  try { rig = JSON.parse(keep.find((e) => e.name === "rig.json")!.data.toString("utf8")); } catch { throw new Error("E_BAD_AVATAR"); }
  const r = rig as { image?: unknown; head?: unknown; eyes?: unknown };
  if (!r || !r.image || !r.head || !Array.isArray(r.eyes)) throw new Error("E_BAD_AVATAR");

  const id = "u-" + Math.random().toString(16).slice(2, 10);
  const dir = avatarDir(home, id);
  mkdirSync(join(dir, "built"), { recursive: true });
  for (const e of keep) {
    const target = join(dir, e.name);
    mkdirSync(join(target, ".."), { recursive: true });
    atomicWriteFile(target, e.data);
  }
  const display = cleanName(name) || "新形象";
  atomicWriteFile(join(dir, "pal.json"), Buffer.from(JSON.stringify({ name: display, kind: "mesh", addedAt: Date.now() }, null, 2) + "\n", "utf8"));
  return { id, name: display, base: `/pal/avatars/${id}/`, thumb: `/pal/avatars/${id}/built/base.png`, builtin: false, kind: "mesh" };
}
