(function(){
  var $ = function(id){ return document.getElementById(id); };
  var H = { 'content-type':'application/json', 'x-jj':'1' };
  var TL = [], BOARD = false, CUR = 0, TAB = -1, BUSY = false, AV = {}, AC = null, MEM_OFF = 0, CFG_TAB = 0;
  var TRACE = [];   // 当前这一轮的过程（想/用/结果/错）；右栏第四个签看它

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

  // 面包屑：现在的「在哪」。分两段，末段加粗。
  var CRUMB = { home: '工作台', chat: '记录', sess: '会话', mem: '记忆', docs: '文档', cap: '能力',
    logs: '日志', files: '文件', git: '校样', cfg: '设置', gap: '还缺', approvals: '待你处理', board: '她收着的' };
  function setCrumb(v, extra){
    var el = $('nb-crumb');
    if (!el) return;
    var a = CRUMB[v] || '记录本';
    var b = extra ? String(extra) : '';
    el.innerHTML = b ? (esc(a) + '<i>/</i><b>' + esc(b) + '</b>') : ('<b>' + esc(a) + '</b>');
  }

  // KB_DELEGATE：所有 role=button 的元素都该能用 Enter / Space 触发（a11y 审计 P1）
  (function(){
    document.addEventListener('keydown', function(e){
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var t = e.target;
      if (!t || t.getAttribute('role') !== 'button') return;
      e.preventDefault();
      t.click();
    });
  })();
  // ── 主题 ──────────────────────────────────────
  // ledger（默认，黑白紧凑）/ hermes（中性灰、宽版式）。只改 <html data-theme>，
  // 结构、数据、接口都不动；服务端也会把它写进首屏，避免闪一下。
  function applyTheme(name){
    if (name === 'hermes') document.documentElement.setAttribute('data-theme', 'hermes');
    else document.documentElement.removeAttribute('data-theme');
  }
  function loadTheme(){
    fetch('/api/ui').then(function(r){ return r.json(); }).then(function(j){
      applyTheme((j && j.theme) || 'ledger');
    }).catch(function(){});
  }

  // ── 顶栏与左栏 ────────────────────────────────
  // 模式：聊天（默认，只靠记忆召回）/ 工作（带最近几轮 + 更宽预算）。
  // 以前面板里根本没有入口 —— 想换只能改 config.json。
  function paintMode(m){
    var b = $('nb-modechip');
    if (!b) return;
    b.textContent = m === 'work' ? '工作' : '聊天';
    b.className = 'nb-modechip' + (m === 'work' ? ' on' : '');
  }
  function loadMode(){
    fetch('/api/mode').then(function(r){ return r.json(); }).then(function(j){ paintMode((j && j.mode) || 'chat'); }).catch(function(){});
  }
  // 「还没配好」横幅（2026-11-06）：用户点过「先用着」之后，没有任何痕迹，
  // 一对话就甩一个 401。这里按**真配置**判断，配好就自己消失。
  function checkSetup(){
    fetch('/api/setup').then(function(r){ return r.json(); }).then(function(j){
      var bar = $('nb-cfgbar');
      if (!bar) return;
      var st = (j && j.session && j.session.status) || 'idle';
      var step = (j && j.session && j.session.step) || 'detect';
      if (!j || !j.needsConfig) { bar.hidden = true; return; }
      var why = st === 'skipped' ? '你点过「先用着」' : st === 'paused' ? '配置暂停了' : st === 'done' ? '配置没完成' : '还没配置';
      bar.innerHTML = '<span class="t">' + esc(why) + ' · 还没有能用的模型，现在聊不了</span>' +
        '<a class="nb-btn" href="/welcome">继续配置</a>';
      bar.hidden = false;
    }).catch(function(){});
  }

  function loadState(){
    fetch('/api/state').then(function(r){ return r.json(); }).then(function(j){
      if (j && j.line) $('nb-line').textContent = j.line;
    }).catch(function(){});
    fetch('/api/memories/summary').then(function(r){ return r.json(); }).then(function(j){
      $('nb-about').textContent = j.about == null ? '…' : j.about;
      var nm = $('nb-nmem'); if (nm) nm.textContent = j.total == null ? '…' : j.total;
      fetch('/api/sessions?limit=50').then(function(r){ return r.json(); }).then(function(x){
        var ns = $('nb-nsess'); if (ns) ns.textContent = String(((x && x.sessions) || []).length);
      }).catch(function(){});
      fetch('/api/docs').then(function(r){ return r.json(); }).then(function(rows){
        var nd = $('nb-ndocs');
        if (nd) nd.textContent = Array.isArray(rows) ? rows.length : '…';
      }).catch(function(){});
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
      // 不在对话中途时，右栏显示**最近一轮**的过程（payload.trace 一直在库里）
      if (!BUSY) {
        for (var i = TL.length - 1; i >= 0; i--) {
          var bb = TL[i];
          if (bb.type === 'msg' && bb.role === 'agent' && bb.trace && bb.trace.length) { TRACE = bb.trace.slice(); break; }
        }
        if (TAB === 4) paintTrace();
      }
      renderDays();
      renderLog();
    }).catch(function(){});
  }

  var DAYS_SHOWN = 8;
  function renderDays(){
    var days = TL.filter(function(b){ return b.type === 'day'; }).slice().reverse(); // 新 → 旧
    var html = '';
    var today = new Date();
    var p = function(n){ return String(n).padStart(2,'0'); };
    var todayLabel = today.getFullYear() + '-' + p(today.getMonth()+1) + '-' + p(today.getDate());
    // 今天：只在今天真的有话时才钉在顶上（以前不管有没有都显示，点了还会跳到最上面）
    var md = String(Number(todayLabel.slice(5, 7))) + ' 月 ' + String(Number(todayLabel.slice(8, 10))) + ' 日';
    var hasToday = days.some(function(d){ return String(d.label || '').indexOf(md) >= 0; });
    if (hasToday) {
      html += '<div class="nb-day on" data-d="' + todayLabel + '" role="button" tabindex="0"><span class="mk"></span>' +
        '<span><span class="d">今天</span><span class="m">' + hhmm(today.toISOString()) + '</span></span></div>';
    }
    days.slice(0, DAYS_SHOWN).forEach(function(d){
      var gap = d.gapMs ? ('距上次 ' + Math.round(d.gapMs/3600000) + ' 小时') : '';
      var lab = String(d.label || '');
      var isToday = lab.indexOf(md) >= 0;
      if (isToday && hasToday) return;   // 顶上已经钉了一个「今天」，别再列一次
      html += '<div class="nb-day' + (isToday ? ' on' : '') + '" data-d="' + esc(lab) + '" role="button" tabindex="0">' +
        '<span class="mk"></span><span><span class="d">' + esc(isToday ? '今天' : lab) + '</span>' +
        '<span class="m">' + esc(gap) + '</span></span></div>';
    });
    var rest = days.length - DAYS_SHOWN;
    if (rest > 0) {
      html += '<div class="nb-day" id="nb-moreday" style="opacity:.8">' +
        '<span class="mk"></span><span><span class="d">更早…</span>' +
        '<span class="m">还有 ' + rest + ' 天</span></span></div>';
    }
    $('nb-days').innerHTML = html;
    var more = $('nb-moreday');
    if (more) more.onclick = function(){ DAYS_SHOWN += 30; renderDays(); };
    Array.prototype.forEach.call($('nb-days').querySelectorAll('.nb-day[data-d]'), function(el){
      el.onclick = function(){
        Board(false);
        go('chat');
        Array.prototype.forEach.call($('nb-days').querySelectorAll('.nb-day'), function(x){ x.classList.remove('on'); });
        el.classList.add('on');
        var lab = el.getAttribute('data-d');
        var marks = $('nb-log').querySelectorAll('.nb-daymark');
        var target = null;
        for (var i = 0; i < marks.length; i++) {
          var dl = marks[i].getAttribute('data-d') || '';
          // 今天用日期前缀匹配（标记是「11 月 5 日 周四」，不是 2026-11-05）
          if (lab === todayLabel ? dl.indexOf(md) >= 0 : dl === lab) { target = marks[i]; break; }
        }
        // 今天点进去要看的是**最新一条**，不是当天最上面（用户：每次点今天都跳到顶）
        if (lab === todayLabel) {
          $('nb-page').scrollTop = $('nb-page').scrollHeight;
          return;
        }
        if (target) target.scrollIntoView({ block: 'start' });
        else $('nb-page').scrollTop = 0;
      };
    });
  }

  // 消息下面那排证据条（工具次数 / 引用条数 / 未发送的本地记忆）
  function evChips(b){
    var out = [];
    var tn = (b.tools || []).length;
    if (tn) out.push('工具 ' + tn + ' 次');
    if (b.cites && b.cites.length) out.push('引用 ' + b.cites.length + ' 条');
    if (b.omitted) out.push(b.omitted + ' 条本地记忆未发送');
    return out;
  }

  // 头像：启动时拉一次，对话流里每条消息旁边画一张
  function loadAvatars(){
    fetch('/api/avatars').then(function(r){ return r.json(); }).then(function(j){
      AV = j || {};
      if (TL.length && $('nb-log')) renderLog();
    }).catch(function(){});
  }

  function renderLog(){
    var html = '', n = 0;
    TL.forEach(function(b){
      if (b.type === 'day') { html += '<div class="nb-daymark" data-d="' + (b.label || '') + '">' + esc(b.label) + '</div>'; return; }
      if (b.type !== 'msg') return;
      n++;
      var mine = b.role === 'user';
      var body = b.html || esc(b.text).split(String.fromCharCode(10)).join('<br>');
      // 他的回答经常带表格，一刀切在中间就是「答不完整」。只有特别长的才折（3000 字以上）
      var long = String(b.text || '').length > 3000;
      var id = 'f' + (CUR++);
      html += '<article class="nb-e ' + (mine ? 'me' : 'her') + '">' +
        '<div class="g">' +
        (function(){
          var av = mine ? AV.user : AV.agent;
          return av && av.url ? '<img class="nb-gav" src="' + esc(av.url) + '" alt="">' : '';
        })() +
        hhmm(b.ts) + '<span class="w">' + (mine ? '你' : '她') + '</span></div>' +
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
        btn.textContent = '展开全文（约 ' + String(b.text || '').length + ' 字，还有 ' + Math.max(1, Math.round((String(b.text || '').length - 700) / 60)) + ' 行）';
        // 记住要展开的是哪个（以前靠 previousElementSibling 猜，位置一变就"展开了个寂寞"）
        btn.setAttribute('data-target', id);
        btn.onclick = function(){ var t = document.getElementById(btn.getAttribute('data-target')); if (t) t.classList.add('open'); btn.remove(); };
        // 插到正文下面、证据条上面（以前 appendChild 到 .b 末尾，会被证据条挤到更下面）
        fold.parentNode.parentNode.insertBefore(btn, fold.parentNode.nextSibling);
        html = holder.innerHTML;
      }
    });
    $('nb-log').innerHTML = html;
    if (!n) $('nb-log').innerHTML = '<div class="nb-empty">还没有任何记录。说一句试试。</div>';
    // 折叠按钮（innerHTML 之后重新绑）
    Array.prototype.forEach.call($('nb-log').querySelectorAll('.nb-more'), function(btn){
      btn.onclick = function(){
        var t = document.getElementById(btn.getAttribute('data-target') || '');
        if (t) t.classList.add('open');
        btn.remove();
      };
    });
    requestAnimationFrame(function(){
      $('nb-page').scrollTop = AT_BOTTOM ? $('nb-page').scrollHeight : 0;
      updateLatest();
    });
  }

  // ── 她收着的（标本页）─────────────────────────
  function Board(on){
    BOARD = !!on;
    $('nb-board').hidden = !on;
    $('nb-log').hidden = !!on;
    showHome(!on);
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
  var gapBtn = $('nb-gap');
  if (gapBtn) gapBtn.onclick = function(){ go('gap'); };

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

  function groupTrace(tr){
    var steps = [];
    var cur = { think: '', items: [] };
    (tr || []).forEach(function(x){
      var k = x.k || 'think';
      if (k === 'think') {
        if (cur.items.length) { steps.push(cur); cur = { think: x.t || '', items: [] }; return; }
        cur.think = (cur.think ? cur.think + String.fromCharCode(10) : '') + String(x.t || '');
        return;
      }
      cur.items.push(x);
    });
    if (cur.think || cur.items.length) steps.push(cur);
    return steps;
  }

  // 推理是逐 token 流进来的：每来一个字就新起一条，面板上就是「想 我 / 想 搜 / 想 一下」
  // 一垛碎字。这里按「连续同类就接上」合并，遇到别的动作才换行。
  function thinkAppend(list, kind, text, max){
    var t = String(text || '');
    if (!t) return;
    var last = list.length ? list[list.length - 1] : null;
    if (last && last.k === kind) {
      var joined = String(last.t || '') + t;
      last.t = joined.length > max ? joined.slice(0, max) + '…' : joined;
      return;
    }
    list.push({ k: kind, t: t.length > max ? t.slice(0, max) + '…' : t });
  }

  // 工具行：服务端给的 args 已经是人话（且常常自带名字），别再前缀一遍
  function toolLine(ev){
    var n = String(ev.name || '');
    var a = String(ev.args || '').trim();
    if (!a) return n;
    return a.indexOf(n) === 0 ? a : (n + ' ' + a);
  }
  function paintTrace(){
    var box = $('nb-trace');
    if (!box) return;
    var steps = groupTrace(TRACE);
    var c4 = $('nb-c4'); if (c4) c4.textContent = String(steps.length);
    if (!steps.length) { box.innerHTML = '<div class="nb-empty">这一轮还没有过程。她说一句话、动一次手，这里会长出来。</div>'; return; }
    box.innerHTML = '<h3>过程 · ' + steps.length + ' 步</h3>' + steps.map(function(st, i){
      var items = st.items.map(function(x){
        var who = x.k === 'tool' ? '用' : x.k === 'res' ? '结果' : x.k === 'err' ? '错' : '·';
        var cls = x.k === 'err' ? 'err' : x.k === 'res' ? 'res' : 'tool';
        return '<div class="nb-tr ' + cls + '"><span class="w">' + who + (x.ms != null ? ' · ' + x.ms + 'ms' : '') + '</span>' +
          esc(String(x.t || '').slice(0, 800)) + '</div>';
      }).join('');
      var think = st.think ? '<div class="nb-tr think"><span class="w">想</span>' + esc(String(st.think).slice(0, 900)) + '</div>' : '';
      return '<div class="nb-step"><div class="hd">第 ' + (i + 1) + ' 步</div>' + think + items + '</div>';
    }).join('');
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
    if (i === 4) {
      panel.innerHTML = '<div id="nb-trace"></div>';
      paintTrace();
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

  // ── 发一句话 ──────────────────────────────────
  // 回到最新：离底超过 200px 就露出来（用户：老面板有这条，记录本没有）
  function updateLatest(){
    var p = $('nb-page'), b = $('nb-latest');
    if (!p || !b) return;
    // 只在记录页露出来：别的页面上它没有意义（还会浮在空白上）
    b.hidden = (typeof VIEW !== "undefined" && VIEW !== "chat") || (p.scrollHeight - (p.scrollTop + p.clientHeight)) < 200;
  }
  (function(){
    var p = $('nb-page'), b = $('nb-latest');
    if (p) p.addEventListener('scroll', updateLatest);
    // 直接跳：长对话有 5 万像素，平滑滚要好几秒，用户点它就是想到那儿
    if (b) b.onclick = function(){ p.scrollTop = p.scrollHeight; updateLatest(); };
  })();

  function send(){
    if (BUSY) return;
    var ta = $('nb-say');
    var text = (ta.value || '').trim();
    if (!text) return;
    BUSY = true; AT_BOTTOM = true; ta.value = ''; ta.style.height = '24px';
    AC = new AbortController();
    var stopBtn = $('nb-stop'); if (stopBtn) stopBtn.hidden = false;
    TRACE = [];
    if (TAB === 4) paintTrace();

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

    fetch('/api/say', { method:'POST', headers:H, body: JSON.stringify({ text: text }), signal: AC ? AC.signal : undefined }).then(function(res){
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
            if (ev.type === 'reset') {
              var lv = $('nb-live'); if (lv) lv.textContent = '';
            } else if (ev.type === 'delta') {
              var live = $('nb-live'); if (live) live.textContent += ev.text;
              $('nb-page').scrollTop = $('nb-page').scrollHeight;
            } else if (ev.type === 'think') {
              thinkAppend(TRACE, 'think', ev.text, 2000);
              if (TAB === 4) paintTrace();
            } else if (ev.type === 'tool') {
              TRACE.push({ k: 'tool', t: toolLine(ev).slice(0, 300) });
              if (TAB === 4) paintTrace();
            } else if (ev.type === 'tool_result') {
              TRACE.push({ k: 'res', t: String(ev.result || '').slice(0, 1200), ms: ev.ms });
              if (TAB === 4) paintTrace();
            } else if (ev.type === 'error') {
              TRACE.push({ k: 'err', t: String(ev.message || '').slice(0, 300) });
              if (TAB === 4) paintTrace();
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
      BUSY = false; AC = null;
      var sb = $('nb-stop'); if (sb) sb.hidden = true;
    TRACE = [];
    if (TAB === 4) paintTrace();   // 过程片收起来：它常驻会一直盖着正文
      go('chat');
      return loadTimeline().then(function(){
        loadState(); loadTabs();
        requestAnimationFrame(function(){ $('nb-page').scrollTop = $('nb-page').scrollHeight; });
      });
    }).catch(function(){
      BUSY = false; AC = null;
      var sb2 = $('nb-stop'); if (sb2) sb2.hidden = true;
      var live = $('nb-live'); if (live) live.textContent = '（这一轮没接上，看右上角状态）';
      tick('发送失败');
    });
  }
  $('nb-send').onclick = send;
  var stopEl = $('nb-stop');
  if (stopEl) stopEl.onclick = function(){
    if (AC) { try { AC.abort(); } catch (e) {} }
    BUSY = false;
    stopEl.hidden = true;
    tick('已停止这一轮');
  };
  $('nb-say').addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('nb-say').addEventListener('input', function(){
    this.style.height = 'auto'; this.style.height = Math.min(160, this.scrollHeight) + 'px';
  });

  // ── 工作台（编号分节 + 三张状态卡 + 健康格）────────────
  var USD = String.fromCharCode(36);
  function showHome(on){ var h = $('nb-home'); if (h) h.hidden = !on; }
  function loadHome(){
    var el = $('nb-home');
    if (!el) return;
    Promise.all([
      fetch('/api/state').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/memories/summary').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/proposals?status=open').then(function(r){ return r.json(); }).catch(function(){ return []; }),
      fetch('/api/dossier').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/health').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/usage').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/night/due').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/egress').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/skills').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/activity?limit=8').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
    ]).then(function(res){
      var st = res[0] || {}, sum = res[1] || {}, props = Array.isArray(res[2]) ? res[2] : [];
      var dors = res[3] || {}, health = res[4] || {};
      var use = res[5] || {}, night = res[6] || {}, eg = res[7] || {};
      var sk = res[8] || {}, act = res[9] || {};
      var ctx = dors.context || {};
      var deg = health.degraded || [];
      var d = new Date();
      var wd = ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()];
      var p2 = function(n){ return String(n).padStart(2, '0'); };
      var date = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
      var h0 = d.getHours();
      var hello = h0 < 6 ? '凌晨好' : h0 < 12 ? '早上好' : h0 < 18 ? '下午好' : '晚上好';
      var about = sum.about == null ? '…' : sum.about;
      var hc = function(k, v, bad){
        return '<div class="nb-hc' + (bad ? ' bad' : '') + '"><div class="k">' + k +
          '</div><div class="v">' + esc(v) + '</div></div>';
      };
      el.innerHTML = '<div class="nb-home">' +
        '<div class="nb-kicker">№ 001 · 工作台</div>' +
        '<h1 class="nb-greet">' + hello + '。<em>她记得 ' + esc(String(about)) + ' 件关于你的事。</em></h1>' +
        '<div class="nb-meta">' + date + ' · ' + wd + ' · ' + esc(String(st.line || '醒着')) +
          ' · 今天 ' + USD + Number(ctx.todayUsd || 0).toFixed(3) + '</div>' +
        '<div class="nb-cards">' +
          '<button class="nb-card2' + (props.length ? ' wait' : '') + '" data-home="wait"><span class="k">待你处理</span><b>' +
            props.length + '</b><span class="m">批准 / 拒绝</span></button>' +
          '<button class="nb-card2" data-home="board"><span class="k">她记得</span><b>' + esc(String(about)) +
            '</b><span class="m">关于你 · 本周 +' + Number(sum.about7d || 0) + '</span></button>' +
          '<button class="nb-card2" data-home="cfg"><span class="k">状态</span><b>' +
            (deg.length ? '有 ' + deg.length + ' 项' : '正常') + '</b><span class="m">' +
            (deg.length ? esc(deg.slice(0, 2).join(' · ')) : 'degraded 0') + '</span></button>' +
        '</div>' +
        '<div class="nb-health">' +
          hc('模型', ctx.model || '—') +
          hc('记忆', String(ctx.memories == null ? '…' : ctx.memories)) +
          hc('文档', String(ctx.docs == null ? '…' : ctx.docs) + '/' + String(ctx.chunks == null ? '…' : ctx.chunks)) +
          hc('工具', String(ctx.tools == null ? '…' : ctx.tools)) +
          hc('技能', String(ctx.skills == null ? '…' : ctx.skills)) +
          hc('断片', String(sum.outage == null ? '…' : sum.outage), Number(sum.outage || 0) > 0) +
        '</div>' +
        '<div class="nb-sec">§ 02 进行中</div>' +
        '<div class="nb-run">' +
          '<div class="nb-runrow"><span class="k">正在跑</span><span class="v">' +
            (night.running ? '夜里那次整理正在跑' : '没有在跑的后台任务') + '</span>' +
            '<span class="m">' + (night.lastAt ? '上次整理 ' + esc(String(night.lastAt).slice(5, 16).replace('T', ' ')) : '还没整理过') + '</span></div>' +
          '<div class="nb-runrow"><span class="k">已花</span><span class="v">' + USD +
            Number(use.todayUsd || 0).toFixed(3) + '</span><span class="m">今天 ' + Number(use.calls || 0) +
            ' 次调用 · ' + Number(use.inTokens || 0) + '/' + Number(use.outTokens || 0) + ' tok</span></div>' +
          '<div class="nb-runrow"><span class="k">等批准</span><span class="v">' +
            (props.length + (Array.isArray(eg.pending) ? eg.pending.length : Number(eg.pending || 0) || 0)) +
            '</span><span class="m">' + props.length + ' 个提议' +
            ((Array.isArray(eg.pending) && eg.pending.length) ? ' · ' + eg.pending.length + ' 个外发' : '') + '</span></div>' +
        '</div>' +
        '<div class="nb-actrow" style="margin:10px 0 2px">' +
        '<button class="nb-btn" id="nb-night">现在整理一次</button>' +
        '<span class="nb-empty" id="nb-nightmsg">夜里那次整理；手动跑一次不写游标也行</span></div>' +
        '<div class="nb-sec">§ 03 配方</div>' +
        ((sk.skills || []).length ? '<div class="nb-grid2">' + (sk.skills || []).slice(0, 6).map(function(x){
          return '<button class="nb-recipe" data-skill="' + esc(x.id) + '">' +
            '<span class="n">' + esc(x.name || x.id) + '</span>' +
            '<span class="d">' + esc(String(x.description || '').slice(0, 60)) + '</span></button>';
        }).join('') + '</div>' : '<div class="nb-empty">还没有技能。把 SKILL.md 放进 data/skills 就会出现在这里。</div>') +
        '<div class="nb-sec">§ 04 活动</div>' +
        ((act.items || []).length ? (act.items || []).map(function(x){
          var mine = x.role === 'user';
          return '<div class="nb-actline"' + (x.session ? ' data-sess="' + esc(x.session) + '"' : '') + '>' +
            '<span class="t">' + esc(String(x.ts || '').slice(5, 16).replace('T', ' ')) + '</span>' +
            '<span class="w">' + (mine ? '你' : '她') + '</span>' +
            '<span class="x">' + esc(String(x.text || '').slice(0, 60)) + '</span></div>';
        }).join('') : '<div class="nb-empty">还没有动静。</div>') +
        '<div class="nb-actrow" style="margin-top:18px">' +
        '<button class="nb-btn" id="nb-gochat">进入记录 · 继续说话</button></div>' +
        '</div>';
      var nb = $('nb-night');
      if (nb) nb.onclick = function(){
        var msg = $('nb-nightmsg');
        nb.disabled = true;
        if (msg) msg.textContent = '整理中…（本地模型，可能要几十秒）';
        fetch('/api/night/run', { method: 'POST', headers: H, body: '{}' })
          .then(function(r){ return r.json(); }).then(function(j){
            if (msg) msg.textContent = j.ok ? '整理完了（退出码 ' + j.code + '）' : ('没整理成：' + (j.why || j.error || j.code || '?'));
            nb.disabled = false;
            loadHome(); loadState();
          }).catch(function(){
            if (msg) msg.textContent = '没整理成（请求失败）';
            nb.disabled = false;
          });
      };
      var gc = $('nb-gochat');
      if (gc) gc.onclick = function(){ go('chat'); };
      Array.prototype.forEach.call(el.querySelectorAll('[data-skill]'), function(b){
        b.onclick = function(){
          go('chat');
          var ta = $('nb-say');
          if (ta) { ta.value = '/' + b.getAttribute('data-skill') + ' '; ta.focus(); }
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll('[data-sess]'), function(b){
        b.onclick = function(){ sessDetail(b.getAttribute('data-sess')); };
      });
      Array.prototype.forEach.call(el.querySelectorAll('[data-home]'), function(b){
        b.onclick = function(){
          var w = b.getAttribute('data-home');
          if (w === 'wait') go('approvals');
          else if (w === 'board') Board(true);
          else if (w === 'cfg') go('cfg');
          else showTab(0);
        };
      });
    }).catch(function(){});
  }
  // ── 还缺：她还没弄明白的六件事（答完就写成契约，不会衰减）──────
  function gapView(){
    var el = $('nb-view');
    el.innerHTML = head('还缺', '<button class="nb-btn" id="nb-gback">← 回记录</button>') +
      wrap('<div id="nb-gaps"><div class="nb-empty">读取中…</div></div>');
    var back = $('nb-gback'); if (back) back.onclick = function(){ go('chat'); };
    fetch('/api/profile/gaps').then(function(r){ return r.json(); }).then(function(j){
      var gaps = (j && j.gaps) || [];
      var done = Number((j && j.answered) || 0), total = Number((j && j.total) || gaps.length);
      var box = $('nb-gaps');
      if (!gaps.length) {
        box.innerHTML = '<div class="nb-empty">六道题都答完了（' + done + ' / ' + total + '）。</div>';
        return;
      }
      box.innerHTML = '<div class="nb-empty">已答 ' + done + ' / ' + total + '。答完的会直接写成契约（不衰减）。</div>' +
        gaps.map(function(g, i){
          var id = 'gapin-' + i;
          return '<div class="nb-gapq">' +
            '<div class="nb-gapt">' + esc(g.question) +
            '<span class="m">' + esc(g.why || '') + '</span></div>' +
            '<div class="nb-actrow"><input class="nb-search" id="' + id + '" placeholder="写一句就行" data-k="' + esc(g.key) + '">' +
            '<button class="nb-btn" data-save="' + id + '">记住</button></div></div>';
        }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-save]'), function(b){
        b.onclick = function(){
          var inp = $(b.getAttribute('data-save'));
          if (!inp || !inp.value.trim()) return;
          fetch('/api/profile/answer', { method: 'POST', headers: H,
            body: JSON.stringify({ key: inp.getAttribute('data-k'), text: inp.value.trim() }) })
            .then(function(r){ return r.json(); }).then(function(r){
              if (r.ok) { tick('记下了'); gapView(); loadState(); }
              else tick(r.why || r.error || '没记上');
            });
        };
      });
    }).catch(function(){
      var box = $('nb-gaps'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
    });
  }

  // ── 待你处理：提议 + 代码外发（2026-11-05）──────────────────
  function approvalsView(){
    var el = $('nb-view');
    el.innerHTML = head('待你处理') + wrap('<div id="nb-appr"><div class="nb-empty">读取中…</div></div>');
    function paint(){
      fetch('/api/approvals').then(function(r){ return r.json(); }).then(function(j){
        var items = (j && j.items) || [];
        var box = $('nb-appr');
        if (!items.length) { box.innerHTML = '<div class="nb-empty">没有等你点头的事。</div>'; return; }
        box.innerHTML = items.map(function(x, i){
          var isP = x.kind === 'proposal';
          return '<div class="nb-appr">' +
            '<div class="nb-gapt">' + esc(x.title || '') + '<span class="m">' + esc(x.kind) + ' · ' + esc(String(x.at || '').slice(0, 16).replace('T', ' ')) + '</span></div>' +
            (x.detail ? '<div class="nb-empty">' + esc(x.detail) + '</div>' : '') +
            '<div class="nb-actrow">' +
            (isP
              ? '<button class="nb-btn" data-ok="' + i + '">同意</button><button class="nb-btn" data-no="' + i + '">不用</button>'
              : '<button class="nb-btn" data-ok="' + i + '">允许一次</button>') +
            '</div></div>';
        }).join('') +
        '<div class="nb-actrow" style="margin-top:14px"><button class="nb-btn" id="nb-egoff">收回全部外发授权</button></div>';
        Array.prototype.forEach.call(box.querySelectorAll('[data-ok]'), function(b){
          b.onclick = function(){
            var it = items[Number(b.getAttribute('data-ok'))];
            if (!it) return;
            var req = it.kind === 'proposal'
              ? fetch(it.route, { method: 'POST', headers: H, body: JSON.stringify({ action: 'accept', reason: '我同意，你来做' }) })
              : fetch('/api/egress', { method: 'POST', headers: H, body: JSON.stringify({ action: 'once', path: String(it.id).replace('egress:', '') }) });
            req.then(function(){ tick('已同意'); paint(); loadState(); });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-no]'), function(b){
          b.onclick = function(){
            var it = items[Number(b.getAttribute('data-no'))];
            if (!it) return;
            fetch(it.route, { method: 'POST', headers: H, body: JSON.stringify({ action: 'reject', reason: '不做' }) })
              .then(function(){ tick('已拒绝'); paint(); loadState(); });
          };
        });
        var off = $('nb-egoff');
        if (off) off.onclick = function(){
          fetch('/api/egress', { method: 'POST', headers: H, body: JSON.stringify({ action: 'revoke' }) })
            .then(function(){ tick('外发授权已收回'); paint(); loadState(); });
        };
      }).catch(function(){
        var box = $('nb-appr'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
      });
    }
    paint();
  }

  // ── 文件：项目的只读浏览（走 project.tree / project.read 两个 verb，不是裸 fs）──
  function filesView(dir){
    var el = $('nb-view');
    var cur = dir || '';
    function crumbs(d){
      var parts = d ? d.split('/') : [];
      var out = '<button class="nb-btn" data-dir="">根</button>';
      var acc = '';
      parts.forEach(function(p){
        acc = acc ? acc + '/' + p : p;
        out += '<span style="color:var(--dim2);margin:0 4px">/</span>' +
          '<button class="nb-btn" data-dir="' + esc(acc) + '">' + esc(p) + '</button>';
      });
      return out;
    }
    function paint(){
      el.innerHTML = head('文件', '<button class="nb-btn" id="nb-froot">根目录</button>') +
        wrap('<div class="nb-actrow" style="margin-bottom:8px">' + crumbs(cur) + '</div>' +
        '<div id="nb-flist"><div class="nb-empty">读取中…</div></div>');
      var fr = $('nb-froot'); if (fr) fr.onclick = function(){ filesView(''); };
      Array.prototype.forEach.call(el.querySelectorAll('[data-dir]'), function(b){
        b.onclick = function(){ filesView(b.getAttribute('data-dir')); };
      });
      fetch('/api/project/tree?dir=' + encodeURIComponent(cur)).then(function(r){ return r.json(); }).then(function(j){
        var box = $('nb-flist');
        if (!j.ok) { box.innerHTML = '<div class="nb-empty">读不了：' + esc(j.error || '?') + '</div>'; return; }
        var rows = j.entries || [];
        box.innerHTML = rows.length ? rows.map(function(x){
          var isDir = x.type === 'dir';
          return '<button class="nb-row" data-' + (isDir ? 'dir2' : 'file') + '="' + esc(x.path) + '">' +
            '<span class="tag">' + (isDir ? '目录' : '文件') + '</span>' + esc(x.path.split('/').pop()) +
            '<span class="m">' + (isDir ? '' : (x.bytes == null ? '' : Math.round(x.bytes / 1024) + ' KB')) + '</span></button>';
        }).join('') : '<div class="nb-empty">这个目录是空的。</div>';
        Array.prototype.forEach.call(box.querySelectorAll('[data-dir2]'), function(b){
          b.onclick = function(){ filesView(b.getAttribute('data-dir2')); };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-file]'), function(b){
          b.onclick = function(){ fileOpen(b.getAttribute('data-file')); };
        });
      }).catch(function(){
        var box = $('nb-flist'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
      });
    }
    paint();
  }

  function fileOpen(path){
    var el = $('nb-view');
    el.innerHTML = head('文件', '<button class="nb-btn" id="nb-fback">← 回去</button>') +
      wrap('<div class="nb-empty">读取中…</div>');
    var dir = path.split('/').slice(0, -1).join('/');
    var back = $('nb-fback'); if (back) back.onclick = function(){ filesView(dir); };
    fetch('/api/project/file?path=' + encodeURIComponent(path)).then(function(r){ return r.json(); }).then(function(j){
      var text = j.ok ? String(j.text || '') : ('读不了：' + (j.error || j.code || '?'));
      el.innerHTML = head(path, '<button class="nb-btn" id="nb-fback2">← 回去</button>') +
        wrap('<div class="nb-pre" style="max-height:70vh">' + esc(text.slice(0, 20000)) + '</div>');
      var b2 = $('nb-fback2'); if (b2) b2.onclick = function(){ filesView(dir); };
    }).catch(function(){
      el.innerHTML = head(path) + wrap('<div class="nb-empty">读取失败。</div>');
    });
  }

  // ── 日志：执行层审计（2026-11-05）────────────────────────────
  function logsView(){
    var el = $('nb-view');
    el.innerHTML = head('日志', '<input class="nb-search" id="nb-logq" placeholder="过滤 verb / 参数 / 决定" style="max-width:260px;margin:0">') +
      wrap('<div id="nb-logs"><div class="nb-empty">读取中…</div></div>');
    function paint(q){
      fetch('/api/logs?limit=200' + (q ? '&q=' + encodeURIComponent(q) : '')).then(function(r){ return r.json(); }).then(function(j){
        var items = (j && j.items) || [];
        var box = $('nb-logs');
        if (!items.length) { box.innerHTML = '<div class="nb-empty">还没有执行记录。' + (q ? '（过滤条件下）' : '') + '</div>'; return; }
        box.innerHTML = items.map(function(x){
          var ok = x.decision === 'allow' || x.decision === 'allowed';
          return '<div class="nb-logrow" data-i="' + esc(JSON.stringify(x).slice(0, 0)) + '">' +
            '<span class="t">' + esc(String(x.ts || '').slice(5, 19).replace('T', ' ')) + '</span>' +
            '<span class="v">' + esc(x.verb) + '</span>' +
            '<span class="d ' + (ok ? 'ok' : 'bad') + '">' + esc(x.decision || '') + '</span>' +
            '<span class="x">' + (x.exit == null ? '' : 'exit ' + x.exit) + (x.ms == null ? '' : ' · ' + x.ms + 'ms') + '</span>' +
            '<span class="a">' + esc(String(x.argv || '').slice(0, 70)) + '</span>' +
            '</div>' +
            (x.why ? '<div class="nb-audit">拒因：' + esc(x.why) + '</div>' : '');
        }).join('');
      }).catch(function(){
        var box = $('nb-logs'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
      });
    }
    var q = $('nb-logq');
    if (q) q.onkeydown = function(e){ if (e.key === 'Enter') paint(q.value.trim()); };
    paint('');
  }

  // ── 会话：一次可指认的对话（2026-11-05）────────────────────────
  function sessView(){
    var el = $('nb-view');
    el.innerHTML = head('会话') + wrap('<div id="nb-sess"><div class="nb-empty">读取中…</div></div>');
    fetch('/api/sessions').then(function(r){ return r.json(); }).then(function(j){
      var rows = (j && j.sessions) || [];
      var box = $('nb-sess');
      if (!rows.length) { box.innerHTML = '<div class="nb-empty">还没有会话。去「记录」说一句就有第一次了。</div>'; return; }
      box.innerHTML = rows.map(function(x){
        var t = String(x.title || '（没起标题）');
        return '<button class="nb-row" data-sess="' + esc(x.id) + '">' + esc(t) +
          '<span class="m">' + esc(String(x.updated_at).slice(5, 16).replace('T', ' ')) +
          ' · ' + Number(x.msgs || 0) + ' 条 · ' + esc(x.status) + '</span></button>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-sess]'), function(b){
        b.onclick = function(){ sessDetail(b.getAttribute('data-sess')); };
      });
    }).catch(function(){
      var box = $('nb-sess'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
    });
  }

  function sessDetail(id){
    var el = $('nb-view');
    el.innerHTML = head('会话', '<button class="nb-btn" id="nb-sback">← 回会话</button>') +
      wrap('<div id="nb-sdetail"><div class="nb-empty">读取中…</div></div>');
    var back = $('nb-sback'); if (back) back.onclick = function(){ sessView(); };
    fetch('/api/sessions/' + encodeURIComponent(id)).then(function(r){ return r.json(); }).then(function(j){
      var msgs = (j && j.messages) || [];
      var tools = (j && j.tools) || [];
      var meta = (j && j.session) || {};
      // 文件：工具参数里像路径的那些；终端：跑过命令的工具
      var files = tools.filter(function(t){ return /(^|[\/])[\w.-]+\.(ts|js|mjs|json|md|html|css|py|ps1|sh)$/.test(String(t.args || '')); });
      var terms = tools.filter(function(t){ return /shell|run|exec|bash|pwsh/i.test(String(t.name || '')); });
      var tab = function(k, label, n){
        return '<button class="nb-jump' + (k === 'msgs' ? ' on' : '') + '" data-tab="' + k + '">' + label +
          (n == null ? '' : ' ' + n) + '</button>';
      };
      var head2 = '<div class="nb-kv"><b>开始</b><span>' + esc(String(meta.created_at || '').slice(0, 16).replace('T', ' ')) + '</span>' +
        '<b>状态</b><span>' + esc(meta.status || '—') + '</span>' +
        '<b>条数</b><span>' + Number(meta.msgs || 0) + '</span></div>';
      var acts = '<div class="nb-actrow" style="margin:6px 0 10px">' +
        '<button class="nb-btn" id="nb-branch">从这里分叉</button>' +
        '<button class="nb-btn" id="nb-undo">撤回最后一轮</button></div>';
      var tabs = '<div class="nb-jumpbar" style="position:static;border-top:0;border-bottom:1px solid var(--line-dim)">' +
        tab('msgs', '记录', msgs.length) + tab('turns', '轮次', null) + tab('files', '文件', files.length) + tab('term', '终端', terms.length) + '</div>';
      var bodyMsgs = msgs.length ? msgs.map(function(m){
        var mine = m.role === 'user';
        return '<div class="nb-e ' + (mine ? 'me' : 'her') + '" style="border-top:1px solid var(--line-dim)">' +
          '<div class="g">' + esc(String(m.ts || '').slice(11, 16)) +
          '<span class="w">' + (mine ? '你' : '她') + '</span></div>' +
          '<div class="b"><div class="nb-say"><div>' + esc(String(m.text || '').slice(0, 1200)) + '</div></div></div></div>';
      }).join('') : '<div class="nb-empty">这次会话没有留下消息。</div>';
      var bodyFiles = files.length ? files.map(function(t){
        return '<div class="nb-runrow"><span class="k">' + esc(String(t.name || '')) + '</span>' +
          '<span class="v">' + esc(String(t.args || '').slice(0, 160)) + '</span><span></span></div>';
      }).join('') : '<div class="nb-empty">这次会话没碰过文件。</div>';
      var bodyTerm = terms.length ? terms.map(function(t){
        return '<div class="nb-pre">$ ' + esc(String(t.args || '').slice(0, 300)) +
          String.fromCharCode(10) + esc(String(t.result || '').slice(0, 800)) + '</div>';
      }).join('') : '<div class="nb-empty">这次会话没跑过命令。</div>';
      var bodyTurns = '<div id="nb-turns"><div class="nb-empty">读取中…</div></div>';
      $('nb-sdetail').innerHTML = head2 + acts + tabs +
        '<div id="nb-stab-msgs">' + bodyMsgs + '</div>' +
        '<div id="nb-stab-turns" hidden>' + bodyTurns + '</div>' +
        '<div id="nb-stab-files" hidden>' + bodyFiles + '</div>' +
        '<div id="nb-stab-term" hidden>' + bodyTerm + '</div>';
      var br = $('nb-branch');
      if (br) br.onclick = function(){ fetch('/api/sessions/' + encodeURIComponent(id) + '/branch', { method: 'POST', headers: H, body: '{}' }).then(function(){ tick('已分叉'); sessView(); }); };
      var un = $('nb-undo');
      if (un) un.onclick = function(){ fetch('/api/sessions/' + encodeURIComponent(id) + '/undo', { method: 'POST', headers: H, body: '{}' }).then(function(){ tick('已撤回最后一轮'); sessDetail(id); }); };
      // 轮次：一问一答一行，按钮各自独立
      fetch('/api/sessions/' + encodeURIComponent(id) + '/turns').then(function(r){ return r.json(); }).then(function(tj){
        var turns = (tj && tj.turns) || [];
        var box = $('nb-turns');
        if (!box) return;
        box.innerHTML = turns.length ? turns.map(function(t, i){
          return '<div class="nb-turn">' +
            '<div class="nb-gapt">' + (i + 1) + '. ' + esc(String(t.user || '').slice(0, 80)) +
            '<span class="m">' + esc(String(t.userTs || '').slice(11, 16)) +
            (t.agentTs ? ' · 答 ' + esc(String(t.agentTs).slice(11, 16)) : ' · 没答') +
            (t.tools ? ' · ' + t.tools + ' 个工具' : '') + '</span></div>' +
            (t.agent ? '<div class="nb-sub">' + esc(String(t.agent).slice(0, 220)) + '</div>' : '') +
            '<div class="nb-actrow">' +
            '<button class="nb-btn" data-tundo="' + esc(t.id) + '">撤回这一轮</button>' +
            '<button class="nb-btn" data-tretry="' + esc(t.id) + '">重问</button>' +
            '<button class="nb-btn" data-tsteer="' + esc(t.id) + '">引导重答</button>' +
            '<button class="nb-btn" data-taudit="' + esc(t.id) + '">这一轮的审计</button>' +
            '</div><div class="nb-audit" id="aud-' + esc(t.id) + '"></div></div>';
        }).join('') : '<div class="nb-empty">还没有轮次。</div>';
        Array.prototype.forEach.call(box.querySelectorAll('[data-tundo]'), function(b){
          b.onclick = function(){
            var tid = b.getAttribute('data-tundo');
            fetch('/api/sessions/' + encodeURIComponent(id) + '/turns/' + tid + '/undo', { method: 'POST', headers: H, body: '{}' })
              .then(function(){ tick('已撤回这一轮'); sessDetail(id); });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-tretry]'), function(b){
          b.onclick = function(){
            var tid = b.getAttribute('data-tretry');
            fetch('/api/sessions/' + encodeURIComponent(id) + '/turns/' + tid + '/retry', { method: 'POST', headers: H, body: '{}' })
              .then(function(r){ return r.json(); }).then(function(j){
                go('chat');
                var ta = $('nb-say');
                if (ta && j.text) { ta.value = j.text; ta.focus(); tick('原话已填回输入框，回车重问'); }
              });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-tsteer]'), function(b){
          b.onclick = function(){
            var tid = b.getAttribute('data-tsteer');
            var note = window.prompt('要她怎么重答？（比如：短一点 / 说具体数字 / 别用列表）');
            if (!note) return;
            b.textContent = '重答中…';
            fetch('/api/sessions/' + encodeURIComponent(id) + '/turns/' + tid + '/steer', { method: 'POST', headers: H, body: JSON.stringify({ note: note }) })
              .then(function(r){ return r.json(); }).then(function(j){
                if (j.ok) { tick('已重答'); sessDetail(id); } else { tick(j.why || j.error || '没答成'); b.textContent = '引导重答'; }
              }).catch(function(){ tick('没答成'); b.textContent = '引导重答'; });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-taudit]'), function(b){
          b.onclick = function(){
            var tid = b.getAttribute('data-taudit');
            var out = document.getElementById('aud-' + tid);
            if (!out) return;
            out.textContent = '读取中…';
            fetch('/api/sessions/' + encodeURIComponent(id) + '/turns/' + tid + '/audit', { method: 'POST', headers: H, body: '{}' })
              .then(function(r){ return r.json(); }).then(function(j){
                var rows = (j && j.audit) || [];
                out.innerHTML = rows.length ? rows.map(function(a){
                  return '<div class="nb-au">' + esc(String(a.ts || '').slice(11, 19)) + ' ' + esc(a.verb) +
                    ' · ' + esc(a.decision) + (a.exit == null ? '' : ' · exit ' + a.exit) + '</div>';
                }).join('') : '<div class="nb-empty">这一轮没有经过执行层的动作。</div>';
              }).catch(function(){ out.textContent = '读取失败'; });
          };
        });
      }).catch(function(){ var box = $('nb-turns'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>'; });
      Array.prototype.forEach.call($('nb-sdetail').querySelectorAll('[data-tab]'), function(b){
        b.onclick = function(){
          var k = b.getAttribute('data-tab');
          Array.prototype.forEach.call($('nb-sdetail').querySelectorAll('[data-tab]'), function(x){ x.className = 'nb-jump'; });
          b.className = 'nb-jump on';
          ['msgs', 'turns', 'files', 'term'].forEach(function(t){
            var e = $('nb-stab-' + t); if (e) e.hidden = t !== k;
          });
        };
      });
    }).catch(function(){
      var box = $('nb-sdetail'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
    });
  }

  // ── 去处：记忆 / 文档 / 能力 / 校样 / 设置 ──────────────────
  var KIND = { boundary:'边界', promise:'承诺', fact_hard:'事实', fact:'事实',
    preference_hard:'偏好', preference_soft:'偏好', episode:'经历', thought:'想法',
    reading:'读来的', anchor:'锚点', contract:'契约', gist:'梗概' };
  var VIEW = 'home', AT_BOTTOM = false;
  function head(title, extra){
    return '<div class="nb-pagehd"><h1>' + esc(title) + '</h1><span class="sp"></span>' +
      (extra || '') + '</div>';
  }
  function wrap(html){ return '<div class="nb-wrap">' + html + '</div>'; }
  function go(v){
    VIEW = v;
    Array.prototype.forEach.call(document.querySelectorAll('.nb-go[data-v]'), function(x){
      x.className = 'nb-go' + (x.getAttribute('data-v') === v ? ' cur' : '');
    });
    var home = v === 'home';
    var chat = v === 'chat';
    setCrumb(home ? 'home' : chat ? 'chat' : v);
    updateLatest();
    // 三块面一次只露一块：工作台 / 记录（对话） / 其余（记忆/文档/设置…）
    showHome(home);
    $('nb-log').hidden = !chat;
    $('nb-board').hidden = true;
    $('nb-view').hidden = home || chat;
    var cb = $('nb-composer'); if (cb) cb.hidden = !chat;
    // 记录页是纯文字：右栏那四个切口是工作台的东西，不该跟着对话流杵在旁边
    // 记录页保留右栏（用户明确要它在对话里；我先前按「记录本也是文字吧」把它撤了，那是猜错了）
    var tb = $('nb-tabs'); if (tb) tb.hidden = home;
    var railGone = home;
    var cbx = $('nb-composer'); if (cbx) cbx.style.right = railGone ? '0px' : '52px';
    var tk = document.querySelector('.nb-tick'); if (tk) tk.style.right = railGone ? '0px' : '52px';
    $('nb-board-btn').className = 'nb-go';
    var el = $('nb-view');
    if (home) { $('nb-page').scrollTop = 0; return; }
    if (chat) { AT_BOTTOM = true; $('nb-page').scrollTop = $('nb-page').scrollHeight; return; }
    if (v === 'mem') memView('');
    else if (v === 'docs') docsView();
    else if (v === 'cap') capView();
    else if (v === 'logs') logsView();
    else if (v === 'files') filesView('');
    else if (v === 'git') gitView();
    else if (v === 'cfg') cfgView();
    else if (v === 'gap') gapView();
    else if (v === 'sess') sessView();
    else if (v === 'approvals') approvalsView();
    else el.innerHTML = head('？') + wrap('<div class="nb-empty">没有这一页。</div>');
  }
  Array.prototype.forEach.call(document.querySelectorAll('.nb-go[data-v]'), function(b){
    b.onclick = function(){ go(b.getAttribute('data-v')); };
  });

  function memView(q){
    var el = $('nb-view');
    el.innerHTML = head('记忆 · ' + (q ? '搜「' + esc(q) + '」' : '全部')) +
      wrap('<input class="nb-search" id="nb-mq" placeholder="搜记忆（回车）" value="' + esc(q || '') + '">' +
        '<div id="nb-mlist"><div class="nb-empty">读取中…</div></div>');
    var box = $('nb-mq');
    if (box) {
      box.onkeydown = function(e){ if (e.key === 'Enter') memView(box.value.trim()); };
      box.focus();
    }
    if (!q) MEM_OFF = MEM_OFF || 0; else MEM_OFF = 0;
    var url = q ? '/api/memories?q=' + encodeURIComponent(q) + '&limit=40'
      : '/api/memories?limit=40&offset=' + MEM_OFF;
    fetch(url).then(function(r){ return r.json(); }).then(function(rows){
      if (!Array.isArray(rows)) rows = [];
      var list = $('nb-mlist');
      var more = (!q && rows.length === 40) ? '<div class="nb-actrow" style="margin-top:10px">' +
        '<button class="nb-btn" id="nb-mmore">看更早的 40 条</button></div>' : '';
      list.innerHTML = (rows.length ? rows.map(function(m){
        return '<button class="nb-row" data-mem="' + m.id + '">' +
          '<span class="tag">' + esc(KIND[m.kind] || m.kind || '') + '</span>' +
          esc(String(m.text).slice(0, 110)) +
          '<span class="m">#' + m.id + ' · ' + esc(m.stage) + ' · ' + Number(m.weight).toFixed(2) + '</span></button>';
      }).join('') : '<div class="nb-empty">没有匹配的记忆。</div>') + (!q ? more : '');
      var mb = $('nb-mmore');
      if (mb) mb.onclick = function(){ MEM_OFF += 40; memView(''); };
      Array.prototype.forEach.call(list.querySelectorAll('[data-mem]'), function(b){
        b.onclick = function(){ memDetail(Number(b.getAttribute('data-mem'))); };
      });
    }).catch(function(){
      var list = $('nb-mlist');
      if (list) list.innerHTML = '<div class="nb-empty">读取失败。</div>';
    });
  }

  function memDetail(id){
    var el = $('nb-view');
    el.innerHTML = head('记忆 #' + id, '<button class="nb-btn" id="nb-mback">← 回列表</button>') +
      wrap('<div class="nb-empty">读取中…</div>');
    var back = $('nb-mback'); if (back) back.onclick = function(){ memView(''); };
    fetch('/api/memories/' + id).then(function(r){ return r.json(); }).then(function(j){
      var m = (j && j.memory) || j || {};
      var kv = [
        ['种类', (KIND[m.kind] || m.kind || '') + ' / ' + (m.layer === 'contract' ? '契约层（不衰减）' : '叙事层')],
        ['状态', esc(m.stage) + ' · 权重 ' + Number(m.weight || 0).toFixed(2) + ' · w0 ' + Number(m.w0 || 0).toFixed(2)],
        ['来源', esc(m.scored_by || '?') + ' / ' + esc(m.source_kind || '?') + ' · ' + (m.sensitivity === 'shareable' ? '可出网' : '仅本地')],
        ['采集', esc(String(m.created_at || '').slice(0, 16).replace('T', ' '))],
        ['编号', '#' + esc(m.id)]
      ].map(function(x){ return '<b>' + x[0] + '</b><span>' + x[1] + '</span>'; }).join('');
      var html = '<div class="nb-sub" id="nb-mtext">' + esc(m.text || '') + '</div>' +
        '<div class="nb-form" id="nb-medit" hidden>' +
        '<textarea id="nb-mtextarea" class="nb-search" style="min-height:70px;width:100%">' + esc(m.text || '') + '</textarea>' +
        '<div class="nb-actrow"><button class="nb-btn" id="nb-msave">保存</button>' +
        '<button class="nb-btn" id="nb-mcancel">取消</button>' +
        '<span class="nb-empty">改动会留一条事件（human:panel）</span></div></div>' +
        (m.quote ? '<div class="nb-kv"><b>原话</b><span>' + esc(m.quote) + '</span></div>' : '') +
        '<div class="nb-kv">' + kv + '</div>' +
        '<div><button class="nb-btn" id="nb-meditbtn">编辑正文</button>' +
        '<button class="nb-btn" id="nb-msens">改成' + (m.sensitivity === 'shareable' ? '仅本地' : '可出网') + '</button>' +
        '<button class="nb-btn danger" id="nb-mforget">忘掉它</button>' +
        '<button class="nb-btn" id="nb-mback2">← 回列表</button></div>';
      el.innerHTML = head('记忆 #' + id, '<button class="nb-btn" id="nb-mback3">← 回列表</button>') + wrap(html);
      var b1 = $('nb-mback3'), b2 = $('nb-mback2'), b3 = $('nb-mforget');
      if (b1) b1.onclick = function(){ memView(''); };
      if (b2) b2.onclick = function(){ memView(''); };
      var eb = $('nb-meditbtn'), ed = $('nb-medit'), cancel = $('nb-mcancel'), save = $('nb-msave');
      if (eb && ed) eb.onclick = function(){ ed.hidden = !ed.hidden; if (!ed.hidden) { var t = $('nb-mtextarea'); if (t) t.focus(); } };
      if (cancel && ed) cancel.onclick = function(){ ed.hidden = true; };
      if (save) save.onclick = function(){
        var t = $('nb-mtextarea'); if (!t) return;
        fetch('/api/memories/' + id, { method: 'PUT', headers: H, body: JSON.stringify({ text: t.value.trim() }) })
          .then(function(r){ return r.json(); }).then(function(j){
            if (j.ok === false) { tick(j.error || '没保存成'); return; }
            tick('已改'); memDetail(id);
          });
      };
      var sens = $('nb-msens');
      if (sens) sens.onclick = function(){
        var next = m.sensitivity === 'shareable' ? 'local_only' : 'shareable';
        fetch('/api/memories/' + id, { method: 'PUT', headers: H, body: JSON.stringify({ sensitivity: next }) })
          .then(function(){ tick('敏感度：' + (next === 'shareable' ? '可出网' : '仅本地')); memDetail(id); });
      };
      if (b3) b3.onclick = function(){
        fetch('/api/memories/' + id + '/forget', { method: 'POST', headers: H, body: '{}' })
          .then(function(){ tick('已忘掉 #' + id); memForgotten(id); })
          .catch(function(){ tick('忘不掉，看状态'); });
      };
    }).catch(function(){
      el.innerHTML = head('记忆 #' + id) + wrap('<div class="nb-empty">读取失败。</div>');
    });
  }

  // 忘掉之后的落点：给一次撤销（调 /api/memories/:id/restore）
  function memForgotten(id){
    var el = $('nb-view');
    el.innerHTML = head('记忆 #' + id, '<button class="nb-btn" id="nb-fback">← 回列表</button>') +
      wrap('<div class="nb-empty">已忘掉这条。它被标成 deleted（不是物理删除），随时可以撤回来。</div>' +
      '<div class="nb-actrow"><button class="nb-btn" id="nb-fundo">撤销，恢复这条</button>' +
      '<button class="nb-btn" id="nb-fback2">← 回列表</button></div>');
    var b1 = $('nb-fback'), b2 = $('nb-fback2'), b3 = $('nb-fundo');
    if (b1) b1.onclick = function(){ memView(''); };
    if (b2) b2.onclick = function(){ memView(''); };
    if (b3) b3.onclick = function(){
      fetch('/api/memories/' + id + '/restore', { method: 'POST', headers: H, body: '{}' })
        .then(function(r){ return r.json(); }).then(function(j){
          if (j.ok === false) { tick(j.error || '没恢复成'); return; }
          tick('已恢复 #' + id); memDetail(id);
        });
    };
  }

  function docsView(){
    var el = $('nb-view');
    el.innerHTML = head('文档') + wrap('<div id="nb-docs"><div class="nb-empty">读取中…</div></div>');
    fetch('/api/docs').then(function(r){ return r.json(); }).then(function(rows){
      if (!Array.isArray(rows)) rows = [];
      var box = $('nb-docs');
      box.innerHTML = '<div class="nb-actrow" style="margin-bottom:10px">' +
        '<button class="nb-btn" id="nb-updoc">上传一份</button>' +
        '<span class="nb-empty">.md / .txt 直接吃；PDF 要 Python + markitdown</span>' +
        '<input type="file" id="nb-upfile" accept=".md,.txt,.pdf,.markdown" style="display:none"></div>' +
        (rows.length ? rows.map(function(d){
        return '<div class="nb-row" style="cursor:default">' +
          '<button class="nb-btn" data-doc="' + esc(d.id) + '" style="border:0;background:none;color:inherit;text-align:left;flex:1">' +
          esc(d.title || d.id) + '</button>' +
          '<span class="m">' + esc(String(d.n_chunks || 0)) + ' 块 · ' +
          (d.sensitivity === 'shareable' ? '可出网' : '仅本地') + '</span>' +
          '<button class="nb-btn" data-docsens="' + esc(d.id) + '">改' + (d.sensitivity === 'shareable' ? '仅本地' : '可出网') + '</button>' +
          '<button class="nb-btn danger" data-docdel="' + esc(d.id) + '">忘掉</button></div>';
      }).join('') : '<div class="nb-empty">还没有摄入任何文档。</div>');
      var up = $('nb-updoc'), upf = $('nb-upfile');
      if (up && upf) up.onclick = function(){ upf.click(); };
      if (upf) upf.onchange = function(){
        var f = upf.files && upf.files[0];
        if (!f) return;
        tick('上传 ' + f.name + '…');
        fetch('/api/ingest/upload?name=' + encodeURIComponent(f.name), {
          method: 'POST', headers: { 'x-jj': '1', 'content-type': 'application/octet-stream' }, body: f,
        }).then(function(r){ return r.json(); }).then(function(j){
          if (!j.ok) { tick(j.error || '上传失败'); return; }
          tick('写进 sources/ 了，开始摄入…');
          return fetch('/api/ingest', { method: 'POST', headers: H, body: JSON.stringify({ path: j.path }) })
            .then(function(r){ return r.json(); }).then(function(r){
              tick(r.ok ? ('已摄入 ' + f.name) : ('摄入失败：' + (r.error || r.why || '?')));
              docsView();
            });
        }).catch(function(){ tick('上传失败'); });
      };
      Array.prototype.forEach.call(box.querySelectorAll('[data-docsens]'), function(b){
        b.onclick = function(){
          var id = b.getAttribute('data-docsens');
          var to = b.textContent.indexOf('可出网') >= 0 ? 'shareable' : 'local_only';
          fetch('/api/docs/' + id + '/sensitivity', { method: 'PUT', headers: H, body: JSON.stringify({ value: to }) })
            .then(function(r){ return r.json(); }).then(function(j){
              tick(j.ok === false ? (j.error || '没改成') : ('改成' + (to === 'shareable' ? '可出网' : '仅本地')));
              docsView();
            });
        };
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-docdel]'), function(b){
        b.onclick = function(){
          var id = b.getAttribute('data-docdel');
          if (!window.confirm('忘掉这份文档？（会从检索里去掉）')) return;
          fetch('/api/docs/' + id + '/forget', { method: 'POST', headers: H, body: '{}' })
            .then(function(r){ return r.json(); }).then(function(j){
              tick(j.ok === false ? (j.error || '没删成') : '已忘掉');
              docsView();
            });
        };
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-doc]'), function(b){
        b.onclick = function(){ docDetail(b.getAttribute('data-doc')); };
      });
    }).catch(function(){
      var box = $('nb-docs'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>';
    });
  }

  function docDetail(id){
    var el = $('nb-view');
    el.innerHTML = head('文档', '<button class="nb-btn" id="nb-dback">← 回文档</button>') +
      wrap('<div class="nb-empty">读取中…</div>');
    var b = $('nb-dback'); if (b) b.onclick = function(){ docsView(); };
    fetch('/api/docs/' + encodeURIComponent(id)).then(function(r){ return r.json(); }).then(function(j){
      var doc = (j && j.doc) || {};
      var chunks = (j && j.chunks) || [];
      var html = '<div class="nb-kv"><b>标题</b><span>' + esc(doc.title || id) + '</span>' +
        '<b>块数</b><span>' + esc(String(doc.n_chunks || chunks.length)) + '</span></div>' +
        chunks.slice(0, 12).map(function(c){
          return '<div class="nb-row" style="cursor:default"><span class="tag">#' + esc(c.ord) + '</span>' +
            esc(String(c.heading_path || '')) + '<span class="m">' + esc(String(c.text || '').slice(0, 160)) + '</span></div>';
        }).join('') +
        '<div style="margin-top:12px"><button class="nb-btn danger" id="nb-dforget">忘掉这篇</button></div>';
      el.innerHTML = head('文档', '<button class="nb-btn" id="nb-dback2">← 回文档</button>') + wrap(html);
      var b2 = $('nb-dback2'), f = $('nb-dforget');
      if (b2) b2.onclick = function(){ docsView(); };
      if (f) f.onclick = function(){
        fetch('/api/docs/' + encodeURIComponent(id) + '/forget', { method: 'POST', headers: H, body: '{}' })
          .then(function(){ tick('已忘掉这篇文档'); docsView(); });
      };
    }).catch(function(){
      el.innerHTML = head('文档') + wrap('<div class="nb-empty">读取失败。</div>');
    });
  }

  function capView(){
    var el = $('nb-view');
    el.innerHTML = head('能力') + wrap('<div id="nb-cap"><div class="nb-empty">读取中…</div></div>');
    fetch('/api/capabilities').then(function(r){ return r.json(); }).then(function(j){
      var tools = ((j.classes && j.classes.tool) || []);
      var deg = j.degraded || [];
      var html = '<div class="nb-kv"><b>工具</b><span>' + tools.length + ' 项</span>' +
        '<b>降级</b><span>' + (deg.length ? esc(deg.join(' · ')) : '没有') + '</span></div>' +
        tools.slice(0, 40).map(function(t){
          return '<div class="nb-row" style="cursor:default"><span class="tag">' + esc(t.tier) + '</span>' +
            esc(t.name) + '<span class="m">' + esc(String(t.note || '').slice(0, 120)) + '</span></div>';
        }).join('');
      var box = $('nb-cap'); if (box) box.innerHTML = html;
      paintPlugins();
    }).catch(function(){});

    // 插件：MCP 服务器与技能（增删 + 重连）—— 旧面板有，新界面之前只剩只读
    function paintPlugins(){
      fetch('/api/plugins').then(function(r){ return r.json(); }).then(function(j){
        var box = $('nb-cap'); if (!box || !j.ok) return;
        var mcp = j.mcp || [], sk = j.skills || [];
        box.innerHTML += '<div class="nb-sec">MCP 服务器</div>' +
          (mcp.length ? mcp.map(function(m){
            return '<div class="nb-row" style="cursor:default"><span class="tag">' + esc(m.trust || 'trusted') + '</span>' +
              esc(m.name) + '<span class="m">' + esc([m.command].concat(m.args || []).join(' ').slice(0, 90)) + '</span>' +
              '<button class="nb-btn danger" data-delmcp="' + esc(m.name) + '">删</button></div>';
          }).join('') : '<div class="nb-empty">还没接 MCP 服务器。</div>') +
          '<div class="nb-form" style="margin-top:8px">' +
          '<input id="nb-mcpname" class="nb-search" placeholder="名字，如 filesystem">' +
          '<input id="nb-mcpcmd" class="nb-search" placeholder="命令，如 npx">' +
          '<input id="nb-mcpargs" class="nb-search" placeholder="参数，空格分隔：-y @modelcontextprotocol/server-filesystem D:/tmp">' +
          '<div class="nb-actrow"><button class="nb-btn" id="nb-mcpadd">接上</button>' +
          '<button class="nb-btn" id="nb-mcpre">重连全部</button>' +
          '<span class="nb-empty" id="nb-mcpmsg"></span></div></div>' +
          '<div class="nb-sec">技能</div>' +
          (sk.length ? sk.map(function(x){
            return '<div class="nb-row" style="cursor:default"><span class="tag">skill</span>' + esc(x.id || x.name || '?') +
              '<span class="m">' + esc(String(x.description || x.title || '').slice(0, 70)) + '</span>' +
              '<button class="nb-btn danger" data-delsk="' + esc(x.id || x.name) + '">删</button></div>';
          }).join('') : '<div class="nb-empty">没有额外技能。</div>');

        Array.prototype.forEach.call(box.querySelectorAll('[data-delmcp]'), function(b){
          b.onclick = function(){
            var name = b.getAttribute('data-delmcp');
            if (!window.confirm('删掉 ' + name + '？')) return;
            fetch('/api/plugins', { method: 'POST', headers: H, body: JSON.stringify({ kind: 'mcp', action: 'remove', name: name }) })
              .then(function(r){ return r.json(); }).then(function(){ capView(); });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-delsk]'), function(b){
          b.onclick = function(){
            var name = b.getAttribute('data-delsk');
            if (!window.confirm('删掉技能 ' + name + '？')) return;
            fetch('/api/plugins', { method: 'POST', headers: H, body: JSON.stringify({ kind: 'skill', action: 'remove', name: name }) })
              .then(function(r){ return r.json(); }).then(function(){ capView(); });
          };
        });
        var add = $('nb-mcpadd');
        if (add) add.onclick = function(){
          var name = ($('nb-mcpname') || {}).value || '';
          var cmd = ($('nb-mcpcmd') || {}).value || '';
          var args = (($('nb-mcpargs') || {}).value || '').split(/\s+/).filter(Boolean);
          var msg = $('nb-mcpmsg');
          if (!name.trim() || !cmd.trim()) { if (msg) msg.textContent = '名字和命令都要填'; return; }
          fetch('/api/plugins', { method: 'POST', headers: H, body: JSON.stringify({ kind: 'mcp', action: 'add', name: name.trim(), command: cmd.trim(), args: args }) })
            .then(function(r){ return r.json(); }).then(function(r){
              if (msg) msg.textContent = r.ok ? '接上了' : (r.error || '没接上');
              if (r.ok) capView();
            });
        };
        var re = $('nb-mcpre');
        if (re) re.onclick = function(){
          var msg = $('nb-mcpmsg');
          fetch('/api/plugins/reconnect', { method: 'POST', headers: H, body: '{}' })
            .then(function(r){ return r.json(); }).then(function(r){
              if (msg) msg.textContent = r.ok ? '重连完了' : (r.why || r.error || '重连失败');
            });
        };
      }).catch(function(){});
    }
  }

  function gitView(){
    var el = $('nb-view');
    function paint(what){
      el.innerHTML = head('校样 · ' + what,
        '<button class="nb-btn" data-g="status">status</button>' +
        '<button class="nb-btn" data-g="diff">diff</button>' +
        '<button class="nb-btn" data-g="log">log</button>') +
        wrap('<div class="nb-pre" id="nb-git">读取中…</div>');
      Array.prototype.forEach.call(el.querySelectorAll('[data-g]'), function(b){
        b.onclick = function(){ paint(b.getAttribute('data-g')); };
      });
      fetch('/api/git?what=' + what).then(function(r){ return r.json(); }).then(function(j){
        var box = $('nb-git');
        if (box) box.textContent = (j && j.ok ? '' : '（读不到：' + ((j && j.code) || '?') + '）') + String((j && j.output) || '');
      }).catch(function(){});
    }
    paint('status');
  }

  // 模型一览（旧面板有 modelpicker）：装了什么、多大、给哪个角色用、测一句
  function modelPicker(){
    var box = $('nb-modals');
    if (!box) {
      box = document.createElement('div');
      box.id = 'nb-modals';
      document.body.appendChild(box);
    }
    box.innerHTML = '<div class="nb-modal-bg" id="nb-mdbg"></div>' +
      '<div class="nb-modal"><div class="nb-sec" style="margin-top:0">已装的模型</div>' +
      '<div id="nb-mdlist"><div class="nb-empty">读取中…</div></div>' +
      '<div class="nb-actrow" style="margin-top:10px">' +
      '<button class="nb-btn" id="nb-mdtest">测一句</button>' +
      '<span class="nb-empty" id="nb-mdmsg"></span>' +
      '<button class="nb-btn" id="nb-mdclose">关上</button></div></div>';
    $('nb-mdclose').onclick = function(){ box.innerHTML = ''; };
    $('nb-mdbg').onclick = function(){ box.innerHTML = ''; };
    fetch('/api/models').then(function(r){ return r.json(); }).then(function(j){
      var list = j.installed || [];
      var roles = j.roles || {};
      var used = (Array.isArray(roles) ? roles : []).map(function(r){ return r.role + ' → ' + r.model + (r.installed ? '' : '（没装）'); });
      var html = used.length ? '<div class="nb-kv"><b>角色</b><span>' + esc(used.join(' · ')) + '</span></div>' : '';
      html += list.length ? list.map(function(m){
        return '<div class="nb-row" style="cursor:default"><span class="tag">model</span>' + esc(m) +
          '<span class="m">' + (String(m).indexOf('bge') === 0 ? '向量' : '对话/抽取') + '</span></div>';
      }).join('') : '<div class="nb-empty">本机 ollama 里没看到模型。</div>';
      $('nb-mdlist').innerHTML = html;
    }).catch(function(){ $('nb-mdlist').innerHTML = '<div class="nb-empty">读不到模型列表。</div>'; });
    var t = $('nb-mdtest'); if (t) t.onclick = function(){
      $('nb-mdmsg').textContent = '测中…';
      fetch('/api/test-cloud', { method: 'POST', headers: H, body: '{}' })
        .then(function(r){ return r.json(); }).then(function(j){
          $('nb-mdmsg').textContent = j.ok ? ('通：' + String(j.text || '').slice(0, 40)) : ('不通：' + (j.error || j.why || '?'));
        }).catch(function(){ $('nb-mdmsg').textContent = '不通（请求失败）'; });
    };
  }

  function cfgView(){
    var el = $('nb-view');
    // 重渲染（改完某节后刷新）要停在原地：不然滚动位置也一起回到顶部
    var keepScroll = (document.getElementById('nb-page') || {}).scrollTop || 0;
    el.innerHTML = head('设置') + wrap('<div id="nb-cfg"><div class="nb-empty">读取中…</div></div>');
    var chosen = {};
    var SECS = [];
    function sec(t, inner){
      SECS.push(t);
      var i = SECS.length;
      // 一次只显示一节：设置页有近两千像素高，靠滚动真的会看不见（用户连问两次）
      return '<div class="nb-secwrap" data-i="' + i + '"' + (i === CFG_TAB + 1 ? '' : ' hidden') + '>' +
        '<div class="nb-sec" id="cf-sec-' + i + '">' + t + '</div>' + inner + '</div>';
    }
    function field(label, id, val, ph){
      return '<label class="nb-fld"><span>' + label + '</span>' +
        '<input id="' + id + '" class="nb-search" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '"></label>';
    }
    // 原生 <select> 的弹层由系统画，暗色主题下仍然是白底灰字（用户截图就是这个）。
    // 所以这里一律用自己画的一排按钮，配色可控。
    function optRow(k, opts, cur, label){
      var hit = opts.filter(function(x){ return cur && String(x).indexOf(cur) === 0; })[0] || opts[0] || '';
      chosen[k] = chosen[k] || hit;
      return '<div class="nb-fld"><span>' + label + '</span><div class="nb-opts" data-k="' + k + '">' +
        opts.map(function(x){
          return '<button class="nb-opt' + (x === chosen[k] ? ' on' : '') + '" data-v="' + esc(x) + '">' + esc(x) + '</button>';
        }).join('') + '</div></div>';
    }
    Promise.all([
      fetch('/api/config').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/ui').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/models').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/mode').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/host').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/standing').then(function(r){ return r.json(); }).catch(function(){ return []; }),
      fetch('/api/grants').then(function(r){ return r.json(); }).catch(function(){ return []; }),
      fetch('/api/egress').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/health').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/persona').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/avatars').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/bridge').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/deploy').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
    ]).then(function(res){
      var c = res[0] || {}, ui = res[1] || {}, m = res[2] || {}, mode = (res[3] || {}).mode || 'chat';
      var host = res[4] || {}, sd = Array.isArray(res[5]) ? res[5] : [];
      var grants = Array.isArray(res[6]) ? res[6] : [];
      var eg = res[7] || {}, health = res[8] || {}, persona = res[9] || {};
      var av = res[10] || {}, br = res[11] || {}, dep = res[12] || {};
      var locals = m.installed || [];
      var roleModel = function(n){
        var hit = (m.roles || []).filter(function(x){ return x.role === n; })[0];
        return hit ? String(hit.model) : '';
      };
      var curEmbed = roleModel('embed'), curChat = roleModel('route') || roleModel('default');
      var deg = health.degraded || [];
      var gen = persona.generation || {};
      var html = '';
      html += sec('接口 · 云端',
        '<div class="nb-form">' +
        field('provider', 'cf-prov', c.provider || '', 'deepseek') +
        field('model', 'cf-model', c.model || '', 'deepseek-flash') +
        field('baseUrl', 'cf-base', c.baseUrl || '', '留空用默认') +
        field('key', 'cf-key', '', c.hasKey ? '已有（' + (c.keyFingerprint || '') + '），留空不改' : '粘贴 key') +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-save">保存</button>' +
        '<button class="nb-btn" id="cf-test">测试连接</button>' +
        '<button class="nb-btn danger" id="cf-clear">清除 key</button>' +
        '<span class="nb-empty" id="cf-msg"></span></div></div>');
      html += sec('本地模型',
        '<div class="nb-form">' +
        (locals.length ? optRow('embed', locals, curEmbed, 'embed') + optRow('chat', locals, curChat, 'chat')
          : '<div class="nb-empty">没有已拉模型</div>') +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-msave">保存模型</button>' +
        '<span class="nb-empty">端点 ' + esc(m.endpoint || '—') + ' · ' + (m.online ? '在线' : '离线') +
        ' · 索引 ' + esc((m.index && m.index.current) || '—') + '</span></div></div>');
      html += sec('人格',
        '<div class="nb-form">' + field('名字', 'cf-name', (c.agent && c.agent.name) || '', '她叫什么') +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-nsave">保存名字</button>' +
        '<span class="nb-empty">第 ' + esc(String(gen.index == null ? '—' : gen.index)) + ' 代</span></div>' +
        '<div class="nb-opts" id="cf-pfiles">' +
        (persona.editable || ['core']).map(function(f, i){
          return '<button class="nb-opt' + (i === 0 ? ' on' : '') + '" data-pfile="' + esc(f) + '">' + esc(f) + '</button>';
        }).join('') + '</div>' +
        '<textarea id="cf-ptext" class="nb-search" style="min-height:150px;width:100%;font-family:var(--mono);font-size:12px;line-height:1.7"></textarea>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-psave">保存这块</button>' +
        '<span class="nb-empty" id="cf-pmsg">改动只向前生效，会开新的一代</span></div></div>');
      html += sec('模型一览',
        '<div class="nb-form"><div class="nb-actrow">' +
        '<button class="nb-btn" id="cf-mpick">看看装了哪些模型</button>' +
        '<span class="nb-empty">装了什么 / 多大 / 给哪个角色用 / 测一句</span></div></div>');
      html += sec('头像',
        '<div class="nb-form">' +
        '<div class="nb-fld"><span>她</span><div class="nb-actrow">' +
        (av.agent ? '<img class="nb-av" src="' + esc(av.agent.url) + '" alt="">' : '<span class="nb-empty">默认图标</span>') +
        '<button class="nb-btn" data-pick="agent">换一张</button>' +
        '<button class="nb-btn danger" data-delav="agent">删除</button>' +
        '<input type="file" data-av="agent" accept="image/png,image/jpeg,image/webp" style="display:none"></div></div>' +
        '<div class="nb-fld"><span>你</span><div class="nb-actrow">' +
        (av.user ? '<img class="nb-av" src="' + esc(av.user.url) + '" alt="">' : '<span class="nb-empty">默认图标</span>') +
        '<button class="nb-btn" data-pick="user">换一张</button>' +
        '<button class="nb-btn danger" data-delav="user">删除</button>' +
        '<input type="file" data-av="user" accept="image/png,image/jpeg,image/webp" style="display:none"></div></div>' +
        '<div class="nb-empty">png / jpeg / webp，≤512KB</div></div>');
      html += sec('主机 · 命令解释器',
        '<div class="nb-form">' + optRow('shell', ['auto', 'powershell', 'pwsh', 'gitbash'], host.wanted || 'auto', '用哪个') +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-hsave">保存</button>' +
        '<span class="nb-empty">当前 <b id="cf-hnow">' + esc((host.active && host.active.label) || '—') + '</b>' +
        '<span id="cf-hmsg"></span></span></div></div>');
      html += sec('常驻指令', sd.length ? sd.map(function(x){
        return '<div class="nb-runrow"><span class="k">' + esc(x.when || '') + '</span>' +
          '<span class="v">' + esc(x.because || x.id) + '</span>' +
          '<button class="nb-btn" data-off="' + esc(x.id) + '">停用</button></div>';
      }).join('') : '<div class="nb-empty">没有常驻指令。</div>');
      html += sec('限制',
        '<div class="nb-runrow"><span class="k">档位</span><span class="v">全开（full）</span>' +
        '<span class="m">限制全部撤掉，等软件能用了再谈</span></div>' +
        '<div class="nb-runrow"><span class="k">授权窗口</span><span class="v">' + grants.length + ' 个</span>' +
        '<span class="m">启动自动开，不会逐次问你</span></div>' +
        '<div class="nb-runrow"><span class="k">代码外发</span><span class="v">开</span>' +
        '<span class="m">每次仍写审计</span></div>' +
        '<div class="nb-runrow"><span class="k">超级权限</span>' +
        '<span class="v" id="cf-super-v">读取中…</span>' +
        '<span class="m">只影响「改记忆库本体 / 人格」这一档；trash 与 snapshots 仍然拒</span></div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-super">切换</button>' +
        '<span class="nb-empty" id="cf-super-msg">开着的时候她会跟你确认一次，并记进审计</span></div>');
      html += sec('诊断',
        '<div class="nb-actrow"><button class="nb-btn" id="cf-doc">跑一遍体检</button>' +
        '<span class="nb-empty">按项看，红的会列出来</span></div>' +
        '<div id="cf-docout"></div>');
      html += sec('导出 / 导入',
        '<div class="nb-actrow"><button class="nb-btn" id="cf-exp">导出一份快照</button>' +
        '<span class="nb-empty" id="cf-expmsg">不带 secrets/tokens/snapshots</span></div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-ver">校验一个导出目录</button>' +
        '<button class="nb-btn" id="cf-imp">看导入命令</button></div>' +
        '<div class="nb-empty" id="cf-impout"></div>');
      html += sec('外观',
        '<div class="nb-form"><div class="nb-opts" id="cf-theme">' +
        [['ledger','记录本（黑白 · 紧凑）'],['hermes','Hermes（中性灰 · 宽版式）']].map(function(x){
          return '<button class="nb-opt" data-theme="' + x[0] + '">' + x[1] + '</button>';
        }).join('') + '</div>' +
        '<div class="nb-actrow"><span class="nb-empty">切了立刻生效，不用重启</span></div></div>');
      html += sec('开机片头',
        '<div class="nb-form">' +
        '<div class="nb-opts" id="cf-splash">' +
        ['full','simple','off'].map(function(x){
          var label = x === 'full' ? '完整（约 7 秒）' : x === 'simple' ? '简易（约 3.6 秒）' : '不播';
          return '<button class="nb-opt' + (ui.splash === x ? ' on' : '') + '" data-splash="' + x + '">' + label + '</button>';
        }).join('') + '</div>' +
        '<div class="nb-actrow"><span class="nb-empty">点一下就是新的档位，下次打开生效</span></div></div>');
      html += sec('QQ 接入（OneBot 11）',
        '<div class="nb-form">' +
        '<div class="nb-kv"><b>桥</b><span id="cf-bstate">读取中…</span></div>' +
        field('WebSocket', 'cf-bws', '', 'ws://127.0.0.1:3001') +
        field('她的 QQ 号', 'cf-bid', '', '填 selfId，用来过滤自己发的、判断有没有 @') +
        field('Token', 'cf-btoken', '', 'NapCat 里设了才填') +
        '<div class="nb-opts" id="cf-bmode">' +
        [['private','只回私聊'],['group','只回群里 @'],['all','两者都回']].map(function(x){
          return '<button class="nb-opt" data-bmode="' + x[0] + '">' + x[1] + '</button>';
        }).join('') + '</div>' +
        field('群白名单', 'cf-bgroups', '', '用逗号分隔群号；空 = 一个群都不回') +
        field('群里前缀', 'cf-bprefix', '', '不 @ 时用这个开头，如：鲸鲸，') +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-bsave">保存</button>' +
        '<button class="nb-btn" id="cf-bon">开启</button>' +
        '<button class="nb-btn danger" id="cf-boff">关闭</button>' +
        '<span class="nb-empty" id="cf-bmsg">保存即生效；软件下次启动会自动接着跑</span></div>' +
        '<div class="nb-empty">先装 NapCat 并在它的 WebUI 里开一个 WebSocket 服务器（默认 127.0.0.1:3001），' +
        '再回来填这里。开启后，私聊她就能收到消息；群里要 @ 她（或在白名单里配群号）。</div></div>');
      html += sec('工作区域',
        '<div class="nb-kv"><b>当前数据目录</b><span id="cf-where-home">读取中…</span></div>' +
        '<div class="nb-fld"><label>换到</label><input id="cf-where" placeholder="D:\\Pseudo Digital Life Project"></div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-where-go">改到这里</button>' +
        '<label class="nb-empty" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" id="cf-where-move" style="width:auto">把现有数据一起复制过去</label>' +
        '<span class="nb-empty" id="cf-where-msg">改完重启一次生效</span></div>' +
        '<div class="nb-actrow" style="margin-top:10px"><button class="nb-btn danger" id="cf-wipe">清空重来</button>' +
        '<span class="nb-empty">先自动备份，再清掉记忆与人格，回到引导</span></div>');

      html += sec('引导',
        '<div class="nb-kv"><b>当前状态</b><span id="cf-setupst">读取中…</span></div>' +
        '<div class="nb-actrow"><a class="nb-btn" href="/welcome">继续配置</a>' +
        '<span class="nb-empty">没配好时这里会写着卡在哪一步；配好之后只是重来一遍</span></div>');
      html += sec('部署状态',
        '<div class="nb-kv">' +
        '<b>版本</b><span>' + esc(dep.version || '—') + '</span>' +
        '<b>运行方式</b><span>' + esc(dep.mode || '—') + '</span></div>' +
        '<div class="nb-kv">' +
        '<b>Node</b><span>' + esc(dep.node || '—') + '</span>' +
        '<b>已运行</b><span>' + esc(String(Math.round((dep.uptimeS || 0) / 60))) + ' 分钟</span>' +
        '<b>数据库</b><span>' + esc((Number(dep.dbBytes || 0) / 1048576).toFixed(1)) + ' MB</span>' +
        '<b>目录</b><span>' + esc(dep.home || '—') + '</span>' +
        '<b>降级</b><span>' + (deg.length ? esc(deg.join(' · ')) : '没有') + '</span></div>');
      var box = $('nb-cfg');
      var jump = '<div class="nb-jumpbar">' + SECS.map(function(t, i){
        return '<button class="nb-jump' + (i === CFG_TAB ? ' on' : '') + '" data-i="' + (i + 1) + '">' + esc(t) + '</button>';
      }).join('') + '</div>';
      if (box) box.innerHTML = jump + '<div class="nb-form-wrap">' + html + '</div>';
      if (keepScroll) { var pg0 = document.getElementById('nb-page'); if (pg0) pg0.scrollTop = keepScroll; }
      Array.prototype.forEach.call(box.querySelectorAll('.nb-jump'), function(b){
        b.onclick = function(){
          var want = b.getAttribute('data-i');
          CFG_TAB = Number(want) - 1;
          Array.prototype.forEach.call(box.querySelectorAll('.nb-jump'), function(x){ x.className = 'nb-jump'; });
          b.className = 'nb-jump on';
          Array.prototype.forEach.call(box.querySelectorAll('.nb-secwrap'), function(w){
            w.hidden = w.getAttribute('data-i') !== want;
          });
          var pg = document.getElementById('nb-page'); if (pg) pg.scrollTop = 0;
        };
      });
      function msg(t, ok){ var e = $('cf-msg'); if (e) { e.textContent = t; e.className = 'hint ' + (ok ? 'ok' : 'err'); } }
      function on(id, fn){ var b = $(id); if (b) b.onclick = fn; }
      Array.prototype.forEach.call(box.querySelectorAll('.nb-opts'), function(g){
        g.onclick = function(e){
          var b = e.target;
          if (!b || b.className.indexOf('nb-opt') < 0) return;
          chosen[g.getAttribute('data-k')] = b.getAttribute('data-v');
          Array.prototype.forEach.call(g.children, function(x){ x.className = 'nb-opt' + (x === b ? ' on' : ''); });
        };
      });
      on('cf-save', function(){
        var b = { provider: $('cf-prov').value.trim(), model: $('cf-model').value.trim() };
        if ($('cf-base').value.trim()) b.baseUrl = $('cf-base').value.trim();
        if ($('cf-key').value.trim()) b.key = $('cf-key').value.trim();
        fetch('/api/config', { method: 'PUT', headers: H, body: JSON.stringify(b) })
          .then(function(r){ return r.json(); }).then(function(j){ msg(j.ok ? '已保存' : (j.error || '失败'), !!j.ok); });
      });
      on('cf-test', function(){
        msg('测试中…', true);
        fetch('/api/test-cloud', { method: 'POST', headers: H, body: '{}' })
          .then(function(r){ return r.json(); }).then(function(j){
            msg(j.ok ? ('通了 · ' + j.ms + 'ms') : (j.error || j.hint || '不通'), !!j.ok);
          });
      });
      on('cf-msave', function(){
        var b = {};
        if (chosen.embed) b.embed = chosen.embed;
        if (chosen.chat) b.default = chosen.chat;
        fetch('/api/models', { method: 'PUT', headers: H, body: JSON.stringify(b) })
          .then(function(r){ return r.json(); }).then(function(j){ msg(j.ok ? '模型已保存' : (j.error || '失败'), !!j.ok); });
      });
      on('cf-nsave', function(){
        fetch('/api/config', { method: 'PUT', headers: H, body: JSON.stringify({ agent: { name: $('cf-name').value.trim() } }) })
          .then(function(r){ return r.json(); }).then(function(j){ msg(j.ok ? '名字已保存' : (j.error || '失败'), !!j.ok); });
      });
      on('cf-mpick', modelPicker);
      // ── QQ 接入（OneBot 11）──
      (function(){
        var cfgB = (br && br.config) || {};
        var st = (br && br.state) || {};
        var setv = function(id, v){ var e = $(id); if (e && v != null) e.value = v; };
        setv('cf-bws', cfgB.ws || 'ws://127.0.0.1:3001');
        setv('cf-bid', cfgB.selfId || '');
        setv('cf-btoken', cfgB.accessToken || '');
        setv('cf-bgroups', (cfgB.allowGroups || []).join(','));
        setv('cf-bprefix', cfgB.prefix || '');
        var curMode = cfgB.mode || 'private';
        function paintMode(){
          Array.prototype.forEach.call(box.querySelectorAll('[data-bmode]'), function(x){
            x.className = 'nb-opt' + (x.getAttribute('data-bmode') === curMode ? ' on' : '');
          });
        }
        paintMode();
        Array.prototype.forEach.call(box.querySelectorAll('[data-bmode]'), function(b){
          b.onclick = function(){ curMode = b.getAttribute('data-bmode'); paintMode(); };
        });
        var stEl = $('cf-bstate');
        if (stEl) stEl.textContent = !cfgB.enabled ? '没开' : (st.connected ? '已连上' : (st.running ? '在跑，但没连上' : '开了，但要重启软件才会起'));
        function save(on){
          var body = {
            enabled: on === undefined ? Boolean(cfgB.enabled) : !!on,
            ws: $('cf-bws') ? $('cf-bws').value.trim() : '',
            selfId: $('cf-bid') ? $('cf-bid').value.trim() : '',
            accessToken: $('cf-btoken') ? $('cf-btoken').value.trim() : '',
            mode: curMode,
            allowGroups: ($('cf-bgroups') ? $('cf-bgroups').value : '').split(',').map(function(x){ return x.trim(); }).filter(Boolean),
            prefix: $('cf-bprefix') ? $('cf-bprefix').value.trim() : '',
          };
          fetch('/api/bridge', { method: 'PUT', headers: H, body: JSON.stringify(body) })
            .then(function(r){ return r.json(); }).then(function(j){
              var m = $('cf-bmsg');
              if (m) m.textContent = j.ok ? ('已保存' + (j.state ? ('·桥：' + (j.state.connected ? '已连上' : j.state.running ? '在跑，没连上' : '没起')) : '')) : (j.why || j.error || '没保存成');
              if (j.ok) setTimeout(cfgView, 600);
            });
        }
        on('cf-bsave', function(){ save(); });
        on('cf-bon', function(){ save(true); });
        on('cf-boff', function(){ save(false); });
      })();
      // ── 人格六块：点哪个填哪个，保存只存当前这块 ──
      var pFiles = persona.files || {};
      var pCur = (persona.editable && persona.editable[0]) || 'core';
      function paintPersona(){
        var t = $('cf-ptext');
        if (t) t.value = String(pFiles[pCur] || '');
        Array.prototype.forEach.call(box.querySelectorAll('[data-pfile]'), function(x){
          x.className = 'nb-opt' + (x.getAttribute('data-pfile') === pCur ? ' on' : '');
        });
      }
      Array.prototype.forEach.call(box.querySelectorAll('[data-pfile]'), function(b){
        b.onclick = function(){ pCur = b.getAttribute('data-pfile'); paintPersona(); };
      });
      paintPersona();
      on('cf-psave', function(){
        var t = $('cf-ptext'); if (!t) return;
        fetch('/api/persona', { method: 'PUT', headers: H,
          body: JSON.stringify({ file: pCur, content: t.value, because: '面板里改的' }) })
          .then(function(r){ return r.json(); }).then(function(j){
            var msg = $('cf-pmsg');
            if (msg) msg.textContent = j.ok === false ? (j.error || '没保存成') : ('已保存 ' + pCur);
          });
      });

      // ── 清除云端 key（key:null 才是清除；空字符串是「没传」）──
      on('cf-clear', function(){
        if (!window.confirm('清除云端 key？清完就只能用本地模型，直到重新填。')) return;
        fetch('/api/config', { method: 'PUT', headers: H, body: JSON.stringify({ key: null }) })
          .then(function(r){ return r.json(); }).then(function(j){
            msg(j.ok ? 'key 已清除' : (j.error || '没清成'), !!j.ok);
            cfgView();
          });
      });

      // ── 删头像 ──
      Array.prototype.forEach.call(box.querySelectorAll('[data-delav]'), function(b){
        b.onclick = function(){
          var role = b.getAttribute('data-delav');
          if (!window.confirm('删掉这个头像？')) return;
          fetch('/api/avatar?role=' + role, { method: 'DELETE', headers: H })
            .then(function(r){ return r.json(); }).then(function(j){
            tick(j.ok ? '已删除头像' : (j.error || '没删成'));
            if (j.ok) loadAvatars();
            cfgView();
          });
        };
      });
      // 主题：点一下立刻换（同时存进 config）
      var curTheme = ui.theme === 'hermes' ? 'hermes' : 'ledger';
      function paintTheme(){
        Array.prototype.forEach.call(box.querySelectorAll('[data-theme]'), function(x){
          x.className = 'nb-opt' + (x.getAttribute('data-theme') === curTheme ? ' on' : '');
        });
      }
      paintTheme();
      Array.prototype.forEach.call(box.querySelectorAll('[data-theme]'), function(b){
        b.onclick = function(){
          var v = b.getAttribute('data-theme');
          curTheme = v;
          applyTheme(v);
          paintTheme();
          fetch('/api/ui', { method: 'PUT', headers: H, body: JSON.stringify({ theme: v }) })
            .then(function(r){ return r.json(); }).then(function(j){ tick(j.ok ? ('主题：' + (v === 'hermes' ? 'Hermes' : '记录本')) : (j.error || '没存成')); });
        };
      });

      Array.prototype.forEach.call(box.querySelectorAll('[data-splash]'), function(b){
        b.onclick = function(){
          var v = b.getAttribute('data-splash');
          fetch('/api/ui', { method: 'PUT', headers: H, body: JSON.stringify({ splash: v }) })
            .then(function(r){ return r.json(); }).then(function(j){
              if (!j.ok) { tick(j.error || '没保存成'); return; }
              Array.prototype.forEach.call(box.querySelectorAll('[data-splash]'), function(x){ x.className = 'nb-opt'; });
              b.className = 'nb-opt on';
              tick('片头：' + (v === 'off' ? '不播' : v) + '（下次打开生效）');
            });
        };
      });
      // 工作区域：读当前目录 → 改（可选搬数据）→ 清空重来
      fetch('/api/where').then(function(r){ return r.json(); }).then(function(j){
        var h = $('cf-where-home');
        if (h) h.textContent = (j && j.home) || '—';
        var i = $('cf-where');
        if (i && j && j.root) i.value = j.root;
      }).catch(function(){ var h = $('cf-where-home'); if (h) h.textContent = '读不到'; });
      on('cf-where-go', function(){
        var i = $('cf-where'), m = $('cf-where-msg'), mv = $('cf-where-move');
        if (!i || !m) return;
        var root = String(i.value || '').trim();
        if (!root) { m.textContent = '先填一个目录'; return; }
        m.textContent = '正在处理…';
        fetch('/api/where', { method: 'PUT', headers: H, body: JSON.stringify({ root: root, move: !!(mv && mv.checked) }) })
          .then(function(r){ return r.json(); })
          .then(function(j){
            if (!j || j.error) { m.textContent = (j && (j.why || j.error)) || '没改成'; return; }
            var n = j.moved && j.moved.files ? ('，复制了 ' + j.moved.files + ' 个文件') : '';
            m.textContent = '已改到 ' + j.root + n + ' —— 重启后生效';
          }).catch(function(){ m.textContent = '没改成'; });
      });
      on('cf-wipe', function(){
        var m = $('cf-where-msg');
        var word = window.prompt('这会清掉全部记忆与人格（会先自动备份）。确认请输入：清空');
        if (word !== '清空') { if (m) m.textContent = '没清（确认词不对）'; return; }
        fetch('/api/reset', { method: 'POST', headers: H, body: JSON.stringify({ action: 'wipe', confirm: word }) })
          .then(function(r){ return r.json(); })
          .then(function(j){
            if (!j || j.error) { if (m) m.textContent = (j && (j.why || j.error)) || '没清成'; return; }
            if (m) m.textContent = '已清空，备份在 ' + j.backup + ' —— 重启后走引导';
          }).catch(function(){ if (m) m.textContent = '没清成'; });
      });

      // 超级权限：读 → 切 → 再读（后端 /api/super 早就有，只是界面没入口）
      var superOn = false;
      function paintSuper(on, why){
        superOn = !!on;
        var v = $('cf-super-v');
        if (v) { v.textContent = on ? '开' : '关'; v.style.color = on ? 'var(--amber)' : ''; }
        var m = $('cf-super-msg');
        if (m && why) m.textContent = why;
      }
      // 引导状态：让人一眼看出「卡在哪」而不是只有一句『重新过一遍』
      var STEPNAME = { detect: '环境检测', ollama: '装 Ollama', embed: '向量模型', chat: '聊天模型',
        api: 'API / 密钥', persona: '人格', smoke: '试运行', first: '第一句话' };
      fetch('/api/setup').then(function(r){ return r.json(); }).then(function(j){
        var el = $('cf-setupst');
        if (!el) return;
        var st = (j && j.session && j.session.status) || 'idle';
        var step = (j && j.session && j.session.step) || 'detect';
        var word = { idle: '还没开始', running: '进行中', paused: '已暂停', skipped: '已跳过', done: '已完成', aborted: '已终止' }[st] || st;
        var tail = st === 'done' ? '' : '（停在：' + (STEPNAME[step] || step) + '）';
        el.textContent = word + tail + ((j && j.needsConfig) ? ' · 还不能对话' : '');
        el.style.color = (j && j.needsConfig) ? 'var(--amber)' : '';
      }).catch(function(){ var el = $('cf-setupst'); if (el) el.textContent = '读不到'; });

      fetch('/api/super').then(function(r){ return r.json(); }).then(function(j){
        paintSuper(!!(j && j.enabled));
      }).catch(function(){ paintSuper(false, '读不到超级权限状态'); });
      on('cf-super', function(){
        var next = !superOn;
        fetch('/api/super', { method: 'POST', headers: H, body: JSON.stringify({ action: next ? 'on' : 'off', because: '面板开关' }) })
          .then(function(r){ return r.json(); })
          .then(function(j){
            if (!j || j.ok === false || j.error) { paintSuper(superOn, (j && (j.why || j.error)) || '切换失败'); return; }
            var on = j && j.state ? j.state.enabled === true : next;
            paintSuper(on, on ? '已开启 —— 改记忆库本体/人格这一档放开（trash 与 snapshots 仍拒）' : '已关闭');
          }).catch(function(){ paintSuper(superOn, '切换失败'); });
      });

      on('cf-hsave', function(){
        fetch('/api/host', { method: 'PUT', headers: H, body: JSON.stringify({ shell: chosen.shell }) })
          .then(function(r){ return r.json(); })
          .then(function(j){
            if (!j || j.ok === false || j.error) { msg(j && (j.error || j.why) ? (j.why || j.error) : '保存失败', false); return; }
            // 保存后**立刻回读并就地重绘**，不用再刷新页面（2026-11-06 用户实测）
            return fetch('/api/host').then(function(r){ return r.json(); }).then(function(h){
              var now = document.getElementById('cf-hnow');
              if (now && h && h.active) now.textContent = h.active.label || h.active.kind || '—';
              var m = document.getElementById('cf-hmsg');
              if (m) m.textContent = h && h.fellBack ? ('（回退原因：' + (h.reason || '不满足条件') + '）') : '';
              msg(h && h.fellBack ? '已保存，但回退了' : '解释器已保存并生效', true);
            });
          }).catch(function(){ msg('保存失败', false); });
      });
      // 「换一张」按钮 → 触发隐藏的 file input（WebView 里 label 包 input 有时不弹框）
      Array.prototype.forEach.call(box.querySelectorAll('[data-pick]'), function(b){
        b.onclick = function(){
          var inp = box.querySelector('input[data-av="' + b.getAttribute('data-pick') + '"]');
          if (inp) inp.click();
        };
      });
      // 头像上传：先在本地缩到 256px 再发。
      // 以前直接把原图 dataURL 发过去 —— 手机拍的图随便就 2–5MB，服务端限 512KB，
      // 于是「换不了」而且看不出为什么（用户实测）。
      function shrink(file, cb){
        var rd = new FileReader();
        rd.onload = function(){
          var img = new Image();
          img.onload = function(){
            try {
              var max = 256;
              var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
              var k = Math.min(1, max / Math.max(w, h));
              var cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
              var c = document.createElement('canvas');
              c.id = 'nb-avcanvas';
              c.width = cw; c.height = ch;
              var cx = c.getContext('2d');
              cx.drawImage(img, 0, 0, cw, ch);
              var out = c.toDataURL('image/png');
              // 缩完还大（少见：透明大图），退一层 JPEG
              if (out.length > 480 * 1024) out = c.toDataURL('image/jpeg', 0.86);
              cb(out);
            } catch (e) { cb(rd.result); }
          };
          img.onerror = function(){ cb(rd.result); };
          img.src = String(rd.result);
        };
        rd.readAsDataURL(file);
      }
      Array.prototype.forEach.call(box.querySelectorAll('input[data-av]'), function(inp){
        inp.onchange = function(){
          var f = inp.files && inp.files[0]; if (!f) return;
          shrink(f, function(dataUrl){
            fetch('/api/avatar', { method: 'POST', headers: H, body: JSON.stringify({ role: inp.getAttribute('data-av'), dataUrl: dataUrl }) })
              .then(function(r){ return r.json(); }).then(function(j){
                tick(j.ok ? '头像已换' : (j.hint || j.error || '换不了'));
                if (j.ok) { loadAvatars(); cfgView(); }
              }).catch(function(){ tick('换不了（请求失败）'); });
          });
        };
      });
      on('cf-doc', function(){
        var out = $('cf-docout'); if (out) out.innerHTML = '<div class="nb-empty">在跑…</div>';
        fetch('/api/doctor').then(function(r){ return r.json(); }).then(function(j){
          var rows = (j && j.checks) || [];
          out.innerHTML = rows.map(function(x){
            return '<div class="nb-runrow"><span class="k">' + (x.ok ? '✅' : '❌') + ' ' + esc(x.name) + '</span>' +
              '<span class="v">' + esc(String(x.detail || '').slice(0, 80)) + '</span><span></span></div>';
          }).join('') || '<div class="nb-empty">没有检查项</div>';
        });
      });
      on('cf-exp', function(){
        var out = $('cf-expmsg'); if (out) out.textContent = '导出中…';
        fetch('/api/export', { method: 'POST', headers: H, body: '{}' })
          .then(function(r){ return r.json(); }).then(function(j){
            if (out) out.textContent = j.ok ? ('已导出 ' + j.files + ' 个文件 / ' + (j.bytes / 1048576).toFixed(1) + ' MB → ' + j.outDir) : (j.error || '失败');
          });
      });
      on('cf-ver', function(){
        var out = $('cf-impout'); if (out) out.textContent = '给一个导出目录（绝对路径）';
        var d = window.prompt('导出目录的绝对路径');
        if (!d) return;
        fetch('/api/export/verify?dir=' + encodeURIComponent(d))
          .then(function(r){ return r.json(); }).then(function(j){
            if (out) out.textContent = j.ok ? ('校验通过 · ' + j.files + ' 个文件') : ('有问题：' + (j.problems || []).join('；'));
          });
      });
      on('cf-imp', function(){
        var out = $('cf-impout');
        if (out) out.textContent = 'node src/cli/jingjing.ts import <导出目录>　（导入会换掉整个 home，面板里不做）';
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-off]'), function(b){
        b.onclick = function(){
          fetch('/api/standing/' + encodeURIComponent(b.getAttribute('data-off')) + '/disable', { method: 'POST', headers: H, body: '{}' })
            .then(function(){ tick('已停用'); cfgView(); });
        };
      });
    });
  }

  // ── ⌘K 命令面板（2026-11-05）：会话 / 记忆 / 文档 / 页面 一起搜 ──
  var PAL = [], PALI = 0, PAL_TIMER = 0;
  var PAGES = [
    { k: '页面', v: '工作台', go: 'home' },
    { k: '页面', v: '记录（对话）', go: 'chat' },
    { k: '页面', v: '会话', go: 'sess' },
    { k: '页面', v: '待你处理', go: 'approvals' },
    { k: '页面', v: '记忆', go: 'mem' },
    { k: '页面', v: '文档', go: 'docs' },
    { k: '页面', v: '能力', go: 'cap' },
    { k: '页面', v: '校样', go: 'git' },
    { k: '页面', v: '设置', go: 'cfg' },
    { k: '页面', v: '还缺', go: 'gap' },
  ];
  function palPaint(){
    var box = $('nb-palist');
    if (!box) return;
    box.innerHTML = PAL.length ? PAL.map(function(x, i){
      return '<div class="nb-palrow' + (i === PALI ? ' on' : '') + '" data-i="' + i + '">' +
        '<span class="k">' + esc(x.k) + '</span><span class="v">' + esc(x.v) + '</span></div>';
    }).join('') : '<div class="nb-palrow"><span class="k">—</span><span class="v">没有匹配</span></div>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-i]'), function(b){
      b.onclick = function(){ palPick(Number(b.getAttribute('data-i'))); };
    });
  }
  function palPick(i){
    var it = PAL[i];
    if (!it) return;
    palClose();
    if (it.go) { go(it.go); return; }
    if (it.sess) { go('sess'); sessDetail(it.sess); return; }
    if (it.mem) { go('mem'); memDetail(it.mem); return; }
  }
  function palOpen(){
    var p = $('nb-pal'); if (!p) return;
    p.hidden = false; PAL = PAGES.slice(); PALI = 0; palPaint();
    var q = $('nb-palq'); if (q) { q.value = ''; q.focus(); }
  }
  function palClose(){ var p = $('nb-pal'); if (p) p.hidden = true; }
  function palSearch(q){
    if (!q) { PAL = PAGES.slice(); PALI = 0; palPaint(); return; }
    var lower = q.toLowerCase();
    var local = PAGES.filter(function(x){ return x.v.toLowerCase().indexOf(lower) >= 0; });
    fetch('/api/sessions?limit=50').then(function(r){ return r.json(); }).then(function(j){
      var ss = ((j && j.sessions) || []).filter(function(x){ return String(x.title || '').toLowerCase().indexOf(lower) >= 0; })
        .slice(0, 5).map(function(x){ return { k: '会话', v: x.title || x.id, sess: x.id }; });
      PAL = local.concat(ss); PALI = 0; palPaint();
    }).catch(function(){ PAL = local; PALI = 0; palPaint(); });
    fetch('/api/search?q=' + encodeURIComponent(q)).then(function(r){ return r.json(); }).then(function(j){
      var ms = ((j && j.mem) || []).slice(0, 5).map(function(m){ return { k: '记忆', v: String(m.text || '').slice(0, 60), mem: m.id }; });
      var ds = ((j && j.docs) || []).slice(0, 4).map(function(d){ return { k: '文档', v: String(d.text || '').slice(0, 60) }; });
      PAL = PAL.concat(ms, ds); palPaint();
    }).catch(function(){});
  }
  document.addEventListener('keydown', function(e){
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); palOpen(); return; }
    var p = $('nb-pal');
    if (!p || p.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); palClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); PALI = Math.min(PAL.length - 1, PALI + 1); palPaint(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); PALI = Math.max(0, PALI - 1); palPaint(); return; }
    if (e.key === 'Enter') { e.preventDefault(); palPick(PALI); return; }
  });
  var palQ = $('nb-palq');
  if (palQ) palQ.addEventListener('input', function(){
    clearTimeout(PAL_TIMER);
    var v = palQ.value.trim();
    PAL_TIMER = setTimeout(function(){ palSearch(v); }, 180);
  });
  var palBg = $('nb-pal');
  if (palBg) palBg.addEventListener('click', function(e){ if (e.target === palBg) palClose(); });

  // ── 启动 ─────────────────────────────────────
  var modeChip = $('nb-modechip');
  if (modeChip) modeChip.onclick = function(){
    var now = modeChip.textContent.trim() === '工作' ? 'work' : 'chat';
    var next = now === 'work' ? 'chat' : 'work';
    modeChip.disabled = true;
    fetch('/api/mode', { method: 'POST', headers: H, body: JSON.stringify({ mode: next }) })
      .then(function(r){ return r.json(); }).then(function(j){
        if (j && j.ok) { paintMode(j.mode); tick(j.mode === 'work' ? '工作模式：带上最近几轮' : '聊天模式：只靠记忆召回'); }
        else tick('没切成');
        modeChip.disabled = false;
      }).catch(function(){ tick('没切成'); modeChip.disabled = false; });
  };
  loadTheme();
  loadMode();
  checkSetup();
  loadState(); loadTimeline(); loadTabs(); loadHome(); loadAvatars();
  // 深链接：?view=home|chat|board|mem|docs|cap|git|gap|cfg（截图、书签、排障都靠它）
  (function(){
    var m = /[?&]view=([a-z]+)/.exec(location.search || '');
    var v = m ? m[1] : '';
    if (v === 'board') { go('home'); setTimeout(function(){ Board(true); }, 120); return; }
    if (v === 'chat') { go('chat'); return; }
    if (['mem','docs','cap','git','cfg','gap','sess','approvals','logs','files'].indexOf(v) >= 0) { setTimeout(function(){ go(v); }, 120); return; }
    go('home');
    if (location.search.indexOf("pal=1") >= 0) setTimeout(palOpen, 200);
  })();
  setInterval(function(){ loadState(); loadTabs(); }, 20000);
})();
