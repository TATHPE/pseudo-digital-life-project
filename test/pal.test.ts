/**
 * 陪伴形象与背景（2026-11-13）：素材列表 / 选择持久化 / 上传校验 / 形象包导入。
 * ZIP 用手工拼的最小包（store + deflate 各一条），不引第三方解压依赖。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  palState, setPal, listAvatars, listBackgrounds, saveBackground, removeBackground,
  importAvatar, removeAvatar, unzip, slugId,
} from "../src/pal.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-pal-"));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

/** 最小 ZIP：local header + central directory + EOCD，crc 不校验（读取器也不查） */
function makeZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = Buffer.from(e.name, "utf8");
    const comp = e.deflate ? deflateRawSync(e.data) : e.data;
    const method = e.deflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

const RIG = JSON.stringify({ version: 1, image: { width: 100, height: 200 }, head: { cx: 50, cy: 40 }, eyes: [{}, {}], mouth: {}, view: { padTop: 0.04, padSide: 0.04 } });
function avatarZip(extra: Array<{ name: string; data: Buffer }> = []): Buffer {
  return makeZip([
    { name: "rig.json", data: Buffer.from(RIG), deflate: true },
    { name: "built/layers.json", data: Buffer.from('{"layers":{},"build":"x"}') },
    { name: "built/base.png", data: PNG },
    { name: "player/player.js", data: Buffer.from("console.log(1)") },
    ...extra,
  ]);
}

test("默认状态：内置形象 + 海洋/房间背景，选择落在内置", () => {
  const home = H();
  const s = palState(home);
  assert.equal(s.avatar, "whale");
  assert.equal(s.bg, "ocean");
  assert.ok(s.avatars.some((a) => a.id === "whale" && a.builtin));
  assert.ok(s.backgrounds.some((b) => b.id === "room" && b.url));
  assert.ok(s.backgrounds.some((b) => b.id === "ocean" && b.url === null));
});

test("slugId：只留小写字母数字连字符，防穿越", () => {
  assert.equal(slugId("../../etc/passwd"), "etc-passwd");
  assert.equal(slugId("我的 背景.PNG"), "png");
  assert.equal(slugId(""), "item");
});

test("saveBackground：查文件头、落盘、能选能删；删掉后选择退回海洋", () => {
  const home = H();
  const b = saveBackground(home, "My Room.png", PNG);
  assert.equal(b.id, "my-room");
  assert.equal(b.name, "My Room", "正常文件名直接给人看");
  assert.ok(listBackgrounds(home).some((x) => x.id === "my-room" && x.name === "My Room"));
  const s = setPal(home, { bg: "my-room" });
  assert.equal(s.bg, "my-room");
  assert.ok(removeBackground(home, "my-room"));
  assert.equal(palState(home).bg, "ocean");
  assert.ok(!removeBackground(home, "room"), "内置背景不许删");
});

test("saveBackground：哈希文件名换成「自定义背景 N」，不顶着十六进制", () => {
  const home = H();
  const a = saveBackground(home, "2a984414c1f47b833476b4d2e693ef1f.png", PNG);
  assert.equal(a.name, "自定义背景 1");
  const b = saveBackground(home, "9f8e7d6c5b4a39281706f5e4d3c2b1a0.png", PNG);
  assert.equal(b.name, "自定义背景 2");
  assert.ok(listBackgrounds(home).some((x) => x.id === a.id && x.name === "自定义背景 1"));
});

test("saveBackground：假图片与超大图都拒", () => {
  const home = H();
  assert.throws(() => saveBackground(home, "x.png", Buffer.from("<script>alert(1)</script>")), /E_BAD_IMAGE/);
  assert.throws(() => saveBackground(home, "big.png", Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)])), /E_TOO_BIG/);
});

test("setPal：不存在的 id 拒；形象与背景互不覆盖", () => {
  const home = H();
  assert.throws(() => setPal(home, { bg: "nope" }), /E_NO_BG/);
  assert.throws(() => setPal(home, { avatar: "nope" }), /E_NO_AVATAR/);
  setPal(home, { bg: "room" });
  const s = setPal(home, { avatar: "whale" });
  assert.equal(s.bg, "room", "改形象不能把背景抹掉");
});

test("unzip：store 与 deflate 都能读；不是 zip 诚实报错", () => {
  const z = makeZip([
    { name: "a.txt", data: Buffer.from("hello") },
    { name: "b.txt", data: Buffer.from("world".repeat(50)), deflate: true },
  ]);
  const out = unzip(z);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.data.toString(), "hello");
  assert.equal(out[1]!.data.toString(), "world".repeat(50));
  assert.throws(() => unzip(Buffer.from("not a zip")), /E_NOT_ZIP/);
});

test("importAvatar：只收 rig/built，穿越条目与播放器被丢弃；导入后能选能删", () => {
  const home = H();
  const a = importAvatar(home, "测试形象", avatarZip([{ name: "../evil.png", data: PNG }]));
  assert.match(a.id, /^u-[0-9a-f]{8}$/);
  assert.equal(a.name, "测试形象");
  const dir = join(home, "pal", "avatars", a.id);
  assert.ok(existsSync(join(dir, "rig.json")));
  assert.ok(existsSync(join(dir, "built", "base.png")));
  assert.ok(!existsSync(join(dir, "player", "player.js")), "播放器不该进包");
  assert.ok(!existsSync(join(home, "pal", "evil.png")), "穿越条目不能落地");
  assert.equal(JSON.parse(readFileSync(join(dir, "rig.json"), "utf8")).eyes.length, 2);
  const s = setPal(home, { avatar: a.id });
  assert.equal(s.avatar, a.id);
  assert.ok(listAvatars(home).some((x) => x.id === a.id && !x.builtin));
  assert.ok(removeAvatar(home, a.id));
  assert.equal(palState(home).avatar, "whale", "删掉正在用的形象要退回内置");
  assert.ok(!removeAvatar(home, "whale"), "内置形象不许删");
});

test("importAvatar：缺 rig / 坏 rig / 非 zip 都拒，不留半个目录", () => {
  const home = H();
  assert.throws(() => importAvatar(home, "x", makeZip([{ name: "built/base.png", data: PNG }])), /E_BAD_AVATAR/);
  assert.throws(() => importAvatar(home, "x", makeZip([
    { name: "rig.json", data: Buffer.from('{"nope":1}') },
    { name: "built/layers.json", data: Buffer.from("{}") },
    { name: "built/base.png", data: PNG },
  ])), /E_BAD_AVATAR/);
  assert.throws(() => importAvatar(home, "x", Buffer.from("hello")), /E_NOT_ZIP/);
  assert.equal(listAvatars(home).length, 1, "失败导入不留目录");
});

test("importAvatar：Live2D 公皮（model3+moc3+贴图）识别为 cubism，剥外层目录、补表情/动作引用", () => {
  const home = H();
  const model3 = JSON.stringify({
    Version: 3,
    FileReferences: { Moc: "m.moc3", Textures: ["tex/texture_00.png"], Physics: "m.physics3.json" },
  });
  const zip = makeZip([
    { name: "包装/DeepSeek/m.model3.json", data: Buffer.from(model3), deflate: true },
    { name: "包装/DeepSeek/m.moc3", data: Buffer.from([1, 2, 3]) },
    { name: "包装/DeepSeek/tex/texture_00.png", data: PNG },
    { name: "包装/DeepSeek/m.physics3.json", data: Buffer.from("{}") },
    { name: "包装/DeepSeek/Exp3/脸红.exp3.json", data: Buffer.from("{}") },
    { name: "包装/DeepSeek/Animation/IDLE.motion3.json", data: Buffer.from("{}") },
    { name: "包装/psd/大.psd", data: Buffer.alloc(70 * 1024 * 1024) },  // >64MB 应被跳过
    { name: "包装/使用须知.txt", data: Buffer.from("license") },
  ]);
  const a = importAvatar(home, "", zip);
  assert.equal(a.kind, "cubism");
  assert.equal(a.entry, "m.model3.json");
  assert.equal(a.name, "m", "没给名字时用模型文件名");
  const dir = join(home, "pal", "avatars", a.id);
  assert.ok(existsSync(join(dir, "m.moc3")));
  assert.ok(existsSync(join(dir, "tex", "texture_00.png")));
  assert.ok(!existsSync(join(dir, "..", "..", "psd")), "PSD 不该落地");
  const saved = JSON.parse(readFileSync(join(dir, "m.model3.json"), "utf8"));
  assert.ok(saved.FileReferences.Expressions.some((e: any) => e.Name === "脸红" && typeof e.File === "string"), "表情要补进引用且为标准对象格式");
  const idle = saved.FileReferences.Motions.Idle;
  assert.ok(Array.isArray(idle) && idle.length === 1 && typeof idle[0] === "object" && typeof idle[0].File === "string", "IDLE 要归到 Idle 组且为 {File} 对象（不是字符串）");
  const listed = listAvatars(home).find((x) => x.id === a.id);
  assert.equal(listed?.kind, "cubism");
  assert.ok(removeAvatar(home, a.id));
});

test("importAvatar：model3 已自带部分表情/动作引用时，仍补齐未引用的项且格式正确", () => {
  const home = H();
  // 模型自带了 Idle 动作和「默认」表情的引用（正确格式），但包里还有 TAP 动作与「脸红」表情未被引用；
  // 旧逻辑因 !fr.Motions / !fr.Expressions 守卫会整段跳过 → 这些项永远进不了引用 → 点了不生效。
  const model3 = JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: "m.moc3", Textures: ["tex/texture_00.png"],
      Motions: { Idle: [{ File: "Animation/IDLE.motion3.json", FadeInTime: 0.5 }] },
      Expressions: [{ Name: "默认", File: "Exp3/默认.exp3.json" }],
    },
  });
  const zip = makeZip([
    { name: "pkg/m.model3.json", data: Buffer.from(model3), deflate: true },
    { name: "pkg/m.moc3", data: Buffer.from([1, 2, 3]) },
    { name: "pkg/tex/texture_00.png", data: PNG },
    { name: "pkg/Animation/IDLE.motion3.json", data: Buffer.from("{}") },
    { name: "pkg/Animation/TAP.motion3.json", data: Buffer.from("{}") }, // 未被原引用，应补到 Tap 组
    { name: "pkg/Exp3/默认.exp3.json", data: Buffer.from("{}") },
    { name: "pkg/Exp3/脸红.exp3.json", data: Buffer.from("{}") }, // 未被原引用，应补
    { name: "pkg/a/b/c/d/TAP2.motion3.json", data: Buffer.from("{}") }, // 5 层：旧逻辑 >4 会被丢，新逻辑保留
  ]);
  const a = importAvatar(home, "自带引用", zip);
  const dir = join(home, "pal", "avatars", a.id);
  const saved = JSON.parse(readFileSync(join(dir, "m.model3.json"), "utf8"));
  const fr = saved.FileReferences;
  // 自带的 Idle 与「默认」表情要保留
  assert.ok(fr.Motions.Idle.some((m: any) => m.File === "Animation/IDLE.motion3.json"), "自带 Idle 引用要保留");
  assert.ok(fr.Expressions.some((e: any) => e.Name === "默认" && e.File === "Exp3/默认.exp3.json"), "自带表情要保留");
  // 未引用的动作补齐到 Tap 组；深层的 TAP2 也要补上且文件落地
  assert.ok(fr.Motions.Tap.some((m: any) => m.File === "Animation/TAP.motion3.json"), "未引用的动作要补到 Tap 组");
  assert.ok(fr.Motions.Tap.some((m: any) => m.File === "a/b/c/d/TAP2.motion3.json"), "深层动作文件也能被引用");
  assert.ok(existsSync(join(dir, "a", "b", "c", "d", "TAP2.motion3.json")), "深层动作文件要落地（不被深度过滤丢）");
  // 未引用的「脸红」补上，且为标准对象格式
  assert.ok(fr.Expressions.some((e: any) => e.Name === "脸红" && typeof e.File === "string"), "未引用的表情要补上且为标准对象格式");
  // 所有 Motions 项都必须是 {File} 对象（之前是字符串数组，pixi 读不到 → 不生效）
  for (const g of Object.keys(fr.Motions)) for (const m of fr.Motions[g]) assert.equal(typeof m, "object", `Motions.${g} 项必须是对象`);
  removeAvatar(home, a.id);
});

test("importAvatar：公皮缺 moc / 缺贴图拒", () => {
  const home = H();
  const model3 = JSON.stringify({ FileReferences: { Moc: "m.moc3", Textures: ["tex/t0.png"] } });
  assert.throws(() => importAvatar(home, "x", makeZip([
    { name: "m.model3.json", data: Buffer.from(model3) },
    { name: "tex/t0.png", data: PNG },
  ])), /E_BAD_AVATAR/);  // 缺 moc
  assert.throws(() => importAvatar(home, "x", makeZip([
    { name: "m.model3.json", data: Buffer.from(model3) },
    { name: "m.moc3", data: Buffer.from([1]) },
  ])), /E_BAD_AVATAR/);  // 缺贴图
});
