(function(){
  var $ = function(id){ return document.getElementById(id); };
  var H = { 'content-type':'application/json', 'x-jj':'1' };
  // 「请求回来就算成功」是假的：/api/standing/bogus/disable 返回 404，界面照样弹「已停用」（2026-11-14 抓到）。
  // 统一走这里：非 2xx 或 body.ok === false 都 reject，message 用服务端给的原因。
  function jsend(method, url, body){
    return fetch(url, { method: method, headers: H, body: JSON.stringify(body || {}) })
      .then(function(r){
        return r.text().then(function(raw){
          var j = {};
          try { j = raw ? JSON.parse(raw) : {}; } catch (e) { j = {}; }
          if (!r.ok || j.ok === false || j.error) {
            var err = new Error(j.why || j.code || j.error || ('HTTP ' + r.status));
            err.status = r.status; err.body = j;
            throw err;
          }
          return j;
        });
      });
  }
  function jpost(url, body){ return jsend('POST', url, body); }
  var TL = [], BOARD = false, CUR = 0, TAB = -1, BUSY = false, AV = {}, AC = null, MEM_OFF = 0, CFG_GRP = 0;
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
    logs: '日志', files: '文件', git: '校样', sys: '系统', cfg: '设置', gap: '还缺', approvals: '待你处理', board: '她收着的', task: '任务', ovw: '能力体检', sto: '存储' };
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
  // 外壳（2026-11-14）：ui.shell 以前只存不用。现在真的有第二种形态：
  // notebook = 三栏记录本；classic = 单栏专注（收左索引与右切口签，≡ 唤回导航）。
  function applyShell(name){
    var h = document.documentElement;
    if (name === 'classic') h.setAttribute('data-shell', 'classic');
    else h.removeAttribute('data-shell');
  }
  function shellPeek(on){ document.documentElement.classList.toggle('shell-peek', !!on); }
  function loadTheme(){
    fetch('/api/ui').then(function(r){ return r.json(); }).then(function(j){
      applyTheme((j && j.theme) || 'ledger');
      applyShell((j && j.shell) || 'notebook');
    }).catch(function(){});
  }
  // ≡ 唤回的导航是浮层：Esc 或点空白就收（避免 classic 下把人困在内容页）
  (function(){
    var b = document.getElementById('nb-navtoggle');
    if (b) b.onclick = function(e){
      e.stopPropagation();
      shellPeek(!document.documentElement.classList.contains('shell-peek'));
    };
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape') shellPeek(false); });
    document.addEventListener('click', function(e){
      if (!document.documentElement.classList.contains('shell-peek')) return;
      var x = e.target;
      if (x && x.closest && x.closest('#nb-navtoggle')) return;
      if (x && x.closest && x.closest('.nb-index')) { if (x.closest('.nb-go')) shellPeek(false); return; }
      shellPeek(false);
    });
  })();

  // ── 顶栏与左栏 ────────────────────────────────
  // 模式：聊天（默认，只靠记忆召回）/ 工作（带最近几轮 + 更宽预算）。
  // 以前面板里根本没有入口 —— 想换只能改 config.json。
  // 自动切档：chip 显示「自动 · <这轮判出来的档>」；手动点了就固定下来（2026-11-07）
  var MODE_AUTO = true, MODE_RESOLVED = 'chat';
  function paintMode(m, resolved){
    var b = $('nb-modechip');
    if (!b) return;
    if (resolved) MODE_RESOLVED = resolved;
    if (m === 'auto') {
      MODE_AUTO = true;
      b.textContent = '自动 · ' + (MODE_RESOLVED === 'work' ? '工作' : '聊天');
      b.className = 'nb-modechip auto' + (MODE_RESOLVED === 'work' ? ' on' : '');
      b.title = '按每句话自己判断该用哪一档；点一下可以手动固定';
    } else {
      MODE_AUTO = false;
      b.textContent = m === 'work' ? '工作' : '聊天';
      b.className = 'nb-modechip' + (m === 'work' ? ' on' : '');
      b.title = '手动固定在这一档；再点两下可以回到自动';
    }
  }
  // 每轮回答里带回来的真实档位（服务端判的），用来更新 chip 后半截
  function noteResolvedMode(m){
    if (!m) return;
    MODE_RESOLVED = m;
    if (MODE_AUTO) paintMode('auto', m);
  }
  function loadMode(){
    fetch('/api/mode').then(function(r){ return r.json(); }).then(function(j){ paintMode((j && j.mode) || 'auto', j && j.resolved); }).catch(function(){});
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
        (b.unanswered ? '<div class="nb-note">这一轮没有生成回答（中途断开或点了停止）</div>' : '') +
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
    // 标本页与「设置/记忆等视图」互斥：不藏起来会叠在一起窜界面
    $('nb-view').hidden = true;
    if (COMPANION) companionOff();
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
          jpost('/api/proposals/' + encodeURIComponent(id), { action: ok ? 'accept' : 'reject' })
            .then(function(){ tick(ok ? '已同意' : '已拒绝'); loadBoard(); loadState(); })
            .catch(function(e){ tick('没' + (ok ? '同意成' : '拒绝成') + '：' + e.message); });
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
      // 顶栏模型标：兜底时写「本地 · 模型名」，并用琥珀色 —— 用户随时知道现在是谁在答（2026-11-07）
      (function(){
        var el = $('nb-model');
        if (!el) return;
        var fb = ctx.expressFallback;
        if (fb) {
          el.textContent = '本地 · ' + (fb.model || '兜底');
          el.style.color = 'var(--amber)';
          el.title = '云端接不上，正在用本机模型作答（只能对话）。填好 key 并成功调用后会自动切回。' + (fb.at ? ' 起于 ' + String(fb.at).slice(11, 16) : '');
        } else {
          el.textContent = ctx.model || '—';
          el.style.color = '';
          el.title = '现在用的表达模型';
        }
      })();
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
      if (b.classList.contains('on')) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
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
    mine.className = 'nb-e me fresh';
    mine.innerHTML = '<div class="g">' + hhmm(new Date().toISOString()) + '<span class="w">你</span></div>' +
      '<div class="b"><div class="nb-say"><div>' + esc(text) + '</div></div></div>';
    $('nb-log').appendChild(mine);

    var her = document.createElement('article');
    her.className = 'nb-e her fresh';
    her.innerHTML = '<div class="g">' + hhmm(new Date().toISOString()) + '<span class="w">她</span></div>' +
      '<div class="b"><div class="nb-say"><div id="nb-live" role="log" aria-live="polite" aria-atomic="true"></div></div></div>';
    var liveBox = her.querySelector('#nb-live');
    if (liveBox) liveBox.className = 'streaming';
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
            if (ev.type === 'mode') {
              // 服务端判定的档位：自动模式下 chip 跟着变
              noteResolvedMode(ev.mode);
            } else if (ev.type === 'done') {
              var lb = $('nb-live'); if (lb) lb.className = '';
            } else if (ev.type === 'reset') {
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
      fetch('/api/nightlog').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
    ]).then(function(res){
      var st = res[0] || {}, sum = res[1] || {}, props = Array.isArray(res[2]) ? res[2] : [];
      var dors = res[3] || {}, health = res[4] || {};
      var use = res[5] || {}, night = res[6] || {}, eg = res[7] || {};
      var sk = res[8] || {}, act = res[9] || {}, nlog = res[10] || {};
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
            (night.running ? '闲时整理正在跑' : '没有在跑的后台任务') + '</span>' +
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
        '<span class="nb-empty" id="nb-nightmsg">闲时整理（闲置 20 小时后自动跑）；手动跑一次不写游标也行</span></div>' +
        ((nlog.runs || []).length ? (nlog.runs || []).slice(0, 5).map(function(r){
          return '<div class="nb-runrow"><span class="k">' + esc(String(r.ts || '').slice(5, 16).replace('T', ' ')) + '</span>' +
            '<span class="v">' + (r.ok ? '整理完了' : '没整理成') + '</span>' +
            '<span class="m">新增 ' + Number(r.added || 0) + ' · 合并 ' + Number(r.merged || 0) + ' · 衰减 ' + Number(r.decayed || 0) + '</span></div>';
        }).join('') : '<div class="nb-empty">还没整理过。</div>') +
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
              ? jpost(it.route, { action: 'accept', reason: '我同意，你来做' })
              : jpost('/api/egress', { action: 'once', path: String(it.id).replace('egress:', '') });
            req.then(function(){ tick('已同意'); paint(); loadState(); })
              .catch(function(e){ tick('没同意成：' + e.message); });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-no]'), function(b){
          b.onclick = function(){
            var it = items[Number(b.getAttribute('data-no'))];
            if (!it) return;
            jpost(it.route, { action: 'reject', reason: '不做' })
              .then(function(){ tick('已拒绝'); paint(); loadState(); })
              .catch(function(e){ tick('没拒绝成：' + e.message); });
          };
        });
        var off = $('nb-egoff');
        if (off) off.onclick = function(){
          jpost('/api/egress', { action: 'revoke' })
            .then(function(){ tick('外发授权已收回'); paint(); loadState(); })
            .catch(function(e){ tick('没收回：' + e.message); });
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
        '<button class="nb-btn" id="nb-undo">撤回最后一轮</button>' +
        '<button class="nb-btn" id="nb-rename">改名</button>' +
        '<button class="nb-btn" id="nb-interrupt">打断回答</button>' +
        '<button class="nb-btn danger" id="nb-close">关闭会话</button></div>';
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
      if (br) br.onclick = function(){ jpost('/api/sessions/' + encodeURIComponent(id) + '/branch', {})
        .then(function(){ tick('已分叉'); sessView(); })
        .catch(function(e){ tick('没分叉：' + e.message); }); };
      var un = $('nb-undo');
      if (un) un.onclick = function(){ jpost('/api/sessions/' + encodeURIComponent(id) + '/undo', {})
        .then(function(){ tick('已撤回最后一轮'); sessDetail(id); })
        .catch(function(e){ tick('没撤回：' + e.message); }); };
      var rn = $('nb-rename');
      if (rn) rn.onclick = function(){
        var title = window.prompt('给这次会话起个名字', String(meta.title || ''));
        if (title == null) return;
        jpost('/api/sessions/' + encodeURIComponent(id) + '/rename', { title: title })
          .then(function(){ tick('已改名'); sessDetail(id); })
          .catch(function(e){ tick('没改名：' + e.message); });
      };
      var it = $('nb-interrupt');
      if (it) it.onclick = function(){
        fetch('/api/sessions/' + encodeURIComponent(id) + '/interrupt', { method: 'POST', headers: H, body: '{}' })
          .then(function(r){ return r.json(); }).then(function(j){ tick(j.interrupted ? '已打断当前回答' : '当前没有在跑的回答'); });
      };
      var cl = $('nb-close');
      if (cl) cl.onclick = function(){
        if (!window.confirm('关闭这次会话？（记录还在，只是不再继续）')) return;
        jpost('/api/sessions/' + encodeURIComponent(id) + '/close', {})
          .then(function(){ tick('已关闭'); sessView(); })
          .catch(function(e){ tick('没关闭：' + e.message); });
      };
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
            jpost('/api/sessions/' + encodeURIComponent(id) + '/turns/' + tid + '/undo', {})
              .then(function(){ tick('已撤回这一轮'); sessDetail(id); })
              .catch(function(e){ tick('没撤回：' + e.message); });
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
  // ── 任务（M7 最小切片）：跨会话把一件事分几步做完 ───────────
  function taskView(){
    var el = $('nb-view');
    el.innerHTML = head('任务', '<span class="nb-empty" id="nb-taskmsg"></span>') + wrap(
      '<div class="nb-actrow"><input id="nb-taskgoal" class="nb-search" placeholder="要她做完什么？（一句话）">' +
      '<button class="nb-btn" id="nb-taskadd">建任务</button></div>' +
      '<div id="nb-tasks"><div class="nb-empty">读取中…</div></div>');

    function paint(){
      fetch('/api/tasks').then(function(r){ return r.json(); }).then(function(j){
        var box = $('nb-tasks');
        if (!box) return;
        var items = (j && j.tasks) || [];
        var n = $('nb-ntask'); if (n) n.textContent = String(items.filter(function(t){ return t.status === 'active'; }).length);
        if (!items.length) { box.innerHTML = '<div class="nb-empty">还没有任务。上面写一句目标就能建一个 —— 她会一步一步做，卡住会来问你。</div>'; return; }
        box.innerHTML = items.map(function(t){
          var mark = t.status === 'active' ? '进行中' : t.status === 'paused' ? '挂起（等你）' : t.status === 'done' ? '完成' : '放弃';
          var steps = (t.steps || []).map(function(x){
            var sm = x.ok === false ? '✗' : x.verified === false ? '?' : '✓';
            return '<div class="nb-row" style="padding:6px 2px"><span class="tag">' + sm + ' ' + x.n + '</span>' + esc(x.intent) +
              (x.verb ? '<span class="m">' + esc(x.verb) + (x.verifyWhy ? ' · ' + esc(x.verifyWhy) : '') + '</span>' :
                '<span class="m">' + esc(x.verifyWhy || '') + '</span>') + '</div>';
          }).join('');
          return '<div class="nb-card">' +
            '<div class="t">#' + t.id + ' ' + esc(t.goal) + '</div>' +
            '<div class="s">' + esc(mark) + (t.stalled ? ' · 连续没进展 ' + t.stalled : '') + ' · ' + (t.steps || []).length + ' 步</div>' +
            (steps || '') +
            '<div class="nb-actrow" style="margin-top:8px">' +
              (t.status === 'active'
                ? '<button class="nb-btn" data-tick="' + t.id + '">推进一步</button>' +
                  '<button class="nb-btn" data-pause="' + t.id + '">挂起</button>'
                : (t.status === 'paused' ? '<button class="nb-btn" data-resume="' + t.id + '">继续</button>' : '')) +
              (t.status === 'done' || t.status === 'abandoned' ? '' : '<button class="nb-btn danger" data-abandon="' + t.id + '">放弃</button>') +
            '</div></div>';
        }).join('');

        Array.prototype.forEach.call(box.querySelectorAll('[data-tick]'), function(b){
          b.onclick = function(){
            var m = $('nb-taskmsg'); if (m) m.textContent = '推进中…（要问一次模型再执行一步，可能十几秒）';
            b.disabled = true;
            fetch('/api/tasks', { method:'POST', headers:H, body: JSON.stringify({ action:'tick', id: Number(b.getAttribute('data-tick')) }) })
              .then(function(r){ return r.json(); })
              .then(function(j){
                var m2 = $('nb-taskmsg');
                if (m2) m2.textContent = j && j.error ? ('没推进：' + (j.why || j.error)) : ('第 ' + (j.step ? j.step.n : '?') + ' 步 → ' + (j.kind || ''));
                paint();
                checkSetup();
              }).catch(function(){ var m3 = $('nb-taskmsg'); if (m3) m3.textContent = '推进失败'; });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-pause],[data-resume],[data-abandon]'), function(b){
          b.onclick = function(){
            var act = b.hasAttribute('data-pause') ? 'pause' : b.hasAttribute('data-resume') ? 'resume' : 'abandon';
            var id = Number(b.getAttribute('data-' + act));
            fetch('/api/tasks', { method:'POST', headers:H, body: JSON.stringify({ action: act, id: id }) })
              .then(function(r){ return r.json(); }).then(function(){ paint(); }).catch(function(){});
          };
        });
      }).catch(function(){ var box = $('nb-tasks'); if (box) box.innerHTML = '<div class="nb-empty">读取失败。</div>'; });
    }

    var addBtn = $('nb-taskadd');
    if (addBtn) addBtn.onclick = function(){
      var i = $('nb-taskgoal'), m = $('nb-taskmsg');
      var goal = String(i && i.value || '').trim();
      if (!goal) { if (m) m.textContent = '先写一句目标'; return; }
      fetch('/api/tasks', { method:'POST', headers:H, body: JSON.stringify({ action:'create', goal: goal }) })
        .then(function(r){ return r.json(); })
        .then(function(j){
          if (j && j.error) { if (m) m.textContent = j.why || j.error; return; }
          if (i) i.value = '';
          if (m) m.textContent = '已建任务 #' + (j.task ? j.task.id : '?');
          paint();
        }).catch(function(){ if (m) m.textContent = '建任务失败'; });
    };
    var gi = $('nb-taskgoal');
    if (gi) gi.onkeydown = function(e){ if (e.key === 'Enter') { var b = $('nb-taskadd'); if (b) b.click(); } };

    paint();
  }
  function go(v){
    VIEW = v;
    BOARD = false;
    if (COMPANION && v !== 'chat') companionOff();
    Array.prototype.forEach.call(document.querySelectorAll('.nb-go[data-v]'), function(x){
      x.className = 'nb-go' + (x.getAttribute('data-v') === v ? ' cur' : '');
      // 选中态同时给念屏（a11y 审计 P2）
      if (x.getAttribute('data-v') === v) x.setAttribute('aria-current', 'page');
      else x.removeAttribute('aria-current');
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
    else if (v === 'ovw') ovwView();
    else if (v === 'sto') stoView();
    else if (v === 'sys') sysView();
    else if (v === 'cfg') cfgView();
    else if (v === 'gap') gapView();
    else if (v === 'task') taskView();
    else if (v === 'sess') sessView();
    else if (v === 'approvals') approvalsView();
    else el.innerHTML = head('？') + wrap('<div class="nb-empty">没有这一页。</div>');
  }
  Array.prototype.forEach.call(document.querySelectorAll('.nb-go[data-v]'), function(b){
    b.onclick = function(){ go(b.getAttribute('data-v')); };
  });

  // ── 记忆浏览器（阶段 4）：列表 + 分面筛选 + 详情抽屉 ─────────────────
  // 三条硬约束：
  //  1) 正文**不可编辑**（决策 3）：抽屉只读。纠错的正确路径是「忘掉 → 重新记住」，
  //     两步都留痕、都能撤销；随手改正文会让「她记得的」和「日志里的」对不上。
  //  2) 空结果不能只说「0 条」，必须给下一步 —— 零命中 ≠ 没发生过。
  //  3) 筛选写进 URL：刷新不丢，也能把一屏筛选直接贴给别人。
  var MEM_F = { scope: '', layer: '', kind: '', since: '', sens: '', sort: '' };
  var MEM_Q = '';
  var MEM_PAGE = 40;
  var MEM_MORE = 40;
  var MEM_FACETS = [
    { k: 'scope', label: '范围', opts: [['', '全部'], ['about', '关于你'], ['outage', '断片']] },
    { k: 'layer', label: '层级', opts: [['', '全部'], ['contract', '契约'], ['narrative', '叙事']] },
    { k: 'since', label: '时间', opts: [['', '全部'], ['7d', '近 7 天'], ['30d', '近 30 天']] },
    { k: 'sens', label: '出网', opts: [['', '全部'], ['local_only', '仅本地'], ['shareable', '可出网']] },
    { k: 'sort', label: '排序', opts: [['', '按权重'], ['created', '最新'], ['oldest', '最早']] }
  ];
  // 词表补充（阶段 4）：KIND 把 fact/fact_hard 都叫「事实」、preference_* 都叫「偏好」，
  // 直接拿来当筛选按钮就会出现两个同名、点了效果不同的按钮（截图验收抓到）。
  var MEM_KIND = { fact_hard: '硬事实', fact: '事实', preference_hard: '强偏好', preference_soft: '弱偏好' };
  function memKind(k){ return MEM_KIND[k] || KIND[k] || k || '记忆'; }
  var MEM_LAYER = { contract: '契约', narrative: '叙事' };
  var MEM_STAGE = { active: '活跃', fading: '淡出中', dormant: '休眠' };

  function memFromUrl(){
    var p = new URLSearchParams(location.search);
    MEM_F = {
      scope: p.get('scope') || '', layer: p.get('layer') || '', kind: p.get('kind') || '',
      since: p.get('since') || '', sens: p.get('sens') || '', sort: p.get('sort') || ''
    };
  }
  function memQs(extra){
    var p = [];
    Object.keys(MEM_F).forEach(function(k){ if (MEM_F[k]) p.push(k + '=' + encodeURIComponent(MEM_F[k])); });
    if (extra) p.push(extra);
    return p.length ? '?' + p.join('&') : '';
  }
  function memCommit(){
    // go() 本身不改 URL（全站如此），这里只补 query，不触发视图切换
    try {
      var parts = ['view=mem'];
      Object.keys(MEM_F).forEach(function(k){ if (MEM_F[k]) parts.push(k + '=' + encodeURIComponent(MEM_F[k])); });
      history.replaceState(null, '', location.pathname + '?' + parts.join('&'));
    } catch (e) { /* 老浏览器 / 特殊宿主：不影响功能，只是刷新会丢筛选 */ }
  }
  function memActive(){
    var out = [];
    MEM_FACETS.forEach(function(f){
      if (!MEM_F[f.k]) return;
      var hit = f.opts.filter(function(o){ return o[0] === MEM_F[f.k]; })[0];
      out.push(f.label + '：' + (hit ? hit[1] : MEM_F[f.k]));
    });
    if (MEM_F.kind) out.push('种类：' + memKind(MEM_F.kind));
    return out;
  }
  function memChip(k, val, label, on){
    return '<button class="nb-opt' + (on ? ' on' : '') + '" data-mf="' + esc(k) + '" data-mfv="' + esc(val) + '">' + esc(label) + '</button>';
  }

  // ── 趋势（阶段 5）──────────────────────────────────────────────────
  // 两条画图原则，与 src/trends.ts 文件头注释一一对应：
  // ① 柱状只画「每日新增」，累计改用文字 —— 两套量纲叠一张图必然被误读
  // ② 衰减曲线横轴是**记忆年龄**，不是日期：库里没有逐日权重快照，
  //    按日期画等于把今天算出来的值按到过去每一天上
  var TRD_OPEN = false, TRD_DAYS = 30, TRD_OUT = false;

  function trdBars(daily){
    // viewBox 宽度贴着实际容器量（实测约 1164）：写 720 会被等比放大约 1.6 倍，
    // 字号跟着放大，整张图虚高一大截
    var W = 1160, H = 150, pl = 32, pr = 10, pt = 12, pb = 20;
    var iw = W - pl - pr, ih = H - pt - pb, n = daily.length || 1;
    var max = 1;
    daily.forEach(function(d){ if (d.created > max) max = d.created; });
    var bw = iw / n, w = Math.max(1.4, bw * 0.6);
    var bars = daily.map(function(d, i){
      if (!d.created) return '';
      var h = Math.max(1.6, ih * d.created / max);
      var x = pl + bw * i + (bw - w) / 2;
      return '<rect x="' + x.toFixed(1) + '" y="' + (pt + ih - h).toFixed(1) +
        '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) +
        '" style="fill:var(--ink);opacity:.82"><title>' + esc(d.date + '：' + d.created + ' 条') + '</title></rect>';
    }).join('');
    // x 轴只标首 / 中 / 末：30 个日期全标会叠成一团
    var idx = [0, Math.floor((n - 1) / 2), n - 1].filter(function(v, i, a){ return v >= 0 && a.indexOf(v) === i; });
    var xlab = idx.map(function(i){
      var d = daily[i]; if (!d) return '';
      var anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
      var x = i === 0 ? pl : (i === n - 1 ? W - pr : pl + bw * i + bw / 2);
      return '<text x="' + x.toFixed(1) + '" y="' + (H - 5) + '" text-anchor="' + anchor +
        '" style="font:9px var(--mono);fill:var(--dim2)">' + esc(d.date.slice(5)) + '</text>';
    }).join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" role="img" aria-label="每日新增记忆条数">' +
      '<line x1="' + pl + '" y1="' + (pt + ih) + '" x2="' + (W - pr) + '" y2="' + (pt + ih) + '" style="stroke:var(--line)"/>' +
      '<text x="' + (pl - 5) + '" y="' + (pt + 5) + '" text-anchor="end" style="font:9px var(--mono);fill:var(--dim2)">' + max + '</text>' +
      '<text x="' + (pl - 5) + '" y="' + (pt + ih) + '" text-anchor="end" style="font:9px var(--mono);fill:var(--dim2)">0</text>' +
      bars + xlab + '</svg>';
  }

  function trdDecay(decay){
    var have = decay.filter(function(b){ return b.n > 0; });
    if (!have.length) return '<div class="nb-empty">这个窗口里没有可算的记忆。</div>';
    var W = 1160, H = 152, pl = 40, pr = 14, pt = 16, pb = 26;
    var iw = W - pl - pr, ih = H - pt - pb, n = decay.length;
    var stepX = n > 1 ? iw / (n - 1) : 0;
    // keep 允许 >1（被召回加强过）。上界按实际最大值取，但至少到 1，否则 1.0 会被顶到框外
    var top = 1;
    have.forEach(function(b){ if (b.keep > top) top = b.keep; });
    var pts = decay.map(function(b, i){
      return { x: pl + stepX * i, y: pt + ih - (Math.min(b.keep, top) / top) * ih, b: b };
    });
    // 没有样本的桶**不画点也不连线**：连线会跨过空桶，看起来像"那段真的掉了"
    var segs = [], cur = [];
    pts.forEach(function(p){
      if (p.b.n > 0) cur.push(p);
      else if (cur.length) { segs.push(cur); cur = []; }
    });
    if (cur.length) segs.push(cur);
    var lines = segs.map(function(s){
      if (s.length < 2) return '';
      return '<polyline points="' + s.map(function(p){ return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ') +
        '" style="fill:none;stroke:var(--ink);stroke-width:1.5;opacity:.85"/>';
    }).join('');
    var dots = pts.filter(function(p){ return p.b.n > 0; }).map(function(p){
      return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="2.6" style="fill:var(--ink)"/>' +
        '<text x="' + p.x.toFixed(1) + '" y="' + (p.y - 10).toFixed(1) + '" text-anchor="middle" ' +
        'style="font:9px var(--mono);fill:var(--dim)">' + p.b.keep.toFixed(2) + '</text>';
    }).join('');
    var xlab = decay.map(function(b, i){
      var x = pl + stepX * i;
      var anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
      return '<text x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + anchor +
        '" style="font:9px var(--mono);fill:' + (b.n > 0 ? 'var(--dim2)' : 'var(--line)') + '">' + esc(b.label) + '</text>';
    }).join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" role="img" aria-label="按记忆年龄的权重保留率">' +
      '<line x1="' + pl + '" y1="' + (pt + ih) + '" x2="' + (W - pr) + '" y2="' + (pt + ih) + '" style="stroke:var(--line)"/>' +
      '<line x1="' + pl + '" y1="' + pt + '" x2="' + (W - pr) + '" y2="' + pt + '" style="stroke:var(--line);stroke-dasharray:3 3"/>' +
      (top >= 0.6 ? (function(){
        // 参考线必须画在它声称的值上：0.5 就落在 0.5 对应的高度，不是「高度的一半」
        var y = pt + ih - (0.5 / top) * ih;
        return '<line x1="' + pl + '" y1="' + y.toFixed(1) + '" x2="' + (W - pr) + '" y2="' + y.toFixed(1) + '" style="stroke:var(--line);stroke-dasharray:2 4"/>' +
          '<text x="' + (pl - 5) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" style="font:9px var(--mono);fill:var(--dim2)">0.5</text>';
      })() : '') +
      '<text x="' + (pl - 5) + '" y="' + (pt + 4) + '" text-anchor="end" style="font:9px var(--mono);fill:var(--dim2)">' + top.toFixed(1) + '</text>' +
      '<text x="' + (pl - 5) + '" y="' + (pt + ih) + '" text-anchor="end" style="font:9px var(--mono);fill:var(--dim2)">0</text>' +
      lines + dots + xlab + '</svg>';
  }

  function trdKindRows(byKind){
    if (!byKind.length) return '<div class="nb-empty">没有种类数据。</div>';
    var maxKeep = 1;
    byKind.forEach(function(k){ if (k.keep > maxKeep) maxKeep = k.keep; });
    // 不用 .nb-runrow：它是给带按钮的操作行用的，行高 35px 配 8px 的条太松，
    // 十条种类排下来像十行表格，看不出是"同类比较"
    return byKind.slice(0, 10).map(function(k){
      var pct = Math.max(2, Math.round(k.keep / maxKeep * 100));
      return '<div style="display:grid;grid-template-columns:104px minmax(80px,1fr) 46px 52px;' +
        'gap:12px;align-items:center;padding:4px 2px">' +
        '<span style="font-size:12.5px;color:var(--ink)">' + esc(memKind(k.kind)) + '</span>' +
        '<span style="height:8px;background:var(--line);display:block">' +
          '<span style="display:block;height:8px;width:' + pct + '%;background:var(--ink);opacity:.8"></span></span>' +
        '<span class="m" style="text-align:right">' + k.keep.toFixed(2) + '</span>' +
        '<span class="m" style="text-align:right">' + k.n + ' 条</span></div>';
    }).join('');
  }

  function trdPaint(j){
    var box = $('nb-mtrend'); if (!box) return;
    var s = j.summary || {}, daily = j.daily || [], decay = j.decay || [], byKind = j.byKind || [];
    var total = daily.reduce(function(a, d){ return a + d.created; }, 0);
    var avg = daily.length ? (total / daily.length) : 0;
    var html = '';
    html += '<div class="nb-actrow" style="gap:8px;margin:2px 0 8px">' +
      '<button class="nb-btn" id="nb-mtrd">收起趋势</button>' +
      '<span class="nb-empty">' + esc(j.from + ' → ' + j.to) + '</span>' +
      '<span style="flex:1"></span>' +
      [7, 30, 90].map(function(d){
        return '<button class="nb-btn" data-trddays="' + d + '"' +
          (d === TRD_DAYS ? ' style="border-color:var(--ink);color:var(--ink)"' : '') + '>' + d + ' 天</button>';
      }).join('') +
      '<button class="nb-btn" data-trdout="1"' + (TRD_OUT ? ' style="border-color:var(--ink);color:var(--ink)"' : '') +
      '>含断片</button></div>';
    html += ovwPart('每日新增', '共 ' + total + ' 条 · 平均 ' + avg.toFixed(1) + ' 条/天',
      trdBars(daily) +
      '<div class="nb-empty" style="margin-top:6px">累计 ' + s.beforeWindow + ' → ' + (s.beforeWindow + total) +
        ' 条（窗口前已有 ' + s.beforeWindow + ' 条）' +
        (s.fading || s.dormant ? '；其中衰减中 ' + s.fading + ' 条、休眠 ' + s.dormant + ' 条' : '') + '</div>');
    html += ovwPart('衰减曲线', '横轴是记忆年龄，不是日期',
      trdDecay(decay) +
      '<div class="nb-empty" style="margin-top:6px">纵轴是平均保留率（当前权重 ÷ 初始权重）。' +
        '没有样本的年龄段不画点、也不连线 —— 连线会跨过空档，看起来像“那段真的掉了”。' +
        '大于 1 表示被召回加强过。</div>');
    html += ovwPart('按种类', byKind.length + ' 种',
      trdKindRows(j.byKind || []));
    html += ovwPart('口径与边界', (j.notes || []).length + ' 条',
      (j.notes || []).map(function(n){
        return '<div style="font:12.5px/1.85 var(--sans);color:var(--dim);padding:2px 2px">' + esc(n) + '</div>';
      }).join(''));
    box.innerHTML = html;

    var close = $('nb-mtrd');
    if (close) close.onclick = function(){ TRD_OPEN = false; memTrendSlot(); };
    Array.prototype.forEach.call(box.querySelectorAll('[data-trddays]'), function(b){
      b.onclick = function(){ TRD_DAYS = Number(b.getAttribute('data-trddays')) || 30; trdLoad(); };
    });
    var ob = box.querySelector('[data-trdout]');
    if (ob) ob.onclick = function(){ TRD_OUT = !TRD_OUT; trdLoad(); };
  }

  function trdLoad(){
    var box = $('nb-mtrend'); if (!box) return;
    box.innerHTML = '<div class="nb-empty">读取中…</div>';
    fetch('/api/memories/trend?days=' + TRD_DAYS + (TRD_OUT ? '&outage=1' : ''))
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (!j || !j.daily) { box.innerHTML = '<div class="nb-empty">趋势读不到：' + esc((j && j.error) || '接口没返回数据') + '</div>'; return; }
        trdPaint(j);
      })
      .catch(function(e){
        if (box) box.innerHTML = '<div class="nb-empty">趋势读不到：' + esc(e.message) + '</div>';
      });
  }

  function memTrendSlot(){
    var box = $('nb-mtrend'); if (!box) return;
    if (!TRD_OPEN) {
      box.innerHTML = '<button class="nb-btn" id="nb-mtrd-open">展开近 30 天趋势</button>' +
        '<span class="nb-empty" style="margin-left:8px">记的东西是越来越多还是越来越少 · 各年龄段还剩下多少</span>';
      var b = $('nb-mtrd-open');
      if (b) b.onclick = function(){ TRD_OPEN = true; trdLoad(); };
      return;
    }
    trdLoad();
  }

  function memView(q){
    memFromUrl();
    if (q !== undefined) MEM_Q = q;
    MEM_MORE = MEM_PAGE;
    var el = $('nb-view');
    el.innerHTML = head('记忆') + wrap(
      '<div class="nb-actrow" style="margin-bottom:6px;gap:8px">' +
        '<input class="nb-search" id="nb-mq" placeholder="搜记忆（回车）——语义召回，不是关键词匹配" value="' + esc(MEM_Q) + '" style="flex:1;min-width:200px">' +
        '<button class="nb-btn" id="nb-mreload">刷新</button></div>' +
      '<div id="nb-mtrend" style="margin:2px 0 8px"></div>' +
      '<div id="nb-mfacet"></div>' +
      '<div id="nb-mstat" class="nb-empty" style="margin:8px 0 4px">读取中…</div>' +
      '<div id="nb-mlist"></div>');
    var box = $('nb-mq');
    if (box) box.onkeydown = function(e){
      if (e.key === 'Enter') { MEM_Q = box.value.trim(); MEM_MORE = MEM_PAGE; memLoad(); }
    };
    var rb = $('nb-mreload'); if (rb) rb.onclick = function(){ memLoad(); };
    memTrendSlot();
    memLoad();
  }

  function memFacets(kinds){
    var box = $('nb-mfacet'); if (!box) return;
    var html = '';
    MEM_FACETS.forEach(function(f){
      html += '<div class="nb-actrow" style="gap:6px;margin:2px 0">' +
        '<span style="font:9.5px/1 var(--mono);letter-spacing:.14em;color:var(--dim2);min-width:30px">' + esc(f.label) + '</span>' +
        f.opts.map(function(o){ return memChip(f.k, o[0], o[1], MEM_F[f.k] === o[0]); }).join('') + '</div>';
    });
    // 种类只列**实际存在**的（summary 给的分布），列一排零结果选项等于让人自己试错
    if (kinds && kinds.length) {
      html += '<div class="nb-actrow" style="gap:6px;margin:2px 0">' +
        '<span style="font:9.5px/1 var(--mono);letter-spacing:.14em;color:var(--dim2);min-width:30px">种类</span>' +
        memChip('kind', '', '全部', !MEM_F.kind) +
        kinds.map(function(x){
          return memChip('kind', x.kind, memKind(x.kind) + ' ' + x.n, MEM_F.kind === x.kind);
        }).join('') + '</div>';
    }
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('[data-mf]'), function(b){
      b.onclick = function(){
        var k = b.getAttribute('data-mf');
        var v = b.getAttribute('data-mfv');
        MEM_F[k] = (MEM_F[k] === v) ? '' : v;
        MEM_MORE = MEM_PAGE;
        memCommit();
        memLoad();
      };
    });
  }

  function memLoad(){
    var list = $('nb-mlist'), stat = $('nb-mstat');
    if (list) list.innerHTML = '<div class="nb-empty">读取中…</div>';
    var extra = 'limit=' + MEM_MORE + (MEM_Q ? '&q=' + encodeURIComponent(MEM_Q) : '');
    Promise.all([
      fetch('/api/memories' + memQs(extra)).then(function(r){ return r.json(); }),
      fetch('/api/memories/summary').then(function(r){ return r.json(); }).catch(function(){ return {}; })
    ]).then(function(res){
      var rows = Array.isArray(res[0]) ? res[0] : [];
      var sum = res[1] || {};
      memFacets(sum.byKind || []);
      var act = memActive();
      if (stat) {
        stat.innerHTML = '<span>' + esc((MEM_Q ? '搜「' + MEM_Q + '」' : '全部') + ' · 显示 ' + rows.length + ' 条' +
            (act.length ? ' · 已筛：' + act.join(' · ') : '')) + '</span>' +
          (act.length || MEM_Q ? ' <button class="nb-btn" id="nb-mclear">清掉条件</button>' : '') +
          '<span style="margin-left:12px;color:var(--dim2)">共 ' + esc(String(sum.total == null ? '?' : sum.total)) +
            ' 条 · 关于你 ' + esc(String(sum.about == null ? '?' : sum.about)) +
            ' · 断片 ' + esc(String(sum.outage == null ? '?' : sum.outage)) +
            ' · 本周新增 ' + esc(String(sum.about7d == null ? 0 : sum.about7d)) + '</span>';
        var cl = $('nb-mclear');
        if (cl) cl.onclick = function(){
          MEM_F = { scope: '', layer: '', kind: '', since: '', sens: '', sort: '' };
          MEM_Q = ''; MEM_MORE = MEM_PAGE; memCommit();
          var qb = $('nb-mq'); if (qb) qb.value = '';
          memLoad();
        };
      }
      if (!rows.length) {
        list.innerHTML = '<div class="nb-empty" style="padding:16px 0;line-height:1.9">没有满足条件的记忆。<br>' +
          '换一组条件，或者清掉条件看全部 —— 空结果只说明这次筛得窄，不说明这些事没发生过。</div>';
        return;
      }
      list.innerHTML = rows.map(function(m){
        var w = Number(m.weight || 0);
        return '<button class="nb-row" data-mem="' + esc(m.id) + '">' +
          '<span class="tag">' + esc(memKind(m.kind)) + '</span>' +
          esc(String(m.text || '').slice(0, 120)) +
          '<span class="m">#' + esc(m.id) + ' · ' + esc(MEM_LAYER[m.layer] || m.layer || '?') +
            ' · ' + esc(MEM_STAGE[m.stage] || m.stage || '?') + ' · 权重 ' + w.toFixed(2) +
            ' · ' + esc(String(m.created_at || '').slice(0, 10)) + '</span></button>';
      }).join('') + (rows.length >= MEM_MORE
        ? '<div class="nb-actrow" style="margin-top:10px"><button class="nb-btn" id="nb-mmore">再多看 ' + MEM_PAGE + ' 条</button></div>'
        : '');
      var mb = $('nb-mmore');
      if (mb) mb.onclick = function(){ MEM_MORE += MEM_PAGE; memLoad(); };
      Array.prototype.forEach.call(list.querySelectorAll('[data-mem]'), function(b){
        b.onclick = function(){ memDrawer(Number(b.getAttribute('data-mem'))); };
      });
    }).catch(function(e){
      if (list) list.innerHTML = '<div class="nb-empty">读取失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  // 详情抽屉：从右侧滑出，列表留在原位。整页跳转再回来，用户得重新滚一遍找刚才那条。
  function memDrawer(id){
    var host = $('nb-mdraw');
    if (!host) {
      host = document.createElement('div');
      host.id = 'nb-mdraw';
      document.body.appendChild(host);
    }
    if (memDrawer._esc) document.removeEventListener('keydown', memDrawer._esc);
    var close = function(){
      host.innerHTML = '';
      if (memDrawer._esc) { document.removeEventListener('keydown', memDrawer._esc); memDrawer._esc = null; }
    };
    memDrawer._esc = function(e){ if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', memDrawer._esc);
    var bindClose = function(){
      Array.prototype.forEach.call(host.querySelectorAll('[data-mclose]'), function(b){ b.onclick = close; });
    };

    host.innerHTML = '<div class="nb-draw-bg" data-mclose="1"></div>' +
      '<div class="nb-draw" role="dialog" aria-modal="true"><div class="nb-empty">读取中…</div></div>';
    bindClose();

    fetch('/api/memories/' + id).then(function(r){ return r.json(); }).then(function(m){
      if (!m || m.error) { close(); tick('找不到 #' + id); return; }
      var kv = [
        ['种类', memKind(m.kind) + (m.layer === 'contract' ? ' · 契约层（不衰减）' : ' · 叙事层')],
        ['状态', (MEM_STAGE[m.stage] || m.stage || '?') + ' · 权重 ' + Number(m.weight || 0).toFixed(2) +
          '（w0 ' + Number(m.w0 || 0).toFixed(2) + '）'],
        ['分量', '重要性 ' + String(m.importance == null ? '?' : m.importance) + '/5 · 被召回 ' + String(m.recall_count || 0) + ' 次'],
        ['来源', (m.source_kind || '?') + (m.source_ref ? ' · ' + m.source_ref : '') +
          ' · ' + (m.sensitivity === 'shareable' ? '可出网' : '仅本地')],
        ['时间', '记于 ' + String(m.created_at || '').slice(0, 16).replace('T', ' ') +
          ' · 末次衰减 ' + String(m.last_decay_at || '').slice(0, 10)]
      ];
      if (m.superseded_by) kv.push(['顶替', '已被 #' + m.superseded_by + ' 取代（不再参与召回）']);
      if (m.generation && m.generation.gen) {
        kv.push(['分代', '第 ' + m.generation.gen + ' 代人格' + (m.generation.because ? ' · ' + m.generation.because : '')]);
      }
      var prov = m.provenance || {};
      var hist = (prov.changes || []).length
        ? '<div class="nb-sec"><span>改过的旧正文（只读留痕）</span></div>' + prov.changes.map(function(c){
            return '<div class="nb-kv" style="margin:0 0 6px"><b>' + esc(String(c.at || '').slice(0, 10)) + '</b>' +
              '<span style="color:var(--dim2)">' + esc(String(c.old || '').slice(0, 200)) + '</span></div>';
          }).join('')
        : '';
      var docLine = (prov.doc && prov.doc.title)
        ? '<div class="nb-kv"><b>来自文档</b><span>' + esc(prov.doc.title) + '</span></div>' : '';

      host.innerHTML = '<div class="nb-draw-bg" data-mclose="1"></div>' +
        '<div class="nb-draw" role="dialog" aria-modal="true">' +
        '<div class="nb-draw-hd"><h2>记忆 #' + esc(m.id) + '</h2><span style="flex:1"></span>' +
        '<button class="nb-btn" data-mclose="1">关闭</button></div>' +
        '<div class="nb-drawtext">' + esc(m.text || '') + '</div>' +
        (m.quote ? '<div class="nb-kv"><b>当时的原话</b><span>' + esc(m.quote) + '</span></div>' : '') +
        docLine +
        '<div class="nb-kv">' + kv.map(function(x){
          return '<b>' + esc(x[0]) + '</b><span>' + esc(x[1]) + '</span>';
        }).join('') + '</div>' +
        hist +
        '<div class="nb-sec"><span>能做什么</span></div>' +
        '<div class="nb-actrow" style="margin-bottom:18px">' +
          '<button class="nb-btn" id="mem-sens">改成' + (m.sensitivity === 'shareable' ? '仅本地' : '可出网') + '</button>' +
          '<button class="nb-btn danger" id="mem-forget">忘掉这条</button></div>' +
        '<div class="nb-sec"><span>为什么不能改正文</span></div>' +
        '<div style="font:12.5px/1.85 var(--sans);color:var(--dim);padding:0 2px 10px">' +
          '记忆记的是「发生过什么」。随手改正文，会让「她记得的」和「日志里的」对不上，' +
          '以后也没法判断哪句是真的。<br>' +
          '要纠正一条记错的，用<b style="color:var(--ink)">忘掉 → 重新记住</b>：' +
          '忘掉只标成 deleted、随时能撤销；重新记住会留一条新事件，两步都有据可查。</div>' +
        '</div>';
      bindClose();

      var sb = host.querySelector('#mem-sens');
      if (sb) sb.onclick = function(){
        var next = m.sensitivity === 'shareable' ? 'local_only' : 'shareable';
        sb.disabled = true;
        jsend('PUT', '/api/memories/' + m.id + '/sensitivity', { value: next })
          .then(function(){
            tick('敏感度：' + (next === 'shareable' ? '可出网' : '仅本地'));
            memDrawer(m.id); memLoad();
          })
          .catch(function(e){ sb.disabled = false; tick('没改成：' + e.message); });
      };

      var fb = host.querySelector('#mem-forget');
      if (fb) fb.onclick = function(){
        if (!window.confirm('忘掉 #' + m.id + '？\n只会标成 deleted、不再参与召回；原始事件和日志都不动，随时能恢复。')) return;
        fb.disabled = true;
        jpost('/api/memories/' + m.id + '/forget', {})
          .then(function(){
            host.innerHTML = '<div class="nb-draw-bg" data-mclose="1"></div><div class="nb-draw">' +
              '<div class="nb-draw-hd"><h2>已忘掉 #' + esc(m.id) + '</h2></div>' +
              '<div class="nb-empty" style="line-height:1.75">已经标成 deleted，不再参与召回。' +
              '原始事件还在 inbox，这条记忆也能原样恢复。</div>' +
              '<div class="nb-actrow" style="margin-top:14px">' +
              '<button class="nb-btn" id="mem-undo">撤销，恢复这条</button>' +
              '<button class="nb-btn" data-mclose="1">关闭</button></div></div>';
            bindClose();
            var ub = host.querySelector('#mem-undo');
            if (ub) ub.onclick = function(){
              jpost('/api/memories/' + m.id + '/restore', {})
                .then(function(){ tick('已恢复 #' + m.id); memDrawer(m.id); memLoad(); })
                .catch(function(e){ tick('没恢复成：' + e.message); });
            };
            memLoad();
          })
          .catch(function(e){ fb.disabled = false; tick('忘不掉：' + e.message); });
      };
    }).catch(function(e){
      host.innerHTML = '<div class="nb-draw-bg" data-mclose="1"></div>' +
        '<div class="nb-draw"><div class="nb-empty">读取失败：' + esc((e && e.message) || e) + '</div></div>';
      bindClose();
    });
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
              if (j.ok === false) { tick(j.error || '没删成'); docsView(); return; }
              tick('已忘掉'); docForgotten(id);
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
        if (!window.confirm('忘掉这篇文档？（会从检索里去掉）')) return;
        fetch('/api/docs/' + encodeURIComponent(id) + '/forget', { method: 'POST', headers: H, body: '{}' })
          .then(function(r){ return r.json(); }).then(function(j){
            if (j.ok === false) { tick(j.error || '没删成'); return; }
            tick('已忘掉这篇文档'); docForgotten(id);
          });
      };
    }).catch(function(){
      el.innerHTML = head('文档') + wrap('<div class="nb-empty">读取失败。</div>');
    });
  }

  // 忘掉之后的落点：给一次撤销（调 /api/docs/:id/restore，恢复会重建 FTS）
  function docForgotten(id){
    var el = $('nb-view');
    el.innerHTML = head('文档', '<button class="nb-btn" id="nd-fback">← 回文档</button>') +
      wrap('<div class="nb-empty">已忘掉这篇。它被标成 deleted（不是物理删除），随时可以撤回来。</div>' +
      '<div class="nb-actrow"><button class="nb-btn" id="nd-fundo">撤销，恢复这篇</button>' +
      '<button class="nb-btn" id="nd-fback2">← 回文档</button></div>');
    var b1 = $('nd-fback'), b2 = $('nd-fback2'), b3 = $('nd-fundo');
    if (b1) b1.onclick = function(){ docsView(); };
    if (b2) b2.onclick = function(){ docsView(); };
    if (b3) b3.onclick = function(){
      fetch('/api/docs/' + encodeURIComponent(id) + '/restore', { method: 'POST', headers: H, body: '{}' })
        .then(function(r){ return r.json(); }).then(function(j){
          if (j.ok === false) { tick(j.error || '没恢复成'); return; }
          tick('已恢复这篇'); docDetail(id);
        });
    };
  }

  // ── 能力体检（阶段 2，2026-11-15）───────────────────────────
  // 数据来自只读接口 /api/overview（src/overview.ts）。这里只做「看清 + 打开入口」，
  // 不做自动下载、不自动开闸；唯一会写盘的是心跳开关，走 PUT /api/ui（同源 + x-jj 闸门）。
  var CAPW = {
    enabled: ['已启用', 'var(--ink)'],
    off:     ['未启用', 'var(--dim2)'],
    missing: ['缺模型 / 素材', 'var(--amber)'],
    gated:   ['需你开闸', 'var(--amber)'],
    unknown: ['未探测', 'var(--dim2)']
  };
  var CAPORDER = ['大脑', '感官', '手脚', '后台', '数据'];
  function ovwBytes(n){
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  // 五态标签：颜色只表示「要不要你动手」，不表示功能好坏
  function ovwTag(state){
    var w = CAPW[state] || CAPW.unknown;
    return '<span class="tag" style="color:' + w[1] + ';cursor:default">' + esc(w[0]) + '</span>';
  }
  function ovwPart(title, note, inner){
    return '<div class="nb-sec"><span>' + esc(title) + '</span>' +
      (note ? '<span class="m" style="margin-left:auto;color:var(--dim2)">' + esc(note) + '</span>' : '') +
      '</div>' + inner;
  }
  function ovwEmpty(t){ return '<div class="nb-empty">' + esc(t) + '</div>'; }
  function ovwView(){
    var el = $('nb-view');
    el.innerHTML = head('能力体检', '<button class="nb-btn" id="ovw-refresh">刷新</button>') +
      wrap('<div class="nb-empty" id="ovw-msg">读取中…</div><div id="ovw-body"></div>');
    var body = $('ovw-body'), msgEl = $('ovw-msg'), btn = $('ovw-refresh');
    var pg = document.getElementById('nb-page'); if (pg) pg.scrollTop = 0;
    var UI = { beat: false };
    if (btn) btn.onclick = function(){ paint(); };

    // 状态标签 / 分节标题 / 空态：存储页也用同一套，避免两页各写一份再慢慢长歪
    var tag = ovwTag, part = ovwPart, empty = ovwEmpty;
    function noteLine(t, color){
      return '<div style="padding:1px 2px 9px;font:11.5px/1.6 var(--mono);color:' + (color || 'var(--dim2)') + '">' + esc(t) + '</div>';
    }
    // 正文级说明（比命令文本重要，用正文字体，不用等宽小字）
    function subLine(t){
      return '<div style="padding:1px 2px 9px;font:12px/1.65 var(--sans);color:var(--dim2)">' + esc(t) + '</div>';
    }
    // 缺环境时给的是「命令文本」，只展示 + 可复制，绝不自动执行（决策 5）
    function hintRow(h){
      return '<div class="nb-runrow" style="grid-template-columns:72px minmax(0,1fr) auto;align-items:center;border-bottom:0;padding:2px 2px 8px">' +
        '<span class="k">怎么办</span>' +
        '<span class="v" style="font-family:var(--mono);font-size:12px;overflow-wrap:anywhere">' + esc(h) + '</span>' +
        '<button class="nb-btn" data-copy="' + esc(h) + '">复制</button></div>';
    }
    function toggleBtn(row){
      if (!row.toggleKey) return '';
      // 目前只有心跳是「配置键 + 需重启」型开关；wsl.autonomous 在设置页已有入口，不在这里开第二个
      if (row.toggleKey !== 'ui.beat') return '';
      var on = !!UI.beat;
      return '<div class="nb-actrow" style="margin:2px 0 10px">' +
        '<button class="nb-btn" data-ovwbeat="1">' + (on ? '关掉心跳' : '打开心跳') + '</button>' +
        '<span class="nb-empty">改的是 config.json，<b>需要重启面板</b>才生效</span></div>';
    }
    function capRow(row){
      var restart = row.restartRequired ? ' <span style="color:var(--dim2)">· 重启生效</span>' : '';
      return '<div class="nb-runrow" style="grid-template-columns:170px 96px minmax(0,1fr);align-items:start">' +
        '<span class="v" style="color:var(--ink)">' + esc(row.label) + '</span>' +
        '<span>' + tag(row.state) + '</span>' +
        '<span style="color:var(--dim);font-size:12px;line-height:1.65">' + esc(row.detail) + restart + '</span>' +
        '</div>' + (row.installHint ? hintRow(row.installHint) : '') + toggleBtn(row);
    }

    function paint(){
      if (msgEl) { msgEl.textContent = '读取中…'; msgEl.style.color = ''; }
      Promise.all([
        fetch('/api/overview').then(function(r){ return r.json(); }),
        fetch('/api/ui').then(function(r){ return r.json(); }).catch(function(){ return {}; })
      ]).then(function(res){
        var j = res[0] || {}, ui = res[1] || {};
        if (msgEl) msgEl.textContent = '';
        UI.beat = !!ui.beat;
        var caps = j.capabilities || [], checks = j.checks || [], models = j.models || [], rs = j.resources || {};

        var ready = caps.filter(function(c){ return c.state === 'enabled'; }).length;
        var bad = checks.filter(function(c){ return c.state !== 'enabled'; }).length;
        var html = '<div class="nb-kv" style="margin-bottom:6px">' +
          '<b>能力</b><span>' + ready + ' / ' + caps.length + ' 项已就绪' +
            (caps.length ? '（未就绪 ' + (caps.length - ready) + ' 项，下面全部列出）' : '') + '</span>' +
          '<b>体检</b><span>' + (bad ? bad + ' 项要你处理' : '没有拦路的问题') + '</span>' +
          '<b>规模</b><span>数据目录 ' + ovwBytes(rs.totalBytes) + ' · ' + (rs.totalFiles || 0) + ' 个文件 · 进程 RSS ' +
            ovwBytes((rs.process || {}).rss) + '</span>' +
          '<b>时间</b><span>' + esc(String(j.generatedAt || '').replace('T', ' ').slice(0, 19)) + '</span>' +
          '</div>';

        // 一、体检：先说要你动手的事
        html += part('体检：要你处理的', bad ? bad + ' 项' : '0 项',
          checks.length ? checks.map(function(c){
            var need = c.state !== 'enabled';
            return '<div class="nb-runrow" style="grid-template-columns:150px 96px minmax(0,1fr) auto;align-items:start">' +
              '<span class="v" style="color:var(--ink)">' + esc(c.label) + '</span>' +
              '<span>' + tag(c.state) + '</span>' +
              '<span style="color:var(--dim);font-size:12px;line-height:1.65">' + esc(c.detail) + '</span>' +
              (need && c.target ? '<button class="nb-btn" data-ovwgo="' + esc(c.target) + '">去设置</button>' : '<span></span>') +
              '</div>' +
              (c.hint ? noteLine(c.hint) : '');
          }).join('') : empty('没有体检项。'));

        // 二、能力清单：五态全列，一行都不藏
        CAPORDER.forEach(function(g){
          var list = caps.filter(function(c){ return c.group === g; });
          if (!list.length) return;
          html += part(g, list.length + ' 项', list.map(capRow).join(''));
        });

        // 三、模型与接口：本地云端共用一张表（集中分类）
        var mcols = 'grid-template-columns:150px 64px minmax(0,1fr) 96px';
        html += part('模型与接口', models.length + ' 个角色',
          models.length ? '<div class="nb-runrow" style="' + mcols + ';padding:4px 2px">' +
            '<span class="k">角色</span><span class="k">哪一侧</span>' +
            '<span class="k">provider / model · 来源</span><span class="k">状态</span></div>' +
            models.map(function(m){
              return '<div class="nb-runrow" style="' + mcols + ';align-items:start">' +
                '<span class="v" style="color:var(--ink)">' + esc(m.purpose) + '</span>' +
                '<span style="font-size:12px;color:var(--dim)">' + esc(m.side) + '</span>' +
                '<span style="font:12px/1.65 var(--mono);color:var(--dim);overflow-wrap:anywhere">' +
                  esc((m.provider || '?') + (m.model ? ' / ' + m.model : ' / 未填')) +
                  ' <span style="color:var(--dim2)">(' + esc(m.source) + ')</span></span>' +
                '<span>' + tag(m.state) + '</span></div>';
            }).join('') : empty('没有模型角色。'));

        // 四、存储：这里只留概要，明细在「存储」页
        //（同一份数字画两个地方会慢慢长歪：口径改了一处、另一处忘了改）
        var groups = rs.groups || [], proc = rs.process || {};
        html += part('存储概要', '明细在「存储」页',
          '<div class="nb-kv"><b>数据目录</b><span>' + ovwBytes(rs.totalBytes) + ' / ' + (rs.totalFiles || 0) + ' 个文件</span>' +
          '<b>进程</b><span>RSS ' + ovwBytes(proc.rss) + ' · heap ' + ovwBytes(proc.heapUsed) +
            ' · 已跑 ' + Math.round(proc.uptimeS || 0) + 's</span>' +
          (groups.length ? '<b>最大几类</b><span>' + groups.slice(0, 3).map(function(g){
            return esc(g.label) + ' ' + ovwBytes(g.bytes);
          }).join(' · ') + '</span>' : '') +
          '</div>' +
          '<div class="nb-actrow" style="margin:2px 0 8px"><button class="nb-btn" data-ovwsto="1">看完整存储明细</button>' +
          (rs.truncated ? '<span class="nb-empty" style="color:var(--amber)">数字不完整：' +
            (Number(rs.depthLimited) > 0 ? '有深层目录被跳过' : '文件数超过扫描上限') + '</span>' : '') +
          '</div>');

        // 五、口径原样展示（服务端写好的边界说明，界面不改写）
        html += part('口径与边界', String((j.notes || []).length) + ' 条',
          (j.notes || []).map(function(n){ return subLine(n); }).join(''));

        body.innerHTML = html;

        // 「去设置」——只切页，不替用户改任何东西
        Array.prototype.forEach.call(body.querySelectorAll('[data-ovwgo]'), function(b){
          b.onclick = function(){ go('cfg'); };
        });
        var stoBtn = body.querySelector('[data-ovwsto]');
        if (stoBtn) stoBtn.onclick = function(){ go('sto'); };
        Array.prototype.forEach.call(body.querySelectorAll('[data-copy]'), function(b){
          b.onclick = function(){
            var t = b.getAttribute('data-copy');
            var done = function(){ tick('已复制：' + t); };
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(t).then(done).catch(function(){ tick('复制不了，手动抄一下'); });
            } else { tick('复制不了，手动抄一下：' + t); }
          };
        });
        // 心跳开关：唯一的写操作，先问再写，写完说清「要重启」
        var bBtn = body.querySelector('[data-ovwbeat]');
        if (bBtn) bBtn.onclick = function(){
          var next = !UI.beat;
          if (!window.confirm(next ? '打开主动开口（心跳）？\n会写 config.json，重启面板后才生效。' : '关掉主动开口？\n会写 config.json，重启面板后才生效。')) return;
          bBtn.disabled = true;
          jsend('PUT', '/api/ui', { beat: next })
            .then(function(){ tick(next ? '已开启：重启面板后开始心跳' : '已关闭：重启面板后停止心跳'); paint(); })
            .catch(function(e){ bBtn.disabled = false; tick('没改成：' + e.message); });
        };
      }).catch(function(e){
        if (msgEl) { msgEl.textContent = '读不到：' + ((e && e.message) || e); msgEl.style.color = 'var(--amber)'; }
      });
    }
    paint();
  }

  // ── 存储（阶段 3）：总览卡片 → 分类明细表（可排序 + 占比条） → 最大文件 ──
  // 数据只来自只读的 /api/overview.resources（一次取回，排序/展开都在本地重绘，不回源）。
  // 不做 treemap、不做历史趋势：PDLP 只有十来类目录，排序表 + 占比条比色块更好读（决策 4）。
  // 任何清理动作都不在这里做——这里只回答「什么占了地方」，不替用户删东西。
  function stoView(){
    var el = $('nb-view');
    el.innerHTML = head('存储', '<button class="nb-btn" id="sto-refresh">刷新</button>') +
      wrap('<div class="nb-empty" id="sto-msg">读取中…</div><div id="sto-body"></div>');
    var body = $('sto-body'), msgEl = $('sto-msg'), btn = $('sto-refresh');
    var pg = document.getElementById('nb-page'); if (pg) pg.scrollTop = 0;
    // 分类列给上限、占比条吃掉剩余宽度：分类名最长也就「记忆库（db / wal / shm）」
    // 那么宽，全给它 1fr 会在名字和条之间留出一大片空档
    var COLS = 'minmax(140px,260px) minmax(80px,1fr) 96px 80px 50px';
    var DATA = null;              // 只存一份快照，排序与展开不重新请求
    var sortKey = 'bytes';        // bytes | files | label
    var sortDesc = true;
    var opened = {};              // groupKey -> true
    if (btn) btn.onclick = function(){ load(); };

    function pct(part, whole){ return whole > 0 ? (part / whole) * 100 : 0; }

    function bar(bytes, total){
      var w = pct(bytes, total);
      // 有体积就给一条能看见的最细线：0.6% 是「有，但很小」，不是「没有」
      if (bytes > 0 && w < 0.6) w = 0.6;
      return '<span style="display:block;height:5px;background:var(--line-dim);position:relative">' +
        '<span style="position:absolute;left:0;top:0;bottom:0;width:' + Math.min(100, w).toFixed(1) +
        '%;background:var(--ink);opacity:.72"></span></span>';
    }

    function card(k, v, m){
      return '<div class="nb-card2"><span class="k">' + esc(k) + '</span><b>' + esc(v) + '</b>' +
        '<span class="m">' + esc(m) + '</span></div>';
    }

    function sortHead(){
      // 表头必须与数据行**逐列对齐**（5 格对 5 列）：百分比单独成列，不能再拿体积的标题去盖占比条
      function h(k, txt, align){
        var on = sortKey === k;
        return '<button class="k" data-sto-sort="' + k + '" style="background:none;border:0;padding:0;cursor:pointer;' +
          'text-align:' + align + ';color:' + (on ? 'var(--ink)' : 'var(--dim2)') + '">' + txt +
          (on ? (sortDesc ? ' ↓' : ' ↑') : '') + '</button>';
      }
      return '<div class="nb-runrow" style="grid-template-columns:' + COLS + ';padding:4px 2px">' +
        '<span style="padding-left:27px">' + h('label', '分类', 'left') + '</span>' +
        '<span></span>' +
        h('bytes', '体积', 'right') +
        h('files', '文件数', 'right') +
        '<span class="k" style="text-align:right;color:var(--dim2)">占比</span></div>';
    }

    function groupRows(groups, total){
      var list = groups.slice();
      list.sort(function(a, b){
        if (sortKey === 'label') return sortDesc ? b.label.localeCompare(a.label) : a.label.localeCompare(b.label);
        if (sortKey === 'files') return sortDesc ? b.files - a.files : a.files - b.files;
        return sortDesc ? b.bytes - a.bytes : a.bytes - b.bytes;
      });
      return list.map(function(g){
        var items = g.items || [];
        var isOpen = !!opened[g.key];
        var head = '<div class="nb-runrow" style="grid-template-columns:' + COLS + ';align-items:center">' +
          '<span class="v" style="color:var(--ink);display:flex;gap:6px;align-items:baseline;min-width:0">' +
            (items.length
              ? '<button class="nb-btn" data-sto-open="' + esc(g.key) + '" title="展开组内明细" ' +
                'style="padding:0 5px;font-size:10px;line-height:15px;min-width:0">' + (isOpen ? '−' : '+') + '</button>'
              : '<span style="display:inline-block;width:21px"></span>') +
            '<span style="overflow-wrap:anywhere">' + esc(g.label) + '</span></span>' +
          '<span>' + bar(g.bytes, total) + '</span>' +
          '<span class="m" style="text-align:right;color:var(--ink)">' + ovwBytes(g.bytes) + '</span>' +
          '<span class="m" style="text-align:right">' + g.files + '</span>' +
          '<span class="m" style="text-align:right">' + pct(g.bytes, total).toFixed(1) + '%</span>' +
          '</div>';
        if (!isOpen) return head;
        return head + items.map(function(it){
          return '<div class="nb-runrow" style="grid-template-columns:' + COLS + ';align-items:center;border-bottom:0;padding:4px 2px">' +
            '<span style="font:12px/1.5 var(--mono);color:var(--dim);padding-left:27px;overflow-wrap:anywhere">' + esc(it.path) + '</span>' +
            '<span></span>' +
            '<span class="m" style="text-align:right">' + ovwBytes(it.bytes) + '</span>' +
            '<span class="m" style="text-align:right">' + it.files + '</span>' +
            '<span class="m" style="text-align:right">' + pct(it.bytes, total).toFixed(1) + '%</span></div>';
        }).join('') +
          (g.itemsOmitted ? '<div class="nb-empty" style="padding:2px 2px 8px 27px">' +
            '还有 ' + g.itemsOmitted + ' 项更小的没列（只保留前 20 项）。</div>' : '');
      }).join('');
    }

    function render(){
      var j = DATA || {};
      var rs = j.resources || {}, proc = rs.process || {}, c = j.counters || {};
      var groups = rs.groups || [], tops = rs.topFiles || [];
      var total = Number(rs.totalBytes) || 0;
      var bad = rs.truncated;

      var cards = '<div class="nb-cards" style="grid-template-columns:repeat(4,minmax(0,1fr))">' +
        card('数据目录', ovwBytes(total), (rs.totalFiles || 0) + ' 个文件' + (bad ? ' · 不完整' : '')) +
        card('进程内存', ovwBytes(proc.rss), 'heap ' + ovwBytes(proc.heapUsed) + ' · external ' + ovwBytes(proc.external)) +
        card('记忆', String(c.memories == null ? '—' : c.memories), '近 7 天 +' + (c.added7d || 0) + ' 条') +
        card('今日花费', '$' + (Number(c.todayUsd) || 0).toFixed(4), (c.calls || 0) + ' 次调用 · 进程已跑 ' +
          Math.round(proc.uptimeS || 0) + 's') +
        '</div>';

      // 不完整原因要分开说：文件数到顶（扫了但没扫完）和深度截断（跳过整棵子树）后果不同
      var warn = bad
        ? '<div style="margin:8px 0 2px;font:11.5px/1.7 var(--mono);color:var(--amber)">' +
          '数字不完整：' + (Number(rs.depthLimited) > 0
            ? '有 ' + rs.depthLimited + ' 个深层子目录超出扫描深度被整棵跳过'
            : '文件数超过扫描上限') + '。别把这张表当准数。</div>'
        : '<div style="margin:8px 0 2px;font:11.5px/1.7 var(--mono);color:var(--dim2)">' +
          '已完整扫描数据目录（' + (rs.totalFiles || 0) + ' 个文件，不跟随链接与 junction）。</div>';

      var table = groups.length
        ? sortHead() + groupRows(groups, total)
        : ovwEmpty('数据目录还是空的。');

      var topBlock = tops.length
        ? tops.map(function(f){
            return '<div class="nb-runrow" style="grid-template-columns:minmax(0,1fr) 92px;align-items:center">' +
              '<span style="font:12px/1.5 var(--mono);color:var(--dim);overflow-wrap:anywhere">' + esc(f.path) + '</span>' +
              '<span class="m" style="text-align:right;color:var(--ink)">' + ovwBytes(f.bytes) + '</span></div>';
          }).join('')
        : ovwEmpty('还没扫到文件。');

      body.innerHTML = cards + warn +
        ovwPart('分类明细', groups.length + ' 类 · 点列头排序，点 + 看组内明细', table) +
        ovwPart('最大的文件', '前 ' + tops.length + ' 个', topBlock) +
        ovwPart('口径', '只读快照',
          '<div style="font:11.5px/1.7 var(--mono);color:var(--dim2);padding:0 2px 10px">' +
          '只统计当前这一刻，不留历史、不算趋势；体积按文件实际字节累加，目录本身不占额。' +
          '镜像/素材类大文件都在上面「分类明细」里，这里不会替你删任何东西——' +
          '要清理请自己确认路径后手动处理；inbox 与 memory.db 是事实源，删了就回不来。' +
          '能力与配置层面的体检在「体检」页。</div>');

      Array.prototype.forEach.call(body.querySelectorAll('[data-sto-sort]'), function(b){
        b.onclick = function(){
          var k = b.getAttribute('data-sto-sort');
          if (sortKey === k) sortDesc = !sortDesc; else { sortKey = k; sortDesc = true; }
          render();
        };
      });
      Array.prototype.forEach.call(body.querySelectorAll('[data-sto-open]'), function(b){
        b.onclick = function(){
          var k = b.getAttribute('data-sto-open');
          if (opened[k]) delete opened[k]; else opened[k] = true;
          render();
        };
      });
    }

    function load(){
      if (msgEl) { msgEl.textContent = '读取中…'; msgEl.style.color = ''; }
      fetch('/api/overview').then(function(r){ return r.json(); }).then(function(j){
        if (msgEl) msgEl.textContent = '';
        DATA = j || {};
        render();
      }).catch(function(e){
        if (msgEl) { msgEl.textContent = '读不到：' + ((e && e.message) || e); msgEl.style.color = 'var(--amber)'; }
      });
    }
    load();
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
      paintDrafts();
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

    // 她写的技能草稿箱（2026-11-12）：自我更新接回路——她自己 propose 的草稿，人可上岗/丢/回滚
    function paintDrafts(){
      fetch('/api/skills/drafts').then(function(r){ return r.json(); }).then(function(j){
        var box = $('nb-cap'); if (!box) return;
        var drafts = j.drafts || [], vers = j.versions || [];
        box.innerHTML += '<div class="nb-sec">她写的技能 · 草稿箱</div>' +
          (j.frozenUntil ? '<div class="nb-empty">自我更新冻结到 ' + esc(String(j.frozenUntil).slice(0, 16)) + '（连续失败太多次）</div>' : '') +
          (drafts.length ? drafts.map(function(d){
            return '<div class="nb-runrow"><span class="k">' + esc(d.id) + '</span>' +
              '<span class="v">' + esc(String(d.because || '').slice(0, 60)) + '</span>' +
              '<button class="nb-btn" data-promote="' + esc(d.id) + '">上岗</button>' +
              '<button class="nb-btn danger" data-drop="' + esc(d.id) + '">丢</button></div>';
          }).join('') : '<div class="nb-empty">她还没写草稿（skill.propose）。</div>') +
          (vers.length ? '<div class="nb-sec">最近改了什么</div>' + vers.slice(0, 5).map(function(v){
            return '<div class="nb-row" style="cursor:default"><span class="tag">ver</span>' + esc(v.file) +
              '<span class="m">' + esc(String(v.text || '').split(String.fromCharCode(10)).slice(2, 4).join(' · ').slice(0, 80)) + '</span></div>';
          }).join('') : '');
        Array.prototype.forEach.call(box.querySelectorAll('[data-promote]'), function(b){
          b.onclick = function(){
            fetch('/api/skills/drafts/' + encodeURIComponent(b.getAttribute('data-promote')) + '/promote', { method: 'POST', headers: H, body: '{}' })
              .then(function(r){ return r.json(); }).then(function(r){ tick(r.ok ? '已上岗' : (r.why || r.error || '没上岗')); capView(); });
          };
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-drop]'), function(b){
          b.onclick = function(){
            if (!window.confirm('丢掉草稿 ' + b.getAttribute('data-drop') + '？')) return;
            fetch('/api/skills/drafts/' + encodeURIComponent(b.getAttribute('data-drop')) + '/drop', { method: 'POST', headers: H, body: '{}' })
              .then(function(r){ return r.json(); }).then(function(){ capView(); });
          };
        });
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

  // ── 陪伴模式（2026-11-13）：鲸鱼娘（RuiC-2D 绑定的 mesh avatar）占主视觉 + 浮动对话，顶栏右上「陪伴」切换。只替换中间对话区，其余区域保留。 ──
  // CP_SOUND / CP_VOLUME 是**运行时**初值，不写回配置：真正的值从服务端读，
  // 点了开关才落盘。以前写死 true 且只在内存翻转，刷新就回去（2026-11-15）。
  var COMPANION = false, CP_MOUNTED = false, CP_BUSY = false, CP_SOUND = true, CP_VOLUME = 1, CP_AC = null;
  function cpLoadPrefs(cb){
    Promise.all([
      fetch('/api/ui').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/tts/status').then(function(r){ return r.json(); }).catch(function(){ return {}; })
    ]).then(function(a){
      var ui = a[0] || {}, t = a[1] || {};
      CP_SOUND = ui.raw && typeof ui.raw.sound === 'boolean' ? ui.raw.sound : true;
      CP_VOLUME = t.raw && typeof t.raw.volume === 'number' ? t.raw.volume : 1;
      var b = $('cp-sound');
      if (b){ b.setAttribute('aria-pressed', CP_SOUND ? 'true' : 'false'); b.textContent = CP_SOUND ? '🔊' : '🔇'; }
      if (window.JJPal && window.JJPal.setVolume) window.JJPal.setVolume(CP_VOLUME);
      if (cb) cb();
    }).catch(function(){ if (cb) cb(); });
  }
  // 形象/背景的选择存在服务端 config.json（设置页与陪伴视图共用同一份），素材在 <home>/pal
  var CP_PAL = null;
  function cpLoadPal(cb){
    fetch('/api/pal').then(function(r){ return r.json(); }).then(function(s){ CP_PAL = s; if (cb) cb(s); })
      .catch(function(){ if (cb) cb(null); });
  }
  function cpCurAvatar(){
    if (!CP_PAL) return null;
    return (CP_PAL.avatars || []).filter(function(a){ return a.id === CP_PAL.avatar; })[0] || null;
  }
  function cpCurBg(){
    if (!CP_PAL) return null;
    return (CP_PAL.backgrounds || []).filter(function(b){ return b.id === CP_PAL.bg; })[0] || null;
  }
  function cpApplyState(){
    var nb = document.querySelector('.nb'); if (!nb) return;
    var bg = cpCurBg();
    // 有图就铺图（房间/自定义同一条路），没图就是内置海洋渐变；右栏透明浮在上面
    if (bg && bg.url){ nb.setAttribute('data-bg', 'custom'); nb.style.setProperty('--cp-bg', 'url("' + bg.url + '") center 32%/cover no-repeat'); }
    else { nb.setAttribute('data-bg', 'ocean'); nb.style.removeProperty('--cp-bg'); }
    var b = $('cp-bg'); if (b) b.textContent = bg ? String(bg.name).replace('（内置）', '') : '海洋';
    var av = cpCurAvatar();
    var st = $('cp-state'); if (st && av) st.textContent = av.name.replace('（内置）', '') + ' · 在发呆';
  }
  // 表情/动作面板：只有 Live2D 公皮（cubism）才有表情表与动作表，mesh 形象隐藏该按钮
  function cpExprSync(){
    var btn = $('cp-expr'); if (!btn) return;
    var isCub = window.JJPal && window.JJPal.kind && window.JJPal.kind() === 'cubism';
    btn.hidden = !isCub;
    if (!isCub){ var pop0 = $('cp-exprpop'); if (pop0) pop0.hidden = true; return; }
    var pop = $('cp-exprpop'); if (!pop || pop.hidden) return;
    cpExprFill();
  }
  // 镜头/形象调参面板：滑杆实时驱动 JJPal.setTune，读数同步，重置回默认
  function cpCtrlSync(){
    if (!window.JJPal || !window.JJPal.getTune) return;
    var t = window.JJPal.getTune();
    Array.prototype.forEach.call(document.querySelectorAll('#cp-ctrl input[data-tune]'), function(inp){
      var k = inp.getAttribute('data-tune');
      if (typeof t[k] === 'number') {
        if (inp.type === 'checkbox') inp.checked = !!t[k]; else inp.value = String(t[k]);
      }
      var ro = $('tv-' + k); if (ro) ro.textContent = fmtTune(k, t[k]);
    });
  }
  function fmtTune(k, v){
    if (k === 'noseFix') return v ? '开' : '关';
    if (k === 'offX' || k === 'offY') return (v > 0 ? '+' : '') + Math.round(v);
    if (typeof v !== 'number' || !isFinite(v)) return '-';
    return (Math.round(v * 100) / 100).toFixed(2);
  }
  var cpCtrl = $('cp-ctrl'); if (cpCtrl) {
    try { cpCtrl.open = localStorage.getItem('jj.cp.ctrl.open') === '1'; } catch (e) {}
    cpCtrl.addEventListener('toggle', function(){ try { localStorage.setItem('jj.cp.ctrl.open', cpCtrl.open ? '1' : '0'); } catch (e) {} });
    cpCtrl.addEventListener('input', function(e){
      var inp = e.target; if (!inp || !inp.getAttribute) return;
      var k = inp.getAttribute('data-tune'); if (!k) return;
      var v = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : parseFloat(inp.value);
      if (isNaN(v)) return;
      var patch = {}; patch[k] = v;
      if (window.JJPal && window.JJPal.setTune) window.JJPal.setTune(patch);
      var ro = $('tv-' + k); if (ro) ro.textContent = fmtTune(k, v);
    });
  }
  var cpCtrlReset = $('cp-ctrl-reset'); if (cpCtrlReset) cpCtrlReset.onclick = function(){
    if (window.JJPal && window.JJPal.resetTune) window.JJPal.resetTune();
    cpCtrlSync();
  };
  function cpExprFill(){
    var pop = $('cp-exprpop'); if (!pop || !window.JJPal) return;
    var ex = window.JJPal.expressions ? window.JJPal.expressions() : [];
    var mo = window.JJPal.motions ? window.JJPal.motions() : [];
    var html = '<div class="cp-exprsec">表情</div><div class="cp-exprrow">';
    html += ex.length ? ex.map(function(n){ return '<button class="cp-chip" data-expr="' + esc(n) + '">' + esc(n) + '</button>'; }).join('') : '<span class="nb-empty">这个模型没有表情表</span>';
    html += '</div><div class="cp-exprsec">动作</div><div class="cp-exprrow">';
    html += mo.length ? mo.map(function(m){ return '<button class="cp-chip" data-motion="' + esc(m.group) + '" data-mi="' + m.index + '">' + esc(m.name || m.group) + '</button>'; }).join('') : '<span class="nb-empty">这个模型没有动作表</span>';
    html += '</div>';
    pop.innerHTML = html;
  }
  function ensurePal(cb){
    if (window.JJPal) { cb(); return; }
    var s = document.createElement('script');
    s.src = '/ui/pal.js';
    s.onload = function(){ cb(); };
    s.onerror = function(){ tick('形象模块加载失败'); };
    document.head.appendChild(s);
  }
  function cpBubbles(){
    var box = $('cp-bubbles'); if (!box || box.childNodes.length) return;
    for (var i = 0; i < 16; i++){
      var b = document.createElement('span');
      b.className = 'cp-bub';
      var sz = 6 + Math.random() * 26;
      b.style.width = sz + 'px'; b.style.height = sz + 'px';
      b.style.left = (Math.random() * 100) + '%';
      b.style.animationDuration = (9 + Math.random() * 12) + 's';
      b.style.animationDelay = (-Math.random() * 18) + 's';
      box.appendChild(b);
    }
  }
  function cpState(text){ var el = $('cp-state'); if (el) el.textContent = '鲸鱼娘 · ' + text; }
  // ── 气泡 = 同一条对话的最近几条（2026-11-13）。数据源就是 /api/timeline，
  //    和记录本完全是同一份 inbox，所以两边看到的是同一串话，不是两套。──
  var CP_HIST_N = 6, TL_DIRTY = false;
  // 默认只露最近两条（你 + 她），更早的折起来；展开/收起的状态记在本地，下次进来还是你上次选的样子
  var CP_EXPANDED = false;
  try { CP_EXPANDED = localStorage.getItem('jj.cp.log.expanded') === '1'; } catch (e) {}
  function cpLogCount(){ var l = $('cp-log'); return l ? l.querySelectorAll('.cp-line').length : 0; }
  function cpMoreSync(){
    var log = $('cp-log'), btn = $('cp-more'); if (!log || !btn) return;
    var hiddenN = Math.max(0, cpLogCount() - 2);
    // 收起只是把窗口收窄（.cp-log.clip 改 max-height），**不再藏历史行**：
    // 行必须留在滚动容器里，鼠标滚轮才能往上翻回去看
    log.classList.toggle('clip', !CP_EXPANDED);
    btn.hidden = hiddenN <= 0;
    btn.textContent = CP_EXPANDED ? '收起' : ('↑ 之前 ' + hiddenN + ' 条');
  }
  var cpMoreBtn = $('cp-more');
  if (cpMoreBtn) cpMoreBtn.onclick = function(){
    CP_EXPANDED = !CP_EXPANDED;
    try { localStorage.setItem('jj.cp.log.expanded', CP_EXPANDED ? '1' : '0'); } catch (e) {}
    cpMoreSync();
    if (CP_EXPANDED) cpLogTop(); else cpLogBottom();
    var inp = $('cp-say'); if (inp) inp.focus();
  };
  function cpFadeSync(){
    var l = $('cp-log'); if (!l) return;
    var canScroll = l.scrollHeight > l.clientHeight + 2;
    var atTop = l.scrollTop < 4;
    var atBot = l.scrollTop + l.clientHeight > l.scrollHeight - 4;
    l.classList.toggle('fade-top', canScroll && !atTop);
    l.classList.toggle('fade-bottom', canScroll && !atBot);
  }
  // 滚动只在「人本来就在底部」时自动跟最新：往上翻历史时别被新内容硬拽回底部。
  // 这个标志不能现算 —— append 之后 scrollHeight 已经变大，用当前值判断会误以为离底了。
  var CP_AT_BOTTOM = true;
  function cpLogTop(){
    var l = $('cp-log'); if (!l) return;
    CP_AT_BOTTOM = false; l.scrollTop = 0; cpFadeSync();
  }
  function cpLogBottom(){
    var l = $('cp-log'); if (!l) return;
    CP_AT_BOTTOM = true; l.scrollTop = l.scrollHeight; cpFadeSync();
  }
  function cpLogScroll(){
    var l = $('cp-log'); if (!l) return;
    if (CP_AT_BOTTOM) l.scrollTop = l.scrollHeight;
    cpFadeSync();
  }
  var cpLogEl = $('cp-log');
  if (cpLogEl) cpLogEl.addEventListener('scroll', function(){
    CP_AT_BOTTOM = cpLogEl.scrollTop + cpLogEl.clientHeight >= cpLogEl.scrollHeight - 24;
    cpFadeSync();
  });
  // 指针压在「↑ 之前 N 条」或气泡内边距上时，滚轮也该翻的是对话，不是什么都不动。
  // 落点在 cp-log 内部（含工具输出框 .cp-tout）就交给它自己，避免滚两遍。
  var cpBubbleEl = document.querySelector('.cp-bubble');
  if (cpBubbleEl) cpBubbleEl.addEventListener('wheel', function(e){
    var l = cpLogEl; if (!l) return;
    if (e.target === l || (l.contains && l.contains(e.target))) return;
    l.scrollTop += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  // 她这一轮动过什么手：一个胶囊一行，点一下摊开那条结果（再点收起）。
  // 之所以不做成记录页那种 <details> 卡片：气泡只有 580px 宽，还压在房间照片上。
  function cpToolStrip(list){
    var box = document.createElement('div'); box.className = 'cp-tools';
    var out = document.createElement('pre'); out.className = 'cp-tout'; out.hidden = true;
    list.forEach(function(t){
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'cp-tchip';
      b.textContent = String(t.name || '工具') + (t.ms == null ? '' : ' · ' + t.ms + 'ms');
      b.title = '点开看这条的输出';
      b.onclick = function(){
        var open = !b.classList.contains('on');
        Array.prototype.forEach.call(box.querySelectorAll('.cp-tchip'), function(x){ x.classList.remove('on'); });
        if (!open){ out.hidden = true; return; }
        b.classList.add('on');
        out.textContent = String(t.result || '（没有输出）');
        out.hidden = false;
        cpLogScroll();
      };
      box.appendChild(b);
    });
    box.appendChild(out);
    return box;
  }
  // 说完回读一次 /api/timeline，把刚才那条纯文字换成渲染好的 html + 工具胶囊。
  // 为什么不走 SSE 多推一帧：那会破坏「最后一帧是 done」这条约定（面板和手机端都靠它收尾），
  // 而 timeline 里这份 html 本来就算好了（md.ts 只有一份实现）。
  function cpUpgrade(bt, reply){
    if (!bt) return Promise.resolve(false);
    return fetch('/api/timeline').then(function(r){ return r.json(); }).then(function(blocks){
      var msgs = (blocks || []).filter(function(b){ return b.type === 'msg' && b.role === 'agent' && b.text; });
      var last = msgs[msgs.length - 1];
      if (!last || !last.html) return false;
      // 只替换「就是这一条」：这一轮被掐断、或者服务端收尾时改写过正文（步数用完的收尾总结），
      // 对不上就留着流式那段纯文字 —— 宁可没排版，也不能把别人的回答盖到这一条上
      if (last.text.trim() !== String(reply == null ? '' : reply).trim()) return false;
      var bd = cpBodyOf(bt);
      bt.className = 'cp-tx';
      if (bd){ bd.className = 'cp-body cp-md'; bd.innerHTML = last.html; }
      var old = bt.querySelector('.cp-tools'); if (old) old.remove();
      if (last.toolList && last.toolList.length) bt.appendChild(cpToolStrip(last.toolList));
      cpLogScroll();
      return true;
    }).catch(function(){ return false; });
  }
  // 正文放 .cp-body 里，工具胶囊留在 .cp-tx 下当兄弟：
  // 收起态要按行钳正文（.cp-log.clip .cp-body{max-height}），胶囊不能被一起切掉
  function cpBodyOf(tx){ return tx ? (tx.querySelector('.cp-body') || tx) : null; }
  // opts.html：服务端渲染好的 markdown（md.ts 那一份）；不给就按纯文本放
  function cpLine(role, text, opts){
    var log = $('cp-log'); if (!log) return null;
    var d = document.createElement('div');
    d.className = 'cp-line ' + (role === 'me' ? 'cp-me' : 'cp-her');
    var w = document.createElement('span'); w.className = 'cp-who'; w.textContent = role === 'me' ? '你' : '她';
    var t = document.createElement('div'); t.className = 'cp-tx';
    var b = document.createElement('div'); b.className = 'cp-body';
    if (opts && opts.html){ b.className = 'cp-body cp-md'; b.innerHTML = opts.html; }
    else if (text) b.textContent = text;
    t.appendChild(b);
    if (opts && opts.tools && opts.tools.length) t.appendChild(cpToolStrip(opts.tools));
    d.appendChild(w); d.appendChild(t); log.appendChild(d);
    cpMoreSync();
    cpLogScroll();
    return t;
  }
  function cpLoadHistory(){
    var log = $('cp-log'); if (!log) return;
    log.innerHTML = '';
    cpLine('her', '在呢，想聊点什么？');
    cpMoreSync();
    fetch('/api/timeline').then(function(r){ return r.json(); }).then(function(blocks){
      var msgs = (blocks || []).filter(function(b){ return b.type === 'msg' && b.text; }).slice(-CP_HIST_N);
      if (!msgs.length) return;
      log.innerHTML = '';
      // 全文，不再截 200 字（高度上限交给 .cp-log 自己滚）：
      // 之前每条只留前 200 字，「往回看一眼」看到的全是省略号
      msgs.forEach(function(b){
        if (b.role === 'user'){ cpLine('me', b.text); return; }
        cpLine('her', b.text, { html: b.html, tools: b.toolList });
      });
      cpMoreSync();
      cpLogScroll();
    }).catch(function(){ /* 拉不到就留着那句招呼，不影响说话 */ });
  }
  function cpMount(){
    if (CP_MOUNTED) return;
    cpBubbles();
    ensurePal(function(){
      var st = $('cp-stage');
      var av = cpCurAvatar();
      if (st && window.JJPal) {
        var p = window.JJPal.mount(st, av ? av.base : undefined, av ? av.kind : 'mesh', av ? av.entry : undefined);
        CP_MOUNTED = true; CP_AV_MOUNTED = av ? av.id : null;
        if (p && p.then) p.then(function(){ cpExprSync(); cpCtrlSync(); }); else { cpExprSync(); cpCtrlSync(); }
      }
    });
  }
  function cpDestroy(){
    // 不打断正在飞的那一轮（2026-11-13）：切视图 / 换形象只是「看不见」，答案仍然要落盘。
    // 以前这里 CP_AC.abort() 会让服务端 aborted=true 直接丢掉整段回复 —— 用户那一轮就像被吃了。
    // 真要停，用发送键变成的「■ 停止」。
    if (window.JJPal) { try { window.JJPal.destroy(); } catch (e) {} }
    CP_MOUNTED = false;
  }
  // 对话框两种形态：玻璃卡片（默认） ⇄ 纯字幕。选择记在本地，下次进来还是上次的样子
  var CP_SUB = false;
  try { CP_SUB = localStorage.getItem('jj.cp.sub') === '1'; } catch (e) {}
  function cpSubSync(){
    var nb = document.querySelector('.nb');
    if (nb) nb.classList.toggle('sub-mode', CP_SUB);
    var b = $('cp-sub');
    if (b) { b.setAttribute('aria-pressed', CP_SUB ? 'true' : 'false'); b.title = CP_SUB ? '当前：纯字幕（点一下回到玻璃卡片）' : '当前：玻璃卡片（点一下切成纯字幕）'; }
  }
  var cpSubBtn = $('cp-sub');
  if (cpSubBtn) cpSubBtn.onclick = function(){
    CP_SUB = !CP_SUB;
    try { localStorage.setItem('jj.cp.sub', CP_SUB ? '1' : '0'); } catch (e) {}
    cpSubSync();
    var inp = $('cp-say'); if (inp) inp.focus();
  };

  function companionOn(){
    COMPANION = true;
    document.querySelector('.nb').classList.add('companion-on');
    var cp = $('nb-companion'); if (cp) cp.hidden = false; // 去掉 hidden，否则被 [hidden]!important 压住
    var oc = $('nb-composer'); if (oc) oc.hidden = true; // 原文字输入栏在 .nb 之外，CSS 选择器够不到，这里直接藏
    var t = $('nb-companion-toggle'); if (t) t.classList.add('on');
    cpLoadHistory();
    cpSubSync();
    cpLoadPrefs(function(){ cpApplyState(); cpMount(); });
    cpLoadPal(function(){ cpApplyState(); cpMount(); });
    cpState('在发呆');
    var inp = $('cp-say'); if (inp) setTimeout(function(){ inp.focus(); if (typeof cpSayGrow === 'function') cpSayGrow(inp); }, 200);
  }
  function companionOff(){
    COMPANION = false;
    document.querySelector('.nb').classList.remove('companion-on');
    var cp = $('nb-companion'); if (cp) cp.hidden = true;
    var oc = $('nb-composer'); if (oc) oc.hidden = false;
    var t = $('nb-companion-toggle'); if (t) t.classList.remove('on');
    cpDestroy();
    // 在陪伴里说过的话，回记录本要立刻能看到（以前不重拉，那几轮像没发生过）
    if (TL_DIRTY){ TL_DIRTY = false; loadTimeline(); }
  }
  function cpSend(){
    if (CP_BUSY) return;
    var inp = $('cp-say'); var text = (inp.value || '').trim(); if (!text) return;
    inp.value = '';
    if (inp.style) { inp.style.height = 'auto'; }
    CP_BUSY = true;
    // 忙碌时这颗键变成「停止」：这是**唯一**的中断入口，切视图不再偷偷把回答掐掉
    var send = $('cp-send');
    if (send) { send.disabled = false; send.dataset.stop = '1'; send.textContent = '■'; send.title = '停止这一轮'; }
    CP_STOPPED = false;
    // 发了新话就回到底部跟着这一轮走 —— 哪怕刚刚正翻在历史里
    CP_AT_BOTTOM = true;
    cpLine('me', text);                                  // 你说的话也进同一条流
    var bt = cpLine('her', ''); if (bt) bt.className = 'cp-tx cp-typing';
    // 说话期间锁输入，别让人对着一句还没答完的话继续敲
    var box = $('cp-input-box');
    inp.disabled = true; inp.placeholder = '她在想…';
    if (box) box.classList.add('busy');
    cpState('在思考');
    if (window.JJPal) window.JJPal.setState('thinking');
    var reply = '';
    // 这一轮动过的手：从流里捡（tool / tool_result 两帧），说完再挂成胶囊
    var liveTools = [];
    CP_AC = new AbortController();
    fetch('/api/say', { method: 'POST', headers: H, body: JSON.stringify({ text: text }), signal: CP_AC.signal }).then(function(res){
      if (!res.ok || !res.body) throw new Error('E_HTTP');
      var rd = res.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump(){ return rd.read().then(function(r){
        if (r.done) return;
        buf += dec.decode(r.value, { stream: true });
        var parts = buf.split(String.fromCharCode(10, 10)); buf = parts.pop();
        parts.forEach(function(frame){
          var line = frame.trim(); if (line.indexOf('data: ') !== 0) return;
          var ev; try { ev = JSON.parse(line.slice(6)); } catch (e) { return; }
          if (ev.type === 'delta'){ reply += ev.text; if (bt){ bt.className = 'cp-tx'; var bd = cpBodyOf(bt); if (bd) bd.textContent = reply; cpLogScroll(); } }
          else if (ev.type === 'tool'){ liveTools.push({ name: ev.name, ms: null, result: '' }); cpState('在用 ' + ev.name); }
          else if (ev.type === 'tool_result'){
            for (var i = liveTools.length - 1; i >= 0; i--){ if (liveTools[i].ms == null){ liveTools[i].ms = ev.ms; liveTools[i].result = ev.result; break; } }
          }
        });
        return pump();
      }); }
      return pump();
    }).then(function(){
      CP_BUSY = false; CP_AC = null;
      if (send) { send.dataset.stop = '0'; send.textContent = '↑'; send.title = '发送'; send.disabled = false; }
      if (bt) bt.className = 'cp-tx';
      if (!reply && bt){ var bd0 = cpBodyOf(bt); if (bd0) bd0.textContent = CP_STOPPED ? '（已停止）' : '（这一轮没接上）'; }
      // 换成渲染好的正文 + 工具胶囊；回读失败就退回刚流下来的纯文字（至少不丢内容），
      // 工具胶囊用当场捡到的那些补上
      if (reply) cpUpgrade(bt, reply).then(function(ok){ if (!ok && bt && liveTools.length) bt.appendChild(cpToolStrip(liveTools)); });
      if (reply) TL_DIRTY = true;
      // 说这话的时候已经离开陪伴视图了：直接刷记录本，别等下次进来
      if (!COMPANION && reply) { TL_DIRTY = false; loadTimeline(); }
      if (box) box.classList.remove('busy');
      inp.disabled = false; inp.placeholder = CP_SAY_PH;
      cpMoreSync();
      if (window.JJPal) window.JJPal.setState('idle');
      if (reply && CP_SOUND && window.JJPal){
        cpState('在说话');
        window.JJPal.speak(reply).then(function(){ cpState('在发呆'); }).catch(function(){ cpState('在发呆'); });
      } else { cpState('在发呆'); }
    }).catch(function(){
      CP_BUSY = false; CP_AC = null;
      if (send) { send.dataset.stop = '0'; send.textContent = '↑'; send.title = '发送'; send.disabled = false; }
      if (bt){ bt.className = 'cp-tx'; var bd1 = cpBodyOf(bt); if (bd1) bd1.textContent = CP_STOPPED ? '（已停止）' : '（这一轮没接上，看看右上角状态）'; }
      if (CP_STOPPED) TL_DIRTY = true;
      var box2 = $('cp-input-box');
      if (box2) box2.classList.remove('busy');
      inp.disabled = false; inp.placeholder = CP_SAY_PH;
      cpMoreSync();
      cpState('在发呆'); if (window.JJPal) window.JJPal.setState('idle');
    });
  }
  var cpTgl = $('nb-companion-toggle');
  if (cpTgl) cpTgl.onclick = function(){ if (COMPANION){ companionOff(); go('chat'); } else { go('chat'); companionOn(); } };
  var cpExit = $('cp-exit'); if (cpExit) cpExit.onclick = function(){ companionOff(); go('chat'); };
  var cpBgBtn = $('cp-bg'); if (cpBgBtn) cpBgBtn.onclick = function(){
    // 在设置页配好的背景列表里循环；选择写回服务端，设置页与这里永远一致
    var list = (CP_PAL && CP_PAL.backgrounds) || [];
    if (!list.length) return;
    var i = 0; for (var k = 0; k < list.length; k++) if (list[k].id === CP_PAL.bg) i = k;
    var next = list[(i + 1) % list.length];
    fetch('/api/pal', { method: 'PUT', headers: H, body: JSON.stringify({ bg: next.id }) })
      .then(function(r){ return r.json(); }).then(function(s){ if (s && s.ok){ CP_PAL = s; cpApplyState(); } })
      .catch(function(){ tick('背景切换失败'); });
  };
  var cpSnd = $('cp-sound'); if (cpSnd) cpSnd.onclick = function(){
    CP_SOUND = !CP_SOUND;
    cpSnd.setAttribute('aria-pressed', CP_SOUND ? 'true' : 'false');
    cpSnd.textContent = CP_SOUND ? '🔊' : '🔇';
    if (!CP_SOUND && window.JJPal && window.JJPal.stop) window.JJPal.stop();
    // 写进 config.json，刷新/重开都认这个；音量、音色等细项在设置页「声音」里自己填
    jsend('PUT', '/api/ui', { sound: CP_SOUND })
      .catch(function(e){ tick('声音开关没存住：' + e.message); });
  };
  var cpExprBtn = $('cp-expr'); if (cpExprBtn) cpExprBtn.onclick = function(){
    var pop = $('cp-exprpop'); if (!pop) return;
    pop.hidden = !pop.hidden;
    if (!pop.hidden) cpExprFill();
  };
  var cpExprPop = $('cp-exprpop'); if (cpExprPop) cpExprPop.onclick = function(e){
    var t = e.target; if (!t || !t.closest) return;
    var ex = t.closest('[data-expr]');
    if (ex){ if (window.JJPal) window.JJPal.setExpression(ex.getAttribute('data-expr')); return; }
    var mo = t.closest('[data-motion]');
    if (mo){ if (window.JJPal) window.JJPal.playMotion(mo.getAttribute('data-motion'), parseInt(mo.getAttribute('data-mi'), 10) || 0); }
  };
  var CP_STOPPED = false;
  function cpStop(){
    CP_STOPPED = true;
    if (CP_AC) { try { CP_AC.abort(); } catch (e) {} }
  }
  var cpSendBtn = $('cp-send');
  if (cpSendBtn) cpSendBtn.onclick = function(){ if (CP_BUSY) { cpStop(); return; } cpSend(); };
  var cpSay = $('cp-say');
  var CP_SAY_PH = '和鲸鱼娘说点什么  ·  Enter 发送，Shift+Enter 换行';
  function cpSayGrow(el){
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(104, el.scrollHeight) + 'px';
  }
  if (cpSay){
    cpSay.onkeydown = function(e){
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); cpSend(); return; }
      if (e.key === 'Escape'){ cpSay.blur(); }
    };
    cpSay.addEventListener('input', function(){ cpSayGrow(cpSay); });
    cpSayGrow(cpSay);
  }

  // ── 设置页 · 陪伴形象与背景（2026-11-13）：点卡片就换、上传/导入后自动用上，全程不用碰文件目录 ──
  var CP_AV_MOUNTED = null;
  function palMsg(id, text, bad){
    var el = $(id); if (!el) return;
    el.textContent = text || '';
    el.style.color = bad ? 'var(--amber)' : '';
  }
  function palCard(kind, item, cur){
    var on = item.id === cur;
    var thumb = kind === 'bg'
      ? (item.url ? '<img class="pal-thumb" src="' + esc(item.url) + '" alt="" loading="lazy">' : '<span class="pal-thumb pal-ocean"></span>')
      : (item.thumb ? '<img class="pal-thumb pal-avthumb" src="' + esc(item.thumb) + '" alt="" loading="lazy">' : '<span class="pal-thumb pal-avthumb pal-noimg">' + (item.kind === 'cubism' ? 'Live2D' : '形象') + '</span>');
    var tag = kind === 'avatar' ? '<span class="pal-kind">' + (item.kind === 'cubism' ? 'Live2D' : '单图绑定') + '</span>' : '';
    return '<div class="pal-card' + (on ? ' on' : '') + '" role="button" tabindex="0" data-pal="' + kind + '" data-id="' + esc(item.id) + '" title="点一下就用它">' +
      thumb + tag + '<span class="pal-name">' + esc(item.name) + '</span>' +
      (on ? '<span class="pal-now">使用中</span>' : '') +
      (item.builtin ? '' : '<span class="pal-del" data-paldel="' + kind + '" data-id="' + esc(item.id) + '" title="删除这个素材">×</span>') +
      '</div>';
  }
  function palGrids(s){
    var a = $('pal-avatars'), b = $('pal-bgs');
    if (a) a.innerHTML = (s.avatars || []).map(function(x){ return palCard('avatar', x, s.avatar); }).join('');
    if (b) b.innerHTML = (s.backgrounds || []).map(function(x){ return palCard('bg', x, s.bg); }).join('');
  }
  function palSyncCompanion(){
    if (!COMPANION) return;
    cpApplyState();
    var av = cpCurAvatar();
    if (av && av.id !== CP_AV_MOUNTED){ cpDestroy(); cpMount(); }
  }
  function palAdopt(s, msgId, what){
    CP_PAL = s; palGrids(s); palSyncCompanion();
    palMsg(msgId, '已用上：' + what);
  }
  function palUpload(url, file, msgId){
    palMsg(msgId, '正在上传 ' + file.name + ' …');
    fetch(url + '?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'x-jj': '1' }, body: file })
      .then(function(r){ return r.json(); }).then(function(s){
        if (s && s.ok) palAdopt(s, msgId, file.name);
        else palMsg(msgId, (s && (s.hint || s.error)) || '上传失败', true);
      }).catch(function(){ palMsg(msgId, '上传失败：检查文件大小或网络', true); });
  }
  // 事件委托：设置页重渲染后不用重新接线
  document.addEventListener('click', function(e){
    var t = e.target;
    if (!t || !t.closest) return;
    var del = t.closest('[data-paldel]');
    if (del){
      e.stopPropagation();
      var kind = del.getAttribute('data-paldel'), id = del.getAttribute('data-id');
      if (!window.confirm('删除这个' + (kind === 'bg' ? '背景' : '形象') + '？删掉后不可恢复。')) return;
      fetch('/api/pal/' + kind + '/' + encodeURIComponent(id), { method: 'DELETE', headers: H })
        .then(function(r){ return r.json(); }).then(function(s){ if (s && s.backgrounds){ CP_PAL = s; palGrids(s); palSyncCompanion(); } })
        .catch(function(){ tick('删除失败'); });
      return;
    }
    var card = t.closest('[data-pal]');
    if (card){
      var k = card.getAttribute('data-pal'), cid = card.getAttribute('data-id');
      var patch = {}; patch[k] = cid;
      fetch('/api/pal', { method: 'PUT', headers: H, body: JSON.stringify(patch) })
        .then(function(r){ return r.json(); }).then(function(s){
          if (s && s.ok) palAdopt(s, k === 'bg' ? 'pal-bg-msg' : 'pal-av-msg', (k === 'bg' ? cpCurBg() : cpCurAvatar() || {}).name || cid);
          else tick('切换失败');
        }).catch(function(){ tick('切换失败'); });
      return;
    }
    if (t.id === 'pal-bg-add'){ var f = $('pal-bg-file'); if (f) f.click(); return; }
    if (t.id === 'pal-av-add'){ var g = $('pal-av-file'); if (g) g.click(); return; }
    if (t.id === 'pal-go'){ go('chat'); companionOn(); return; }
  });
  document.addEventListener('change', function(e){
    var t = e.target;
    if (t.id === 'pal-bg-file' && t.files && t.files[0]){ palUpload('/api/pal/bg', t.files[0], 'pal-bg-msg'); t.value = ''; }
    if (t.id === 'pal-av-file' && t.files && t.files[0]){ palUpload('/api/pal/avatar', t.files[0], 'pal-av-msg'); t.value = ''; }
  });
  // 卡片是 role=button 的 div：键盘 Enter/空格 也要能选
  document.addEventListener('keydown', function(e){
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var c = e.target && e.target.closest ? e.target.closest('[data-pal]') : null;
    if (c){ e.preventDefault(); c.click(); }
  });

  // ── 系统（2026-11-14）：后端早就建好、界面一直没有入口的六块，收进一页 ──────
  // 工具 / 审计 / 回执 / 待处理 / 线头 / 抽检。只读为主；能动手的都走 jsend，失败会说话。
  function sysView(){
    var el = $('nb-view');
    el.innerHTML = head('系统', '<button class="nb-btn" id="sys-refresh">刷新</button>') +
      wrap('<div class="nb-empty" id="sys-msg">读取中…</div><div id="sys-body"></div>');
    var body = $('sys-body'), msgEl = $('sys-msg'), btn = $('sys-refresh');
    // 别继承上一页的滚动位置：从对话切过来时页面可能停在底部，一进来就看不见待处理
    var pg = document.getElementById('nb-page'); if (pg) pg.scrollTop = 0;
    if (btn) btn.onclick = function(){ paint(); };

    function cut(s, n){ s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
    function when(ts){ return String(ts || '').replace('T', ' ').slice(5, 16); }
    function empty(t){ return '<div class="nb-empty">' + esc(t) + '</div>'; }
    function sec(title, n, inner){
      return '<div class="nb-sec"><span>' + esc(title) + '</span>' +
        (n == null ? '' : '<span class="m" style="margin-left:auto;color:var(--dim2)">' + n + '</span>') + '</div>' + inner;
    }

    function pendHtml(list){
      if (!list.length) return empty('没有等你点头的事。');
      return list.map(function(p){
        var leftMin = Math.round((Date.parse(p.expires_at) - Date.now()) / 60000);
        return '<div class="nb-runrow" style="grid-template-columns:1fr auto">' +
          '<span class="v">' + esc(p.verb) + ' <span class="m" style="text-align:left">' + esc(cut(p.template || '', 60)) + '</span></span>' +
          '<span class="m">' + (p.expired || leftMin <= 0 ? '已过期' : '剩 ' + leftMin + ' 分钟') + '</span></div>' +
          '<div class="nb-logrow" style="padding:2px 2px 8px">' + esc(cut((p.argv || []).join(' '), 180)) + '</div>' +
          '<div class="nb-actrow" style="margin:-4px 0 10px">' +
          '<button class="nb-btn" data-pend="' + esc(p.id) + '" data-act="confirm">批准</button>' +
          '<button class="nb-btn danger" data-pend="' + esc(p.id) + '" data-act="reject">拒绝</button></div>';
      }).join('');
    }

    function rcpHtml(r){
      var items = (r && r.items) || [];
      if (!items.length) return empty('没有回执。');
      return items.map(function(x){
        return '<div class="nb-row" style="cursor:default">' +
          '<span class="tag">' + (x.seen ? '已读' : '未读') + '</span>' + esc(cut(x.title, 60)) +
          '<span class="m">' + esc(when(x.at)) + '</span></div>' +
          (x.body ? '<div class="nb-sub">' + esc(cut(x.body, 200)) + '</div>' : '') +
          (x.seen ? '' : '<div class="nb-actrow" style="margin:-2px 0 8px">' +
            '<button class="nb-btn" data-seen="' + esc(x.id) + '">标为已读</button></div>');
      }).join('');
    }

    function thHtml(list){
      if (!list.length) return empty('没有开着的线头。');
      return list.map(function(x){
        return '<div class="nb-row" style="cursor:default">' +
          '<span class="tag">' + (x.aging ? '有点久' : '线头') + '</span>' + esc(cut(x.text, 70)) +
          '<span class="m">' + (x.ageDays || 0) + ' 天</span></div>' +
          (x.why ? '<div class="nb-sub">' + esc(cut(x.why, 120)) + '</div>' : '') +
          '<div class="nb-actrow" style="margin:-2px 0 8px">' +
          '<button class="nb-btn" data-thclose="' + x.id + '">收线</button></div>';
      }).join('');
    }

    function revHtml(list){
      if (!list.length) return empty('今天没有要抽检的关联。');
      return list.map(function(x){
        var key = x.src_id + '|' + x.dst_id + '|' + String(x.rel || '');
        return '<div class="nb-runrow" style="grid-template-columns:1fr auto">' +
          '<span class="v">' + esc(cut(x.a_text, 44)) + ' ↔ ' + esc(cut(x.b_text, 44)) + '</span>' +
          '<span class="m">' + esc(x.rel) + ' · ' + Number(x.weight || 0).toFixed(2) + '</span></div>' +
          '<div class="nb-actrow" style="margin:-4px 0 10px">' +
          '<button class="nb-btn" data-rev="' + esc(key) + '" data-okv="1">对</button>' +
          '<button class="nb-btn danger" data-rev="' + esc(key) + '" data-okv="0">不对，剪断</button></div>';
      }).join('');
    }

    function auditHtml(a){
      var rows = (a && a.rows) || [];
      if (!rows.length) return empty('还没有执行记录。');
      return '<div class="nb-empty" style="margin-bottom:6px">显示最近 ' + rows.length + ' 条 / 共 ' + (a.total || rows.length) + ' 条</div>' +
        rows.map(function(r){
          var bad = r.decision !== 'allowed';
          return '<div class="nb-logrow">' +
            '<span class="d">' + esc(when(r.ts)) + '</span>' +
            '<span class="v">' + esc(r.verb) + '</span>' +
            '<span class="d">' + esc(r.tier) + '</span>' +
            '<span class="d" style="color:' + (bad ? 'var(--amber)' : 'inherit') + '">' + esc(r.decision) + '</span>' +
            '<span class="d">' + (r.ms ? r.ms + 'ms' : '') + '</span></div>' +
            (r.reason ? '<div class="nb-audit">' + esc(cut(r.reason, 140)) + '</div>' : '');
        }).join('');
    }

    function toolsHtml(list){
      if (!list.length) return empty('没有注册工具。');
      return list.map(function(x){
        return '<div class="nb-row" style="cursor:default">' +
          '<span class="tag">' + esc(x.tier) + '</span>' + esc(x.name) +
          '<span class="m">' + esc(cut(x.description, 90)) + '</span></div>';
      }).join('');
    }

    function wire(){
      Array.prototype.forEach.call(body.querySelectorAll('[data-pend]'), function(b){
        b.onclick = function(){
          var act = b.getAttribute('data-act');
          jpost('/api/pending/' + encodeURIComponent(b.getAttribute('data-pend')), { action: act })
            .then(function(){ tick(act === 'confirm' ? '已批准' : '已拒绝'); paint(); })
            .catch(function(e){ tick('没成：' + e.message); });
        };
      });
      Array.prototype.forEach.call(body.querySelectorAll('[data-seen]'), function(b){
        b.onclick = function(){
          jpost('/api/receipts/' + encodeURIComponent(b.getAttribute('data-seen')) + '/seen', {})
            .then(function(){ paint(); })
            .catch(function(e){ tick('没标成：' + e.message); });
        };
      });
      Array.prototype.forEach.call(body.querySelectorAll('[data-thclose]'), function(b){
        b.onclick = function(){
          var note = window.prompt('这条线怎么收的？（一句话，可留空）', '');
          if (note === null) return;
          jpost('/api/threads/' + b.getAttribute('data-thclose') + '/close', { note: note })
            .then(function(){ tick('已收线'); paint(); })
            .catch(function(e){ tick('没收成：' + e.message); });
        };
      });
      Array.prototype.forEach.call(body.querySelectorAll('[data-rev]'), function(b){
        b.onclick = function(){
          var parts = b.getAttribute('data-rev').split('|');
          var ok = b.getAttribute('data-okv') === '1';
          jpost('/api/surface/review', { src_id: Number(parts[0]), dst_id: Number(parts[1]), rel: parts[2], ok: ok })
            .then(function(){ tick(ok ? '记下了' : '已剪断这条关联'); paint(); })
            .catch(function(e){ tick('没记成：' + e.message); });
        };
      });
    }

    function paint(){
      if (msgEl){ msgEl.textContent = '读取中…'; msgEl.style.color = ''; }
      Promise.all([
        fetch('/api/tools').then(function(r){ return r.json(); }).catch(function(){ return []; }),
        fetch('/api/audit?limit=60').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
        fetch('/api/receipts').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
        fetch('/api/pending').then(function(r){ return r.json(); }).catch(function(){ return []; }),
        fetch('/api/threads').then(function(r){ return r.json(); }).catch(function(){ return []; }),
        fetch('/api/surface/review').then(function(r){ return r.json(); }).catch(function(){ return []; })
      ]).then(function(res){
        var tools = res[0] || [], audit = res[1] || {}, rcp = res[2] || {};
        var pend = res[3] || [], th = res[4] || [], rev = res[5] || [];
        if (msgEl) {
          msgEl.textContent = '工具 ' + tools.length + ' · 审计 ' + (audit.total || 0) +
            ' · 回执 ' + (rcp.unseen || 0) + ' 未读 · 待处理 ' + pend.length +
            ' · 线头 ' + th.length + ' · 抽检 ' + rev.length;
        }
        body.innerHTML =
          sec('待处理', pend.length, pendHtml(pend)) +
          sec('回执', (rcp.items || []).length, rcpHtml(rcp)) +
          sec('线头', th.length, thHtml(th)) +
          sec('抽检', rev.length, revHtml(rev)) +
          sec('审计', null, auditHtml(audit)) +
          sec('工具', tools.length, toolsHtml(tools));
        wire();
      }).catch(function(e){ if (msgEl) msgEl.textContent = '读不到：' + ((e && e.message) || e); });
    }

    paint();
  }

  // 设置页的五个分类（2026-11-14 重排）：原来 20 个平铺标签，一半得横向滚动才看得见，
  // 同类功能还被拆散（模型一览夹在人格和头像之间）。这里按「她在想什么 → 她是谁 → 她能做什么 → 界面长什么样 → 数据怎么管」排。
  // 内置布局只是「没写过自定义布局时」的兜底。真正的分组与顺序从 /api/ui 的
  // raw.cfgGroups 读（用户自己写进 config.json），不在这里把顺序钉死（2026-11-15）。
  var CFG_GROUPS_DEFAULT = [
    { name: '大脑', hint: '模型 · 接口', secs: ['接口 · 云端', '本地模型', '眼 · 视觉'] },
    { name: '她',   hint: '人格 · 形象 · 主动性', secs: ['人格', '头像', '形象与背景', '声音', '主动开口'] },
    { name: '手脚', hint: '能力 · 权限 · 接入', secs: ['主机 · 命令解释器', 'WSL 小房子', '常驻指令', '限制', 'QQ 接入（OneBot 11）'] },
    { name: '观感', hint: '主题 · 片头', secs: ['外观', '开机片头'] },
    { name: '数据', hint: '备份 · 诊断 · 版本 · 目录', secs: ['诊断', '版本与更新', '导出 / 导入', '工作区域', '引导', '部署状态'] }
  ];
  function cfgGroupsFrom(ui){
    var g = ui && ui.raw ? ui.raw.cfgGroups : null;
    if (!Array.isArray(g)) return CFG_GROUPS_DEFAULT;
    // 只做形状检查，不替用户补节、不改顺序
    var ok = g.every(function(x){ return x && typeof x.name === 'string' && Array.isArray(x.secs) &&
      x.secs.every(function(s){ return typeof s === 'string'; }); });
    return ok ? g.map(function(x){ return { name: x.name, hint: x.hint || '', secs: x.secs.slice() }; }) : CFG_GROUPS_DEFAULT;
  }
  function cfgDefaultJson(){ return JSON.stringify(CFG_GROUPS_DEFAULT, null, 2); }

  function cfgView(){
    var el = $('nb-view');
    // 重渲染（改完某节后刷新）要停在原地：不然滚动位置也一起回到顶部
    var keepScroll = (document.getElementById('nb-page') || {}).scrollTop || 0;
    el.innerHTML = head('设置') + wrap('<div id="nb-cfg"><div class="nb-empty">读取中…</div></div>');
    var chosen = {};
    // 设置页重排（2026-11-14）：原来是 20 个平铺标签（总宽 1407 > 容器 1075，最后 5 项得横向滚动才看得见），
    // 而且一次只显示一节 —— 有关联的功能被拆到不同页。现在收成 5 组，组内整组铺开，靠分组表决定顺序。
    var SECMAP = {};
    function sec(t, inner){ SECMAP[t] = inner; return ''; }
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
      fetch('/api/wsl').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/vision').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/tts/status').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/tts/voices').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/pal').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/permission').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
      fetch('/api/version').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
    ]).then(function(res){
      var c = res[0] || {}, ui = res[1] || {}, m = res[2] || {}, mode = (res[3] || {}).mode || 'chat';
      var host = res[4] || {}, sd = Array.isArray(res[5]) ? res[5] : [];
      var grants = Array.isArray(res[6]) ? res[6] : [];
      var eg = res[7] || {}, health = res[8] || {}, persona = res[9] || {};
      var av = res[10] || {}, br = res[11] || {}, dep = res[12] || {};
      var wsl = res[13] || {}, vis = res[14] || {};
      var tts = res[15] || {}, ttsVoices = (res[16] || {}).voices || [];
      var pal = res[17] || {};
      var perm = res[18] || {};
      var ver = res[19] || {};
      var CFG_GROUPS = cfgGroupsFrom(ui);   // 用户自己的分组/顺序；没写才用内置默认
      CP_PAL = pal.avatars ? pal : CP_PAL;
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
        '<button class="nb-btn" id="cf-mpick">看看装了哪些模型</button>' +
        '<span class="nb-empty">端点 ' + esc(m.endpoint || '—') + ' · ' + (m.online ? '在线' : '离线') +
        ' · 索引 ' + esc((m.index && m.index.current) || '—') + '</span></div></div>');
      var vr = vis.raw || {};
      // provider 也是自由文本：ollama=本地 /api/chat，其它任意名字都按 OpenAI 兼容
      // /v1/chat/completions 走（厂商名只是标签）。显示的同样只是用户写下的原值。
      html += sec('眼 · 视觉',
        '<div class="nb-form">' +
        field('provider', 'cf-vprov', vr.provider || '', '未设置。ollama=本地；其它名字=OpenAI 兼容端点') +
        field('model', 'cf-vmodel', vr.model || '', '未设置。自己填模型名') +
        field('baseUrl', 'cf-vbase', vr.baseUrl || '', '未设置。Ollama 地址或 OpenAI 兼容地址') +
        field('key', 'cf-vkey', '', vis.hasKey ? '已有（' + (vis.keyFingerprint || '') + '），留空不改' : '未设置。走加密凭据库，不进 config.json') +
        '<div class="nb-runrow"><span class="k">屏幕可发外部端点</span><span class="v">' + (vis.cloudEnabled ? '开' : '关') + '</span>' +
        '<span class="m">默认只走本地；开了才允许把截图发到非 ollama 的端点</span></div>' +
        '<div class="nb-kv"><b>运行时</b><span>' + esc(vis.provider || '—') + (vis.configured === false ? '（未设置，暂用本地）' : '') +
        ' / ' + esc(vis.model || '—') + (vis.modelSet === false ? '（未设置，暂用内置模型）' : '') + '</span></div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-vsave">保存</button>' +
        '<button class="nb-btn" id="cf-vcloud">' + (vis.cloudEnabled ? '关掉云闸' : '开云闸') + '</button>' +
        '<button class="nb-btn danger" id="cf-vclear">清除 key</button>' +
        '<span class="nb-empty" id="cf-vmsg"></span></div>' +
        '<div class="nb-empty">留空 = 清掉这一项，不替你补默认值。字段与本地推理服务（Ollama 11434/v1）' +
        '及 OpenAI 兼容网关一致。</div></div>');
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
      // 「模型一览」已并入上一节「本地模型」：同一个按钮不必单独占一页
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
      html += sec('WSL 小房子',
        '<div class="nb-form">' +
        '<div class="nb-kv"><b>发行版</b><span>' + esc(wsl.distro || 'Ubuntu') + '</span>' +
        '<b>状态</b><span>' + (wsl.installed ? esc(wsl.state || '已装') : '未安装') + '</span>' +
        '<b>自主</b><span>' + (wsl.autonomous ? '开（不逐次问）' : '关') + '</span></div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-wsetup">' + (wsl.installed ? '重新初始化' : '装 Ubuntu') + '</button>' +
        '<button class="nb-btn" id="cf-wauto">' + (wsl.autonomous ? '关掉自主' : '开自主') + '</button>' +
        '<button class="nb-btn" id="cf-wsnap">立即快照</button>' +
        '<span class="nb-empty" id="cf-wmsg"></span></div>' +
        '<div class="nb-empty">她自己的 Linux（/root/jj）。自主开了就不逐次问；逐条审计 + 快照兜底，格式化/删盘根/删快照永久拒。装 Ubuntu 约 1GB。</div>' +
        ((wsl.snapshots || []).length ? '<div class="nb-sec">快照</div>' + wsl.snapshots.map(function(s){
          return '<div class="nb-row" style="cursor:default"><span class="tag">tar</span>' + esc(s.file) +
            '<span class="m">' + Math.round((s.bytes || 0) / 1048576) + ' MB · ' + esc(String(s.at || '').slice(0, 16)) + '</span></div>';
        }).join('') : '') +
        '</div>');
      html += sec('形象与背景',
        '<div class="nb-form">' +
        '<div class="nb-empty">点卡片就换，立刻生效；上传或导入成功后自动用上。素材只存在本机，不上传云端。</div>' +
        '<div class="nb-sec">人物形象</div>' +
        '<div class="pal-grid" id="pal-avatars"></div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="pal-av-add">＋ 导入形象包（.yxavatar / .zip）</button>' +
        '<input type="file" id="pal-av-file" accept=".yxavatar,.zip,application/zip" hidden>' +
        '<span class="nb-empty" id="pal-av-msg"></span></div>' +
        '<div class="pal-steps">两种形象都能导，不用装任何软件也能先用内置鲸鱼娘：<br>① 现成 Live2D 模型（zip 里有 .model3.json，例如 VTube Studio 公皮）→ 直接点「导入形象包」选那个 zip，表情 / 动作 / 物理都保留；<br>② 只有一张立绘 → 可选免费开源工具 RuiC-2D（github.com/HRuiCcc/RuiC-2D，本机运行）绑定后导出 .yxavatar 再导入。<br>导入成功后自动切换，不用重启；不想要了点卡片右上 × 删除。</div>' +
        '<div class="nb-sec">背景</div>' +
        '<div class="pal-grid" id="pal-bgs"></div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="pal-bg-add">＋ 上传背景图</button>' +
        '<input type="file" id="pal-bg-file" accept="image/png,image/jpeg,image/webp" hidden>' +
        '<span class="nb-empty" id="pal-bg-msg"></span></div>' +
        '<div class="pal-steps">支持 PNG / JPG / WebP，≤8MB。人物站在画面中间，建议选横图或上下留白多的图；右栏按钮会浮在背景上，任何图都能配。</div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="pal-go">去陪伴视图看看</button></div>' +
        '</div>');
      var tr = tts.raw || {};
      // 所有值都是**用户自己填的自由文本**，不再给 local/cloud 两档按钮（2026-11-15）。
      // 显示的是 config.json 里的原值；运行时归一化出来的默认值只放在「状态」里，不冒充配置。
      html += sec('声音',
        '<div class="nb-form">' +
        // 标签要短：.nb-fld 左列只有 76px，写「格式 (RESPONSE_FORMAT)」会折行压到输入框上。
        // 字段名一律放 placeholder 里，既看得见又不挤。
        field('后端', 'cf-ttsbackend', tr.backend || '', '未设置 · backend：local=本地 / cloud=Edge / 其它名字=OpenAI 兼容端点') +
        field('接口地址', 'cf-ttsbase', tr.baseUrl || '', '未设置 · baseUrl：如 http://localhost:1234/v1') +
        field('模型', 'cf-ttsmodel', tr.model || '', '未设置 · model：自定义后端填服务上的模型名') +
        field('密钥', 'cf-ttskey', '', tts.hasKey ? ('已存 ' + esc(tts.keyFingerprint || '') + '，留空不改；填 null 清除') : '未设置 · apiKey：走加密凭据库，不进 config.json') +
        field('音色', 'cf-ttsvoice', tr.voice || '', '未设置 · voice：本地填 speaker id；Edge 填 zh-CN-XiaoxiaoNeural；OpenAI 填 alloy 等') +
        field('语速', 'cf-ttsspeed', tr.speed == null ? '' : String(tr.speed), '未设置 · speed：OpenAI 口径 0.25–4.0，内置后端 0.5–2.0') +
        field('音量', 'cf-ttsvolume', tr.volume == null ? '' : String(tr.volume), '未设置 · volume：0–1') +
        field('格式', 'cf-ttsformat', tr.format || '', '未设置 · response_format：mp3 / wav / opus / aac / flac / pcm') +
        field('指令', 'cf-ttsinst', tr.instructions || '', '未设置 · instructions：部分 OpenAI 兼容模型支持') +
        field('模型目录', 'cf-ttsmodelpath', tr.modelPath || '', '未设置 · modelPath：仅后端填 local 时用') +
        '<div class="nb-kv"><b>运行时后端</b><span>' + esc(tts.backend || '—') + (tts.configured === false ? '（未设置，暂用内置 local）' : '') + '</span>' +
        '<b>状态</b><span>' + (tts.ready ? '就绪' : '未就绪') + '</span></div>' +
        (tts.why ? '<div class="nb-empty">' + esc(tts.why) + '</div>' : '') +
        (ttsVoices.length ? '<div class="nb-empty">这几个是后端自带的可选音色，点一下填进去，也可以自己写：</div><div class="nb-opts">' +
          ttsVoices.slice(0, 12).map(function(v){ return '<button class="nb-opt" data-ttsvoice="' + esc(v.id) + '">' + esc(v.name || v.id) + '</button>'; }).join('') + '</div>' : '') +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-ttssave">保存</button>' +
        '<button class="nb-btn" id="cf-ttstest">试听一句</button>' +
        '<span class="nb-empty" id="cf-ttsmsg"></span></div>' +
        '<div class="nb-empty">留空 = 清掉这一项，界面不会替你写回默认值。字段口径对齐 OpenAI 兼容 /v1/audio/speech ' +
        '与常见本地推理服务（Ollama 11434/v1、LM Studio 1234/v1、llama.cpp 8080/v1、vLLM 8000/v1）；' +
        '本地服务的 apiKey 常只是占位符。形象与背景在「形象与背景」那一节。</div>' +
        '</div>');
      // 主动开口（心跳）：2026-11-15 从启动参数 --beat 改成界面开关。
      // 原来只在「体检」页第三段里有个按钮，用户去设置里找不到——开关该在设置里。
      var beatOn = ui.beat === true, beatRun = ui.beatRunning === true;
      html += sec('主动开口',
        '<div class="nb-form">' +
        '<div class="nb-kv"><b>状态</b><span id="cf-beatstate" style="color:' +
          (beatRun ? 'var(--ok, #8fd694)' : beatOn ? 'var(--amber)' : 'var(--dim)') + '">' +
          (beatRun ? '已开启 · 正在跑' : beatOn ? '已开启 · 等重启才生效' : '未开启（她不会主动说话）') + '</span></div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-beat">' + (beatOn ? '关掉' : '打开') + '</button>' +
        '<span class="nb-empty" id="cf-beatmsg">' +
          (beatRun ? '关了并在重启后生效' : beatOn ? '已经写进 config.json，重启面板后开始' : '打开后要重启面板才生效') +
        '</span></div>' +
        '<div class="nb-empty">开启后每 60 秒判定一次要不要主动找你；静音 23:30–08:00，每日最多 3 次；' +
        '每次发或不发都留审计，可在「系统」里查。默认关闭 —— 没有主动性的需求时，安静就是最好的行为。</div>' +
        '</div>');
      html += sec('常驻指令', sd.length ? sd.map(function(x){
        return '<div class="nb-runrow"><span class="k">' + esc(x.when || '') + '</span>' +
          '<span class="v">' + esc(x.because || x.id) + '</span>' +
          '<button class="nb-btn" data-off="' + esc(x.id) + '">停用</button></div>';
      }).join('') : '<div class="nb-empty">没有常驻指令。</div>');
      // 权限档位（2026-11-14）：后端一直有 ask / read / write / full 四档，
      // 但这里以前把这行**写死**成「全开（full）」——实际档位不是 full 时界面在说谎，
      // 而且用户根本没有切档入口。现在读 /api/permission，四档直接可选。
      var permPresets = (Array.isArray(perm.presets) && perm.presets.length) ? perm.presets : [
        { id: 'ask', label: '逐次确认', hint: '每次动作都要你看一眼' },
        { id: 'read', label: '仅可查看', hint: '只读；要动手的命令都拒绝' },
        { id: 'write', label: '工作区内修改', hint: '只在 workspace 内' },
        { id: 'full', label: '完全权限', hint: '任意命令（会话级）' }
      ];
      // 读不到就写「读不到」，绝不默默回落到 full —— 那正是以前那行写死文案的问题
      var curPreset = String(perm.preset || '');
      var curPresetObj = permPresets.filter(function(x){ return x.id === curPreset; })[0] || { id: curPreset, label: curPreset, hint: '' };
      html += sec('限制',
        // 说明单独一行：grant.ts 里 full 的 hint 有一百多字，塞进 .nb-runrow 的右列会把档位挤成三行
        '<div class="nb-runrow"><span class="k">档位</span><span class="v" id="cf-perm-v">' +
        (curPreset ? esc(curPresetObj.label) + '（' + esc(curPreset) + '）' : '读不到') + '</span></div>' +
        '<div class="nb-empty" style="margin:-2px 0 8px">' + esc(curPresetObj.hint || '刷新一下再看') + '</div>' +
        '<div class="nb-opts" id="cf-perm">' + permPresets.map(function(x){
          return '<button class="nb-opt' + (x.id === curPreset ? ' on' : '') + '" data-perm="' + esc(x.id) + '" title="' + esc(x.hint || '') + '">' + esc(x.label) + '</button>';
        }).join('') + '</div>' +
        '<div class="nb-empty" id="cf-perm-msg">切档会立刻撤销当前所有授权窗口，并记一条审计</div>' +
        '<div class="nb-runrow"><span class="k">授权窗口</span><span class="v">' + grants.length + ' 个</span>' +
        '<span class="m">启动自动开，不会逐次问你</span></div>' +
        (grants.length ? grants.map(function(g){
          var left = g.remainingS < 0 ? '长期' : (g.remainingS >= 60 ? Math.round(g.remainingS / 60) + ' 分钟' : g.remainingS + ' 秒');
          return '<div class="nb-runrow"><span class="k">' + esc(g.full ? '全权' : (g.commands || []).join(',')) + '</span>' +
            '<span class="v">' + esc(g.scope || '') + ' · 剩 ' + esc(left) + '</span>' +
            '<button class="nb-btn danger" data-revoke="' + esc(g.id) + '">收回</button></div>';
        }).join('') : '') +
        '<div class="nb-runrow"><span class="k">代码外发</span><span class="v">开</span>' +
        '<span class="m">每次仍写审计</span></div>' +
        '<div class="nb-runrow"><span class="k">超级权限</span>' +
        '<span class="v" id="cf-super-v">读取中…</span>' +
        '<span class="m">只影响「改记忆库本体 / 人格」这一档；trash 与 snapshots 仍然拒</span></div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-super">切换</button>' +
        '<span class="nb-empty" id="cf-super-msg">开着的时候她会跟你确认一次，并记进审计</span></div>');
      html += sec('诊断',
        '<div class="nb-actrow"><button class="nb-btn" id="cf-doc">跑一遍体检</button>' +
        '<button class="nb-btn" id="cf-diagcopy">复制诊断摘要</button>' +
        '<span class="nb-empty">按项看，红的会列出来；摘要只读版本与健康关键字段</span></div>' +
        '<div class="nb-empty" id="cf-diagcopy-msg"></div>' +
        '<div id="cf-docout"></div>');
      // 「版本与更新」：数据全来自 /api/version，不硬编码版本号（docs/ops/26 §1）。
      // manual-verified 翻成一句中文人话；检查更新只展示，绝不下载 / 安装。
      var policyCn = ver.updatePolicy === 'manual-verified'
        ? '人工校验覆盖安装，不会自动更新' : esc(ver.updatePolicy || '—');
      html += sec('版本与更新',
        '<div class="nb-kv">' +
        '<b>当前版本</b><span>' + esc(ver.version || '—') + '</span>' +
        '<b>Node</b><span>' + esc(ver.node || '—') + '</span>' +
        '<b>更新策略</b><span>' + policyCn + '</span></div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-upcheck">检查更新</button>' +
        '<span class="nb-empty" id="cf-upmsg">只读本地发布清单；本页不会自动下载或安装</span></div>' +
        '<div id="cf-upout"></div>');
      html += sec('导出 / 导入',
        '<div class="nb-actrow"><button class="nb-btn" id="cf-exp">导出一份快照</button>' +
        '<span class="nb-empty" id="cf-expmsg">不带 secrets/tokens/snapshots</span></div>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-ver">校验一个导出目录</button>' +
        '<button class="nb-btn" id="cf-imp">看导入命令</button></div>' +
        '<div class="nb-empty" id="cf-impout"></div>');
      html += sec('外观',
        '<div class="nb-form">' +
        '<div class="nb-fld"><span>外壳</span><div class="nb-opts" id="cf-shell">' +
        [['notebook', '记录本（三栏）'], ['classic', '专注（单栏）']].map(function(x){
          return '<button class="nb-opt' + (((ui.shell || 'notebook') === x[0]) ? ' on' : '') +
            '" data-shellv="' + x[0] + '" title="' + (x[0] === 'classic' ? '收起左侧索引与右侧切口签，顶栏 ≡ 临时叫回导航' : '默认三栏') +
            '">' + x[1] + '</button>';
        }).join('') + '</div></div>' +
        '<div class="nb-opts" id="cf-theme">' +
        [['ledger','记录本（黑白 · 紧凑）'],['hermes','Hermes（中性灰 · 宽版式）']].map(function(x){
          return '<button class="nb-opt" data-theme="' + x[0] + '">' + x[1] + '</button>';
        }).join('') + '</div>' +
        '<div class="nb-actrow"><span class="nb-empty">切了立刻生效，不用重启。这几档是内置版式 / 片头，' +
        '不是我能随便造的值；其余配置请用页首的「直接编辑配置 JSON」自己写。</span></div></div>');
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
        '<div class="nb-fld"><label>换到</label><input id="cf-where" class="nb-search" placeholder="D:\\Pseudo Digital Life Project"></div>' +
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
      if (CFG_GRP < 0 || CFG_GRP >= CFG_GROUPS.length) CFG_GRP = 0;
      var navHtml = '<nav class="cf-nav" aria-label="设置分类">' + CFG_GROUPS.map(function(g, i){
        return '<button class="cf-navitem' + (i === CFG_GRP ? ' on' : '') + '" data-g="' + i + '"' +
          (i === CFG_GRP ? ' aria-current="true"' : '') + '>' +
          '<span class="cf-navname">' + esc(g.name) + '</span>' +
          '<span class="cf-navhint">' + esc(g.hint) + '</span>' +
          '<span class="cf-navn">' + g.secs.length + '</span></button>';
      }).join('') + '</nav>';
      // 组内整组铺开：同类的几节能一次看全，不用来回点标签
      var bodyHtml = CFG_GROUPS.map(function(g, i){
        return '<div class="cf-group" data-g="' + i + '"' + (i === CFG_GRP ? '' : ' hidden') + '>' +
          '<div class="cf-ghead"><h2>' + esc(g.name) + '</h2><span class="t">' + esc(g.hint) + '</span></div>' +
          g.secs.map(function(t){
            var inner = SECMAP[t];
            // 分组表里的标题和 sec() 的标题必须一字不差；对不上就当场显红，别让整节设置静默消失
            if (inner === undefined) return '<div class="nb-sec">' + esc(t) + '</div>' +
              '<div class="nb-empty" style="color:var(--amber)">这一节没渲染出来：分组表里的标题对不上（' + esc(t) + '）</div>';
            return '<div class="nb-sec">' + esc(t) + '</div>' + inner;
          }).join('') + '</div>';
      }).join('');
      // 布局编辑器放在分组之外：万一用户把分组删空，也得有个地方能改回来。
      var bar = '<div class="nb-actrow cf-custombar">' +
        '<button class="nb-btn" id="cf-edit-layout">⚙ 自定义分组与顺序</button>' +
        '<button class="nb-btn" id="cf-edit-raw">{ } 直接编辑配置 JSON</button>' +
        '<span class="nb-empty">' + (ui.raw && Array.isArray(ui.raw.cfgGroups) ? '现在用的是你自己的布局' : '现在用的是内置默认布局') + '</span>' +
        '</div>' +
        '<div id="cf-editor" hidden><div class="nb-sec" id="cf-editor-title"></div>' +
        '<textarea id="cf-editor-text" class="nb-search" rows="14" spellcheck="false" style="width:100%;min-height:220px;font:12px/1.6 var(--mono);padding:10px;resize:vertical"></textarea>' +
        '<div class="nb-actrow"><button class="nb-btn" id="cf-editor-save">保存并刷新</button>' +
        '<button class="nb-btn" id="cf-editor-cancel">收起</button>' +
        '<button class="nb-btn danger" id="cf-editor-reset">恢复内置默认布局</button>' +
        '<span class="nb-empty" id="cf-editor-msg"></span></div>' +
        '<div class="nb-empty" id="cf-editor-help"></div></div>';
      if (box) box.innerHTML = bar + '<div class="cf-layout">' + navHtml + '<div class="cf-body">' + bodyHtml + '</div></div>';
      palGrids(pal);
      if (keepScroll) { var pg0 = document.getElementById('nb-page'); if (pg0) pg0.scrollTop = keepScroll; }
      Array.prototype.forEach.call(box.querySelectorAll('.cf-navitem'), function(b){
        b.onclick = function(){
          var want = Number(b.getAttribute('data-g'));
          CFG_GRP = want;
          Array.prototype.forEach.call(box.querySelectorAll('.cf-navitem'), function(x){
            x.className = 'cf-navitem' + (x === b ? ' on' : '');
            if (x === b) x.setAttribute('aria-current', 'true'); else x.removeAttribute('aria-current');
          });
          Array.prototype.forEach.call(box.querySelectorAll('.cf-group'), function(w){
            w.hidden = w.getAttribute('data-g') !== String(want);
          });
          var pg = document.getElementById('nb-page'); if (pg) pg.scrollTop = 0;
        };
      });
      function msg(t, ok){ var e = $('cf-msg'); if (e) { e.textContent = t; e.className = 'hint ' + (ok ? 'ok' : 'err'); } }
      function on(id, fn){ var b = $(id); if (b) b.onclick = fn; }
      // ── 自己决定怎么配置（2026-11-15）───────────────────────────
      // 两个入口都直接写 config.json：① 设置页分组与顺序 ② VS Code 式的原始 JSON。
      // 不替用户预设、不把归一化后的默认值写回去；写坏了只报错，不悄悄修。
      var editMode = '';
      function editMsg(s, bad){ var e = $('cf-editor-msg'); if (e){ e.textContent = s; e.style.color = bad ? 'var(--amber)' : ''; } }
      function editOpen(mode){
        editMode = mode;
        var wrap2 = $('cf-editor'), ta = $('cf-editor-text'); if (!wrap2 || !ta) return;
        wrap2.hidden = false; editMsg('');
        $('cf-editor-reset').hidden = mode !== 'layout';
        if (mode === 'layout'){
          $('cf-editor-title').textContent = '设置页分组与顺序';
          ta.value = JSON.stringify(CFG_GROUPS, null, 2);
          $('cf-editor-help').textContent = '一行一组：name 是组名，hint 是副标题，secs 按你写的顺序放节名。' +
            '节名必须和页面上的小节标题一字不差，对不上会当场标红。留空数组就是只留这一条工具栏。' +
            '保存只改 ui.cfgGroups，不动其他配置；「恢复内置默认布局」把它删掉。';
        } else {
          $('cf-editor-title').textContent = '直接编辑配置（ui / tts / vision）';
          $('cf-editor-help').textContent = '只认 ui / tts / vision 三个命名空间，其余原样保留。' +
            '密钥不在这里（走系统的加密凭据库），声音/视觉都能在这里一次写全。' +
            '字符串留空 = 清掉这一项；没写的键保持不变，不会替你补默认值。';
          editMsg('读取中…');
          fetch('/api/config/raw').then(function(r){ return r.json(); }).then(function(j){
            if (editMode !== 'raw') return;
            ta.value = JSON.stringify({ ui: j.ui || {}, tts: j.tts || {}, vision: j.vision || {} }, null, 2);
            editMsg('');
          }).catch(function(e){ editMsg('读取失败：' + e.message, true); });
        }
        ta.focus();
      }
      on('cf-edit-layout', function(){ editOpen('layout'); });
      on('cf-edit-raw', function(){ editOpen('raw'); });
      on('cf-editor-cancel', function(){ var w = $('cf-editor'); if (w) w.hidden = true; editMode = ''; });
      on('cf-editor-reset', function(){
        editMsg('保存中…');
        jsend('PUT', '/api/ui', { cfgGroups: null })
          .then(function(){ cfgView(); })
          .catch(function(e){ editMsg('没存成：' + e.message, true); });
      });
      on('cf-editor-save', function(){
        var ta = $('cf-editor-text'); if (!ta) return;
        var obj;
        try { obj = JSON.parse(ta.value); }
        catch (e){ editMsg('JSON 写错了：' + e.message, true); return; }
        var call = editMode === 'layout'
          ? jsend('PUT', '/api/ui', { cfgGroups: obj })
          : jsend('PUT', '/api/config/raw', obj);
        editMsg('保存中…');
        call.then(function(){ cfgView(); })
          .catch(function(e){ editMsg('没存成：' + e.message, true); });
      });
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

      // 外壳：切换立刻生效（不刷新页面）
      Array.prototype.forEach.call(box.querySelectorAll('[data-shellv]'), function(b){
        b.onclick = function(){
          var v = b.getAttribute('data-shellv');
          if (((ui.shell || 'notebook') === v)) return;
          jsend('PUT', '/api/ui', { shell: v })
            .then(function(){
              ui.shell = v;
              applyShell(v);
              shellPeek(false);
              tick(v === 'classic' ? '外壳：专注（单栏）' : '外壳：记录本（三栏）');
              cfgView();
            })
            .catch(function(e){ tick('没切换：' + e.message); });
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
      // 主动开口（心跳）：写 config.json，**必须重启面板**才生效 ——
      // 所以这里不假装「已开启」，只如实说「等重启」。
      on('cf-beat', function(){
        var btn = $('cf-beat'), st = $('cf-beatstate'), msg = $('cf-beatmsg');
        var next = !(ui.beat === true);
        if (btn) btn.disabled = true;
        if (msg) msg.textContent = '保存中…';
        fetch('/api/ui', { method: 'PUT', headers: H, body: JSON.stringify({ beat: next }) })
          .then(function(r){ return r.json(); })
          .then(function(j){
            if (!j || j.ok !== true) {
              if (msg) msg.textContent = (j && (j.why || j.error)) || '没保存成';
              if (btn) btn.disabled = false;
              return;
            }
            ui.beat = next;
            if (btn) { btn.textContent = next ? '关掉' : '打开'; btn.disabled = false; }
            if (st) {
              st.textContent = next ? '已开启 · 等重启才生效' : '未开启（她不会主动说话）';
              st.style.color = next ? 'var(--amber)' : 'var(--dim)';
            }
            if (msg) msg.textContent = next ? '已写进 config.json，重启面板后开始' : '已关掉，重启面板后彻底停';
            tick(next ? '心跳已开启（重启面板后开始）' : '心跳已关闭（重启面板后生效）');
          })
          .catch(function(){
            if (msg) msg.textContent = '没保存成：网络或服务没响应';
            if (btn) btn.disabled = false;
          });
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
      // 眼 · 视觉（2026-11-12）
      on('cf-vsave', function(){
        var v = function(id){ return (($(id) || {}).value || '').trim(); };
        var body = { provider: v('cf-vprov'), model: v('cf-vmodel'), baseUrl: v('cf-vbase') };
        var k = v('cf-vkey');
        if (k) body.key = k;                 // 留空 = 不动已有 key
        jsend('PUT', '/api/vision', body)
          .then(function(){ tick('视觉配置已保存'); cfgView(); })
          .catch(function(e){ tick('没保存：' + e.message); });
      });
      on('cf-vcloud', function(){
        jsend('PUT', '/api/vision', { cloudEnabled: !vis.cloudEnabled })
          .then(function(){ tick('云闸已切换'); cfgView(); })
          .catch(function(e){ tick('没切换：' + e.message); });
      });
      on('cf-vclear', function(){
        jsend('PUT', '/api/vision', { key: null })
          .then(function(){ tick('已清除视觉 key'); cfgView(); })
          .catch(function(e){ tick('没清除：' + e.message); });
      });
      // WSL 小房子（2026-11-12）
      on('cf-wsetup', function(){
        if (!window.confirm('装/初始化她的 Ubuntu 小房子？约 1GB，可能要几分钟。')) return;
        tick('装中…（别关页面）');
        jpost('/api/wsl/setup', {})
          .then(function(){ tick('小房子好了'); cfgView(); })
          .catch(function(e){ tick('没装成：' + e.message); });
      });
      on('cf-wauto', function(){
        jsend('PUT', '/api/wsl', { autonomous: !wsl.autonomous })
          .then(function(){ tick('自主已切换'); cfgView(); })
          .catch(function(e){ tick('没切换：' + e.message); });
      });
      on('cf-wsnap', function(){
        tick('快照中…');
        jpost('/api/wsl/snapshot', {})
          .then(function(){ tick('快照好了'); cfgView(); })
          .catch(function(e){ tick('没拍成：' + e.message); });
      });
      // 陪伴 · 声音（2026-11-12）
      Array.prototype.forEach.call(box.querySelectorAll('[data-ttsvoice]'), function(b){
        b.onclick = function(){ var f = $('cf-ttsvoice'); if (f) f.value = b.getAttribute('data-ttsvoice'); };
      });
      on('cf-ttssave', function(){
        var v = function(id){ return (($(id) || {}).value || '').trim(); };
        // 全部按原样回写：空串 = 清掉，**不补默认值**（用户明确要自己决定，不要我预设）
        var body = {
          backend: v('cf-ttsbackend'), baseUrl: v('cf-ttsbase'), model: v('cf-ttsmodel'),
          voice: v('cf-ttsvoice'), format: v('cf-ttsformat'), instructions: v('cf-ttsinst'),
          modelPath: v('cf-ttsmodelpath')
        };
        var sp = v('cf-ttsspeed'), vol = v('cf-ttsvolume');
        if (sp !== '') body.speed = Number(sp);
        if (vol !== '') body.volume = Number(vol);
        var k = v('cf-ttskey');
        if (k === 'null') body.apiKey = null;      // 显式清除
        else if (k) body.apiKey = k;                // 留空 = 不动已有 key
        jsend('PUT', '/api/tts', body)
          .then(function(){ tick('声音配置已保存'); cfgView(); })
          .catch(function(e){ tick('没保存：' + e.message); });
      });
      on('cf-ttstest', function(){
        var m = $('cf-ttsmsg'); if (m) m.textContent = '合成中…';
        fetch('/api/tts', { method: 'POST', headers: H, body: JSON.stringify({ text: '你好，我是鲸鲸。' }) })
          .then(function(r){ if (!r.ok) return r.json().then(function(j){ throw new Error(j.error || '失败'); }); return r.blob(); })
          .then(function(blob){ var a = new Audio(URL.createObjectURL(blob)); a.play(); if (m) m.textContent = '在放了'; })
          .catch(function(e){ if (m) m.textContent = '试听失败：' + (e.message || e); });
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
      // 纯前端剪贴板：navigator.clipboard 在非安全上下文不可用，退一步用 execCommand。
      // 只写剪贴板，不调用任何会写数据目录的服务端动作（exportDiag 会写 home/diag，这里不碰）。
      function copyDiagText(text, msgEl){
        var ok = function(){ if (msgEl) { msgEl.textContent = '已复制诊断摘要到剪贴板'; msgEl.style.color = 'var(--cyan)'; } };
        var bad = function(){ if (msgEl) { msgEl.textContent = '复制失败：请检查浏览器剪贴板权限，或手动复制'; msgEl.style.color = 'var(--amber)'; } };
        var legacy = function(){
          try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            var done = document.execCommand('copy');
            document.body.removeChild(ta);
            return done;
          } catch (e) { return false; }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(ok, function(){ legacy() ? ok() : bad(); });
        } else {
          legacy() ? ok() : bad();
        }
      }
      on('cf-diagcopy', function(){
        var msgEl = $('cf-diagcopy-msg');
        if (msgEl) { msgEl.textContent = '正在整理…'; msgEl.style.color = ''; }
        // 纯前端读两个只读接口的关键字段；不新增任何服务端导出动作。
        Promise.all([
          fetch('/health').then(function(r){ return r.json(); }).catch(function(){ return {}; }),
          fetch('/api/version').then(function(r){ return r.json(); }).catch(function(){ return {}; })
        ]).then(function(res){
          var h = res[0] || {}, v = res[1] || {};
          var dg = Array.isArray(h.degraded) ? h.degraded : [];
          var lines = [
            'PDLP 诊断摘要',
            '生成时间: ' + new Date().toISOString(),
            '版本: ' + (v.version || '—'),
            '更新策略: ' + (v.updatePolicy || '—') + (v.updatePolicy === 'manual-verified' ? '（人工校验覆盖安装，不会自动更新）' : ''),
            'Node: ' + (v.node || '—'),
            '平台 / 架构: ' + (v.platform || '—') + ' / ' + (v.arch || '—'),
            '最低 Node: ' + (v.minNode || '—'),
            '健康: ' + (h.ok === false ? '异常' : '正常'),
            'schema: ' + (h.schema == null ? '—' : h.schema),
            '记忆(active): ' + (h.memories == null ? '—' : h.memories),
            '已运行: ' + (h.uptimeS == null ? '—' : h.uptimeS + ' 秒'),
            '部署槽: ' + (h.release || '—'),
            '降级项: ' + (dg.length ? dg.join(' · ') : '无')
          ];
          copyDiagText(lines.join('\n'), msgEl);
        }).catch(function(){
          if (msgEl) { msgEl.textContent = '整理失败：接口没回来'; msgEl.style.color = 'var(--amber)'; }
        });
      });
      // 「检查更新」只读：把 notes / downloadUrl / sha256 当文本展示，不给下载按钮、不触发安装。
      on('cf-upcheck', function(){
        var out = $('cf-upout'), m = $('cf-upmsg');
        if (out) out.innerHTML = '<div class="nb-empty">检查中…</div>';
        fetch('/api/update-check').then(function(r){ return r.json(); }).then(function(j){
          j = j || {};
          var rows = [];
          if (j.notice) rows.push('<div class="nb-empty">' + esc(j.notice) + '</div>');
          if (j.hasUpdate) {
            rows.push('<div class="nb-runrow"><span class="k">有新版</span><span class="v">' +
              esc(j.current || '—') + ' -> ' + esc(j.latest || '—') + '</span><span></span></div>');
            rows.push('<div class="nb-runrow"><span class="k">更新说明</span><span class="v">' +
              esc(j.notes || '—') + '</span><span></span></div>');
            rows.push('<div class="nb-runrow"><span class="k">下载地址</span><span class="v">' +
              esc(j.downloadUrl || '—') + '</span><span></span></div>');
            rows.push('<div class="nb-runrow"><span class="k">SHA-256</span><span class="v">' +
              esc(j.sha256 || '—') + '</span><span></span></div>');
            rows.push('<div class="nb-empty">请自行下载、核对 SHA-256 后覆盖安装；本页不会自动下载或安装。</div>');
          } else if (!j.notice) {
            rows.push('<div class="nb-empty">当前已是最新（' + esc(j.current || '—') + '）。</div>');
          }
          if (out) out.innerHTML = rows.join('');
          if (m) m.textContent = '只读本地发布清单；本页不会自动下载或安装';
        }).catch(function(){
          if (out) out.innerHTML = '<div class="nb-empty">检查失败（接口没回来）</div>';
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
          jpost('/api/standing/' + encodeURIComponent(b.getAttribute('data-off')) + '/disable', {})
            .then(function(){ tick('已停用'); cfgView(); })
            .catch(function(e){ tick('没停用成：' + e.message); });
        };
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-revoke]'), function(b){
        b.onclick = function(){
          jpost('/api/grants/' + encodeURIComponent(b.getAttribute('data-revoke')) + '/revoke', {})
            .then(function(){ tick('已收回'); cfgView(); })
            .catch(function(e){ tick('没收成：' + e.message); });
        };
      });
      // 权限档位：切档会 revokeAll，所以先问一句；失败要说清原因，别静默
      Array.prototype.forEach.call(box.querySelectorAll('[data-perm]'), function(b){
        b.onclick = function(){
          var want = b.getAttribute('data-perm');
          if (want === curPreset) return;
          var label = b.textContent;
          var msg = $('cf-perm-msg');
          if (!window.confirm('切到「' + label + '」？\n\n会立刻撤销当前所有授权窗口（正在跑的命令不受影响）。')) return;
          if (msg) msg.textContent = '切换中…';
          fetch('/api/permission', { method: 'POST', headers: H, body: JSON.stringify({ preset: want, because: '面板上切档位' }) })
            .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j || {} }; }); })
            .then(function(x){
              if (!x.ok || x.j.ok === false) {
                if (msg) msg.textContent = '没切成：' + (x.j.why || x.j.code || x.j.error || ('HTTP ' + x.ok));
                return;
              }
              tick('档位：' + label);
              cfgView();
            })
            .catch(function(e){ if (msg) msg.textContent = '没切成：' + ((e && e.message) || e); });
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
    { k: '页面', v: '能力体检', go: 'ovw' },
    { k: '页面', v: '存储', go: 'sto' },
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
  // 点一下循环：自动 → 聊天 → 工作 → 自动（自动时不再问，直接按句子判）
  if (modeChip) modeChip.onclick = function(){
    var next = MODE_AUTO ? 'chat' : (modeChip.textContent.indexOf('工作') >= 0 ? 'auto' : 'work');
    modeChip.disabled = true;
    fetch('/api/mode', { method: 'POST', headers: H, body: JSON.stringify({ mode: next }) })
      .then(function(r){ return r.json(); }).then(function(j){
        if (j && j.ok) {
          paintMode(j.mode, j.mode === 'auto' ? MODE_RESOLVED : undefined);
          tick(j.mode === 'auto' ? '自动：按每句话自己判断该用哪档'
            : j.mode === 'work' ? '固定工作模式：简报更长、允许更多步'
            : '固定聊天模式：简报更短、更省');
        } else tick('没切成');
        modeChip.disabled = false;
      }).catch(function(){ modeChip.disabled = false; tick('没切成'); });
  };
  loadTheme();
  loadMode();
  checkSetup();
  loadState(); loadTimeline(); loadTabs(); loadHome(); loadAvatars();
  // 深链接：?view=home|chat|board|mem|docs|cap|git|gap|task|cfg（截图、书签、排障都靠它）
  (function(){
    var m = /[?&]view=([a-z]+)/.exec(location.search || '');
    var v = m ? m[1] : '';
    if (v === 'board') { go('home'); setTimeout(function(){ Board(true); }, 120); return; }
    if (v === 'chat') { go('chat'); return; }
    if (['mem','docs','cap','ovw','sto','git','cfg','gap','task','sess','approvals','logs','files'].indexOf(v) >= 0) { setTimeout(function(){ go(v); }, 120); return; }
    // 没有 ?view= 时**默认进记录**：打开就该是「今天 + 最近一轮会话」，不是工作台
    if (!v && location.search.indexOf("pal=1") < 0) { go('chat'); return; }
    go('home');
    if (location.search.indexOf("pal=1") >= 0) setTimeout(palOpen, 200);
  })();
  setInterval(function(){ loadState(); loadTabs(); }, 20000);
})();
