import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import {
  QUESTIONS, classifyLines, templateDraft, parseDraft, saveDraft, readDraft, discardDraft,
  sealDraft, countModelAdded, renderBlock,
} from "../src/interview.ts";
import { runSmoke, sayFirstWords } from "../src/firstrun.ts";
import { generationLog, currentGeneration } from "../src/generation.ts";
import { readEvents } from "../src/journal.ts";

const H = () => mkdtempSync(join(tmpdir(), "jj-iv-"));
const ANSWERS = {
  name: "她叫我主人；我叫她鲸鲸",
  never: "不替我确认。不假装记得。不刷屏。",
  hate: "最烦被敷衍、被套话",
  voice: "短句，陈述，不解释自己。",
  initiative: "可以主动，但一天最多两次",
};

test("H-4 访谈：5 个问题，每个都有兜底（不许卡死）", () => {
  assert.equal(QUESTIONS.length, 5);
  for (const q of QUESTIONS) {
    assert.ok(q.q.length > 4);
    assert.ok(q.fallback.length > 4, "每个问题都要有中立兜底：" + q.id);
    assert.ok(q.feeds.length > 0);
  }
});

test("H-4 死约束：模型不能自称「你原话」—— 只有逐字命中用户的回答才算", () => {
  const raw = [
    "她叫我主人；我叫她鲸鲸",                      // 逐字命中 → 你原话
    "她每天凌晨三点会写诗",                        // 编的 → 模型补的
    "[你原话] 她讨厌被叫助手",                    // 假claim + 内容不在回答里 → 降级
  ].join(String.fromCharCode(10));
  const lines = classifyLines(raw, ANSWERS);
  assert.equal(lines[0]!.source, "你原话");
  assert.equal(lines[1]!.source, "模型补的（请确认）", "模型编的内容必须被降级");
  assert.equal(lines[2]!.source, "模型补的（请确认）", "模型自己写「你原话」不算数");
});

test("H-4 没有模型时用模板：只用用户原话 + 中立补丁，且明说", () => {
  const d = templateDraft(ANSWERS);
  assert.equal(d.via, "template");
  assert.match(String(d.note), /没有可用模型/);
  const boundary = d.blocks.boundaries.map((l) => l.text);
  assert.deepEqual(boundary, ["不替我确认", "不假装记得", "不刷屏"], "按句号拆开");
  assert.ok(d.blocks.evidence.every((l) => l.source === "模型补的（请确认）"), "模板补的必须标出来");
  assert.ok(countModelAdded(d) >= 2);
});

test("H-4 解析模型输出：按 ## 块名分段，未知内容归 core 并过闸", () => {
  const raw = [
    "## core", "- 她叫我主人；我叫她鲸鲸", "- 她会主动说话，但一天最多两次",
    "## boundaries", "- 不替我确认",
    "## voice", "- 短句，陈述，不解释自己。",
  ].join(String.fromCharCode(10));
  const d = parseDraft(raw, ANSWERS);
  assert.equal(d.via, "model");
  assert.ok(d.blocks.core.length >= 1);
  assert.ok(d.blocks.boundaries.some((l) => l.text === "不替我确认" && l.source === "你原话"));
  assert.match(renderBlock(d.blocks.boundaries), /你原话/);
});

test("H-4 草稿只在草稿区：封存之前不碰真人格文件", () => {
  const home = H();
  const d = templateDraft(ANSWERS);
  saveDraft(home, d);
  assert.ok(readDraft(home), "草稿存得住");
  assert.equal(existsSync(join(home, "persona", "core.md")), false, "封存前不许写真人格");
  discardDraft(home);
  assert.equal(readDraft(home), null);
});

test("H-4 封存：写 6 块 + 开第 1 代 + 清掉草稿 + 留事件", () => {
  const home = H();
  const d = openDb(join(home, "m.db"));
  saveDraft(home, templateDraft(ANSWERS));
  const r = sealDraft(d.db, home, { because: "访谈完封存" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.gen, 1, "封存 = 第 1 代");
  assert.ok(r.files.includes("core"));
  assert.ok(readFileSync(join(home, "persona", "core.md"), "utf8").includes("鲸鲸"));
  assert.equal(readDraft(home), null, "封存后草稿清掉（内容已经在 persona 里）");
  assert.equal(generationLog(d.db).length, 1);
  assert.match(generationLog(d.db)[0]!.because, /访谈/);
  assert.equal(currentGeneration(d.db, home).gen, 1);
});

test("H-4 试运行：没有表达模型就用模板，但**明说**这是模板", async () => {
  const r = await runSmoke({ personaText: "# core\n短句。" , });
  assert.equal(r.via, "template");
  assert.match(r.reply, /模板/);
  assert.match(String(r.note), /云端 API/);
  assert.ok(r.extracted.length >= 1);
});

test("H-4 第一句话：写进 journal（不是弹个成功框）", async () => {
  const home = H();
  const r = await sayFirstWords({ inboxDir: join(home, "inbox"), personaText: "# core\n短句。" });
  assert.equal(r.written, true);
  assert.ok(r.text.length > 0);
  const { events } = readEvents(join(home, "inbox"));
  const first = events.find((e) => (e.payload as { firstWords?: boolean }).firstWords);
  assert.ok(first, "第一句话必须真的落到 journal 里");
  assert.equal(first!.kind, "agent_reply");
});
