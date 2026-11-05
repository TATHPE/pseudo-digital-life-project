/**
 * 第二条壳：工作记录本（2026-11-05）
 *
 * 为什么是**第二条**而不是改 page.ts：用户要保留旧面板、随时能退回去。
 *   /            经典面板（page.ts，一行没动）
 *   /notebook    记录本（这个文件）
 * 两套都走同一份数据、同一批 /api；回退 = 换个 URL，不改代码。
 *
 * 结构来自三个方向的原型，但只有一个是骨架：
 *   · 骨架 = 工作记录本：按天的目录 / 页边时间戳 / 长回复折叠 / 证据条
 *   · 借一块 = 标本柜的「她收着的」页：一张纸一件事，褪色可见，「要你点头」钉在第一张
 *   · 借一块 = 手册的醋酸片：过程是盖在正文上的半透明页，掀起来才看
 *
 * 约束不变：零构建、单文件内联、无外部字体/图床、黑底白线、青色只给她的回话。
 */
export const NOTEBOOK = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>鲸鲸 · 记录本</title>
<style>
:root{
  --void:#0b0e0b;--ink:#e9f0f2;--dim:#9fb0b3;--dim2:#66757a;
  --line:rgba(233,240,242,.30);--line-dim:rgba(233,240,242,.10);
  --cyan:#0f97a4;--amber:#c9a227;--fade:#8a9698;
  --mono:ui-monospace,"Cascadia Mono",Consolas,monospace;
  --sans:"Noto Sans SC","Source Han Sans SC","Microsoft YaHei",system-ui,sans-serif;
  --measure:660px;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--void);color:var(--ink);font:15px/1.85 var(--sans);-webkit-font-smoothing:antialiased}
.nb{height:100vh;display:grid;grid-template-rows:34px minmax(0,1fr)}
.nb-top{display:flex;align-items:center;gap:16px;padding:0 14px;border-bottom:1px solid var(--line-dim);
  font:11px/1 var(--mono);color:var(--dim);letter-spacing:.04em;white-space:nowrap;overflow:hidden}
.nb-top b{color:var(--ink);font-weight:600}
.nb-top .sp{flex:1}
.nb-dot{width:5px;height:5px;background:var(--cyan);border-radius:50%;display:inline-block;margin-right:7px;vertical-align:1px}
.nb-main{display:grid;grid-template-columns:196px minmax(0,1fr) auto;min-height:0}

.nb-index{border-right:1px solid var(--line-dim);display:flex;flex-direction:column;min-height:0;padding:14px 0 8px;overflow:auto}
.nb-index h2{font:10px/1 var(--mono);letter-spacing:.18em;color:var(--dim2);margin:0 0 10px 16px;font-weight:400}
.nb-day{display:grid;grid-template-columns:18px 1fr;gap:8px;padding:7px 14px;cursor:pointer;border-left:2px solid transparent}
.nb-day:hover{background:rgba(233,240,242,.03)}
.nb-day.on{border-left-color:var(--ink);background:rgba(233,240,242,.04)}
.nb-day .mk{width:7px;height:7px;border:1px solid var(--line);margin-top:9px}
.nb-day.on .mk{background:var(--ink);border-color:var(--ink)}
.nb-day .d{display:block;font:12px/1.5 var(--sans)}
.nb-day .m{display:block;font:10px/1.6 var(--mono);color:var(--dim2)}
.nb-grow{flex:1;min-height:16px}
.nb-go{display:flex;justify-content:space-between;gap:8px;padding:6px 14px;font:11px/1.9 var(--mono);
  color:var(--dim);cursor:pointer;border-top:1px solid var(--line-dim)}
.nb-go:hover{color:var(--ink)}
.nb-go.cur{color:var(--ink);background:rgba(233,240,242,.04)}
.nb-go .n{color:var(--dim2)}
.nb-go.warn .n{color:var(--amber)}

.nb-page{min-width:0;overflow:auto;padding:0 0 110px;scroll-behavior:auto}
.nb-sheet{max-width:calc(var(--measure) + 76px);margin:0 auto;padding:24px 24px 0 8px}
.nb-e{display:grid;grid-template-columns:64px 1fr;gap:0 12px;position:relative;padding:16px 0 20px;border-top:1px solid var(--line-dim)}
.nb-e:first-child{border-top:0}
.nb-e .g{text-align:right;font:10px/1.7 var(--mono);color:var(--dim2);padding-top:5px}
.nb-e .g .w{display:block;color:var(--dim);letter-spacing:.06em}
.nb-e.me .g .w{color:var(--amber)}
.nb-e .b{min-width:0}
.nb-say{border-left:2px solid var(--cyan);padding:2px 0 2px 14px}
.nb-e.me .nb-say{border-left-color:var(--amber)}
.nb-say p{margin:0 0 .8em}
.nb-say p:last-child{margin-bottom:0}
.nb-say ul,.nb-say ol{margin:.2em 0 .9em;padding-left:1.15em}
.nb-say li{margin:.3em 0}
.nb-say code{font:12.5px/1.7 var(--mono);background:rgba(233,240,242,.06);padding:1px 5px}
.nb-say pre{background:rgba(233,240,242,.05);border:1px solid var(--line-dim);padding:10px;overflow:auto;
  font:12px/1.7 var(--mono);margin:.6em 0}
.nb-say h1,.nb-say h2,.nb-say h3{font-size:15px;margin:.9em 0 .4em;letter-spacing:.02em}
.nb-fold{position:relative;max-height:10.8em;overflow:hidden}
.nb-fold:after{content:"";position:absolute;left:0;right:0;bottom:0;height:3em;
  background:linear-gradient(to bottom,rgba(11,14,11,0),var(--void))}
.nb-fold.open{max-height:none}.nb-fold.open:after{display:none}
.nb-more{margin-top:6px;font:11px/1 var(--mono);color:var(--dim);background:none;border:0;
  border-bottom:1px dashed var(--line);padding:0 0 3px;cursor:pointer;letter-spacing:.04em}
.nb-more:hover{color:var(--ink);border-bottom-color:var(--ink)}
.nb-ev{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.nb-ev span{font:10px/1 var(--mono);color:var(--dim);border:1px solid var(--line-dim);
  padding:5px 7px;background:rgba(233,240,242,.02)}
.nb-daymark{display:flex;align-items:center;gap:10px;margin:6px 0 4px;font:10px/1 var(--mono);
  letter-spacing:.14em;color:var(--dim2)}
.nb-daymark:after{content:"";flex:1;height:1px;background:var(--line-dim)}

/* 标本页：她收着的 */
.nb-board{max-width:1240px;margin:0 auto;padding:20px 22px 40px}
.nb-board h1{font:10px/1 var(--mono);letter-spacing:.2em;color:var(--dim2);margin:0 0 14px;font-weight:400}
.nb-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.nb-spec{position:relative;border:1px solid var(--line-dim);padding:13px 13px 38px;min-height:132px;}
.nb-spec:hover{border-color:var(--line);background:rgba(233,240,242,.03)}
.nb-spec .k{font:9px/1 var(--mono);letter-spacing:.16em;color:var(--dim2);margin-bottom:8px}
.nb-spec .v{font-size:14px;line-height:1.7;word-break:break-word}
.nb-spec .lab{position:absolute;left:13px;right:13px;bottom:9px;display:flex;justify-content:space-between;
  gap:8px;font:9px/1.4 var(--mono);color:var(--dim2);border-top:1px solid var(--line-dim);padding-top:6px}
.nb-spec.fade .v{color:var(--fade)}
.nb-spec.wait{border-color:var(--amber)}
.nb-spec.wait .k{color:var(--amber)}
.nb-spec.wait .act{display:flex;gap:6px;margin-top:6px}
.nb-spec.wait .act button{font:10px/1 var(--mono);background:none;color:var(--ink);border:1px solid var(--line);
  padding:6px 8px;cursor:pointer}
.nb-spec.wait .act button:hover{background:var(--ink);color:var(--void)}

/* 切口索引 */
.nb-tabs{display:flex;border-left:1px solid var(--line-dim)}
.nb-rail{width:52px;display:flex;flex-direction:column;gap:2px;padding-top:12px}
.nb-tab{font:11px/1 var(--mono);letter-spacing:.1em;color:var(--dim2);padding:11px 0;cursor:pointer;
  text-align:center;border:0;background:none;border-left:2px solid transparent}
.nb-tab:hover{color:var(--dim);background:rgba(233,240,242,.03)}
.nb-tab.on{color:var(--void);background:var(--ink);border-left-color:var(--ink)}
.nb-tab.wait{color:var(--amber)}
.nb-tab.wait.on{color:var(--void);background:var(--amber);border-left-color:var(--amber)}
.nb-tab .c{display:block;margin-top:5px;font-size:9px}
.nb-panel{width:280px;padding:14px 14px 40px;overflow:auto;border-left:1px solid var(--line-dim)}
.nb-panel[hidden]{display:none}
.nb-panel h3{font:10px/1 var(--mono);letter-spacing:.16em;color:var(--dim2);margin:0 0 12px;font-weight:400}
.nb-card{border:1px solid var(--line-dim);padding:10px 11px;margin-bottom:9px}
.nb-card .t{font-size:13px;line-height:1.6}
.nb-card .s{font:10px/1.6 var(--mono);color:var(--dim2);margin-top:5px}
.nb-card button{font:10px/1 var(--mono);background:none;color:var(--ink);border:1px solid var(--line);
  padding:6px 8px;margin-top:8px;cursor:pointer}
.nb-card button:hover{background:var(--ink);color:var(--void)}
.nb-au{font:10.5px/1.9 var(--mono);color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nb-au i{font-style:normal;color:var(--dim2)}
.nb-empty{font:11px/1.8 var(--mono);color:var(--dim2)}

/* 输入 */
.nb-composer{position:fixed;left:196px;right:52px;bottom:0;padding:0 24px 14px;
  background:linear-gradient(to bottom,rgba(11,14,11,0),var(--void) 30%)}
.nb-cin{max-width:calc(var(--measure) + 76px);margin:0 auto;border-top:1px solid var(--line);
  padding:9px 24px 0 76px;display:flex;align-items:flex-end;gap:10px}
.nb-cin .cr{color:var(--cyan);font:12px/1 var(--mono);padding-bottom:7px}
.nb-cin textarea{flex:1;min-height:24px;max-height:160px;resize:none;background:none;border:0;
  color:var(--ink);font:15px/1.7 var(--sans);outline:none;padding:3px 0}
.nb-cin textarea::placeholder{color:var(--dim2)}
.nb-cin .h{font:10px/1 var(--mono);color:var(--dim2);padding-bottom:8px;white-space:nowrap}
.nb-cin .sd{font:10px/1 var(--mono);letter-spacing:.1em;color:var(--ink);background:none;
  border:1px solid var(--line);padding:7px 10px;cursor:pointer;margin-bottom:3px}
.nb-cin .sd:hover{background:var(--ink);color:var(--void)}
.nb-tick{position:fixed;left:196px;right:52px;bottom:64px;padding:0 24px;pointer-events:none}
.nb-tick div{max-width:calc(var(--measure) + 76px);margin:0 auto;font:10px/1.4 var(--mono);color:var(--dim2);
  padding-left:76px;text-align:right}

/* 醋酸片：过程盖在正文上 */
.nb-leaf{position:fixed;right:64px;bottom:78px;width:360px;max-height:56vh;overflow:auto;z-index:5;
  background:linear-gradient(180deg,rgba(233,240,242,.10),rgba(233,240,242,.04)),rgba(10,13,12,.92);
  backdrop-filter:blur(3px) saturate(.6);border:1px solid rgba(233,240,242,.22);
  box-shadow:-1px 0 0 rgba(233,240,242,.12);padding:18px 12px 12px}
.nb-leaf[hidden]{display:none}
.nb-leaf .holes{position:absolute;left:8px;top:8px;display:flex;gap:5px}
.nb-leaf .holes i{width:4px;height:4px;border:1px solid rgba(233,240,242,.35);border-radius:50%}
.nb-leaf h4{font:9px/1 var(--mono);letter-spacing:.16em;color:var(--dim);margin:0 0 9px;font-weight:400}
.nb-leaf .ln{font:11px/1.8 var(--mono);color:var(--ink);word-break:break-word}
.nb-leaf .ln b{color:var(--dim2);font-weight:400}
.nb-leaf .x{position:absolute;right:6px;top:6px;font:9px/1 var(--mono);color:var(--dim);background:none;
  border:1px solid var(--line-dim);padding:4px 6px;cursor:pointer}
</style></head>
<body>
<div class="nb">
  <div class="nb-top">
    <span><i class="nb-dot"></i><b id="nb-line">醒着</b></span>
    <span id="nb-counts"></span>
    <span class="sp"></span>
    <span id="nb-usd">今天 $0.000</span><span id="nb-model">—</span>
    <span><a href="/classic" style="color:inherit;text-decoration:underline">完整面板</a></span>
  </div>

  <div class="nb-main">
    <nav class="nb-index">
      <h2>记录</h2>
      <div id="nb-days"></div>
      <div class="nb-grow"></div>
      <div class="nb-go" id="nb-board-btn">她收着的<span class="n" id="nb-about">…</span></div>
      <div class="nb-go" id="nb-gap">还缺<span class="n" id="nb-gapn">…</span></div>
    </nav>

    <main class="nb-page" id="nb-page">
      <div id="nb-board" hidden></div>
      <div class="nb-sheet" id="nb-log"></div>
    </main>

    <aside class="nb-tabs">
      <div class="nb-rail">
        <button class="nb-tab" data-t="0" id="nb-t0">0<span class="c" id="nb-c0">0</span></button>
        <button class="nb-tab" data-t="1" id="nb-t1">I<span class="c" id="nb-c1">0</span></button>
        <button class="nb-tab" data-t="2" id="nb-t2">II<span class="c" id="nb-c2">0</span></button>
        <button class="nb-tab" data-t="3" id="nb-t3">III<span class="c" id="nb-c3">0</span></button>
      </div>
      <div class="nb-panel" id="nb-panel" hidden></div>
    </aside>
  </div>
</div>

<div class="nb-tick"><div id="nb-tickmsg"></div></div>
<div class="nb-composer">
  <div class="nb-cin">
    <span class="cr">›</span>
    <textarea id="nb-say" rows="1" placeholder="说点什么"></textarea>
    <span class="h">Enter 发送 · Shift+Enter 换行</span>
    <button class="sd" id="nb-send">发送</button>
  </div>
</div>
<div class="nb-leaf" id="nb-leaf" hidden>
  <div class="holes"><i></i><i></i></div>
  <button class="x" id="nb-leafx">×</button>
  <h4>过程 · 掀起来的这一页</h4>
  <div id="nb-leaflines"></div>
</div>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var H = { 'content-type':'application/json', 'x-jj':'1' };
  var TL = [], BOARD = false, CUR = 0, TAB = -1, BUSY = false;

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  function tick(msg){
    $('nb-tickmsg').textContent = msg || '';
    if (!msg) return;
    setTimeout(function(){ if ($('nb-tickmsg').textContent === msg) $('nb-tickmsg').textContent = ''; }, 5000);
  }
  function hhmm(ts){
    try {
      var d = new Date(ts);
      var p = function(n){ return String(n).padStart(2,'0'); };
      return p(d.getHours()) + ':' + p(d.getMinutes());
    } catch(e){ return ''; }
  }

  // ── 顶栏与左栏 ────────────────────────────────
  function loadState(){
    fetch('/api/state').then(function(r){ return r.json(); }).then(function(j){
      if (j && j.line) $('nb-line').textContent = j.line;
    }).catch(function(){});
    fetch('/api/memories/summary').then(function(r){ return r.json(); }).then(function(j){
      $('nb-about').textContent = j.about == null ? '…' : j.about;
      $('nb-counts').textContent = '关于你 ' + (j.about||0) + ' 条' +
        (j.about7d ? ' · 本周 +' + j.about7d : '') + ' · 断片 ' + (j.outage||0);
    }).catch(function(){});
    fetch('/api/profile/gaps').then(function(r){ return r.json(); }).then(function(j){
      var g = (j && j.gaps) || [];
      $('nb-gapn').textContent = g.length ? (g.length + ' 件') : '齐了';
      $('nb-gap').className = 'nb-go' + (g.length ? ' warn' : '');
    }).catch(function(){});
  }

  function loadTimeline(){
    return fetch('/api/timeline').then(function(r){ return r.json(); }).then(function(blocks){
      TL = blocks || [];
      renderDays();
      renderLog();
    }).catch(function(){});
  }

  function renderDays(){
    var days = TL.filter(function(b){ return b.type === 'day'; });
    var html = '';
    var today = new Date();
    var p = function(n){ return String(n).padStart(2,'0'); };
    var todayLabel = today.getFullYear() + '-' + p(today.getMonth()+1) + '-' + p(today.getDate());
    html += '<div class="nb-day on" data-jump="' + todayLabel + '"><span class="mk"></span>' +
      '<span><span class="d">今天</span><span class="m">' + hhmm(today.toISOString()) + '</span></span></div>';
    days.slice(-8).reverse().forEach(function(d){
      var gap = d.gapMs ? ('距上次 ' + Math.round(d.gapMs/3600000) + ' 小时') : '';
      html += '<div class="nb-day" data-jump="' + esc(d.label) + '">' +
        '<span class="mk"></span><span><span class="d">' + esc(d.label) + '</span>' +
        '<span class="m">' + esc(gap) + '</span></span></div>';
    });
    $('nb-days').innerHTML = html;
    Array.prototype.forEach.call($('nb-days').querySelectorAll('.nb-day'), function(el){
      el.onclick = function(){
        Board(false);
        Array.prototype.forEach.call($('nb-days').querySelectorAll('.nb-day'), function(x){ x.classList.remove('on'); });
        el.classList.add('on');
        var lab = el.getAttribute('data-jump');
        var marks = $('nb-log').querySelectorAll('.nb-daymark');
        for (var i = 0; i < marks.length; i++) {
          if ((marks[i].textContent || '').indexOf(lab) >= 0) { marks[i].scrollIntoView({ block:'start' }); return; }
        }
        $('nb-page').scrollTop = 0;
      };
    });
  }

  function evChips(b){
    var out = [];
    var tn = (b.tools || []).length;
    if (tn) out.push('工具 ' + tn + ' 次');
    if (b.cites && b.cites.length) out.push('引用 ' + b.cites.length + ' 条');
    if (b.omitted) out.push(b.omitted + ' 条本地记忆未发送');
    return out;
  }

  function renderLog(){
    var html = '', n = 0;
    TL.forEach(function(b){
      if (b.type === 'day') { html += '<div class="nb-daymark">' + esc(b.label) + '</div>'; return; }
      if (b.type !== 'msg') return;
      n++;
      var mine = b.role === 'user';
      var body = b.html || esc(b.text).split(String.fromCharCode(10)).join('<br>');
      var long = String(b.text || '').length > 420;
      var id = 'f' + (CUR++);
      html += '<article class="nb-e ' + (mine ? 'me' : 'her') + '">' +
        '<div class="g">' + hhmm(b.ts) + '<span class="w">' + (mine ? '你' : '她') + '</span></div>' +
        '<div class="b"><div class="nb-say"><div class="' + (long ? 'nb-fold' : '') + '" id="' + id + '">' +
        body + '</div></div>' +
        (evChips(b).length ? '<div class="nb-ev">' + evChips(b).map(function(t){ return '<span>' + esc(t) + '</span>'; }).join('') + '</div>' : '') +
        '</div></article>';
      if (long) {
        var holder = document.createElement('div');
        holder.innerHTML = html; html = '';
        var fold = holder.querySelector('#' + id);
        var btn = document.createElement('button');
        btn.className = 'nb-more';
        btn.textContent = '展开全文 · 还有 ' + Math.max(1, Math.round((String(b.text).length - 300) / 60)) + ' 行';
        btn.onclick = function(){ fold.classList.add('open'); btn.remove(); };
        fold.parentNode.parentNode.appendChild(btn);
        html = holder.innerHTML;
      }
    });
    $('nb-log').innerHTML = html;
    if (!n) $('nb-log').innerHTML = '<div class="nb-empty">还没有任何记录。说一句试试。</div>';
    // 折叠按钮（innerHTML 之后重新绑）
    Array.prototype.forEach.call($('nb-log').querySelectorAll('.nb-more'), function(btn){
      btn.onclick = function(){
        var prev = btn.previousElementSibling;
        var fold = prev ? prev.querySelector('.nb-fold') : null;
        if (fold) fold.classList.add('open');
        btn.remove();
      };
    });
    requestAnimationFrame(function(){ $('nb-page').scrollTop = $('nb-page').scrollHeight; });
  }

  // ── 她收着的（标本页）─────────────────────────
  function Board(on){
    BOARD = !!on;
    $('nb-board').hidden = !on;
    $('nb-log').hidden = !!on;
    $('nb-board-btn').className = 'nb-go' + (on ? ' cur' : '');
    if (on) loadBoard();
  }
  function loadBoard(){
    var el = $('nb-board');
    el.innerHTML = '<div class="nb-board"><h1>她收着的 · 关于你</h1><div class="nb-grid" id="nb-grid">' +
      '<div class="nb-empty">读取中…</div></div></div>';
    Promise.all([
      fetch('/api/proposals?status=open').then(function(r){ return r.json(); }).catch(function(){ return []; }),
      fetch('/api/memories?scope=about&limit=18').then(function(r){ return r.json(); }).catch(function(){ return []; }),
    ]).then(function(res){
      var props = Array.isArray(res[0]) ? res[0] : [];
      var mems = Array.isArray(res[1]) ? res[1] : [];
      var html = '';
      props.slice(0, 3).forEach(function(p){
        html += '<div class="nb-spec wait"><div class="k">要你点头</div>' +
          '<div class="v">' + esc(p.title || p.text || '') + '</div>' +
          '<div class="act"><button data-ok="' + esc(p.id) + '">同意</button>' +
          '<button data-no="' + esc(p.id) + '">不用</button></div>' +
          '<div class="lab"><span>她提的 · ' + esc(String(p.createdAt || '').slice(5,16).replace('T',' ')) + '</span><span>等你</span></div></div>';
      });
      var KIND = { boundary:'边界', promise:'承诺', fact_hard:'事实', fact:'事实',
        preference_hard:'偏好', preference_soft:'偏好', episode:'经历', thought:'想法',
        reading:'读来的', anchor:'锚点', contract:'契约', gist:'梗概' };
      mems.forEach(function(m){
        var w = Number(m.weight || 0);
        var fade = w < 0.35 ? ' fade' : '';
        html += '<div class="nb-spec' + fade + '"><div class="k">' + esc(KIND[m.kind] || m.kind || '记忆') + '</div>' +
          '<div class="v">' + esc(m.text) + '</div>' +
          '<div class="lab"><span>#' + esc(m.id) + '</span>' +
          '<span>' + (w >= 0.999 ? '契约 · 不衰减' : '鲜度 ' + w.toFixed(2)) + '</span></div></div>';
      });
      if (!props.length) html = '<div class="nb-empty" style="grid-column:1/-1;border:1px dashed var(--line-dim);padding:10px">' +
        '现在没有等你点头的事。</div>' + html;
      if (!mems.length && !props.length) html += '<div class="nb-empty" style="grid-column:1/-1">' +
        '还没有关于你的事。对她说一句「记住：…」。</div>';
      $('nb-grid').innerHTML = html;
      Array.prototype.forEach.call($('nb-grid').querySelectorAll('button[data-ok], button[data-no]'), function(b){
        b.onclick = function(){
          var ok = b.hasAttribute('data-ok');
          var id = ok ? b.getAttribute('data-ok') : b.getAttribute('data-no');
          fetch('/api/proposals/' + encodeURIComponent(id), {
            method:'POST', headers:H, body: JSON.stringify({ action: ok ? 'accept' : 'reject' })
          }).then(function(){ tick(ok ? '已同意' : '已拒绝'); loadBoard(); loadState(); }).catch(function(){});
        };
      });
    });
  }
  $('nb-board-btn').onclick = function(){ Board(!BOARD); if (!BOARD) renderLog(); };

  // ── 切口索引 ──────────────────────────────────
  function loadTabs(){
    fetch('/api/dossier').then(function(r){ return r.json(); }).then(function(d){
      var plan = (d.plan && (d.plan.agenda.length + d.plan.threads.length)) || 0;
      var chg = (d.changes || []).length;
      var ctx = d.context || {};
      $('nb-c1').textContent = plan;
      $('nb-c2').textContent = chg;
      $('nb-c3').textContent = ctx.memories == null ? '…' : ctx.memories;
      $('nb-model').textContent = ctx.model || '—';
      if (ctx.todayUsd != null) $('nb-usd').textContent = '今天 $' + Number(ctx.todayUsd).toFixed(3);
      window.__dossier = d;
    }).catch(function(){});
    fetch('/api/proposals?status=open').then(function(r){ return r.json(); }).then(function(j){
      var n = Array.isArray(j) ? j.length : 0;
      $('nb-c0').textContent = n;
      $('nb-t0').className = 'nb-tab' + (n ? ' wait' : '') + (TAB === 0 ? ' on' : '');
    }).catch(function(){});
  }

  function paintTab(i){
    Array.prototype.forEach.call(document.querySelectorAll('.nb-tab'), function(b){
      b.className = 'nb-tab' + (Number(b.getAttribute('data-t')) === 0 && Number($('nb-c0').textContent) > 0 ? ' wait' : '') +
        (Number(b.getAttribute('data-t')) === i ? ' on' : '');
    });
  }

  function showTab(i){
    var panel = $('nb-panel');
    if (TAB === i) { TAB = -1; panel.hidden = true; paintTab(-1); return; }
    TAB = i; panel.hidden = false; paintTab(i);
    var d = window.__dossier || {};
    if (i === 0) {
      panel.innerHTML = '<h3>等你点头</h3><div class="nb-empty">读取中…</div>';
      fetch('/api/proposals?status=open').then(function(r){ return r.json(); }).then(function(j){
        var rows = Array.isArray(j) ? j : [];
        panel.innerHTML = '<h3>等你点头 · ' + rows.length + '</h3>' + (rows.length ? rows.map(function(p){
          return '<div class="nb-card"><div class="t">' + esc(p.title || '') + '</div>' +
            '<div class="s">' + esc((p.why || '').slice(0, 60)) + '</div></div>';
        }).join('') : '<div class="nb-empty">没有等你点头的事。</div>');
      }).catch(function(){});
      return;
    }
    if (i === 1) {
      var ag = (d.plan && d.plan.agenda) || [], th = (d.plan && d.plan.threads) || [];
      panel.innerHTML = '<h3>计划 · ' + (ag.length + th.length) + '</h3>' + (ag.concat(th).length ?
        ag.map(function(x){ return '<div class="nb-card"><div class="t">' + esc(x.t) + '</div><div class="s">来自 ' + esc(x.from||'') + '</div></div>'; }).join('') +
        th.map(function(x){ return '<div class="nb-card"><div class="t">' + esc(x.t) + '</div><div class="s">' + esc(String(x.d||0)) + ' 天' + (x.aging?' · 变旧':'') + '</div></div>'; }).join('')
        : '<div class="nb-empty">手上没有未了的事。</div>');
      return;
    }
    if (i === 2) {
      var ch = d.changes || [];
      panel.innerHTML = '<h3>改动 · ' + ch.length + '</h3>' + (ch.length ? ch.map(function(c){
        return '<div class="nb-au"><i>' + esc(String(c.ts||'').slice(11,16)) + '</i> ' + esc(c.verb) + ' · ' + esc(String(c.argv||'').slice(0,48)) + '</div>';
      }).join('') : '<div class="nb-empty">这一轮还没动过东西。</div>');
      return;
    }
    var ctx = d.context || {};
    panel.innerHTML = '<h3>上下文</h3>' +
      '<div class="nb-au">记忆 ' + esc(ctx.memories) + ' · 文档 ' + esc(ctx.docs) + ' 篇 / ' + esc(ctx.chunks) + ' 块</div>' +
      '<div class="nb-au">工具 ' + esc(ctx.tools) + ' · 技能 ' + esc(ctx.skills) + '</div>' +
      '<div class="nb-au">模型 ' + esc(ctx.model || '—') + '</div>' +
      '<div class="nb-au">今天 ' + esc(ctx.todayTokens) + ' tok · $' + esc(Number(ctx.todayUsd||0).toFixed(3)) + '</div>';
  }
  Array.prototype.forEach.call(document.querySelectorAll('.nb-tab'), function(b){
    b.onclick = function(){ showTab(Number(b.getAttribute('data-t'))); };
  });

  // ── 醋酸片（过程）─────────────────────────────
  var LEAF = [];
  function leafAdd(kind, text){
    LEAF.push({ k: kind, t: String(text || '').slice(0, 400) });
    if (LEAF.length > 40) LEAF.shift();
    paintLeaf();
  }
  function paintLeaf(){
    if (!LEAF.length) { $('nb-leaf').hidden = true; return; }
    $('nb-leaf').hidden = false;
    $('nb-leaflines').innerHTML = LEAF.map(function(x){
      return '<div class="ln"><b>' + esc(x.k) + '</b> ' + esc(x.t) + '</div>';
    }).join('');
    $('nb-leaf').scrollTop = $('nb-leaf').scrollHeight;
  }
  $('nb-leafx').onclick = function(){ LEAF = []; paintLeaf(); };

  // ── 发一句话 ──────────────────────────────────
  function send(){
    if (BUSY) return;
    var ta = $('nb-say');
    var text = (ta.value || '').trim();
    if (!text) return;
    BUSY = true; ta.value = ''; ta.style.height = '24px';
    LEAF = []; paintLeaf();

    var mine = document.createElement('article');
    mine.className = 'nb-e me';
    mine.innerHTML = '<div class="g">' + hhmm(new Date().toISOString()) + '<span class="w">你</span></div>' +
      '<div class="b"><div class="nb-say"><div>' + esc(text) + '</div></div></div>';
    $('nb-log').appendChild(mine);

    var her = document.createElement('article');
    her.className = 'nb-e her';
    her.innerHTML = '<div class="g">' + hhmm(new Date().toISOString()) + '<span class="w">她</span></div>' +
      '<div class="b"><div class="nb-say"><div id="nb-live"></div></div></div>';
    $('nb-log').appendChild(her);
    $('nb-page').scrollTop = $('nb-page').scrollHeight;

    fetch('/api/say', { method:'POST', headers:H, body: JSON.stringify({ text: text }) }).then(function(res){
      if (!res.ok || !res.body) throw new Error('E_HTTP');
      var rd = res.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump(){
        return rd.read().then(function(r){
          if (r.done) return;
          buf += dec.decode(r.value, { stream:true });
          var parts = buf.split(String.fromCharCode(10,10));
          buf = parts.pop();
          parts.forEach(function(frame){
            var line = frame.trim();
            if (line.indexOf('data: ') !== 0) return;
            var ev;
            try { ev = JSON.parse(line.slice(6)); } catch(e){ return; }
            if (ev.type === 'delta') {
              var live = $('nb-live'); if (live) live.textContent += ev.text;
              $('nb-page').scrollTop = $('nb-page').scrollHeight;
            } else if (ev.type === 'think') {
              leafAdd('想', ev.text);
            } else if (ev.type === 'tool') {
              leafAdd('用', ev.name + ' ' + String(ev.args || '').slice(0, 80));
            } else if (ev.type === 'notice' || ev.type === 'memo') {
              tick(ev.text);
            } else if (ev.type === 'error') {
              tick(ev.message);
            }
          });
          return pump();
        });
      }
      return pump();
    }).then(function(){
      BUSY = false;
      return loadTimeline().then(function(){
        loadState(); loadTabs();
        requestAnimationFrame(function(){ $('nb-page').scrollTop = $('nb-page').scrollHeight; });
      });
    }).catch(function(){
      BUSY = false;
      var live = $('nb-live'); if (live) live.textContent = '（这一轮没接上，看右上角状态）';
      tick('发送失败');
    });
  }
  $('nb-send').onclick = send;
  $('nb-say').addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('nb-say').addEventListener('input', function(){
    this.style.height = 'auto'; this.style.height = Math.min(160, this.scrollHeight) + 'px';
  });

  // ── 启动 ─────────────────────────────────────
  loadState(); loadTimeline(); loadTabs();
  // 直接翻到「她收着的」那一页（截图/书签用）
  if (location.search.indexOf('view=board') >= 0) setTimeout(function(){ Board(true); }, 120);
  setInterval(function(){ loadState(); loadTabs(); }, 20000);
})();
</script>
</body></html>`;
