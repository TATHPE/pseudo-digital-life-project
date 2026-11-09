/**
 * 记忆 / 文档视图与增删改路由（从 web/server.ts 抽出，行为逐字不变）。
 * 命中任一路由就自己写响应并 return true；没命中 return false。
 * 只通过 MemoryCtx 拿闭包量，不与 server.ts 形成运行期循环依赖。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { search } from "../../retrieve.ts";
import { listDocs, forgetDoc, setDocSensitivity } from "../../ingest.ts";
import { appendEvent, newEventId } from "../../journal.ts";
import type { Embedder } from "../../embed.ts";

/**
 * 「不是关于人、是关于机器」的那一类记忆（断片 / 睡过头）。
 *
 * 只用于**视图分流**，不参与任何写入或删除：D-J（2026-10-28）拍过
 * 「outage 是真事件，不动记忆，要改就改视图」。现在它占 active 的 92%，
 * 视图这层不能再不做了 —— 否则「记忆」这一屏打开就是 193 条「进程被杀 N 分钟」。
 *
 * `ifnull(source_ref,'')` 不是防御性写法，是必须的：source_ref 允许为 NULL，
 * 而 `NULL = 'startup'` 是 NULL，`NOT (NULL OR …)` 还是 NULL —— 整行会被静默过滤掉。
 * 第一版就是这么写的，测试直接抓到「关于你 0 条」。
 */
const OUTAGE_SQL =
  "(ifnull(source_ref,'')='startup' OR text LIKE '进程被杀%' OR text LIKE '我睡了%' OR text LIKE '断电%' OR text LIKE '关机%')";

/** 只声明本模块真正用到的 deps 字段（结构化类型，WebDeps 天然可赋值）。 */
export interface MemoryDeps {
  db: DatabaseSync;
  inboxDir: string;
  getEmbedder: () => Embedder | null;
}

export interface MemoryCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  deps: MemoryDeps;
  now: () => Date;
  json: (res: ServerResponse, code: number, obj: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
  writeGuarded: (req: IncomingMessage) => { ok: boolean; reason?: string };
}

export async function handleMemory(ctx: MemoryCtx): Promise<boolean> {
  const { req, res, url, deps, now, json, readBody, writeGuarded } = ctx;
      if (req.method === "GET" && url.pathname === "/api/memories") {
        const q = url.searchParams.get("q") ?? "";
        // 两种视图（2026-11-04）：断片记录占了 active 的 92%，把「关于你」淹没了。
        // 只过滤**视图**，不动数据（D-J 2026-10-28：outage 是真事件，改视图不改记忆）。
        const scope = url.searchParams.get("scope") ?? "all";
        const scopeSql = scope === "about" ? ` AND NOT ${OUTAGE_SQL}` : scope === "outage" ? ` AND ${OUTAGE_SQL}` : "";
        const rows = q
          ? (deps.getEmbedder()
            ? (await search(deps.db, deps.getEmbedder()!, q, { k: 12 })).hits.map((h) => ({
              id: h.id, text: h.text, stage: h.stage, weight: h.weight, kind: "episode",
            }))
            : [])
          : (deps.db.prepare(
            `SELECT id,text,stage,weight,kind FROM memories WHERE status='active'${scopeSql}
             ORDER BY weight DESC, updated_at DESC LIMIT ? OFFSET ?`)
            .all(
              Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 40))),
              Math.max(0, Number(url.searchParams.get("offset") ?? 0)),
            ) as Array<{ id: number; text: string; stage: string; weight: number; kind: string }>);
        json(res, 200, rows);
        return true;
      }
      // 「关于你」的缺口（2026-11-04）：记忆不够多，就由人补 —— 面板问三句，答一句落一条。
      if (req.method === "GET" && url.pathname === "/api/profile/gaps") {
        try {
          const { openGaps, GAPS } = await import("../../profile.ts");
          // 面板要能把六道题一条条答完，所以给全量
          const gaps = openGaps(deps.db, 99);
          json(res, 200, { gaps, answered: GAPS.length - gaps.length, total: GAPS.length });
        } catch { json(res, 200, { gaps: [], answered: 0, total: 0 }); }
        return true;
      }
      if (req.method === "POST" && url.pathname === "/api/profile/answer") {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        let body: { key?: unknown; text?: unknown } = {};
        try { body = JSON.parse(await readBody(req)) as typeof body; } catch { json(res, 400, { error: "E_JSON" }); return true; }
        const { answerGap } = await import("../../profile.ts");
        const r = answerGap(deps.db, String(body.key ?? ""), String(body.text ?? ""), now());
        json(res, r.ok ? 200 : 400, r.ok ? { ok: true, id: r.id } : r);
        return true;
      }

      // 记忆的三个数：总数 / 关于你 / 断片。给面板的两个 chip 用。
      if (req.method === "GET" && url.pathname === "/api/memories/summary") {
        const r = deps.db.prepare(
          `SELECT count(*) AS total,
                  sum(CASE WHEN ${OUTAGE_SQL} THEN 1 ELSE 0 END) AS outage,
                  sum(CASE WHEN NOT ${OUTAGE_SQL} AND julianday(created_at) > julianday('now','-7 days')
                           THEN 1 ELSE 0 END) AS about7d
             FROM memories WHERE status='active'`,
        ).get() as { total: number; outage: number | null; about7d: number | null };
        const total = Number(r.total ?? 0);
        const outage = Number(r.outage ?? 0);
        // 本周新增的「关于你」：没有这条，用户只能靠感觉判断"是不是越记越多"
        json(res, 200, { total, outage, about: total - outage, about7d: Number(r.about7d ?? 0) });
        return true;
      }
      const memId = url.pathname.match(/^\/api\/memories\/(\d+)$/);
      if (req.method === "GET" && memId) {
        const id = Number(memId[1]);
        const row = deps.db.prepare(
          `SELECT id,text,kind,layer,subject,stage,weight,w0,importance,sensitivity,taint,scored_by,status,
                  quote,source_kind,source_ref,superseded_by,created_under_gen,created_at,updated_at,last_decay_at
           FROM memories WHERE id=?`).get(id) as Record<string, unknown> | undefined;
        if (!row) { json(res, 404, { error: "E_NOT_FOUND" }); return true; }

        // F-1 #5「看不出来源」：一条记忆必须能回答"它从哪来、改过什么"
        // pre-image 来自 events(kind='memory_text_changed')，旧正文存在 payload 里（E-4/E-5 写的）
        const changes = (deps.db.prepare(
          `SELECT ts, actor, payload FROM events WHERE kind='memory_text_changed' AND target=? ORDER BY ts DESC LIMIT 10`,
        ).all(String(id)) as Array<{ ts: string; actor: string; payload: string }>)
          .map((e) => {
            // 字段名是 store.ts 写的 `before_text`（不是 old）—— 这里猜错过一次
            let old = "";
            try {
              const j = JSON.parse(e.payload) as { before_text?: string; old?: string };
              old = String(j.before_text ?? j.old ?? "");
            } catch { /* 老记录没有 pre-image */ }
            return { at: e.ts, by: e.actor, old };
          })
          .filter((x) => x.old);

        // 文档来源：source_ref 存的是相对路径（ingest 时写的），能对上的给出 doc id
        let doc: { id: string; title: string } | null = null;
        const ref = String(row.source_ref ?? "");
        if (row.source_kind === "doc" && ref) {
          try {
            const d = deps.db.prepare(
              "SELECT id,title FROM documents WHERE rel_path=? AND deleted_at IS NULL LIMIT 1",
            ).get(ref) as { id: string; title: string } | undefined;
            if (d) doc = { id: d.id, title: d.title };
          } catch { /* 没有 documents 表也不该 500 */ }
        }
        // H-5：这条记忆出生时是哪一代人格（改人格不改写旧记忆的解释）
        let generation: { gen: number; fingerprint: string; createdAt: string; because: string } | null = null;
        try {
          const g = Number((row.created_under_gen as number | undefined) ?? 0);
          const { generationOf } = await import("../../generation.ts");
          generation = generationOf(deps.db, g) ?? {
            gen: g, fingerprint: "", createdAt: "",
            because: g === 0 ? "未封存（迁移前的老记忆）" : "那条分代记录已不在日志里",
          };
        } catch { /* 读不到不影响详情 */ }
        json(res, 200, { ...row, generation, provenance: { changes, doc } });
        return true;
      }
      // F-3：忘记的**撤销**。忘记是软删（status='deleted'），所以能原样放回；
      // 只回 status，不动 weight —— 权重已经按时间衰减过，硬抬回去等于假装它没被忘过。
      const memRestore = url.pathname.match(/^\/api\/memories\/(\d+)\/restore$/);
      if (req.method === "POST" && memRestore) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const id = Number(memRestore[1]);
        const row = deps.db.prepare("SELECT status FROM memories WHERE id=?").get(id) as { status?: string } | undefined;
        if (!row) { json(res, 404, { error: "E_NOT_FOUND" }); return true; }
        if (row.status !== "deleted") { json(res, 409, { error: "E_NOT_DELETED" }); return true; }
        deps.db.prepare("UPDATE memories SET status='active', updated_at=? WHERE id=?").run(now().toISOString(), id);
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "memory_restore", actor: "user",
          payload: { id },
        });
        json(res, 200, { ok: true });
        return true;
      }

      const forget = url.pathname.match(/^\/api\/memories\/(\d+)\/forget$/);
      if (req.method === "POST" && forget) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        deps.db.prepare("UPDATE memories SET status='deleted', updated_at=? WHERE id=?")
          .run(now().toISOString(), Number(forget[1]));
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "memory_forget", actor: "user",
          payload: { id: Number(forget[1]) },
        });
        json(res, 200, { ok: true });
        return true;
      }

      if (req.method === "GET" && url.pathname === "/api/docs") {
        json(res, 200, listDocs(deps.db, 200));
        return true;
      }
      const docIdRe = url.pathname.match(/^\/api\/docs\/(doc_[0-9a-f]+)$/);
      if (req.method === "GET" && docIdRe) {
        const id = String(docIdRe[1]);
        const doc = deps.db.prepare(
          `SELECT id,title,rel_path,n_chunks,bytes,converter,created_at FROM documents WHERE id=? AND deleted_at IS NULL`,
        ).get(id) as Record<string, unknown> | undefined;
        if (!doc) { json(res, 404, { error: "E_NO_DOC" }); return true; }
        const chunks = deps.db.prepare(
          `SELECT ord,heading_path,text,n_tokens FROM chunks
            WHERE doc_id=? AND deleted_at IS NULL ORDER BY ord`,
        ).all(id);
        json(res, 200, { doc, chunks });
        return true;
      }
      const docSens = url.pathname.match(/^\/api\/docs\/(doc_[0-9a-f]+)\/sensitivity$/);
      if ((req.method === "POST" || req.method === "PUT") && docSens) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const body = JSON.parse(await readBody(req)) as { value?: string };
        if (body.value !== "shareable" && body.value !== "local_only") {
          json(res, 400, { error: "E_BAD_SENSITIVITY" }); return true;
        }
        const ok = setDocSensitivity(deps.db, String(docSens[1]), body.value, now());
        if (!ok) { json(res, 404, { error: "E_NO_DOC" }); return true; }
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "doc_sensitivity", actor: "user",
          payload: { docId: String(docSens[1]), value: body.value },
        });
        json(res, 200, { ok: true, value: body.value });
        return true;
      }
      const docForget = url.pathname.match(/^\/api\/docs\/(doc_[0-9a-f]+)\/forget$/);
      if (req.method === "POST" && docForget) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const n = forgetDoc(deps.db, String(docForget[1]), now());
        appendEvent(deps.inboxDir, {
          v: 1, id: newEventId(), ts: now().toISOString(), kind: "doc_forget", actor: "user",
          payload: { docId: String(docForget[1]), chunks: n },
        });
        json(res, 200, { ok: true, chunks: n });
        return true;
      }
      // F-3：撤销「忘掉这篇」——5 秒内能反悔。作废是写 deleted_at，恢复就是把它们清空并重建 FTS。
      const docRestore = url.pathname.match(/^\/api\/docs\/(doc_[0-9a-f]+)\/restore$/);
      if (req.method === "POST" && docRestore) {
        const g = writeGuarded(req); if (!g.ok) { json(res, 403, { error: g.reason }); return true; }
        const id = String(docRestore[1]);
        const rows = deps.db.prepare("SELECT id,text_bigram,heading_path FROM chunks WHERE doc_id=?").all(id) as Array<{ id: number; text_bigram: string; heading_path: string }>;
        if (!rows.length) { json(res, 404, { error: "E_NO_DOC" }); return true; }
        deps.db.exec("BEGIN");
        try {
          deps.db.prepare("UPDATE chunks SET deleted_at=NULL WHERE doc_id=?").run(id);
          deps.db.prepare("UPDATE documents SET deleted_at=NULL WHERE id=?").run(id);
          // 只重插索引行：forget 时已经用 'delete' 命令正确地移除过
          for (const r of rows) {
            deps.db.prepare("INSERT INTO chunks_fts(rowid, text_bigram, heading_path) VALUES(?,?,?)")
              .run(BigInt(r.id), r.text_bigram, r.heading_path);
          }
          deps.db.exec("COMMIT");
        } catch (e) { deps.db.exec("ROLLBACK"); json(res, 500, { error: String(e).slice(0, 120) }); return true; }
        appendEvent(deps.inboxDir, { v: 1, id: newEventId(), ts: now().toISOString(), kind: "doc_restore", actor: "user", payload: { docId: id } });
        json(res, 200, { ok: true, chunks: rows.length });
        return true;
      }

  return false;
}
