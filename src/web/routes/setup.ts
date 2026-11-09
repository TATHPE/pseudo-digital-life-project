/**
 * 首次配置 / 人格访谈路由（从 web/server.ts 抽出，行为逐字不变）。
 * expressComplete 与 jobState 原本是 server.ts 的模块级状态，整块搬来保持语义。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { readFileConfig } from "../../configfile.ts";
import { readSession, startSetup, skipSetup, pauseSetup, resumeSetup, backSetup, undoSetup, detect, SETUP_STEPS, type SetupStep } from "../../setup.ts";
import { runStep } from "../../setupsteps.ts";
import { appendEvent, newEventId } from "../../journal.ts";
import type { Provider } from "../../auth.ts";

type SecretStore = ReturnType<typeof import("../../auth.ts").createStore>;

/**
 * 给首次配置用的表达模型取用器：有云端 key 就返回一个 complete；没有就 null。
 * 返回 null 不是错误 —— 调用方会用模板并**明说**这是模板。
 */
async function expressComplete(deps: { home: string }): Promise<((system: string, user: string) => Promise<string>) | null> {
  try {
    const { resolveConfig } = await import("../../configfile.ts");
    const { createChatTransport, routerFrom } = await import("../../transport.ts");
    const { createStore } = await import("../../auth.ts");
    const cfg = resolveConfig(deps.home);
    const store = createStore(`${deps.home}/secrets`);
    const keys: Record<string, string> = {};
    for (const p of ["deepseek", "anthropic", "openai"] as const) { const k = store.get(p); if (k) keys[p] = k; }
    if (!Object.keys(keys).length) return null;
    const chat = createChatTransport(routerFrom(cfg.roles as never), { apiKeys: keys });
    return async (system, user) => {
      let out = "";
      let finish = "";
      for await (const ev of chat.chat("express", [{ role: "system", content: system }, { role: "user", content: user }], {
        // 发的是人格设定（用户刚写的答案），不是记忆原文；面板已在访谈前告知
        // 900 不够：实测 finish="length" 且 **delta 为空**（预算被推理吃掉），
        // 上层只能看到空串，于是"模型写不出草稿"——其实是根本没给它写完的额度。
        containsMemory: false, purpose: "setup-interview", maxTokens: 4096, temperature: 0.4,
      })) {
        if (ev.type === "delta") out += ev.text;
        else if (ev.type === "done") finish = String((ev as { finish?: string }).finish ?? "");
      }
      // 空输出 + finish=length：不是"没内容"，是额度被吃完了（推理模型常见）。
      // 必须区分开 —— 否则上层会把它当成"模型写不出来"然后静默退回模板，真因就被埋了。
      if (!out.trim() && finish === "length") throw new Error("E_OUTPUT_TRUNCATED: 额度用尽但没产出内容");
      return out;
    };
  } catch { return null; }
}
// H-4：首次配置的后台任务状态（pull 模型可能要几分钟，不能把 HTTP 请求挂着）
const jobState: { running: boolean; step: string | null; note: string; done: boolean; ok: boolean } =
  { running: false, step: null, note: "", done: true, ok: true };

/** 只声明本模块真正用到的 deps 字段（结构化类型，WebDeps 天然可赋值）。 */
export interface SetupDeps {
  db: DatabaseSync;
  home: string;
  inboxDir: string;
  getConfig: () => { roles: Record<string, { provider: string; model: string; baseUrl?: string }>; ollama: string };
}

export interface SetupCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  deps: SetupDeps;
  now: () => Date;
  json: (res: ServerResponse, code: number, obj: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
  writeGuarded: (req: IncomingMessage) => { ok: boolean; reason?: string };
  secrets: () => SecretStore;
}

export async function handleSetup(ctx: SetupCtx): Promise<boolean> {
  const { req, res, url, deps, now, json, readBody, writeGuarded, secrets } = ctx;
      // ── 人格访谈（H-4 ⑥）：5 问 → 6 块草稿 → 逐块确认 → 封存 ──
      if (req.method === "GET" && url.pathname === "/api/setup/interview") {
        const iv = await import("../../interview.ts");
        json(res, 200, { questions: iv.QUESTIONS, draft: iv.readDraft(deps.home) });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/setup/interview") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const iv = await import("../../interview.ts");
        const body = JSON.parse(await readBody(req)) as {
          action?: string; answers?: Record<string, string>; blocks?: Record<string, Array<{ text: string; source: string }>>; because?: string;
        };
        if (body.action === "draft") {
          const answers = body.answers ?? {};
          // 一个字都没填就别让模型写：它会输出"未提供具体内容（仅出现字段名）"这种句子，
          // 而我们在面板上看到的是一屏看起来很像内容的垃圾（真踩过）。
          const filled = Object.values(answers).filter((v) => String(v ?? "").trim().length > 0);
          // 一个字都没答：不叫模型（它只会说"未提供具体内容"），直接用中立模板拼 —— 并明说。
          if (!filled.length) {
            const t = iv.templateDraft(answers, now());
            iv.saveDraft(deps.home, t);
            json(res, 200, { ok: true, draft: t, modelAdded: iv.countModelAdded(t), via: "template" });
            return true;
          }
          // 答得少时，没答的那些用问题自带的 fallback 顶上（中立模板，不是编造）。
          // 这样模型总有事可做，不会因为"信息太少"把整份草稿写成借口。
          for (const q of iv.QUESTIONS) {
            const v = String(answers[q.id] ?? "").trim();
            if (!v) answers[q.id] = q.fallback;
          }
          // 有表达模型就用它写；没有就模板（**明说**，不假装是模型写的）
          let d = iv.templateDraft(answers, now());
          const complete = await expressComplete(deps);
          if (complete) {
            try {
              const prompt = [
                "下面是一个人对自己 AI 伴侣的 5 个回答。请把它整理成 6 块设定。",
                "铁律：只能整理他说过的话，不能添加他没说过的具体事实、名称、数字。",
                "输出格式：**块的标题必须恰好是这些英文小写**：## core / ## boundaries / ## values / ## voice / ## evidence / ## tools。",
                "每条一行，行首用 - 开头。不要用中文标题，不要加别的段落。",
                "例子（照这个形状写）：",
                "## core",
                "- 她叫我主人（你原话）",
                "## boundaries",
                "- 不替我确认（你原话）",
                "你自己补充的理解，行尾必须写（模型补的，请确认）。",
                "用户的原话（每条一问一答，问题只是标签）：",
                ...Object.entries(answers).map(([k, v]) => `问（${k}）：${v}`),
              ].join(String.fromCharCode(10));
              const raw = await complete(prompt, "现在开始整理，只输出那 6 段。");
              d = iv.parseDraft(raw, answers, now());
            } catch (e) {
              d = { ...iv.templateDraft(answers, now()), note: "模型写失败了，用你的原话 + 中立模板：" + String(e).slice(0, 80) };
            }
          }
          if ((d as { emptyAll?: boolean }).emptyAll) {
            // 模型没产出 → 退回模板（有兜底，但不能假装是模型写的）
            const t = iv.templateDraft(answers, now());
            t.note = "模型这次没写出可用的内容，下面是用你的原话 + 中立模板拼的";
            iv.saveDraft(deps.home, t);
            json(res, 200, { ok: true, draft: t, modelAdded: iv.countModelAdded(t), via: "template", fellBack: true });
            return true;
          }
          iv.saveDraft(deps.home, d);
          json(res, 200, { ok: true, draft: d, modelAdded: iv.countModelAdded(d) });
          return true;
        }
        if (body.action === "discard") {
          iv.discardDraft(deps.home);
          json(res, 200, { ok: true, draft: null });
          return true;
        }
        if (body.action === "save") {
          const cur = iv.readDraft(deps.home);
          if (!cur) { json(res, 404, { error: "E_NO_DRAFT" }); return true; }
          const next = { ...cur, blocks: body.blocks ?? cur.blocks } as typeof cur;
          iv.saveDraft(deps.home, next);
          json(res, 200, { ok: true, draft: next });
          return true;
        }
        if (body.action === "seal") {
          const r = iv.sealDraft(deps.db, deps.home, { because: String(body.because ?? ""), now: now() });
          if (!r.ok) { json(res, 400, r); return true; }
          try {
            appendEvent(deps.inboxDir, {
              v: 1, id: newEventId(), ts: now().toISOString(), kind: "persona_seal", actor: "user",
              payload: { gen: r.gen, files: r.files },
            });
          } catch { /* 事件写不下不影响封存 */ }
          const miss = r.missing.map((f) => f + ".md").join("、");
          json(res, 200, {
            ok: true, gen: r.gen, files: r.files, missing: r.missing,
            note: "已封存为第 " + r.gen + " 代；之后要改就是开新一代" +
              (miss ? "（" + miss + " 访谈里没说到，仍是出厂默认 —— 可以去设置里补）" : ""),
          });
          return true;
        }
        json(res, 400, { error: "E_BAD_ACTION" });
        return true;
      }

      // ── 试运行（⑦）与第一句话（⑧）──
      if (req.method === "POST" && url.pathname === "/api/setup/smoke") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const fr = await import("../../firstrun.ts");
        const { loadPersonaText } = await import("../../persona.ts");
        const files = loadPersonaText(deps.home);
        const personaText = Object.entries(files).map(([k, v]) => `# ${k}` + String.fromCharCode(10) + v).join(String.fromCharCode(10, 10));
        const r = await fr.runSmoke({ personaText, ...(await expressComplete(deps) ? { complete: (await expressComplete(deps))! } : {}) });
        json(res, 200, r);
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/setup/first") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const fr = await import("../../firstrun.ts");
        const { loadPersonaText } = await import("../../persona.ts");
        const files = loadPersonaText(deps.home);
        const personaText = Object.entries(files).map(([k, v]) => `# ${k}` + String.fromCharCode(10) + v).join(String.fromCharCode(10, 10));
        const r = await fr.sayFirstWords({
          inboxDir: deps.inboxDir, personaText, now: now(),
          ...(await expressComplete(deps) ? { complete: (await expressComplete(deps))! } : {}),
        });
        json(res, 200, r);
        return true;
      }
      // ── 首次配置（H-4）：可暂停、可终止、终止先给预览 ──
      if (req.method === "GET" && url.pathname === "/api/setup") {
        const session = readSession(deps.home);
        let d: Awaited<ReturnType<typeof detect>> | null = null;
        if (url.searchParams.get("detect") === "1") { try { d = await detect(deps.home); } catch { d = null; } }
        // 「还没配好」看的是能不能真开口：有没有模型 + 有没有对应的密钥。
        // 用户跳过引导、后来在设置里手配了，这里就应当是 false（不该再挂横幅）。
        const cfgNow = deps.getConfig();
        const exRole = cfgNow.roles?.["express"];
        const localModel = String((readFileConfig(deps.home) as { local?: { default?: string } }).local?.default ?? "");
        const hasAnyModel = Boolean(exRole?.model) || Boolean(localModel);
        let hasAnyKey = false;
        try { hasAnyKey = Boolean(exRole?.provider && secrets().get(exRole.provider as Provider)); } catch { hasAnyKey = false; }
        const needsConfig = !hasAnyModel || (Boolean(exRole?.provider) && !hasAnyKey && !localModel);
        json(res, 200, { session, steps: SETUP_STEPS, job: jobState, detected: d, needsConfig });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/setup") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { action?: string; step?: string; confirm?: boolean };
        if (body.action === "start") { json(res, 200, { ok: true, session: startSetup(deps.home) }); return true; }
        if (body.action === "pause") { json(res, 200, { ok: true, session: pauseSetup(deps.home) }); return true; }
        if (body.action === "skip") { json(res, 200, { ok: true, session: skipSetup(deps.home) }); return true; }
        if (body.action === "resume") { json(res, 200, { ok: true, session: resumeSetup(deps.home) }); return true; }
        if (body.action === "back") { json(res, 200, { ok: true, session: backSetup(deps.home) }); return true; }
        if (body.action === "run") {
          const step = String(body.step ?? "") as SetupStep;
          if (!SETUP_STEPS.includes(step)) { json(res, 400, { error: "E_BAD_STEP" }); return true; }
          if (jobState.running) { json(res, 409, { error: "E_SETUP_BUSY" }); return true; }
          Object.assign(jobState, { running: true, step, note: "开始…", done: false, ok: true });
          // 后台跑：pull 模型可能要几分钟，HTTP 不能挂着
          void (async () => {
            try {
              const { execFileSync } = await import("node:child_process");
              const runner = {
                run(cmd: string, args: string[], o?: { timeoutMs?: number }) {
                  try { return { ok: true, out: String(execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: o?.timeoutMs ?? 600_000 })) }; }
                  catch (e) { return { ok: false, out: String((e as Error).message).slice(0, 200) }; }
                },
              };
              const r = runStep(deps.home, step, runner);
              Object.assign(jobState, { running: false, note: r.note, done: true, ok: r.ok });
            } catch (e) {
              Object.assign(jobState, { running: false, done: true, ok: false, note: String(e).slice(0, 200) });
            }
          })();
          json(res, 202, { ok: true, job: jobState });
          return true;
        }
        if (body.action === "abort") {
          const session = readSession(deps.home);
          const a = session?.artifacts;
          // **先说再做**：预览里列出会删什么、会恢复什么；没 confirm 就只返回预览
          const preview = {
            models: a?.pulledModels ?? [],
            files: (a?.files ?? []).map((f) => f.path),
            processes: (a?.startedProcesses ?? []).map((p) => p.name),
            dirs: a?.tempDirs ?? [],
          };
          if (body.confirm !== true) { json(res, 200, { ok: true, needConfirm: true, preview }); return true; }
          const report = undoSetup(deps.home);
          json(res, 200, { ok: true, report });
          return true;
        }
        json(res, 400, { error: "E_BAD_ACTION" });
        return true;
      }

  return false;
}
