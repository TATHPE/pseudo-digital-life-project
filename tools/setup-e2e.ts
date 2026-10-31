/**
 * H-4 端到端验收：**模拟一台什么都没装的机器**，把八步连跑一遍。
 *
 * 为什么要有它：H-4 的验收标准是"新机器从零到能聊，全程不碰终端"。
 * 但真在干净机器上跑要下 6 GB 模型、装 Ollama —— 不能每次改代码都来一遍。
 * 所以这里用**假 runner**把外部件模拟掉（winget / ollama 的调用都是假的），
 * 只验证我们自己的那一半：顺序、记账、配置写入、人格封存、第一句话落盘。
 *
 * 跑法：npm run setup:e2e
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { startSetup, readSession, completeStep, detect, undoSetup, SETUP_STEPS } from "../src/setup.ts";
import { runStep, type Runner } from "../src/setupsteps.ts";
import { templateDraft, saveDraft, sealDraft, readDraft, QUESTIONS } from "../src/interview.ts";
import { runSmoke, sayFirstWords } from "../src/firstrun.ts";
import { generationLog, currentGeneration } from "../src/generation.ts";
import { readEvents } from "../src/journal.ts";
import { loadPersonaText } from "../src/persona.ts";

const home = mkdtempSync(join(tmpdir(), "jj-e2e-"));
const checks: Array<[string, boolean, string]> = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);

/** 假 runner：模拟"什么都还没装"的机器 */
const state = { installed: false, serving: false, models: [] as string[] };
const calls: string[] = [];
const runner: Runner = {
  run(cmd, args) {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "winget") { state.installed = true; return { ok: true, out: "installed" }; }
    if (cmd === "ollama" && args[0] === "--version") return { ok: state.installed, out: "ollama version 0.5.0" };
    if (cmd === "ollama" && args[0] === "list") {
      return { ok: state.serving, out: state.serving ? state.models.map((m) => `${m}:latest`).join("\n") : "" };
    }
    if (cmd === "ollama" && args[0] === "serve") { state.serving = true; return { ok: true, out: "" }; }
    if (cmd === "ollama" && args[0] === "pull") { state.models.push(args[1]!); return { ok: true, out: "success" }; }
    if (cmd === "ollama" && args[0] === "rm") { state.models = state.models.filter((m) => m !== args[1]); return { ok: true, out: "deleted" }; }
    return { ok: true, out: "" };
  },
};

const line = (s: string) => process.stdout.write(s + String.fromCharCode(10));

// ── 0. 空机器 ────────────────────────────────────────
line("home = " + home);
startSetup(home);
ok("事务已开，账本落盘", readSession(home) !== null);

// ── 1. 探测（只读）────────────────────────────────────
const d = await detect(home, { totalMemGB: 15.4, run: runner.run });
ok("探测：认出 ollama 没装", d.ollama.installed === false);
ok("探测：认出没有云端 key", d.config.hasCloudKey === false);
ok("探测：按 15.4 GB 推荐 7B", /7b/.test(d.recommend.model), d.recommend.model);
completeStep(home, "detect", true, "15.4 GB / 空机器");

// ── 2–4. 装 Ollama / embedding / chat ─────────────────
const a1 = runStep(home, "ollama", runner);
ok("装 Ollama：winget 被调用", calls.some((c) => c.startsWith("winget install")), a1.note);
ok("装 Ollama：记账了'我们起的进程'", (readSession(home)!.artifacts.startedProcesses.length > 0));

const a2 = runStep(home, "embed", runner, { model: "bge-m3" });
ok("装 embedding：成功", a2.ok, a2.note);
ok("装 embedding：记账（终止会删）", readSession(home)!.artifacts.pulledModels.includes("bge-m3"));

const a3 = runStep(home, "chat", runner, { chat: "qwen2.5:7b-instruct", model: "bge-m3" });
ok("装 chat 模型：成功", a3.ok, a3.note);
const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { local?: Record<string, string> };
ok("配置写对了 embed/chat", cfg.local?.embed === "bge-m3" && cfg.local?.default === "qwen2.5:7b-instruct", JSON.stringify(cfg.local));
ok("改配置前备份了原文", readSession(home)!.artifacts.files.some((f) => f.path.endsWith("config.json")));

// ── 5. API（面板里填；这里记为已完成）────────────────
completeStep(home, "api", true, "(模拟) 面板上填了 key");

// ── 6. 人格访谈 → 草稿 → 封存 ─────────────────────────
const answers: Record<string, string> = {
  name: "她叫我主人；我叫她鲸鲸",
  never: "不替我确认。不假装记得。不刷屏。",
  hate: "最烦被敷衍、被套话",
  voice: "短句，陈述，不解释自己。",
  initiative: "可以主动，但一天最多两次",
};
const draft = templateDraft(answers);      // 没有模型时的路径（也验它）
saveDraft(home, draft);
ok("草稿存在草稿区，不碰真人格", readDraft(home) !== null && !existsSync(join(home, "persona", "core.md")));
const db = openDb(join(home, "memory.db"));
const seal = sealDraft(db.db, home, { because: "端到端验收封存" });
ok("封存成功", seal.ok);
if (seal.ok) {
  ok("封存开了第 1 代", seal.gen === 1, String(seal.gen));
  const files = readdirSync(join(home, "persona")).filter((f) => f.endsWith(".md"));
  ok("6 个人格文件都写了", files.length >= 6, files.join(","));
  ok("人格内容来自回答", loadPersonaText(home).core.includes("鲸鲸"));
  ok("封存后草稿清掉", readDraft(home) === null);
  ok("代数日志有 1 条", generationLog(db.db).length === 1);
  ok("当前代 = 1", currentGeneration(db.db, home).gen === 1);
  completeStep(home, "persona", true, "访谈 → 草稿 → 封存");
}

// ── 7. 试运行 ────────────────────────────────────────
const smoke = await runSmoke({
  personaText: loadPersonaText(home).core,
  complete: async () => "在。累了就歇着，别硬撑。",
});
ok("试运行拿到回复", smoke.reply.includes("别硬撑"), smoke.reply);
ok("试运行标了 via=model", smoke.via === "model");
completeStep(home, "smoke", true, "试运行通过");

// ── 8. 第一句话 ──────────────────────────────────────
const first = await sayFirstWords({
  inboxDir: join(home, "inbox"),
  personaText: loadPersonaText(home).core,
  complete: async () => "我醒了。你叫什么来着？",
});
ok("第一句话说出来了", first.text.includes("我醒了"), first.text);
ok("第一句话写进 journal", first.written);
const { events } = readEvents(join(home, "inbox"));
ok("journal 里有 firstWords 标记", events.some((e) => (e.payload as { firstWords?: boolean }).firstWords === true));
completeStep(home, "first", true, "第一句话");

// ── 收尾检查 ─────────────────────────────────────────
const s = readSession(home)!;
ok("事务状态 = done", s.status === "done", s.status);
ok("八步全部走到", s.log.length >= 8, String(s.log.length));
ok("步骤顺序没被换", SETUP_STEPS.join(">") === "detect>ollama>embed>chat>api>persona>smoke>first");
ok("账本仍然完整（还能终止回滚）", s.artifacts.pulledModels.length >= 2 && s.artifacts.files.length >= 1);
ok("访谈问题数 = 5", QUESTIONS.length === 5);

// ── 最后：连撤销都要能回到干净状态 ───────────────────
ok("人事文件也进了账本", s.artifacts.files.some((f) => f.path.endsWith("core.md")));
const undone = undoSetup(home, { run: () => ({ ok: true, out: "" }), removeDir: () => { /* ok */ } });
ok("撤销：删掉我们拉的两个模型", undone.removedModels.length === 2, undone.removedModels.join(","));
ok("撤销：没有清不掉的", undone.failed.length === 0, undone.failed.join(";"));
ok("撤销：人格文件也删了（不是删一半）", !existsSync(join(home, "persona", "core.md")));
ok("撤销：config 也回到原样（原本没有）", !existsSync(join(home, "config.json")));

// ── 报告 ─────────────────────────────────────────────
let bad = 0;
for (const [name, pass, detail] of checks) {
  line((pass ? "✅ " : "❌ ") + name + (detail ? "  — " + detail : ""));
  if (!pass) bad++;
}
line("");
line(bad ? `❌ ${bad} 项失败（临时目录留着：${home}）` : `✅ 八步全通（临时目录：${home}）`);
process.exitCode = bad ? 1 : 0;
