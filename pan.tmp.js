
window.SOURCES_DIR = "D:\\LLM\\jingjing\\data\\sources";   // 服务端会把它替换成 data/sources 的绝对路径（点“摄入”的人才知道文件该放哪）
const $ = (s) => document.querySelector(s);
const NL2 = String.fromCharCode(10, 10);
// 标签页标题：待确认闪烁时也要闪回这个名字
const TITLE = 'Pseudo Digital Life Project';
// 占位符按屏宽给：手机上长提示会换行顶出输入框（截图抓到的）
var mEl = document.getElementById("m");
if (mEl) mEl.placeholder = innerWidth > 560 ? "说点什么…（Enter 发送 · Shift+Enter 换行）" : "说点什么…";
const H = { "x-jj": "1", "content-type": "application/json" };
const WHALE = "<svg class='ico' aria-hidden='true'><use href='#whale' /></svg>";
let view = "chat", TOOLS = [], MEMS = [];
let sideActive = null;   // 侧栏里最后点的那一项（文档/工具/记忆/日期都是多选一）


var chatScroll = 0;   // 切走前记下对话滚到哪了
const VIEWNAME = { chat: "对话 · CHAT", cfg: "设置 · CONFIG", toolview: "工具 · TOOL",
  memview: "记忆 · MEMORY", memlistview: "记忆 · MEMORY", docview: "文档 · DOC", capview: "能力 · CAPABILITIES",
  filesview: "文件 · PROJECT", gitview: "校样 · GIT",
  docsview: "文档 · DOCS", auditview: "动作 · ACTIONS",
  searchview: "搜索 · SEARCH", propview: "它想做的一件事", setupview: "首次配置 · SETUP" };
function show(v, opts) {
  // 切走时把滚动位置存下来：隐藏 #chat 会让 #scroll 的 scrollHeight 塌成 0，浏览器会把 scrollTop 归零
  if (view === "chat" && v !== "chat") chatScroll = $("#scroll").scrollTop;
  view = v;
  document.body.dataset.view = v;   // CSS 用它把「回到最新」锁在对话里
  for (const id of ["chat", "cfg", "toolview", "memview", "memlistview", "docview", "docsview", "auditview", "capview", "filesview", "gitview", "searchview", "propview", "setupview"]) $("#" + id).hidden = id !== v;
  $("#composer").style.display = v === "chat" ? "" : "none";
  // "回到最新"是对话专用的，别的界面不该出现
  if (v !== "chat") $("#jump").classList.remove("on");
  if (v === "chat") {
    requestAnimationFrame(function () {
      const el = $("#scroll");
      // 指定了哪一天就滚到那一天（这是唯一决定滚动位置的地方）
      if (opts && opts.day) {
        const target = [...document.querySelectorAll("#chat .day")].find(function (e) {
          return e.textContent.startsWith(opts.day);
        });
        if (target) {
          el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
          return;
        }
      }
      // 只在"离开前不是贴底"时恢复；贴底的话重新滚到底更符合直觉
      if (chatScroll > 0 && chatScroll < el.scrollHeight - el.clientHeight - 4) el.scrollTop = chatScroll;
      else { el.scrollTop = el.scrollHeight; chatScroll = 0; }
    });
  } else {
    // 切到面板（设置/记忆/文档/审计/搜索）时**必须回到顶部**：
    // 对话是自动贴底的，scrollTop 是个大值；带着它切过去，浏览器会把它夹到底部，
    // 表现就是"每次点进设置都在最下面"。
    //
    // 必须**同步**压一次：只靠 rAF 的话，异步内容（设置页要等 /api/config、/api/models）
    // 落地前的那一两帧能看到错位；headless 下 rAF 还可能更晚。
    // rAF 里再压一次是为了内容撑高之后仍然在顶。
    const sc = $("#scroll");
    sc.scrollTop = 0;
    requestAnimationFrame(function () { sc.scrollTop = 0; });
  }
  // 侧栏里除了几个导航项，其余都是多选一（工具 / 文档 / 记忆 / 日期）。
  // 只按 data-view 匹配会变成「点了 A，B C D 一起被框」。
  const navOnly = (b) => !b.dataset.doc && !b.dataset.tool && !b.dataset.mem && !b.dataset.day;
  // 点了某一天：只亮那一天，别再顺手把「现在」点亮（两个都亮等于没有高亮）
  const dayItem = sideActive && sideActive.isConnected && sideActive.dataset.day ? sideActive : null;
  for (const b of document.querySelectorAll("#side .item")) {
    const on = navOnly(b) && b.dataset.view === v && !(dayItem && b.dataset.view === "chat" && !b.dataset.day);
    b.classList.toggle("on", on);
  }
  if (sideActive && sideActive.isConnected && !navOnly(sideActive) && sideActive.dataset.view === v) {
    sideActive.classList.add("on");
  }
  $("#side").classList.remove("open");
  // 标题条（照 Trianon 的 stage 顶部）：当前在哪一屏，别让人靠猜
  const st = $("#stTitle"); if (st) st.textContent = VIEWNAME[v] || v;
  const sub = $("#stSub"); if (sub) sub.textContent = v === "chat" ? "本地 · 记忆库" : "";
}
function gapText(ms) {
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  if (d > 0) return d + " 天 " + h + " 小时";
  if (h > 0) return h + " 小时 " + (m % 60) + " 分";
  return m + " 分钟";
}
function clock(iso) {
  const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}
async function state() {
  const s = await (await fetch("/api/state")).json();
  $("#state").textContent = s.line;
  var stTxt = s.state?.text ? " · " + s.state.text : "";
  $("#statetext").textContent = stTxt;
  var ws = $("#wingstate"); if (ws) ws.textContent = s.state?.text ? s.state.text : "…";
  var hud = document.querySelector(".hud"); if (hud) hud.title = s.line + (s.state?.text ? " · " + s.state.text : "");
  // 断电提示：只在重启后第一次显示（服务端只给一次）
  if (s.outage) {
    const b = $("#banner");
    const kind = s.outage.kind === "power" ? "断电" : s.outage.kind === "crash" ? "进程被杀" : "关机";
    b.hidden = false;
    b.innerHTML = "// " + kind + " " + String(s.outage.from).slice(5, 16).replace("T", " ") + " → " +
      String(s.outage.to).slice(5, 16).replace("T", " ") + " —— 那段我没有经历";
  }
  const g = (k) => (s.memories || []).find((m) => m.stage === k);
  // 读数进仪表带（原来那行拼在 hud 里，现在 hud 只留一句话状态）
  var mem = ((g("active") || {}).c || 0) + ((g("fading") || {}).c || 0) + ((g("dormant") || {}).c || 0);
  var act = (g("active") || {}).c || 0;
  var e1 = $("#ro-mem"); if (e1) e1.innerHTML = mem + "<span class='u'>条</span>";
  var e2 = $("#ro-act"); if (e2) e2.innerHTML = act + "<span class='u'>条</span>";
  var en = (s.state && typeof s.state.energy === "number") ? s.state.energy : null;
  var e3 = $("#ro-energy");
  if (e3 && en !== null) {
    e3.innerHTML = Math.round(en * 100) + "<span class='u'>%</span>";
    // E-6 第二步：energy 的唯一恢复点在夜间整备；它没跑就得说清，否则只能看着数字掉
    var nrc = document.querySelector(".ro-w");
    if (nrc) {
      nrc.title = s.nightlySkipped
        ? "energy 只在夜间整备后恢复 —— 现在夜间未运行（" + String(s.nightlySkipped).slice(11, 19) + " · 缺模型）"
        : "energy：每轮对话 -2%，夜间整备 +25%";
    }
    var segs = $("#ro-segs");
    if (segs) {
      var n = 14, on = Math.round(en * n);
      var html = "";
      for (var i = 0; i < n; i++) html += "<i class='" + (i < on ? (en < 0.25 ? "hot" : "on") : "") + "'></i>";
      segs.innerHTML = html;
    }
  }
}
function rowHtml(b) {
  const isUser = b.role === "user";
  const body = isUser ? escapeHtml(b.text).replace(/&lt;br&gt;/g, "<br>") : (b.html || escapeHtml(b.text));
  const tools = (b.tools || []).join("");
  const recall = isUser ? "" : recallHtml(b.cites || [], b.omitted || 0, b.omittedDocs || 0);
  const resend = isUser ? " <span class='hintacts'><button class='resend'>重发</button></span>" : "";
  return "<div class='row " + b.role + "'><div class='av'>" + avHtml(isUser) + "</div><div>" +
    "<div class='meta'>" + (isUser ? "USER · " : "") + clock(b.ts) + resend + "</div>" +
    recall +
    "<div class='body md'>" + body + tools + "</div></div></div>";
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function timeline() {
  const blocks = await (await fetch("/api/timeline")).json();
  const el = $("#chat"); el.innerHTML = "";
  if (!blocks.length) {
    // 空库不是“加载中”：首次安装和清空数据后都会走到这里
    el.insertAdjacentHTML("beforeend",
      "<div class='empty'>// 还没有任何经历。" +
      "<b>说一句试试</b>——它会记住，也会忘。<br>" +
      "// 夜里整理记忆需要本地模型；现在没装，所以只会追加不会整理。</div>");
    return;
  }
  for (const b of blocks) {
    if (b.type === "day") {
      el.insertAdjacentHTML("beforeend", "<div class='day'>" + b.label +
        (b.gapMs ? "  //  距上次 " + gapText(b.gapMs) : "") + "</div>");
    } else if (b.type === "gap") {
      el.insertAdjacentHTML("beforeend", "<div class='gap'>// 信号中断 " + b.label + "</div>");
    } else {
      el.insertAdjacentHTML("beforeend", rowHtml(b));
    }
  }
  scrollBottom();
}
// 待确认的 T3：侧栏一张卡。确认 = 服务端现场签发令牌并执行，页面拿不到令牌。
async function pending() {
  let list = [];
  try { list = await (await fetch("/api/pending")).json(); } catch (e) { return; }
  const sec = $("#pendsec"), box = $("#pendlist");
  const open = (list || []).filter((p) => p.status === "pending" && !p.expired);
  paintPendBadge(open.length);
  loadProposals(); loadSurfaceReview(); loadThreads(); loadReceipts(); loadStanding(); loadPermission(); loadEgress(); loadSetup(false); loadCapPage();
  sec.hidden = open.length === 0;
  if (!open.length) { box.innerHTML = ""; return; }
  box.innerHTML = open.map((p) =>
    "<div class='pend' data-pend='" + p.id + "'>" +
    "<span class='cmd'>" + escapeHtml(p.argv.join(" ")) + "</span>" +
    "<span class='dir'>" + escapeHtml(p.cwd) + "</span>" +
    "<span class='fp'>指纹 " + escapeHtml(String(p.digest || "").slice(0, 8)) + " · 15 分钟内有效</span>" +
    "<div class='acts'><button class='ok' data-act='confirm'>确认执行</button>" +
    "<button class='no' data-act='reject'>拒绝</button></div>" +
    "<span class='msg'></span></div>").join("");
}
$("#pendlist").onclick = async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const card = btn.closest("[data-pend]");
  const id = card.dataset.pend;
  const msg = card.querySelector(".msg");
  btn.disabled = true;
  msg.textContent = "处理中…";
  try {
    const j = await (await fetch("/api/pending/" + id, {
      method: "POST", headers: H, body: JSON.stringify({ action: btn.dataset.act }),
    })).json();
    msg.textContent = j.ok ? (btn.dataset.act === "confirm" ? "已执行" : "已拒绝") : (j.error || "FAILED");
  } catch (err) { msg.textContent = "网络错误"; }
  await pending(); await timeline(); await state();
};
// ── DOCS：摄入过的文档（点击看分块）──────────────────────────
async function ingestCandidates() {
  var list = [];
  try { list = await (await fetch("/api/ingest/candidates")).json(); } catch (e) { return; }
  var sel = $("#dlg-pick");
  if (!sel) return;
  var has = !!(list && list.length);
  $("#dlg-cands").hidden = !has;          // 候选优先：有就直接选，没有才提示放哪
  $("#dlg-empty").hidden = has;
  if (window.SOURCES_DIR) { var d = $("#dlg-dir"); if (d) d.textContent = window.SOURCES_DIR; }
  sel.innerHTML = has
    ? "<option value=''>data/sources 里待摄入的 " + list.length + " 个文件…</option>" +
      list.map(function (x) { return "<option value='" + escapeHtml(x.path) + "'>" + escapeHtml(x.path) + "</option>"; }).join("")
    : "";
}
async function docs() {
  ingestCandidates();
  let list = [];
  try { list = await (await fetch("/api/docs")).json(); } catch (e) { return; }
  const box = $("#doclist");
  var dc = $("#doccount"); if (dc) dc.textContent = (list ? list.length : 0) + " 篇";
  if (!list || !list.length) {
    // 路径和“怎么放”由下面的摄入区负责说，这里只报事实（否则同一句话在侧栏里重复三遍）
    box.innerHTML = "<div class='hint' style='padding:4px 2px'>还没有文档。在下面加一篇。</div>";
    return;
  }
  box.innerHTML = list.map((d) =>
    "<button class='item' data-view='docview' data-doc='" + escapeHtml(d.id) + "'>" +
    escapeHtml(d.title || d.id) + "<span class='m'>" + d.chunks + " 块 · " + (d.sensitivity === "shareable" ? "可发送" : "仅本地") + "</span></button>").join("");
}
async function openDoc(id) {
  show("docview");
  $("#dv-title").textContent = "DOC · " + id;
  $("#dv-meta").textContent = "…";
  $("#dv-chunks").innerHTML = "";
  const j = await (await fetch("/api/docs/" + id)).json();
  if (!j || !j.doc) { $("#dv-meta").textContent = j.error || "E_NO_DOC"; return; }
  $("#dv-title").textContent = j.doc.title || id;
  $("#dv-sens").dataset.doc = id;
  dvSens = j.doc.sensitivity === "shareable" ? "shareable" : "local_only";
  paintSens();
  $("#dv-meta").textContent = (j.doc.rel_path || "") + " · " + j.doc.n_chunks + " 块 · " + (j.doc.converter || "") + " · " + (j.doc.bytes || 0) + " 字节";
  $("#dv-chunks").innerHTML = (j.chunks || []).map((c) =>
    "<div class='ck'><div class='ck-h'>#" + c.ord + "　" + escapeHtml(c.heading_path || "(无章节)") + "　<span class='ck-t'>" + c.n_tokens + " tok</span></div>" +
    "<pre class='ck-b'>" + escapeHtml(c.text.slice(0, 1200)) + (c.text.length > 1200 ? String.fromCharCode(10) + "…（截断）" : "") + "</pre></div>").join("");
}
// 敏感度开关：默认「仅本地」，点了才会进云端简报（02 §10.1）
let dvSens = "local_only";
function paintSens() {
  const b = $("#dv-sens");
  b.textContent = dvSens === "shareable" ? "当前：可发送（点一下改回仅本地）" : "当前：仅本地（点一下标为可发送）";
  b.className = dvSens === "shareable" ? "primary" : "";
}
$("#dv-sens").onclick = async () => {
  const m = $("#dv-title").textContent.match(/^DOC · (doc_[0-9a-f]+)$/);
  const id = m ? m[1] : $("#dv-sens").dataset.doc;
  if (!id) return;
  const next = dvSens === "shareable" ? "local_only" : "shareable";
  const j = await (await fetch("/api/docs/" + id + "/sensitivity", { method: "POST", headers: H, body: JSON.stringify({ value: next }) })).json();
  const msg = $("#dv-msg");
  if (j.ok) { dvSens = j.value; paintSens(); msg.className = "ok"; msg.textContent = "已保存"; await docs(); }
  else { msg.className = "err"; msg.textContent = j.error || "FAILED"; }
};
$("#dv-forget").onclick = async () => {
  const id = $("#dv-title").textContent.startsWith("DOC · ") ? $("#dv-title").textContent.slice(6) : "";
  const meta = $("#dv-meta").textContent;
  const realId = (meta && $("#dv-title").textContent.match(/^DOC · (doc_[0-9a-f]+)$/) ? $("#dv-title").textContent.slice(6) : "");
  const target = realId || id;
  if (!target) return;
  const j = await (await fetch("/api/docs/" + target + "/forget", { method: "POST", headers: H, body: "{}" })).json();
  const m = $("#dv-msg");
  if (j.ok) {
    m.className = "ok"; m.textContent = "已忘掉 " + j.chunks + " 块"; await docs(); show("chat");
    // F-3：5 秒内可反悔（作废是写 deleted_at，恢复是把它们清掉并重插 FTS）
    offerUndo("已忘掉 " + j.chunks + " 块 · 5 秒内可撤销", async function () {
      const r2 = await (await fetch("/api/docs/" + target + "/restore", { method: "POST", headers: H, body: "{}" })).json();
      if (r2.ok) { await docs(); await timeline(); }
    });
  }
  else { m.className = "err"; m.textContent = j.error || "FAILED"; }
};
// ── 记忆纠错（P1 #9）──────────────────────────────────
$("#mv-save").onclick = async () => {
  const id = $("#mv-save").dataset.id;
  if (!id) return;
  const body = {
    text: $("#mv-edit").value,
    importance: Number($("#mv-imp").value),
    sensitivity: $("#mv-sens").value,
  };
  const j = await (await fetch("/api/memories/" + id, { method: "PUT", headers: H, body: JSON.stringify(body) })).json();
  const m = $("#mv-msg");
  if (j.ok) {
    m.className = "ok"; m.textContent = "已保存（改了正文会重算向量）";
    await memories(); await timeline();
  } else { m.className = "err"; m.textContent = j.error || "FAILED"; }
};

// ── 面板内摄入（P1 #6）────────────────────────────────
$("#dlg-go").onclick = async () => {
  const p = $("#dlg-path").value.trim();
  const msg = $("#dlg-msg");
  const markBad = (on) => { const el = $("#dlg-path"); if (el) el.classList.toggle("bad", on); };
  if (!p) {
    markBad(true);
    msg.className = "err";
    const n = $("#dlg-pick") ? $("#dlg-pick").options.length - 1 : 0;
    // 侧栏很窄：长句会挤成四行，而且和上面空状态的说明重复。
    // 这里只说"该做什么"，路径已经在上面写清了。
    msg.textContent = n > 0
      ? "先从上面的下拉里选一个（有 " + n + " 个待摄入）"
      : "还没有可摄入的文件 —— 见上面的两条路";
    return;
  }
  markBad(false);
  msg.className = "hint"; msg.textContent = "摄入中…（转换 + 分块 + 向量）";
  const j = await (await fetch("/api/ingest", {
    method: "POST", headers: H,
    // 摄入永远只在本机；能不能进云端是文档属性，在 docview 里单独改
    body: JSON.stringify({ path: p, shareable: false }),
  })).json();
  if (j.ok) {
    msg.className = "ok";
    msg.textContent = "完成：" + j.files + " 个文件 · " + j.chunks + " 块" + (j.skipped ? "（跳过 " + j.skipped + "）" : "");
    $("#dlg-path").value = "";
    await docs();
  } else {
    msg.className = "err";
    msg.textContent = j.error + (j.hint ? " · " + j.hint : "");
  }
};
$("#dlg-file-btn").onclick = () => $("#dlg-file").click();
$("#dlg-file").addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  if (!files.length) return;
  const msg = $("#dlg-msg");
  for (const f of files) {
    msg.className = "hint";
    msg.textContent = "上传 " + f.name + "…";
    let up;
    try {
      up = await (await fetch("/api/ingest/upload?name=" + encodeURIComponent(f.name), {
        method: "POST", headers: { "x-jj": "1", "content-type": "application/octet-stream" }, body: f,
      })).json();
    } catch (err) { msg.className = "err"; msg.textContent = "上传失败：" + err.message; return; }
    if (!up.ok) { msg.className = "err"; msg.textContent = up.error + (up.hint ? " · " + up.hint : ""); return; }
    $("#dlg-path").value = up.path;
  }
  $("#dlg-go").click();                     // 传完直接摄入（路径已填好）
});
$("#dlg-pick").addEventListener("change", (e) => {
  if (e.target.value) $("#dlg-path").value = e.target.value;
});
$("#dlg-path").addEventListener("input", () => {
  $("#dlg-path").classList.remove("bad");
  const m = $("#dlg-msg"); if (m && m.className === "err") { m.className = "hint"; m.textContent = ""; }
});
$("#dlg-path").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#dlg-go").click(); } });

// ── 测试连接 + 今日花费（P1 #11/#12）──────────────────
$("#c-test").onclick = async () => {
  const m = $("#c-msg");
  m.className = "hint"; m.textContent = "测试中…";
  const j = await (await fetch("/api/test-cloud", { method: "POST", headers: H, body: "{}" })).json();
  if (j.ok) { m.className = "ok"; m.textContent = "通了 · " + j.ms + "ms · " + j.reply; }
  else { m.className = "err"; m.textContent = (j.error || "FAILED") + (j.hint ? " · " + j.hint : ""); }
};
async function usage() {
  try {
    const u = await (await fetch("/api/usage")).json();
    const el = $("#c-usage");
    if (el) {
      el.textContent = "今日 $" + u.todayUsd.toFixed(4) + " / 预算 $" + u.budgetUsd +
        " · " + u.calls + " 次调用 · in " + u.inTokens + " / out " + u.outTokens + " tok";
    }
  } catch (e) { /* 面板离线时忽略 */ }
}

// ── 审计：侧栏常驻刷新 ────────────────────────────────
async function auditTick() { await audit(); }

// ── 仪表带 + ticker（照参照图的读数字段，但每个数都来自真接口）──
async function readout() {
  var h = null, u = null, docs = null, last = null;
  try {
    var rs = await Promise.all([
      fetch("/health").then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch("/api/usage").then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch("/api/docs").then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch("/api/audit?limit=1").then(function (r) { return r.json(); }).catch(function () { return null; }),
    ]);
    h = rs[0]; u = rs[1]; docs = rs[2]; last = rs[3];
  } catch (e) { /* 离线时保持上一次读数 */ }

  var docN = docs ? docs.length : 0;
  var chunkN = docs ? docs.reduce(function (n, d) { return n + (d.chunks || 0); }, 0) : 0;
  var set = function (id, html) { var el = $(id); if (el) el.innerHTML = html; };
  set("#ro-doc", docN + "<span class='u'>篇</span>");
  set("#ro-chunks", chunkN + "<span class='u'>块</span>");
  if (u) set("#ro-usd", "$" + Number(u.todayUsd || 0).toFixed(3) + "<span class='u'>/" + (u.budgetUsd || 2) + "</span>");
  if (h) {
    set("#ro-rel", (h.release ? String(h.release).slice(4, 8) + "·" + String(h.release).slice(-4) : "—"));
    var up = Number(h.uptimeS || 0);
    var upText = up >= 3600 ? Math.floor(up / 3600) + "h" + Math.floor((up % 3600) / 60) + "m" : Math.floor(up / 60) + "m";
    set("#ro-up", upText);
  }

  // ticker：最近一个动作 / 待确认 / 降级或冻结 —— 都是"现在是什么状态"
  var tk = [];
  if (last && last.rows && last.rows.length) {
    var a = last.rows[0];
    var cls = a.decision === "allowed" ? "" : a.decision === "needs_confirm" ? " warn" : " bad";
    tk.push("<span class='tk" + cls + "'>最近 <b>" + escapeHtml(a.verb) + "</b> " + escapeHtml(a.decision) + "</span>");
  }
  var pn = Number(($("#pendbadge") || {}).textContent || 0);
  if (pn > 0) tk.push("<span class='tk warn'>待确认 <b>" + pn + "</b></span>");
  if (h && h.frozen) tk.push("<span class='tk warn'>自我更新冻结</span>");
  if (h && h.degraded && h.degraded.length) tk.push("<span class='tk bad'>降级 " + escapeHtml(h.degraded.join(",")) + "</span>");
  if (h && last && typeof last.total === "number") tk.push("<span class='tk fade'>动作累计 <b>" + last.total + "</b></span>");
  if (u) tk.push("<span class='tk fade'>今日调用 <b>" + u.calls + "</b></span>");
  var tb = $("#ticker"); if (tb) tb.innerHTML = tk.join("");
}

// ── 头像：默认用鲸尾/U，上传后用图片（P1）────────────────
var AV = { agent: null, user: null };
function avHtml(isUser) {
  var role = isUser ? "user" : "agent";
  if (AV[role]) return "<img class='avi' alt='' src='" + AV[role] + "'>";
  return isUser ? "U" : WHALE;
}
async function loadAvatars() {
  try {
    var j = await (await fetch("/api/avatars")).json();
    AV.agent = j.agent ? j.agent.url : null;
    AV.user = j.user ? j.user.url : null;
  } catch (e) { /* 离线就都用默认 */ }
  paintPreview();
}
function paintPreview() {
  var a = $("#pv-agent"), u = $("#pv-user");
  if (!a || !u) return;
  a.innerHTML = avHtml(false);
  u.innerHTML = avHtml(true);
}
async function uploadAvatar(role, file) {
  if (!file) return;
  var msg = $("#av-msg");
  if (file.size > 512 * 1024) { msg.className = 'err'; msg.textContent = '图片太大（≤512KB）'; return; }
  var dataUrl = await new Promise(function (res, rej) {
    var r = new FileReader();
    r.onload = function () { res(String(r.result)); };
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  var j = await (await fetch("/api/avatar", { method: "POST", headers: H, body: JSON.stringify({ role: role, dataUrl: dataUrl }) })).json();
  if (j.ok) {
    AV[role] = j.url; paintPreview(); await timeline();
    msg.className = 'ok'; msg.textContent = '已更换（' + role + '）';
  } else { msg.className = 'err'; msg.textContent = (j.error || 'FAILED') + (j.hint ? ' · ' + j.hint : ''); }
}
async function resetAvatar(role, btn) {
  var j = await (await fetch("/api/avatar?role=" + role, { method: "DELETE", headers: H })).json();
  if (j.ok) { AV[role] = null; paintPreview(); await timeline();
    var msg = $('#av-msg'); msg.className = 'ok'; msg.textContent = '已恢复默认'; }
}
["agent", "user"].forEach(function (role) {
  $("#up-" + role).onclick = function () { $("#f-" + role).click(); };
  $("#f-" + role).onchange = function (e) { uploadAvatar(role, e.target.files && e.target.files[0]); };
  $("#rm-" + role).onclick = function () { resetAvatar(role); };
});

// ── 侧栏分区折叠（MEMORY / DOCS / ACTIONS）──────────────
var SECT = (function () {
  try { return JSON.parse(localStorage.getItem('jj-sections') || '{}'); } catch (e) { return {}; }
})();
function applySections() {
  document.querySelectorAll(".sec[data-sec]").forEach(function (el) {
    var k = el.dataset.sec;
    el.classList.toggle('collapsed', !!SECT[k]);
    var body = el.querySelector('div');
    if (body) body.hidden = !!SECT[k];
  });
}
document.addEventListener("click", function (e) {
  var b = e.target.closest('[data-tog]');
  if (!b) return;
  var k = b.dataset.tog;
  SECT[k] = !SECT[k];
  try { localStorage.setItem('jj-sections', JSON.stringify(SECT)); } catch (err) { /* 隐私模式 */ }
  applySections();
});

// ── 证据：召回行 + 可点引用（P0 #1/#2）──────────────────
function recallHtml(cites, omitted, omittedDocs) {
  if ((!cites || !cites.length) && !omitted && !omittedDocs) return "";
  var chips = (cites || []).map(function (c) {
    var kind = c.indexOf("doc:") === 0 ? "doc" : "mem";
    return "<span class='cite' data-cite='" + escapeHtml(c) + "' data-kind='" + kind + "'>" + escapeHtml(c) + "</span>";
  }).join("");
  var omit = [];
  if (omitted) omit.push(omitted + " 条记忆");
  if (omittedDocs) omit.push(omittedDocs + " 段文档");
  var tail = omit.length ? "<span>· 另有 " + omit.join("、") + "仅本地</span>" : "";
  return "<div class='recall'><b>依据</b>" + (chips || "<span>无</span>") + tail + "</div>";
}
async function openCite(cite) {
  if (cite.indexOf("doc:") === 0) {
    var m = cite.match(/^doc:(doc_[0-9a-f]+)#(d+)$/);
    if (m) { await openDoc(m[1]); return; }
    return;
  }
  var mm = cite.match(/^mem:(d+)$/);
  if (mm) { await openMemory(Number(mm[1])); return; }
}
document.addEventListener("click", function (e) {
  var c = e.target.closest("[data-cite]");
  if (c && c.dataset.cite) { e.preventDefault(); openCite(c.dataset.cite); }
});
document.addEventListener("keydown", function (e) {
  var c = document.activeElement;
  if (c && c.classList && c.classList.contains("cite") && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault(); openCite(c.dataset.cite);
  }
});

// ── 动作审计（P0 #3）────────────────────────────────────
async function audit() {
  // 左栏的「动作」只是一行入口 + 计数；列表本体在 openAudit() 里渲染。
  var rows = [], total = 0;
  try { var j = await (await fetch('/api/audit?limit=1')).json(); total = j.total || (j.rows || []).length; } catch (e) { return; }
  var ac = $('#actcount'); if (ac) ac.textContent = total + ' 条';
}
async function openAudit() {
  show("auditview");
  var rows = [], total = 0;
  try { var j2 = await (await fetch("/api/audit?limit=80")).json(); rows = j2.rows || []; total = j2.total || rows.length; } catch (e) { rows = []; }
  var am = $("#av-meta"); if (am) am.textContent = "exec_audit 共 " + total + " 条 · 下面显示最近 " + rows.length + " 条（含被拒绝的）";
  $("#auditlist").innerHTML = (rows || []).map(function (r) {
    var cls = r.decision === "allowed" ? "d-ok" : r.decision === "needs_confirm" ? "d-wait" : "d-no";
    return "<div class='arow'><span class='t'>" + escapeHtml(clock(r.ts)) + "</span>" +
      "<span class='v'>" + escapeHtml(r.verb) + "</span>" +
      "<span><span class='" + cls + "'>" + escapeHtml(r.decision) + "</span>" +
      (r.reason ? " · " + escapeHtml(r.reason) : "") + "</span>" +
      "<span class='ms'>" + (r.ms ? r.ms + "ms" : "") + "</span></div>";
  }).join("") || "<div class='hint'>没有动作</div>";
}

// ── 搜索（P1 #8）────────────────────────────────────────
var searchTimer = null;
async function doSearch(q) {
  if (!q.trim()) { show("chat"); return; }
  show("searchview");
  $("#sv-meta").textContent = "搜索「" + q + "」…";
  $("#sv-mem").innerHTML = ""; $("#sv-docs").innerHTML = "";
  var j = null;
  try { j = await (await fetch("/api/search?q=" + encodeURIComponent(q))).json(); } catch (e) { $("#sv-meta").textContent = "搜索失败"; return; }
  $("#sv-meta").textContent = "「" + q + "」· 记忆 " + j.mem.length + " 条 · 文档 " + j.docs.length + " 段";
  $("#sv-mem").innerHTML = j.mem.length
    ? "<h3 style='font:10px/1 var(--mono);color:var(--ink-dim);letter-spacing:.18em;margin:12px 0 6px'>MEMORY</h3>" + j.mem.map(function (h) {
      return "<button class='hit' data-view='memview' data-mem='" + h.id + "'>" + escapeHtml(h.text.slice(0, 90)) +
        "<span class='m'>" + h.stage + " · " + h.weight.toFixed(2) + " · " + (h.sensitivity === "shareable" ? "可发送" : "仅本地") + " · mem:" + h.id + "</span></button>";
    }).join("")
    : "";
  $("#sv-docs").innerHTML = j.docs.length
    ? "<h3 style='font:10px/1 var(--mono);color:var(--ink-dim);letter-spacing:.18em;margin:14px 0 6px'>DOCS</h3>" + j.docs.map(function (h) {
      return "<button class='hit' data-cite='" + escapeHtml(h.cite) + "'>" + escapeHtml(h.text.slice(0, 90)) +
        "<span class='m'>" + escapeHtml(h.title) + " › " + escapeHtml(h.headingPath || "—") + " · " + (h.sensitivity === "shareable" ? "可发送" : "仅本地") + "</span></button>";
    }).join("")
    : "";
}

// ── 输入区：多行自适应 + Enter 发送 + 快捷键（P2 #16/#17）──────
function fitComposer() {
  var m = $("#m");
  m.style.height = "auto";
  m.style.height = Math.min(180, m.scrollHeight) + "px";
}
$("#m").addEventListener("input", fitComposer);
$("#m").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").dispatchEvent(new Event("submit", { cancelable: true }));
  }
});
// ── F-3 命令面板：Ctrl+K 到任何地方（导航 + 少量安全的动作）──────
var PAL_ACTIONS = [
  { id: "chat", label: "对话", key: "视图", run: function () { show("chat"); } },
  { id: "cfg", label: "设置（接口 / 本地模型 / 能力 / 人格）", key: "视图", run: function () { show("cfg"); loadConfig(); } },
  { id: "mem", label: "记忆", key: "视图", run: function () { memories(); } },
  { id: "docs", label: "文档 DOCS", key: "视图", run: function () { docs(); } },
  { id: "audit", label: "动作审计", key: "视图", run: function () { audit(); } },
  { id: "tools", label: "工具列表", key: "视图", run: function () { $("#foldtools").click(); } },
  { id: "new", label: "说点什么（聚焦输入框）", key: "动作", run: function () { show("chat"); $("#m").focus(); } },
  { id: "ingest", label: "加文档（跳到 DOCS 的摄入区）", key: "动作", run: function () { docs(); setTimeout(function () { var el = $("#dlg-path"); if (el) el.focus(); }, 300); } },
  { id: "search", label: "搜记忆 / 文档…", key: "动作", run: function () { show("memlistview"); memories(); setTimeout(function () { var el = $("#q"); if (el) el.focus(); }, 300); } },
  { id: "cap", label: "看能力与降级项", key: "动作", run: function () { show("cfg"); setTimeout(function () { var el = $("#cap-sum"); if (el) el.scrollIntoView({ block: "center" }); }, 600); } },
];
var palOpen = false, palIdx = 0, palShown = PAL_ACTIONS;

function palRender() {
  var q = ($("#palq").value || "").trim().toLowerCase();
  palShown = PAL_ACTIONS.filter(function (a) { return !q || (a.label + " " + a.id).toLowerCase().indexOf(q) >= 0; });
  if (palIdx >= palShown.length) palIdx = 0;
  $("#pallist").innerHTML = palShown.length
    ? palShown.map(function (a, i) {
        return "<div class='pi" + (i === palIdx ? " on" : "") + "' data-pal='" + a.id + "'>" +
          "<span>" + escapeHtml(a.label) + "</span><span class='k'>" + a.key + "</span></div>";
      }).join("")
    : "<div class='pi'><span>没有匹配的条目</span></div>";
}
function palShow(on) {
  palOpen = on;
  $("#pal").hidden = !on;
  if (on) { $("#palq").value = ""; palIdx = 0; palRender(); $("#palq").focus(); }
}
function palRun(id) {
  var a = PAL_ACTIONS.find(function (x) { return x.id === id; });
  palShow(false);
  if (a) a.run();
}
$("#palq").addEventListener("input", function () { palIdx = 0; palRender(); });
$("#pallist").addEventListener("click", function (e) {
  var row = e.target.closest("[data-pal]");
  if (row) palRun(row.dataset.pal);
});
$("#pal").addEventListener("click", function (e) { if (e.target === $("#pal")) palShow(false); });

// ── F-3 撤销条：破坏性操作 5 秒内可反悔 ────────────────────
var undoState = null, undoTimer = 0;
function offerUndo(text, fn, ms) {
  undoState = fn;
  $("#undo-text").textContent = text;
  $("#undo").hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(function () { undoState = null; $("#undo").hidden = true; }, ms || 5000);
}
$("#undo-go").onclick = async function () {
  var fn = undoState;
  undoState = null; $("#undo").hidden = true; clearTimeout(undoTimer);
  if (fn) await fn();
};

document.addEventListener("keydown", function (e) {
  var mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); palShow(true); return; }
  if (palOpen) {
    if (e.key === "Escape") { e.preventDefault(); palShow(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); palIdx = Math.min(palShown.length - 1, palIdx + 1); palRender(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); palRender(); return; }
    if (e.key === "Enter") { e.preventDefault(); if (palShown[palIdx]) palRun(palShown[palIdx].id); return; }
  }
  if (e.key === "Escape") {
    if (view !== "chat") { show("chat"); return; }
    if ($("#side").classList.contains("open")) { $("#side").classList.remove("open"); return; }
  }
  if (e.key === "ArrowUp" && document.activeElement === $("#m") && !$("#m").value) {
    e.preventDefault();
    var last = [...document.querySelectorAll(".row.user .body")].pop();
    if (last) { $("#m").value = last.textContent || ""; fitComposer(); }
  }
});

// ── 搜索输入（防抖）────────────────────────────────────
$("#q").addEventListener("input", function (e) {
  var q = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function () { doSearch(q); }, 300);
});
$("#q").addEventListener("keydown", function (e) {
  if (e.key === "Escape") { $("#q").value = ""; show("chat"); }
});

// ── 工具面板折叠（P2 #20）──────────────────────────────
$("#foldtools").onclick = function () {
  var box = $("#toollist");
  box.hidden = !box.hidden;
  if (!box.hidden) renderTools();
};

// ── 版本 / 冻结状态（P0 #4）────────────────────────────

// ── 待确认角标（P1 #10）────────────────────────────────
var lastPendCount = 0, titleTimer = null, flashLeft = 0;
function paintPendBadge(n) {
  var b = $("#pendbadge");
  b.hidden = n === 0;
  b.style.display = n === 0 ? "none" : "inline-flex";
  b.textContent = String(n);
  if (n > lastPendCount) {
    clearInterval(titleTimer);
    flashLeft = 6;
    var on = false;
    titleTimer = setInterval(function () {
      on = !on;
      document.title = on ? "● 有待确认" : TITLE;
      if (!on) { flashLeft--; if (flashLeft <= 0) { clearInterval(titleTimer); document.title = TITLE; } }
    }, 700);
  }
  lastPendCount = n;
}

// ── 回到最新（P2 #15）────────────────────────────────
var follow = true;
function nearBottom() {
  var el = $("#scroll");
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
$("#scroll").addEventListener("scroll", function () {
  if (view !== "chat") return;
  follow = nearBottom();
  $("#jump").classList.toggle("on", !follow);
  if (follow) $("#jumpn").textContent = "";
});
$("#jump").onclick = function () {
  $("#jump").classList.remove("on");
  follow = true; scrollBottom();
  $("#jumpn").textContent = "";
};

// ── 停止生成（P1 #7）──────────────────────────────────
var inflight = null;
function setStreaming(on) {
  $("#stop").style.display = on ? "inline-block" : "none";
  var send = $(".send"); if (send) send.style.display = on ? "none" : "";
}
$("#stop").onclick = function () {
  if (inflight) { try { inflight.abort(); } catch (e) { /* 已结束 */ } }
};

// ── 重发（P1 #13）──────────────────────────────────────
document.addEventListener("click", function (e) {
  var b = e.target.closest(".resend");
  if (!b) return;
  var row = b.closest(".row");
  var body = row && row.querySelector(".body");
  if (!body) return;
  $("#m").value = body.textContent || "";
  fitComposer();
  $("#m").focus();
});

async function sessions() {
  const blocks = await (await fetch("/api/timeline")).json();
  const days = blocks.filter((b) => b.type === "day");
  const lastMsg = blocks.filter((b) => b.type === "msg").slice(-1)[0];
  $("#sesslist").innerHTML =
    "<button class='item on' data-view='chat'>现在<span class='m'>" +
    (lastMsg ? clock(lastMsg.ts) : "还没聊过") + "</span></button>" +
    days.slice(-5).reverse().map((d) =>
      "<button class='item' data-view='chat' data-day='" + d.label + "'>" +
      "<span class='preview'>" + d.label + "</span>" +
      "<span class='m'>" + (d.gapMs ? "距上次 " + gapText(d.gapMs) : "—") + "</span></button>").join("");
}
/** 点会话 → 滚到那一天的标题 */
function jumpToDay(label) {
  const els = [...document.querySelectorAll("#chat .day")];
  const el = els.find((e) => e.textContent.startsWith(label));
  if (el) el.scrollIntoView({ block: "start" });
}
var TOOLQ = "", TOOLALL = false;
async function tools() {
  const ts = await (await fetch("/api/tools")).json();
  TOOLS = ts;
  var cnt = $("#toolcount"); if (cnt) cnt.textContent = ts.length + " 项";
  paintTools();
}
/** F-1 #3：16 项全铺开会把 DOCS/MEMORY 挤到折叠线以下，所以默认只给 6 项 + 搜索 */
function paintTools() {
  var q = TOOLQ.trim().toLowerCase();
  var rows = TOOLS.map(function (t, i) { return { t: t, i: i }; })
    .filter(function (x) { return !q || (x.t.name + " " + x.t.description).toLowerCase().indexOf(q) >= 0; });
  var shown = TOOLALL || q ? rows : rows.slice(0, 6);
  $("#toolrows").innerHTML = shown.length
    ? shown.map(function (x) {
      return "<button class='item' data-view='toolview' data-tool='" + x.i + "'><span class='preview tname'>" + x.t.name +
        "<span class='tier'>" + x.t.tier + "</span></span><span class='m'>" + escapeHtml(x.t.description) + "</span></button>";
    }).join("")
    : "<div class='hint'>没有匹配的工具</div>";
  var more = $("#toolmore");
  more.hidden = Boolean(q) || TOOLALL || rows.length <= 6;
  more.textContent = "显示全部 " + rows.length + " 项";
}
$("#toolq").addEventListener("input", function () { TOOLQ = this.value; paintTools(); });
$("#toolmore").addEventListener("click", function () { TOOLALL = true; paintTools(); });
const renderTools = () => tools();
var MEMPAGE = 8;   // 侧栏先给 8 条；点「看更早的」按 8→40→200 往上翻
async function memories(limit) {
  var lim = limit || MEMPAGE;
  const rows = await (await fetch("/api/memories?limit=" + lim)).json();
  MEMS = rows;
  MEMPAGE = lim;
  var mc = $("#memcount"); if (mc) mc.textContent = rows.length + " 条";
  const more = rows.length >= MEMPAGE
    ? "<button class='item dimmore' id='memmore'>看更早的（已显示 " + rows.length + " 条）</button>"
    : "";
  $("#memlist").innerHTML = rows.slice(0, MEMPAGE).map((r) =>
    "<button class='item' data-view='memview' data-mem='" + r.id + "'>" +
    "<span class='preview'>" + escapeHtml(r.text) + "</span>" +
    "<span class='m'>" + r.weight.toFixed(2) + " · " + r.stage + "</span>" +
    "<span class='bar'><i style='width:" + Math.round(r.weight * 100) + "%'></i></span></button>").join("") + more;
  const mb = $("#memmore");
  if (mb) mb.onclick = function () { memories(Math.min(200, MEMPAGE * 5)); };
}
async function openTool(i) {
  const t = TOOLS[i]; if (!t) return;
  $("#t-title").textContent = t.name;
  $("#t-desc").textContent = t.description;
  $("#t-tier").textContent = "档位 " + t.tier + " · 参数 " + Object.keys((t.parameters || {}).properties || {}).join(", ");
  $("#t-params").textContent = JSON.stringify(t.parameters || {}, null, 2);
  $("#t-use").onclick = () => { show("chat"); $("#m").value = "用 " + t.name + " "; $("#m").focus(); };
  show("toolview");
}
// ── 它想做的事（K-2）：一张卡说清 做什么 / 为什么 / 会动哪些文件 ──
var PROPS = [];
async function loadProposals() {
  var rows;
  try { rows = await (await fetch("/api/proposals?status=open")).json(); }
  catch (e) { return; }
  PROPS = Array.isArray(rows) ? rows : [];
  var sec = $("#propsec"), n = PROPS.length;
  $("#propcount").textContent = n ? n + " 件" : "";
  sec.hidden = n === 0;
  $("#proplist").innerHTML = PROPS.map(function (x) {
    return "<button class='item' data-prop='" + escapeHtml(x.id) + "'>" +
      "<span class='preview'>" + escapeHtml(x.title) + "</span>" +
      "<span class='m'>" + escapeHtml(x.risk) + " 风险" + (x.seen > 1 ? " · 提过 " + x.seen + " 次" : "") + "</span></button>";
  }).join("");
}
function openProposal(id) {
  var x = PROPS.filter(function (y) { return y.id === id; })[0];
  if (!x) return;
  $("#pv-title").textContent = x.title;
  $("#pv-meta").textContent = x.id + " · " + x.risk + " 风险 · 提到过 " + x.seen + " 次 · " +
    String(x.at).slice(0, 19) + " · 来源 " + (x.from || "agent");
  $("#pv-why").textContent = x.why;
  $("#pv-plan").innerHTML = (x.plan || []).length
    ? "<ol class='hint'>" + x.plan.map(function (t) { return "<li>" + escapeHtml(t) + "</li>"; }).join("") + "</ol>"
    : "";
  $("#pv-argv").textContent = (x.argv || []).length ? x.argv.join(" ") : "（不是一条命令能做完的）";
  $("#pv-touch").textContent = (x.touches || []).length ? "会动：" + x.touches.join(", ") : "会动：（它没写）";
  $("#pv-msg").textContent = "";
  var send = async function (action) {
    $("#pv-msg").textContent = "处理中…";
    try {
      var r = await (await fetch("/api/proposals/" + encodeURIComponent(id), {
        method: "POST", headers: H, body: JSON.stringify({ action: action }),
      })).json();
      if (r.ok) {
        $("#pv-msg").className = "ok";
        $("#pv-msg").textContent = action === "accept" ? "已同意（执行仍要授权）" : "已拒绝";
        await loadProposals();
        if (action === "accept") { $("#pv-msg").textContent += " —— 现在可以照上面的命令自己跑"; }
      } else { $("#pv-msg").className = "err"; $("#pv-msg").textContent = r.error || "失败"; }
    } catch (e) { $("#pv-msg").className = "err"; $("#pv-msg").textContent = "请求失败"; }
  };
  $("#pv-yes").onclick = function () { send("accept"); };
  $("#pv-no").onclick = function () { send("reject"); };
  show("propview");
}
$("#proplist").onclick = function (e) {
  var b = e.target.closest("button[data-prop]");
  if (b) openProposal(b.dataset.prop);
};

// 极小的提示：写进底部 ticker，5 秒后由 readout 自己刷回真实状态
var TICK_MSG = null, TICK_TIMER = null;
function pushTicker(msg) {
  TICK_MSG = msg;
  var tb = document.getElementById("ticker");
  if (tb) tb.innerHTML = "<span class='tk'>" + escapeHtml(msg) + "</span>";
  if (TICK_TIMER) clearTimeout(TICK_TIMER);
  TICK_TIMER = setTimeout(function () { TICK_MSG = null; readout(); }, 5000);
}

// ── 首次配置（H-4）：可暂停、可终止，终止先给预览 ────────
var SETUP_STEPS = ["detect", "ollama", "embed", "chat", "api", "persona", "smoke", "first"];
var SU_LABEL = {
  detect: "① 看看这台机器", ollama: "② 装 Ollama", embed: "③ 装 embedding（不能跳）",
  chat: "④ 本地对话模型（可选）", api: "⑤ 配云端 API", persona: "⑥ 人格访谈",
  smoke: "⑦ 试运行", first: "⑧ 让它说第一句话",
};
var SU_DESC = {
  detect: "只读：内存、显卡、ollama、已有模型、有没有云端 key",
  ollama: "没有就装。装不上会给两条退路（手动装 / 跳过本地只配云端）",
  embed: "bge-m3。chat 可以云端兜底，embedding 没有语义检索就退化成词法",
  chat: "按内存推荐。有云端 key 也能跳过 —— 只是夜间抽取会停",
  api: "云端表达模型。没有它也能记，只是不能聊",
  persona: "5 个问题 → 6 块草稿 → 逐块确认 → 封存（开第 1 代）",
  smoke: "用假数据跑一轮抽取 + 自传，先听 voice，不满意免费改",
  first: "不弹「配置成功」，让它直接说第一句话",
};
var SU = null;
async function loadSetup(detect) {
  try { SU = await (await fetch("/api/setup" + (detect ? "?detect=1" : ""))).json(); } catch (e) { return; }
  paintSetup();
}
function paintSetup() {
  var box = $("#su-steps");
  if (!box) return;
  var cur = SU && SU.session ? SU.session.step : "detect";
  var done = SU && SU.session ? SU.session.log.map(function (x) { return x.step; }) : [];
  box.innerHTML = SETUP_STEPS.map(function (k) {
    var isDone = done.indexOf(k) >= 0;
    var isNow = k === cur;
    return "<div class='step" + (isNow ? " now" : isDone ? " done" : "") + "'>" +
      "<span class='k'>" + escapeHtml(SU_LABEL[k] || k) + "</span>" +
      "<span class='v'>" + escapeHtml(SU_DESC[k] || "") + (isDone ? " · 已完成" : "") + "</span></div>";
  }).join("");
  var st = SU && SU.session ? SU.session.status : "idle";
  $("#su-start").textContent = st === "idle" ? "开始" : st === "paused" ? "继续" : "跑这一步";
  $("#su-msg").textContent = st === "aborted" ? "上一轮已终止并清理" : "";
  var job = SU && SU.job;
  $("#su-job").textContent = job && job.running ? "进行中：" + (SU_LABEL[job.step] || job.step) + " …" : (job && job.note ? job.note : "");
  paintSetupPanel();
  // 第一次进来：探测一次（只读）
  if (SU && !SU.detected && !SU._detectedOnce) { SU._detectedOnce = true; loadSetup(true); }
}
$("#su-start").addEventListener("click", async function () {
  var st = SU && SU.session ? SU.session.status : "idle";
  if (st === "idle" || !SU || !SU.session) {
    await fetch("/api/setup", { method: "POST", headers: H, body: JSON.stringify({ action: "start" }) });
    await loadSetup(true);
    return;
  }
  if (st === "paused") {
    await fetch("/api/setup", { method: "POST", headers: H, body: JSON.stringify({ action: "resume" }) });
    await loadSetup();
    return;
  }
  var step = SU.session.step;
  var r = await (await fetch("/api/setup", { method: "POST", headers: H, body: JSON.stringify({ action: "run", step: step }) })).json();
  $("#su-job").textContent = "进行中：" + (SU_LABEL[step] || step) + " …";
  if (!r.ok) $("#su-msg").textContent = r.error || "启动失败";
  pollSetup();
});
function pollSetup() {
  var t = setInterval(async function () {
    await loadSetup(false);
    var job = SU && SU.job;
    if (!job || !job.running) { clearInterval(t); await loadSetup(true); }
  }, 1500);
}
$("#su-pause").addEventListener("click", async function () {
  await fetch("/api/setup", { method: "POST", headers: H, body: JSON.stringify({ action: "pause" }) });
  await loadSetup();
  $("#su-msg").textContent = "已暂停：账本还在，接着跑不会重装";
});
$("#su-abort").addEventListener("click", async function () {
  // **先说再做**：先把会删/会恢复的东西列出来，人确认了才动手
  var p = await (await fetch("/api/setup", { method: "POST", headers: H, body: JSON.stringify({ action: "abort" }) })).json();
  if (!p.ok) return;
  var pv = p.preview || {};
  var lines = [];
  if ((pv.models || []).length) lines.push("删掉我们下载的模型：" + pv.models.join("、"));
  if ((pv.files || []).length) lines.push("把改过的配置恢复原样：" + pv.files.join("、"));
  if ((pv.processes || []).length) lines.push("停掉我们起的进程：" + pv.processes.join("、"));
  if ((pv.dirs || []).length) lines.push("删掉临时目录：" + pv.dirs.join("、"));
  if (!lines.length) lines.push("这一轮还没改动任何东西（只是探测），终止不会删任何文件。");
  var NL = String.fromCharCode(10);
  var typed = prompt("终止会做这些：" + NL + NL + lines.join(NL) + NL + NL + "要终止就输入：终止");
  if (typed !== "终止") { $("#su-msg").textContent = "没有确认，什么都没动"; return; }
  var done = await (await fetch("/api/setup", { method: "POST", headers: H, body: JSON.stringify({ action: "abort", confirm: true }) })).json();
  var rep = done.report || {};
  $("#su-msg").textContent = "已清理：" + ((rep.removedModels || []).length) + " 个模型 / " + ((rep.restoredFiles || []).length) + " 个文件" +
    ((rep.failed || []).length ? "；没清掉的：" + rep.failed.join("；") : "");
  await loadSetup();
});
// ── 首次配置：当前步骤的实际界面（⑤ API ⑥ 人格 ⑦ 试运行 ⑧ 第一句话）──
var SU_IV = null;
async function paintSetupPanel() {
  var box = $("#su-panel");
  if (!box) return;
  var step = SU && SU.session ? SU.session.step : null;
  if (!step || !["api", "persona", "smoke", "first"].includes(step)) { box.hidden = true; return; }
  box.hidden = false;
  if (step === "api") {
    box.innerHTML = "<p class='hint'>云端表达模型：没有它也能记，只是不能聊。key 存在本机（DPAPI 加密）。</p>" +
      "<div class='two'><div><label>provider</label><select id='su-prov'><option value='deepseek'>deepseek</option><option value='openai'>openai</option><option value='anthropic'>anthropic</option></select></div>" +
      "<div><label>model</label><input id='su-model' placeholder='deepseek-chat'></div></div>" +
      "<label>api key</label><input id='su-key' type='password' placeholder='sk-…' autocomplete='off'>" +
      "<div class='acts'><button id='su-api-save' class='primary'>保存并继续</button><span id='su-api-msg' class='hint'></span></div>";
    $("#su-api-save").onclick = async function () {
      var msg = $("#su-api-msg"); msg.textContent = "保存中…";
      var body = { provider: $("#su-prov").value, model: $("#su-model").value || undefined, key: $("#su-key").value || undefined };
      var r = await (await fetch("/api/config", { method: "PUT", headers: H, body: JSON.stringify(body) })).json();
      if (!r.ok) { msg.className = "err"; msg.textContent = r.error || "保存失败"; return; }
      await fetch("/api/setup", { method: "POST", headers: H, body: JSON.stringify({ action: "run", step: "api" }) });
      msg.className = "ok"; msg.textContent = "已保存";
      await loadSetup();
    };
    return;
  }
  if (step === "persona") {
    box.innerHTML = "<p class='hint'><b>先说一句：这 5 个回答会发给云端模型做整理</b>（只这一次；不写进记忆，也不发你的记忆原文）。</p>" +
      "<p class='hint'>5 个问题 → 模型写成 6 块草稿 → 你逐块确认 → 封存。<b>只有你自己说过的话才会被标成「你原话」</b>（这一条是代码校验的，不是提示词）。</p>" +
      "<div id='su-qs'><p class='hint'>正在取问题…</p></div>";
    var iv = SU_IV || await (await fetch("/api/setup/interview")).json();
    SU_IV = iv;
    $("#su-qs").innerHTML = (iv.questions || []).map(function (q) {
      return "<div class='q'><label>" + escapeHtml(q.q) + "</label>" +
        "<textarea id='su-a-" + escapeHtml(q.id) + "' placeholder='" + escapeHtml(q.fallback) + "'></textarea></div>";
    }).join("") + "<div class='acts'><button id='su-iv-go' class='primary'>让模型写草稿</button><span id='su-iv-msg' class='hint'></span></div><div id='su-draft'></div>";
    $("#su-iv-go").onclick = async function () {
      var msg = $("#su-iv-msg"); msg.textContent = "写草稿中…";
      var answers = {};
      (SU_IV.questions || []).forEach(function (q) { answers[q.id] = ($("#su-a-" + q.id).value || "").trim(); });
      var filled = Object.keys(answers).filter(function (k) { return answers[k]; });
      if (!filled.length) {
        msg.className = "err";
        msg.textContent = "先回答几个问题（哪怕一句）。一个字都不填，模型只会写出「未提供具体内容」这种废话。";
        return;
      }
      var r = await (await fetch("/api/setup/interview", { method: "POST", headers: H, body: JSON.stringify({ action: "draft", answers: answers }) })).json();
      // why 是人话，error 是错误码：先显示 why
      if (!r.ok) { msg.className = "err"; msg.textContent = r.why || r.error || "写不出来"; return; }
      msg.className = "hint"; msg.textContent = (r.draft.via === "template" ? "（没有可用模型，用你的原话 + 中立模板拼的）" : "模型写的") + " · 需要你确认的 " + r.modelAdded + " 条";
      renderDraft(r.draft);
    };
    if (iv.draft) renderDraft(iv.draft);
    return;
  }
  if (step === "smoke") {
    box.innerHTML = "<p class='hint'>用假数据跑一轮，先听 voice。不满意就回上一步改（<b>封存前的修改是免费的</b>）。</p>" +
      "<div class='acts'><button id='su-smoke' class='primary'>跑一次</button><span id='su-smoke-msg' class='hint'></span></div><div id='su-smoke-out'></div>";
    $("#su-smoke").onclick = async function () {
      $("#su-smoke-msg").textContent = "跑…";
      var r = await (await fetch("/api/setup/smoke", { method: "POST", headers: H, body: JSON.stringify({}) })).json();
      $("#su-smoke-msg").textContent = r.via === "template" ? "没有表达模型，下面是模板" : ("用时 " + r.ms + "ms");
      $("#su-smoke-out").innerHTML = "<div class='reply'>" + escapeHtml(r.reply) + "</div>" +
        ((r.note) ? "<p class='hint'>" + escapeHtml(r.note) + "</p>" : "") +
        "<p class='hint'>它会这样看待这段假对话：</p>" + (r.extracted || []).map(function (x) { return "<div class='hint'>· " + escapeHtml(x) + "</div>"; }).join("");
      await fetch("/api/setup", { method: "POST", headers: H, body: JSON.stringify({ action: "run", step: "smoke" }) });
      await loadSetup();
    };
    return;
  }
  if (step === "first") {
    box.innerHTML = "<p class='hint'>不弹「配置成功」。让它直接说第一句话 —— 同时验证整条链路通了。</p>" +
      "<div class='acts'><button id='su-first' class='primary'>让它开口</button><span id='su-first-msg' class='hint'></span></div><div id='su-first-out'></div>";
    $("#su-first").onclick = async function () {
      $("#su-first-msg").textContent = "…";
      var r = await (await fetch("/api/setup/first", { method: "POST", headers: H, body: JSON.stringify({}) })).json();
      $("#su-first-msg").textContent = r.written ? "（已写进 journal，之后它就是这条时间线的第一句）" : "（没写进 journal）";
      $("#su-first-out").innerHTML = "<div class='reply' style='color:var(--cyan-hi)'>" + escapeHtml(r.text) + "</div>";
      await fetch("/api/setup", { method: "POST", headers: H, body: JSON.stringify({ action: "run", step: "first" }) });
      await loadSetup();
    };
    return;
  }
}
// 草稿：**六块全列**（空的也列，写「还是出厂默认」），每行带着它的出处。
// 出处不能被面板改掉：interview.ts 的铁律是「模型写的每一行要么能在你回答里逐字找到，
// 要么标成『模型补的，请确认』」。之前这里保存时不看 source、一律写成「你原话」，
// 等于把那条校验绕过去了 —— 封存出来的 persona 会把模型编的话挂上你的名字。
var DRAFT_BLOCKS = ['core', 'boundaries', 'values', 'voice', 'evidence', 'tools'];
function renderDraft(d) {
  var box = document.getElementById('su-draft');
  if (!box) return;
  var html = '';
  var empty = [];
  DRAFT_BLOCKS.forEach(function (k) {
    var lines = (d.blocks || {})[k] || [];
    if (!lines.length) { empty.push(k); return; }
    html += '<p class="hint" style="margin-top:12px">#' + k + '</p>';
    lines.forEach(function (l, i) {
      var mine = l.source === '你原话';
      html += '<div class="draftline' + (mine ? ' mine' : '') + '">' +
        '<span class="src">' + (mine ? '你原话' : '请确认') + '</span>' +
        '<input data-blk="' + k + '" data-i="' + i + '" data-src="' + (mine ? '你原话' : '模型补的') + '" value="' + escapeHtml(l.text) + '"></div>';
    });
  });
  if (empty.length) {
    html += '<p class="hint" style="margin-top:12px">这几块访谈里没说到，封存后会<b>保持出厂默认</b>：' +
      empty.map(function (k) { return '#' + k; }).join(' · ') + '（之后可在设置 → 人格里补）</p>';
  }
  html += '<div class="acts" style="margin-top:12px"><button id="su-seal" class="primary">封存（开第 1 代）</button><span id="su-seal-msg" class="hint"></span></div>';
  box.innerHTML = html;
  document.getElementById('su-seal').onclick = async function () {
    var msg = document.getElementById('su-seal-msg'); msg.className = 'hint'; msg.textContent = '封存中…';
    var blocks = {};
    document.querySelectorAll('#su-draft input[data-blk]').forEach(function (inp) {
      var k = inp.dataset.blk;
      var src = inp.dataset.src === '你原话' ? '你原话' : '模型补的（请确认）';
      (blocks[k] = blocks[k] || []).push({ text: inp.value, source: src });
    });
    await fetch('/api/setup/interview', { method: 'POST', headers: H, body: JSON.stringify({ action: 'save', blocks: blocks }) });
    var r = await (await fetch('/api/setup/interview', { method: 'POST', headers: H, body: JSON.stringify({ action: 'seal', because: '首次封存（面板）' }) })).json();
    if (!r.ok) { msg.className = 'err'; msg.textContent = r.error || '封存失败'; return; }
    msg.className = 'ok'; msg.textContent = r.note;
    await fetch('/api/setup', { method: 'POST', headers: H, body: JSON.stringify({ action: 'run', step: 'persona' }) });
    // 封存后立刻把世代/人格读回来：不然设置里看到的还是旧的（要刷新才变）
    await loadGeneration();
    if (document.getElementById('p-file')) await loadPersona(document.getElementById('p-file').value);
    await loadSetup();
  };
}
// ── 分代（H-5）：显示当前第几代，并说清"改动只向前生效" ──
// ── 文件面板：只读浏览项目两个根（白名单在服务端 project.read/list）──
var TREE = [], FCUR = "", FSEEN = 40;
async function loadTree(dir) {
  var j;
  try { j = await (await fetch("/api/project/tree?dir=" + encodeURIComponent(dir))).json(); } catch (e) { return; }
  var box = document.getElementById("flist");
  if (!j.ok) { box.innerHTML = '<p class="hint err">' + escapeHtml(j.error || '读不了这个目录') + '</p>'; return; }
  TREE = j.entries || []; FCUR = dir || ""; FSEEN = 40;
  var crumbs = document.getElementById("fcrumbs");
  if (crumbs) {
    crumbs.innerHTML = FCUR ? ("位置：<b>" + escapeHtml(FCUR) + "</b>") : "位置：项目根（jingjing/ 与 docs/）";
  }
  paintTree();
}
function paintTree() {
  var q = (document.getElementById("fq") || {}).value || "";
  q = q.trim().toLowerCase();
  var rows = TREE.filter(function (e) { return !q || e.path.toLowerCase().indexOf(q) >= 0; });
  var box = document.getElementById("flist");
  if (!rows.length) { box.innerHTML = '<p class="hint">没有匹配的文件。</p>'; return; }
  var shown = rows.slice(0, FSEEN);
  var html = shown.map(function (e) {
    var isDir = e.type === "dir";
    return '<button class="item" data-fpath="' + escapeHtml(e.path) + '" data-ftype="' + (isDir ? 'dir' : 'file') + '">' +
      escapeHtml(e.path.replace(FCUR ? FCUR + "/" : "", "")) +
      '<span class="m">' + (isDir ? '目录' : Math.max(1, Math.round((e.bytes || 0) / 1024)) + 'KB') + '</span></button>';
  }).join("");
  if (rows.length > shown.length) {
    html += '<button class="item dimmore" id="fmore">显示更多（' + shown.length + ' / ' + rows.length + '）</button>';
  }
  box.innerHTML = html;
  var more = document.getElementById("fmore");
  if (more) more.onclick = function () { FSEEN += 40; paintTree(); };
}
async function openFile(path) {
  var j;
  try { j = await (await fetch("/api/project/file?path=" + encodeURIComponent(path))).json(); } catch (e) { return; }
  var box = document.getElementById("fview");
  var head = document.getElementById("fpath");
  var pre = document.getElementById("ftext");
  if (!j.ok) {
    box.hidden = false; head.textContent = path; pre.textContent = j.error || "读不了"; return;
  }
  box.hidden = false;
  head.textContent = j.path;
  pre.textContent = j.text || "（空文件）";
  pre.scrollTop = 0;
}
// ── git 校样：只读（status / diff / log）────────────────────────
async function loadGit(what, path) {
  var msg = document.getElementById("gmsg");
  if (msg) msg.textContent = "…";
  var url = "/api/git?what=" + encodeURIComponent(what) + (path ? "&path=" + encodeURIComponent(path) : "");
  var j;
  try { j = await (await fetch(url)).json(); } catch (e) { if (msg) msg.textContent = "网络错误"; return; }
  var pre = document.getElementById("gdiff");
  var lines = document.getElementById("gfiles");
  var head = "";
  if (!j.ok) {
    if (msg) msg.textContent = j.code || "失败";
    pre.textContent = j.output || "";
    lines.innerHTML = "";
    return;
  }
  if (what === "status") {
    // status 的输出第一行是摘要，剩下每行一个文件；把文件行做成可点的（点了看这个文件的 diff）
    var all = String(j.output || "").split(String.fromCharCode(10));
    head = all.shift() || "";
    if (msg) msg.textContent = head;
    lines.innerHTML = all.filter(Boolean).map(function (ln) {
      var p = ln.slice(3).trim();
      return '<button class="item" data-gpath="' + escapeHtml(p) + '"><span class="preview">' +
        escapeHtml(ln.slice(0, 2).trim() || '??') + '  ' + escapeHtml(p) + '</span></button>';
    }).join("");
    pre.textContent = "";
    return;
  }
  lines.innerHTML = "";
  if (msg) msg.textContent = what === "log" ? "最近提交" : "差异";
  pre.textContent = j.output || "（没有内容）";
  pre.scrollTop = 0;
}

// ── 能力屏：插件（MCP）/ 技能 / 原生工具 / 降级项 ────────────────
// 三件事都只读：这里不装、不启、不改配置 —— 装是跑 jingjing mcp add，或往目录里放文件。
function capline(k, v, bad) {
  return '<div class="capline' + (bad ? ' bad' : '') + '">' +
    '<span class="k">' + escapeHtml(k) + '</span>' +
    '<span class="v">' + escapeHtml(v == null ? '' : String(v)) + '</span></div>';
}
async function loadCapPage() {
  var cap = null, sk = null;
  try { cap = await (await fetch('/api/capabilities')).json(); } catch (e) { /* 下面显示空 */ }
  try { sk = await (await fetch('/api/skills')).json(); } catch (e) { /* 同上 */ }

  var cls = (cap && cap.classes) || {};
  var mcpTools = ((cls.tool) || []).filter(function (t) { return t.source === 'mcp'; });
  var byServer = {};
  mcpTools.forEach(function (t) {
    var m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(t.name);
    var server = m ? m[1] : '?';
    (byServer[server] = byServer[server] || []).push(t);
  });
  var errs = ((cap && cap.degraded) || []).filter(function (d) { return d.indexOf('mcp-unavailable') === 0; });
  var html = '';
  Object.keys(byServer).filter(function (k) { return k !== '?'; }).forEach(function (name) {
    html += capline(name, byServer[name].length + ' 个工具 · ok');
    byServer[name].forEach(function (t) {
      html += '<div class="hint">· ' + escapeHtml(t.name.replace(/^mcp__[^_]+__/, '')) + '（' + escapeHtml(t.tier) + '）</div>';
    });
  });
  errs.forEach(function (d) { html += capline(d.replace('mcp-unavailable:', ''), '连不上', true); });
  document.getElementById('cap-mcp').innerHTML = html ||
    '<p class="hint">没装插件。插件是 MCP server：写进 data/mcp.json 的 servers 里，重启面板就会出现在这里。</p>';

  var list = (sk && sk.skills) || [];
  var dirsEl = document.getElementById('cap-skills-dirs');
  if (dirsEl) {
    dirsEl.textContent = '放这里就会被认到：' + ((sk && sk.dirs) || []).join(' 或 ') + '（和 pi / Claude Code 同一套目录）';
  }
  // 分两组：她自己的（会进简报索引）/ 使用者的开发技能（默认不进简报，折起来）
  var mine = list.filter(function (x) { return x.source !== 'agents'; });
  var devs = list.filter(function (x) { return x.source === 'agents'; });
  var skHtml = '';
  function skillRow(x) {
    return capline(x.id, x.source + ' · ' + Math.max(1, Math.round(x.bytes / 1024)) + 'KB') +
      '<div class="hint">' + escapeHtml(x.description || '（没有描述）') + '</div>';
  }
  if (mine.length) {
    skHtml += '<p class="hint">她自己的（会进简报索引：名字 + 一句描述）</p>';
    skHtml += mine.map(skillRow).join('');
  }
  if (devs.length) {
    skHtml += '<p class="hint">使用者的开发技能（共 ' + devs.length + ' 个；默认不进简报，要看用 skill_list）' +
      '<button type="button" id="cap-more" class="dimmore" style="margin-left:8px;padding:3px 6px">展开</button></p>';
    skHtml += '<div id="cap-dev" hidden>' + devs.map(skillRow).join('') + '</div>';
  }
  document.getElementById('cap-skills').innerHTML = skHtml ||
    '<p class="hint">还没有技能。一份 SKILL.md 就是一个技能：<b>一句话说明 + 做法</b>。对话时只把名字和那句说明放进简报，正文由它自己 skill_read 取 —— 不占每轮的上下文。</p>';
  var more = document.getElementById('cap-more'), dev = document.getElementById('cap-dev');
  if (more && dev) more.onclick = function () { dev.hidden = !dev.hidden; more.textContent = dev.hidden ? '展开' : '收起'; };

  var cnt = function (k) { return ((cls[k] || []).filter(function (t) { return t.source !== 'mcp'; })).length; };
  document.getElementById('cap-native').innerHTML =
    capline('工具（verbs）', cnt('tool') + ' 个') +
    capline('命令（CLI）', cnt('command') + ' 个') +
    capline('面板能力', cnt('panel') + ' 个') +
    capline('定时模板', cnt('cron') + ' 个');

  var deg = (cap && cap.degraded) || [];
  document.getElementById('cap-degraded').innerHTML = deg.length
    ? deg.map(function (d) { return capline(d, '缺', true); }).join('')
    : '<p class="hint">没有降级项：当前能自述的能力都是真的。</p>';

  var cc = document.getElementById('capcount');
  if (cc) cc.textContent = (mcpTools.length + list.length + cnt('tool')) + ' 项';
}
async function loadGeneration() {
  var g; try { g = await (await fetch("/api/persona")).json(); } catch (e) { return; }
  var el = $("#p-gen");
  if (!el) return;
  if (!g || !g.generation) { el.textContent = ""; return; }
  el.innerHTML = "当前第 <b>" + g.generation.gen + "</b> 代（" + escapeHtml(String(g.generation.createdAt).slice(0, 10)) +
    "）· 改动只影响<b>之后</b>写下的记忆；旧记忆仍按原来的代解释。";
}
// ── 代码外发（H-7）：它想读、被挡下、等人批 ─────────────
async function loadEgress() {
  var st;
  try { st = await (await fetch("/api/egress")).json(); } catch (e) { return; }
  var rows = (st && st.pending) || [];
  $("#egrcount").textContent = st.until ? "开放中" : (rows.length ? rows.length + " 条" : "");
  $("#egrsec").hidden = !rows.length && !st.until;
  var head = st.until
    ? "<div class='pend'><span class='cmd'>代码外发：开放中（到 " + escapeHtml(String(st.until).slice(11, 16)) + "）</span>" +
      "<div class='acts'><button class='no' data-egr='revoke'>收回</button></div></div>"
    : (st.forced ? "<p class='hint'>当前由 JJ_PROJECT_EGRESS=1 强制放行（无人值守模式）。</p>" : "");
  $("#egrlist").innerHTML = head + rows.map(function (r) {
    return "<div class='pend' data-egrpath='" + escapeHtml(r.path) + "'>" +
      "<span class='cmd'>" + escapeHtml(r.path) + "</span>" +
      "<span class='dir'>" + escapeHtml(String(r.at).slice(0, 16)) + " · " + escapeHtml(r.verb) + "</span>" +
      "<div class='acts'>" +
        "<button class='ok' data-egr='once'>只这一次</button>" +
        "<button class='ok' data-egr='window'>10 分钟内都行</button>" +
        "<button class='no' data-egr='deny'>拒绝</button>" +
      "</div><span class='msg'></span></div>";
  }).join("");
}
$("#egrlist").onclick = async function (e) {
  var b = e.target.closest("button[data-egr]");
  if (!b) return;
  var card = b.closest("[data-egrpath]");
  var act = b.dataset.egr;
  var body = { action: act === "window" ? "window" : act };
  if (act === "once" && card) body.path = card.dataset.egrpath;
  if (act === "deny") { if (card) card.remove(); var left = $("#egrlist").children.length; $("#egrcount").textContent = left ? left + " 条" : ""; $("#egrsec").hidden = left === 0; return; }
  await fetch("/api/egress", { method: "POST", headers: H, body: JSON.stringify(body) });
  await loadEgress();
};
// ── 权限档：当前会话在输入框旁切；设置只放「以后新建会话的默认值」──
var PERM = { preset: "ask", remainingS: 0 };
var PERM_LABEL = { ask: "逐次确认", read: "仅可查看", write: "工作区内修改", full: "完全权限" };
async function loadPermission() {
  try { PERM = await (await fetch("/api/permission")).json(); } catch (e) { return; }
  paintPermission();
}
function paintPermission() {
  var b = document.getElementById("perm");
  if (!b) return;
  // 会话级：不再显示倒计时（它不会自己过期；换了档或关掉进程才变）
  b.textContent = PERM_LABEL[PERM.preset] || PERM.preset;
  b.className = "permchip" + (PERM.preset === "full" ? " full" : "");
}
async function setPermission(preset) {
  var r;
  try {
    r = await (await fetch("/api/permission", {
      method: "POST", headers: H, body: JSON.stringify({ preset: preset }),
    })).json();
  } catch (e) { return false; }
  if (r.ok) { await loadPermission(); return true; }
  var msg = document.getElementById("permmsg");
  if (msg) msg.textContent = r.why || r.code || "切换失败";
  return false;
}
function renderPermOptions() {
  var cur = PERM.preset;
  var box = document.getElementById("permopts");
  box.innerHTML = (PERM.presets || []).map(function (x) {
    var on = x.id === cur ? " on" : "";
    var warn = x.id === "full" ? " ⚠" : "";
    return "<button class='opt" + on + "' data-preset='" + escapeHtml(x.id) + "' aria-current='" + (x.id === cur ? "true" : "false") + "'>" +
      "<b>" + escapeHtml(x.label) + warn + "</b><span>" + escapeHtml(x.hint) + "</span></button>";
  }).join("");
}
document.getElementById("perm").addEventListener("click", function () {
  renderPermOptions();
  document.getElementById("permpop").hidden = false;
  var on = document.querySelector("#permopts .opt.on");
  if (on) on.focus();
});
document.getElementById("permclose").addEventListener("click", function () {
  document.getElementById("permpop").hidden = true;
});
document.getElementById("permpop").addEventListener("click", function (e) {
  if (e.target.id === "permpop") document.getElementById("permpop").hidden = true;
});
document.getElementById("permopts").addEventListener("click", async function (e) {
  var b = e.target.closest("button[data-preset]");
  if (!b) return;
  var preset = b.dataset.preset;
  // 一键切：选中就生效，没有二次确认（安全边界在"哪些命令永久拒绝"，不在"多点几下手"）
  if (await setPermission(preset)) document.getElementById("permpop").hidden = true;
});
document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") return;
  var pop = document.getElementById("permpop");
  if (pop && !pop.hidden) { pop.hidden = true; document.getElementById("perm").focus(); }
});

// /permission 斜杠命令：带参直接切，不带参打开选择器（同 DSH）
async function handleSlash(text) {
  // 不用正则：page.ts 是模板字符串，反斜杠在这一层就会被吃掉（踩过）
  var t = String(text || "").trim();
  if (t !== "/permission" && t.indexOf("/permission ") !== 0) return false;
  var arg = t === "/permission" ? "" : t.slice(11).trim().split(" ")[0].toLowerCase();
  if (!arg) { document.getElementById("perm").click(); return true; }
  var alias = { full: "full", write: "write", read: "read", ask: "ask" };
  var preset = alias[arg];
  if (!preset) { pushTicker("未知档位：" + arg + "（可用 ask / read / write / full）"); return true; }
  if (await setPermission(preset)) pushTicker("权限已切到 " + preset);
  return true;
}

// ── 回执（D-3 前置）：送达 ≠ 已读 ───────────────────
async function loadReceipts() {
  var j;
  try { j = await (await fetch("/api/receipts")).json(); } catch (e) { return; }
  var rows = (j && j.items) || [];
  $("#rcpcount").textContent = rows.length ? rows.length + " 条" : "";
  $("#rcpsec").hidden = rows.length === 0;
  $("#rcplist").innerHTML = rows.map(function (r) {
    return "<div class='pend rcp' data-rcp='" + escapeHtml(r.id) + "'>" +
      "<span class='cmd'>" + (r.ok ? "" : "<span class='err'>失败 </span>") + escapeHtml(r.title) + "</span>" +
      "<span class='dir'>" + escapeHtml(String(r.at).slice(0, 16)) + (r.source ? " · " + escapeHtml(r.source) : "") + "</span>" +
      "<div class='acts'><button class='ok' data-act='seen'>知道了</button></div>" +
      "<span class='msg'></span></div>";
  }).join("") || "<p class='hint'>没有待读回执。</p>";
}
$("#rcplist").onclick = async function (e) {
  var b = e.target.closest("button[data-act=seen]");
  if (!b) return;
  var card = b.closest("[data-rcp]");
  b.disabled = true;
  await fetch("/api/receipts/" + card.dataset.rcp + "/seen", { method: "POST", headers: H });
  await loadReceipts();
};

// ── 常驻指令（D-3）：只读列表 + 停用 ─────────────────
async function loadStanding() {
  var rows;
  try { rows = await (await fetch("/api/standing")).json(); } catch (e) { return; }
  rows = Array.isArray(rows) ? rows : [];
  var el = $("#st-list");
  if (!el) return;
  el.innerHTML = rows.length ? rows.map(function (o) {
    return "<div class='pend' data-std='" + escapeHtml(o.id) + "'>" +
      "<span class='cmd'>" + escapeHtml(o.id) + " · " + escapeHtml(o.when) + " · " + escapeHtml(o.template) + "</span>" +
      "<span class='dir'>" + (o.enabled ? "启用" : "<span class='err'>已停用</span>") +
        " · 到期 " + escapeHtml(String(o.expiresAt).slice(0, 10)) + " · 为什么：" + escapeHtml(o.because) + "</span>" +
      (o.enabled ? "<div class='acts'><button class='no' data-act='off'>停用</button></div>" : "") +
      (o.disabledReason ? "<span class='hint'>" + escapeHtml(o.disabledReason) + "</span>" : "") +
      "<span class='msg'></span></div>";
  }).join("") : "<p class='hint'>还没有常驻指令。加一条：jingjing standing add --id x --when 09:00 --run node.run_script --because 理由（必须写为什么）</p>";
}
$("#st-list").onclick = async function (e) {
  var b = e.target.closest("button[data-act=off]");
  if (!b) return;
  var card = b.closest("[data-std]");
  b.disabled = true;
  await fetch("/api/standing/" + card.dataset.std + "/disable", { method: "POST", headers: H, body: JSON.stringify({ reason: "面板上停用" }) });
  await loadStanding();
};
// ── 线索层：未闭合的事（"这件事发展到哪一步"）────────
async function loadThreads() {
  var rows;
  try { rows = await (await fetch("/api/threads")).json(); } catch (e) { return; }
  rows = Array.isArray(rows) ? rows : [];
  $("#threadcount").textContent = rows.length ? rows.length + " 件" : "";
  $("#threadsec").hidden = rows.length === 0;
  $("#threadlist").innerHTML = rows.map(function (t) {
    var age = t.ageDays > 0 ? "立下 " + t.ageDays + " 天" : "今天立的";
    return "<div class='pend thr' data-thr='" + t.id + "'>" +
      "<span class='cmd'>" + escapeHtml(String(t.text).slice(0, 40)) + "</span>" +
      "<span class='dir'>" + escapeHtml(age) + (t.aging ? " · 拖了 " + t.ageDays + " 天" : "") +
      (t.quote ? " · 原话「" + escapeHtml(String(t.quote).slice(0, 20)) + "」" : "") + "</span>" +
      "<div class='acts'><button class='ok' data-act='done'>了结了</button></div>" +
      "<span class='msg'></span></div>";
  }).join("");
}
$("#threadlist").onclick = async function (e) {
  var btn = e.target.closest("button[data-act=done]");
  if (!btn) return;
  var card = btn.closest("[data-thr]");
  var msg = card.querySelector(".msg");
  btn.disabled = true;
  msg.textContent = "处理中…";
  try {
    var r = await (await fetch("/api/threads/" + card.dataset.thr + "/close", {
      method: "POST", headers: H, body: JSON.stringify({ note: "人点了了结" }),
    })).json();
    if (r.ok) { msg.textContent = "已了结（历史仍查得到）"; setTimeout(function () { loadThreads(); }, 600); }
    else { msg.textContent = r.error || "失败"; btn.disabled = false; }
  } catch (err) { msg.textContent = "请求失败"; btn.disabled = false; }
};

// ── 抽检（J-5b）：把最没把握的线送到眼前，当场能断 ──
async function loadSurfaceReview() {
  var rows;
  try { rows = await (await fetch("/api/surface/review")).json(); } catch (e) { return; }
  rows = Array.isArray(rows) ? rows : [];
  $("#surfcount").textContent = rows.length ? rows.length + " 根" : "";
  $("#surfsec").hidden = rows.length === 0;
  $("#surflist").innerHTML = rows.map(function (r) {
    return "<div class='pend surf' data-key='" + escapeHtml(r.key) + "' data-src='" + r.src_id + "' data-dst='" + r.dst_id + "' data-rel='" + escapeHtml(r.rel) + "'>" +
      "<span class='cmd'>" + escapeHtml(String(r.a_text).slice(0, 26)) + " ↔ " + escapeHtml(String(r.b_text).slice(0, 26)) + "</span>" +
      "<span class='dir'>为什么连：" + escapeHtml(r.why || "（没有理由）") + " · 把握 " + Number(r.weight).toFixed(2) + "</span>" +
      "<div class='acts'><button class='ok' data-act='yes'>对</button><button class='no' data-act='no'>不对，断掉</button></div>" +
      "<span class='msg'></span></div>";
  }).join("");
}
$("#surflist").onclick = async function (e) {
  var btn = e.target.closest("button[data-act]");
  if (!btn) return;
  var card = btn.closest("[data-key]");
  var msg = card.querySelector(".msg");
  btn.disabled = true;
  msg.textContent = "处理中…";
  var body = { src_id: Number(card.dataset.src), dst_id: Number(card.dataset.dst), rel: card.dataset.rel, ok: btn.dataset.act === "yes" };
  try {
    var r = await (await fetch("/api/surface/review", { method: "POST", headers: H, body: JSON.stringify(body) })).json();
    msg.textContent = r.ok ? (r.cut ? "已断" : "已记下") : (r.error || "失败");
    setTimeout(function () { card.remove(); var left = $("#surflist").children.length; $("#surfcount").textContent = left ? left + " 根" : ""; $("#surfsec").hidden = left === 0; }, 700);
  } catch (err) { msg.textContent = "请求失败"; btn.disabled = false; }
};

async function openMemory(id) {
  const r = await (await fetch("/api/memories/" + id)).json();
  $("#mv-text").textContent = r.text;
  $("#mv-meta").textContent = "id " + r.id + " · " + r.layer + "/" + r.kind + " · " + r.stage +
    " · 权重 " + Number(r.weight).toFixed(2) + " · " + r.sensitivity + " · " + r.taint +
    " · 打分 " + (r.scored_by || "未记录") +
    " · 建于 " + String(r.created_at).slice(0, 19);
  $("#mv-msg").textContent = "";
  $("#mv-edit").value = r.text;
  $("#mv-imp").value = String(r.importance ?? 3);
  $("#mv-sens").value = r.sensitivity === "shareable" ? "shareable" : "local_only";
  // F-1 #5：一条记忆必须能回答"它从哪来、改过什么"
  var prov = r.provenance || { changes: [], doc: null };
  var bits = [];
  var fromText = r.source_kind === "doc" ? "文档" : r.source_kind === "extract" ? "夜间抽取" : r.source_kind === "user" ? "你说的话" : (r.source_kind || "未知");
  bits.push("<div class='hint'>来自：" + escapeHtml(fromText) + (r.source_ref ? " · " + escapeHtml(String(r.source_ref).slice(0, 120)) : "") + "</div>");
  if (r.quote) bits.push("<div class='quote'>原话：「" + escapeHtml(r.quote) + "」</div>");
  if (prov.doc) bits.push("<button class='item mini' data-doc='" + escapeHtml(prov.doc.id) + "'>打开来源文档：" + escapeHtml(prov.doc.title) + "</button>");
  if (r.superseded_by) bits.push("<div class='hint'>被 #" + r.superseded_by + " 取代（旧的留着可追溯）</div>");
  if ((prov.changes || []).length) {
    bits.push("<details class='hist'><summary>改过 " + prov.changes.length + " 次（点开看旧正文）</summary>" +
      prov.changes.map(function (c) {
        return "<div class='oldver'><span class='dim2'>" + String(c.at).slice(0, 19) + " · " + escapeHtml(c.by) + "</span><br>" + escapeHtml(c.old) + "</div>";
      }).join("") + "</details>");
  }
  $("#mv-prov").innerHTML = bits.join("");
  var docBtn = $("#mv-prov").querySelector("button[data-doc]");
  if (docBtn) docBtn.onclick = function () { openDoc(docBtn.dataset.doc); };
  $("#mv-save").dataset.id = String(id);
  $("#mv-forget").onclick = async () => {
    const j = await (await fetch("/api/memories/" + id + "/forget", { method: "POST", headers: H })).json();
    if (!j.ok) { $("#mv-msg").className = "err"; $("#mv-msg").textContent = j.error || "失败"; return; }
    $("#mv-msg").className = "ok";
    // F-3：忘记是可撤回的（软删）。5 秒内点一下就回来，过期才真的算忘了
    $("#mv-msg").innerHTML = "已忘记 · <button class='item mini' id='mv-undo'>撤销</button>（5 秒）";
    await memories();
    const undo = $("#mv-undo");
    const timer = setTimeout(() => { $("#mv-msg").innerHTML = "已忘记"; }, 5000);
    if (undo) undo.onclick = async () => {
      clearTimeout(timer);
      const r = await (await fetch("/api/memories/" + id + "/restore", { method: "POST", headers: H })).json();
      if (r.ok) { $("#mv-msg").className = "ok"; $("#mv-msg").textContent = "已撤回（权重按原样，没补回来）"; await memories(); }
      else { $("#mv-msg").className = "err"; $("#mv-msg").textContent = r.error || "撤回失败"; }
    };
  };
  show("memview");
}
function scrollBottom() {
  const s = $("#scroll"); s.scrollTop = s.scrollHeight;
}
async function loadUi() {
  try {
    const u = await (await fetch("/api/ui")).json();
    const av = u && u.avatar ? u.avatar : "plain";
    document.body.dataset.av = av;
    const s = $("#a-frame");
    if (s) s.value = av;
  } catch (e) {
    // 面板照常能用：外观是装饰，读不到就不改
  }
}

// 官方默认：baseUrl 留空时服务端就用这些（与 src/transport.ts 的 endpointOf 一致）
var PROVIDER_DEFAULTS = {
  deepseek: { base: "https://api.deepseek.com", model: "deepseek-chat" },
  anthropic: { base: "https://api.anthropic.com", model: "claude-sonnet-4-20250514" },
  openai: { base: "https://api.openai.com", model: "gpt-4o" }
};
function paintEndpoint() {
  var pv = $("#c-provider").value;
  var d = PROVIDER_DEFAULTS[pv] || { base: "", model: "" };
  var typed = $("#c-base").value.trim();
  $("#c-base").placeholder = d.base ? ("留空 = " + d.base) : "";
  $("#c-model").placeholder = d.model;
  var ep = $("#c-ep");
  if (ep) ep.textContent = "实际请求：" + (typed || d.base) + "/…（" + pv + "）" +
    (typed ? "　← 自定义地址（局域网 / 中转 / 自建）" : "　← 官方默认");
}
$("#c-provider").addEventListener("change", function () {
  var d = PROVIDER_DEFAULTS[$("#c-provider").value];
  if (d && !$("#c-model").value.trim()) $("#c-model").value = d.model;
  paintEndpoint();
});
$("#c-base").addEventListener("input", paintEndpoint);

async function loadConfig() {
  loadModels();
  loadCapabilities();
  const c = await (await fetch("/api/config")).json();
  $("#c-provider").value = c.provider;
  $("#c-model").value = c.model;
  $("#c-base").value = c.baseUrl || "";
  $("#modelchip").textContent = c.provider.toUpperCase() + " · " + c.model;
  $("#c-clear").hidden = !c.hasKey;          // 没有 key 就不显示"清除"（避免点了没反应）
  $("#c-cur").textContent = "当前 " + c.provider + " / " + c.model +
    (c.hasKey ? " · key " + c.keyFingerprint + " (" + c.secretStore + ")" : " · 还没配 key") +
    " · 预算 $" + c.budgetUsd + "/天";
  const b = $("#banner");
  if (!c.hasKey) {
    b.hidden = false;
    // 以前这里写「仅本地推理」——那是假话：没有 key 时聊天直接 401，本地只有兜底模型回一句
    b.innerHTML = "// 还没配云端 key —— 现在是你本地那个小模型在硬撑（质量差），点这里配 <button id='go-cfg'>去设置</button>";
    $("#go-cfg").onclick = () => show("cfg");
  } else { b.hidden = true; }
  paintEndpoint();
  return c;
}
// ── 本地模型（C-4）：与云端接口分开管 ─────────────────────
let MODELS = null;
function fillModels(el, cur, installed, extraEmpty) {
  const names = installed.slice();
  if (cur && !names.includes(cur)) names.unshift(cur);
  const opts = (extraEmpty ? ["<option value=''>（未配置）</option>"] : [])
    .concat(names.map(function (n) {
      // Ollama 的 tag 常带 :latest：bge-m3 与 bge-m3:latest 是同一个模型
      const missing = (installed.includes(n) || installed.includes(n + ":latest")) ? "" : " · 未安装";
      return "<option value='" + escapeHtml(n) + "'>" + escapeHtml(n) + missing + "</option>";
    }));
  el.innerHTML = opts.join("");
  el.value = cur || (extraEmpty ? "" : (names[0] || ""));
}
// ── 能力自述（B-0 / F-2）：数据全部来自 /api/capabilities，面板只负责显示 ──
var CAP_CLASSES = [
  ["tool", "工具"], ["command", "命令"], ["hook", "钩子"],
  ["cron", "定时"], ["panel", "面板"], ["provider", "供应商"],
];
async function loadCapabilities() {
  var c;
  try { c = await (await fetch("/api/capabilities")).json(); }
  catch (e) { $("#cap-sum").textContent = "查不到能力表（服务没起来？）"; return; }
  var counts = CAP_CLASSES.map(function (p) { return p[1] + " " + ((c.classes[p[0]] || []).length); });
  $("#cap-sum").textContent = counts.join(" · ");
  $("#cap-list").innerHTML = CAP_CLASSES.map(function (p) {
    var id = p[0], items = c.classes[id] || [];
    if (!items.length) return "<div class='capline dim2'>" + p[1] + "：0（未实现）</div>";
    var names = items.slice(0, 60).map(function (x) {
      return "<span class='capname'>" + escapeHtml(x.name) + "</span>" +
        (x.tier ? " <span class='dim2'>" + x.tier + "</span>" : "") +
        (x.source === "mcp" ? " <span class='dim2'>mcp</span>" : "");
    }).join("");
    return "<details class='capbox'><summary>" + p[1] + " · " + items.length + "</summary>" +
      "<div class='capnames'>" + names + "</div></details>";
  }).join("");
  var deg = c.degraded || [];
  $("#cap-deg").innerHTML = deg.length
    ? "<span class='err'>降级 " + deg.length + " 项</span><br>" +
      "<span class='err'>" + deg.map(escapeHtml).join(" · ") + "</span>" +
      (c.notes && c.notes.length ? "<br><span class='dim2'>" + c.notes.map(escapeHtml).join("；") + "</span>" : "")
    : "<span class='dim2'>无降级</span>";
}

async function loadModels(force) {
  if (MODELS && !force) { paintModels(MODELS); return; }   // 进设置别每次都重新探测
  $("#m-state").textContent = "查询本地模型…";
  let m;
  try { m = await (await fetch("/api/models")).json(); } catch (e) {
    $("#m-state").textContent = "查不到本地模型（服务没起来？）"; return;
  }
  MODELS = m;
  paintModels(m);
}
function paintModels(m) {
  const byRole = {};
  (m.roles || []).forEach(function (r) { byRole[r.role] = r; });
  var envAny = (byRole["route"] && byRole["route"].source === "env") || (byRole["night"] && byRole["night"].source === "env") || (byRole["embed"] && byRole["embed"].source === "env");
  $("#m-state").textContent = m.online
    ? "端点 " + m.endpoint + " · 已装 " + (m.installed.length ? m.installed.join(", ") : "（无）") + (envAny ? " · 部分值被 JJ_MODEL_* 环境变量覆盖（改这里不生效）" : "")
    : "端点 " + m.endpoint + " 连不上：" + (m.error || "") + " —— 先启动 Ollama";
  fillModels($("#m-default"), (byRole["route"] || {}).model || "", m.installed, true);
  fillModels($("#m-night"), (byRole["night"] || {}).model || "", m.installed, true);
  fillModels($("#m-embed"), (byRole["embed"] || {}).model || "", m.installed, true);
}
$("#m-save").addEventListener("click", async function () {
  const btn = this;
  btn.disabled = true;
  $("#m-msg").textContent = "保存中…";
  try {
    const body = { default: $("#m-default").value, night: $("#m-night").value, embed: $("#m-embed").value };
    const r = await fetch("/api/models", { method: "PUT", headers: H, body: JSON.stringify(body) });
    const j = await r.json();
    $("#m-msg").textContent = j.ok ? "已保存：下次夜间整备与重启面板后生效" : ("失败：" + (j.error || r.status));
    await loadModels(true);
  } catch (e) {
    $("#m-msg").textContent = "保存失败：" + e.message;
  } finally { btn.disabled = false; }
});

async function loadPersona(file) {
  const p = await (await fetch("/api/persona")).json();
  $("#p-text").value = p.files[file] || "";
}
document.addEventListener("click", (e) => {
  // 认任何带 data-view 的 .item：左栏是导航，中栏的列表项（记忆/文档/审计）也走这里。
  // 之前只认 #side 里的 .item，列表搬出左栏之后点不动了（回归过一次）。
  const t = e.target.closest(".item[data-view]");
  if (!t) return;
  const v = t.dataset.view;
  if (t.closest("#side")) {
    sideActive = t;
    for (const b of document.querySelectorAll("#side .item")) b.classList.toggle("on", b === t);
  }
  if (v === "setupview") { show("setupview"); loadSetup(false); return; }
  if (v === "cfg") { show("cfg"); loadConfig().then(() => loadPersona($("#p-file").value)); return; }
  if (v === "toolview") { openTool(Number(t.dataset.tool)); return; }
  if (v === "memview") { openMemory(Number(t.dataset.mem)); return; }
  if (v === "docview") { openDoc(t.dataset.doc); return; }
  if (v === "capview") { show("capview"); loadCapPage(); return; }
  if (v === "filesview") { show("filesview"); loadTree(""); return; }
  if (v === "gitview") { show("gitview"); loadGit("status"); return; }
  if (v === "memlistview") { show("memlistview"); memories(); return; }
  if (v === "docsview") { show("docsview"); docs(); return; }
  if (v === "auditview") { openAudit(); return; }
  show("chat", t.dataset.day ? { day: t.dataset.day } : undefined);
});
$("#p-file").onchange = (e) => loadPersona(e.target.value);
// 头像框：改完立刻套上（不等服务端），再把选择存住
$("#a-frame").onchange = async (e) => {
  const v = e.target.value;
  document.body.dataset.av = v;
  const j = await (await fetch("/api/ui", { method: "PUT", headers: H, body: JSON.stringify({ avatar: v }) })).json();
  const m = $("#a-msg");
  if (j.ok) { m.className = "ok"; m.textContent = "  · SAVED"; }
  else { m.className = "err"; m.textContent = "  · " + (j.error || "FAILED"); }
};
// 移动端：点主区域收起抽屉
document.addEventListener("click", (e) => {
  const side = $("#side");
  if (!side.classList.contains("open")) return;
  if (e.target.closest("#side")) return;
  side.classList.remove("open");
});
// 清除密钥：两步确认（第一次只是"你确定？"，4 秒后自动复位）
let clearArmed = 0;
$("#c-clear").onclick = async () => {
  const btn = $("#c-clear"), m = $("#c-msg");
  if (Date.now() - clearArmed > 4000) {
    clearArmed = Date.now();
    btn.textContent = "再点一次 = 真的清除";
    m.className = "err"; m.textContent = "会删掉本机存的 key（可重新填回）；没 key 时云端会回落本地，本地也没模型就直接报错";
    setTimeout(() => { btn.textContent = "清除密钥"; }, 4000);
    return;
  }
  clearArmed = 0;
  btn.disabled = true;
  try {
    const j = await (await fetch("/api/config", { method: "PUT", headers: H, body: JSON.stringify({ key: null }) })).json();
    m.className = j.ok ? "ok" : "err";
    m.textContent = j.ok
      ? (j.removed ? "已清除本机的 key。没有 key 时云端会回落本地模型" : "本来就没有 key")
      : ("失败：" + (j.error || "?"));
    await loadConfig();
  } finally {
    btn.disabled = false;
    btn.textContent = "清除密钥";
  }
};
$("#c-save").onclick = async () => {
  const body = { provider: $("#c-provider").value, model: $("#c-model").value.trim() };
  const base = $("#c-base").value.trim(); if (base) body.baseUrl = base;
  const key = $("#c-key").value.trim(); if (key) body.key = key;
  const j = await (await fetch("/api/config", { method: "PUT", headers: H, body: JSON.stringify(body) })).json();
  const m = $("#c-msg");
  if (j.ok) { m.className = "ok"; m.textContent = "SAVED"; $("#c-key").value = ""; await loadConfig(); }
  else { m.className = "err"; m.textContent = j.error || "FAILED"; }
};
$("#p-save").onclick = async () => {
  const body = { file: $("#p-file").value, content: $("#p-text").value, because: $("#p-because").value.trim() };
  const j = await (await fetch("/api/persona", { method: "PUT", headers: H, body: JSON.stringify(body) })).json();
  const m = $("#p-msg");
  if (j.ok) { m.className = "ok"; m.textContent = j.changed ? "SAVED · 已留版本与理由" : "NO CHANGE"; $("#p-because").value = ""; }
  else { m.className = "err"; m.textContent = j.error || "FAILED"; }
};

// ── 卷宗（右栏）：Plan / Changes / Context ───────────────────────────
// 数据来自 /api/dossier（只读）。它不猜、不跑命令：
//   Plan   = 她惦记的事（agenda.json）+ 没闭合的线（memories 里的 thread）
//   Changes= 我们自己的账本 exec_audit 里**真的动过东西**的那几条（写入/执行）
//   Context= 记忆/文档/分块/今天用量 —— 都是系统量，不是装饰数字
var DOSSIER = null;
// 生成代码里禁反斜杠转义（TS 模板字符串会吃掉一层）：JS 字符串只用单引号，HTML 属性只用双引号
function dline(k, v, t) {
  return '<div class="dline"><span class="k">' + escapeHtml(k) + '</span>' +
    '<span class="t" title="' + escapeHtml(t || v) + '">' + escapeHtml(v) + '</span></div>';
}
// 「等你点头」那张卡：五块各自有 loader 在维护 DOM，这里只负责
//   · 数一数有几条（卡片标题上的数字）
//   · 全空时显示「没有等你点头的事」
// 坑（踩过）：回调里改 #dc-inbox-empty 的 hidden，而观察器正盯着 #dc-inbox 的 attributes
// → 自己触发自己，微任务无限循环，整页卡死。所以**值没变就不写**，并且用 rAF 合并。
var inboxRaf = 0;
function paintInbox() {
  var box = document.getElementById('dc-inbox');
  if (!box) return;
  var n = 0;
  ['pendsec', 'propsec', 'egrsec', 'rcpsec', 'threadsec'].forEach(function (id) {
    var sec = document.getElementById(id);
    if (!sec || sec.hidden) return;
    n += sec.querySelectorAll('.pend, .item, .card').length;
  });
  var badge = document.getElementById('dc-inbox-n');
  if (badge) {
    var txt = n ? n + ' 条' : '';
    if (badge.textContent !== txt) badge.textContent = txt;
  }
  var empty = document.getElementById('dc-inbox-empty');
  if (empty) {
    var hide = n > 0;
    if (empty.hidden !== hide) empty.hidden = hide;   // 值不变不写 → 不会自触发
  }
}
function paintInboxSoon() {
  if (inboxRaf) return;
  inboxRaf = requestAnimationFrame(function () { inboxRaf = 0; paintInbox(); });
}
function watchInbox() {
  var box = document.getElementById('dc-inbox');
  if (!box || !window.MutationObserver) return;
  new MutationObserver(paintInboxSoon).observe(box, { childList: true, subtree: true });
  paintInbox();
}
watchInbox();
function renderDossier() {
  var d = DOSSIER; if (!d) return;
  var ag = d.plan.agenda || [], th = d.plan.threads || [];
  var n = ag.length + th.length;
  document.getElementById('dc-plan-n').textContent = n ? n + ' 条' : '';
  var ph = '';
  for (var i = 0; i < ag.length; i++) ph += dline(ag[i].k, ag[i].t, ag[i].from);
  for (var j = 0; j < th.length; j++) {
    ph += dline(th[j].aging ? '拖了 ' + th[j].d + ' 天' : th[j].d + ' 天', th[j].t, '#' + th[j].id);
  }
  document.getElementById('dc-plan').innerHTML = ph || '<p class="dempty">手上没有未了的事。</p>';
  var ch = d.changes || [];
  document.getElementById('dc-chg-n').textContent = ch.length ? ch.length + ' 条' : '';
  var chh = '';
  for (var k2 = 0; k2 < ch.length; k2++) {
    var r = ch[k2], a = r.argv || '';
    try { var o = JSON.parse(a); if (o && o.argv) a = o.argv.join(' '); else if (o && o.path) a = o.path; } catch (e) { /* 不是 JSON 就原样 */ }
    chh += '<div class="dline"><span class="k">' + (r.ok ? '✓' : '✗') + ' ' + escapeHtml(r.verb) +
      '</span><span class="t" title="' + escapeHtml(a) + '">' + escapeHtml(a) + '</span></div>';
  }
  document.getElementById('dc-chg').innerHTML = chh || '<p class="dempty">这一轮还没动过东西。她动手时（含被拒的）都会记在这里。</p>';
  var c = d.context || {};
  document.getElementById('dc-ctx-n').textContent = c.model ? String(c.model).split('/').pop() : '';
  var ctxh = '';
  ctxh += dline('记忆', (c.memories || 0) + ' 条', 'status=active');
  var stages = (c.stages || []).map(function (x) { return x.stage + ' ' + x.c; }).join(' · ');
  if (stages) ctxh += dline('分层', stages, '');
  ctxh += dline('文档', (c.docs || 0) + ' 篇 / ' + (c.chunks || 0) + ' 块', '');
  ctxh += dline('模型', c.model || '未配置', '');
  ctxh += dline('今天用量', (c.todayTokens || 0) + ' tok · $' + Number(c.todayUsd || 0).toFixed(4), '');
  var pl = c.plugins || {};
  ctxh += dline('能借的手脚', '插件 ' + (pl.servers || 0) + ' · 工具 ' + (c.tools || 0) + ' · 技能 ' + (c.skills || 0), 'MCP / verbs / SKILL.md');
  document.getElementById('dc-ctx-stats').innerHTML = ctxh;
}
async function loadDossier() {
  try {
    DOSSIER = await (await fetch('/api/dossier')).json();
    renderDossier();
  } catch (e) { /* 拿不到就保持原样，不弹错 */ }
}
for (const b of document.querySelectorAll('#folio .dtab')) {
  b.onclick = function () { b.parentElement.classList.toggle('closed'); };
}
var folioTog = document.getElementById('folioTog');
if (folioTog) folioTog.onclick = function () { document.body.classList.toggle('folio-open'); };
var ws = document.getElementById('wspath');
if (ws) ws.textContent = 'data/ · persona/ · workspace/';
loadDossier();
setInterval(loadDossier, 20000);

// ── 边栏收纳：收起来是「收」，不是「删」────────────────────────────
// 状态存在 localStorage：这是**这台机器的视觉偏好**，不该进 data/config.json
// （那是会跟着搬家走的东西；换台机器屏幕宽度不同，不该跟着搬）。
function applyLayout() {
  // 窄屏不套用这两个偏好：那里它们由抽屉管
  var narrow = innerWidth <= 1180;
  var wing = !narrow && localStorage.getItem('jj.wing') === 'off';
  var folio = !narrow && localStorage.getItem('jj.folio') === 'off';
  document.body.classList.toggle('wing-off', wing);
  document.body.classList.toggle('folio-off', folio);
  var h = document.getElementById('wingHandle');
  if (h) h.hidden = !wing;
}
function toggleWing(on) {
  var off = (typeof on === 'boolean') ? !on : !document.body.classList.contains('wing-off');
  localStorage.setItem('jj.wing', off ? 'off' : 'on');
  applyLayout();
// 文件面板 / git 校样的事件（只读）
(function () {
  var fq = document.getElementById('fq');
  if (fq) fq.oninput = function () { paintTree(); };
  var froot = document.getElementById('froot');
  if (froot) froot.onclick = function () { loadTree(''); };
  var flist = document.getElementById('flist');
  if (flist) flist.onclick = function (e) {
    var b = e.target.closest('[data-fpath]');
    if (!b) return;
    if (b.dataset.ftype === 'dir') loadTree(b.dataset.fpath);
    else openFile(b.dataset.fpath);
  };
  var fclose = document.getElementById('fclose');
  if (fclose) fclose.onclick = function () { document.getElementById('fview').hidden = true; };
  var gs = document.getElementById('gs'), gst = document.getElementById('gst'), gl = document.getElementById('gl');
  if (gs) gs.onclick = function () { loadGit('status'); };
  if (gst) gst.onclick = function () { loadGit('diff'); };
  if (gl) gl.onclick = function () { loadGit('log'); };
  var gfiles = document.getElementById('gfiles');
  if (gfiles) gfiles.onclick = function (e) {
    var b = e.target.closest('[data-gpath]');
    if (b) loadGit('diff', b.dataset.gpath);
  };
})();
}
function toggleFolio(on) {
  var off = (typeof on === 'boolean') ? !on : !document.body.classList.contains('folio-off');
  localStorage.setItem('jj.folio', off ? 'off' : 'on');
  applyLayout();
}
applyLayout();
var wingHandle = document.getElementById('wingHandle');
if (wingHandle) wingHandle.onclick = function () { toggleWing(true); };
// ── 卷宗的开/关（唯一入口）──────────────────────────────────────
// 两套状态不能混：窄屏是**抽屉**（folio-open，只在内存里），宽屏是**收纳**（folio-off，记 localStorage）。
// 之前 » 在手机上也去写 folio-off，于是抽屉一关，◧ 再也打不开（folio-off 压着 display:none）。
var NARROW = function () { return innerWidth <= 1180; };
function folioIsOpen() {
  return NARROW() ? document.body.classList.contains('folio-open')
                  : !document.body.classList.contains('folio-off');
}
function setFolioOpen(open) {
  if (NARROW()) {
    document.body.classList.toggle('folio-open', open);
    document.body.classList.remove('folio-off');   // 窄屏不认宽屏留下的收纳状态
    return;
  }
  toggleFolio(open);
}
var folioX = document.getElementById('folioX');
if (folioX) folioX.onclick = function () { setFolioOpen(false); };
var folioTog2 = document.getElementById('folioTog');
if (folioTog2) folioTog2.onclick = function () { setFolioOpen(!folioIsOpen()); };
// 左栏的 «：窄屏只是关抽屉，别把「收起」记成偏好
var wingTog2 = document.getElementById('wingTog');
if (wingTog2) wingTog2.onclick = function () {
  if (NARROW()) { document.getElementById('side').classList.remove('open'); return; }
  toggleWing(false);
};
// 窗口跨过 1180：把另一种模式的状态清干净（窄屏拖宽不该带着 folio-open）
addEventListener('resize', function () {
  if (NARROW()) document.body.classList.remove('wing-off', 'folio-off');
  else document.body.classList.remove('folio-open');
  applyLayout();
});
document.addEventListener('keydown', function (e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  var k = (e.key || '').toLowerCase();
  if (k === 'b') { e.preventDefault(); toggleWing(); }
  else if (k === 'j') { e.preventDefault(); toggleFolio(); }
});

$("#composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#m").value.trim(); if (!text) return;
  // 斜杠命令先过一道：/permission 之类的本地动作不该被当成聊天发出去
  if (await handleSlash(text)) { $("#m").value = ""; fitComposer(); return; }
  if (inflight) return;                       // 上一轮还没完就别叠
  $("#m").value = ""; fitComposer();
  const el = $("#chat");
  el.insertAdjacentHTML("beforeend", rowHtml({ role: "user", ts: new Date().toISOString(), text }));
  const id = "live-" + Date.now();
  el.insertAdjacentHTML("beforeend",
    "<div class='row agent' id='" + id + "'><div class='av'>" + avHtml(false) + "</div><div>" +
    "<div class='meta'>处理中…</div><div class='recall'></div><div class='body md'><span class='cursor'></span></div></div></div>");
  const box = document.querySelector("#" + id + " .md");
  const meta = document.querySelector("#" + id + " .meta");
  const recallBox = document.querySelector("#" + id + " .recall");
  let acc = "", cites = [], omitted = 0, omittedDocs = 0;
  inflight = new AbortController();
  setStreaming(true);
  try {
    const res = await fetch("/api/say", {
      method: "POST", headers: H, body: JSON.stringify({ text }), signal: inflight.signal,
    });
    if (!res.ok) {
      const j = await res.json();
      box.innerHTML = "<span class='sys'>E: " + escapeHtml(j.error || res.status) + "</span>" +
        " <button class='resend' data-retry='" + escapeHtml(text) + "'>重试</button>";
      return;
    }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const r = await reader.read(); if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const frames = buf.split(NL2); buf = frames.pop() || "";
      for (const f of frames) {
        const mm = f.match(/^data: (.*)$/m); if (!mm) continue;
        const d = JSON.parse(mm[1]);
        if (d.type === "brief") {
          // 证据链（P0 #1）：这一轮它到底调了哪几条记忆/文档
          cites = d.cites || []; omitted = d.omitted || 0; omittedDocs = d.omittedDocs || 0;
          recallBox.innerHTML = recallHtml(cites, omitted, omittedDocs);
          // 「这次到底是本地还是云端在说话」：写在气泡的 meta 里，不靠猜
          if (d.responder) {
            var who = d.responder;
            meta.innerHTML = "<span class='who " + (who.kind === "local" ? "local" : "cloud") + "'>" +
              escapeHtml(who.label) + "</span>";
          }
        }
        if (d.type === "unavailable") {
          meta.textContent = "不可用";
          box.innerHTML = "<span class='err'>" + escapeHtml(d.message || "对话不可用") + "</span>";
          continue;
        }
        if (d.type === "notice") {
          recallBox.insertAdjacentHTML("beforeend", "<span class='notice'>" + escapeHtml(d.text) + "</span>");
        }
        if (d.type === "delta") { acc += d.text; box.innerHTML = escapeHtml(acc) + "<span class='cursor'></span>"; }
        if (d.type === "tool") {
          meta.textContent = "调用 " + d.name;
          box.insertAdjacentHTML("beforeend",
            "<details class='tool'><summary><span class='tn'>" + escapeHtml(d.name) + "</span>" +
            "<span class='tms'>运行中…</span></summary><pre class='targs'>" + escapeHtml(d.args || "") + "</pre></details>");
        }
        if (d.type === "tool_result") {
          const cards = box.querySelectorAll("details.tool");
          const last = cards[cards.length - 1];
          if (last) { last.querySelector(".tms").textContent = d.ms + "ms";
            last.insertAdjacentHTML("beforeend", "<pre class='tres'>" + escapeHtml(d.result) + "</pre>"); }
        }
        if (d.type === "error") {
          box.insertAdjacentHTML("beforeend", "<div class='sys'>E: " + escapeHtml(d.message) + "</div>");
        }
        if (d.type === "done") { meta.textContent = clock(new Date().toISOString()); }
      }
      if (follow) scrollBottom();
else { const n = Number($("#jumpn").textContent || 0) + 1; $("#jumpn").textContent = String(n); $("#jump").classList.add("on"); }
    }
  } catch (err) {
    const aborted = err && (err.name === "AbortError");
    box.insertAdjacentHTML("beforeend",
      "<div class='sys'>" + (aborted ? "已停止" : "网络错误：" + escapeHtml(err.message || err)) + "</div>" +
      (aborted ? "" : " <button class='resend' data-retry='" + escapeHtml(text) + "'>重试</button>"));
  } finally {
    inflight = null;
    setStreaming(false);
    const meta2 = document.querySelector("#" + id + " .meta");
    if (meta2 && meta2.textContent === "处理中…") meta2.textContent = clock(new Date().toISOString()) + (acc ? "" : " · 无内容");
  }
  await timeline(); await state(); await memories(); await pending(); await audit();
};
// PWA：注册离线壳。注册失败不能影响面板本身（手机上走 http 时浏览器会直接拒绝）
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("/sw.js").catch(function () { /* 忽略：离线壳是增强，不是前提 */ });
}
// 手机上侧栏是抽屉：没有这个按钮，SESSIONS/DOCS/MEMORY/TOOLS/CONFIG 全都不可达
$("#menu").onclick = (e) => { e.stopPropagation(); $("#side").classList.toggle("open"); };
loadAvatars(); applySections(); state(); timeline(); sessions(); tools(); memories(); docs(); audit(); readout(); loadConfig(); loadUi(); pending(); usage(); loadProposals(); loadSurfaceReview(); loadThreads(); loadReceipts(); loadStanding(); loadEgress(); loadSetup(false);
setInterval(() => { state(); pending(); audit(); readout(); loadEgress(); }, 20000);
