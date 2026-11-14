// 陪伴视图 · 形象（2026-11-13）。两种渲染：
//  · mesh：RuiC-2D 用立绘绑定的 mesh avatar（/static/pal/ruic/ 或导入包），参数驱动眨眼/视线/口型/呼吸；
//  · cubism：现成 Live2D 公皮（.model3.json + .moc3），pixi-live2d-display 渲染，保留表情/动作/物理。
// 走 /ui/pal.js 热加载路由，notebook.js 的陪伴模式调 window.JJPal。
(function(){
  'use strict';
  var S = null;
  function blank(){
    return { stage:null, canvas:null, avatar:null, model:null, app:null, kind:'mesh', mw:0, mh:0, raf:0, onMove:null, onResize:null, dead:false,
      audio:null, audioUrl:null, audioCtx:null, analyser:null, mouth:0,
      t:0, last:0, nextBlink:2.5, blinkAt:-1, gazeX:0, gazeY:0, wantX:0, wantY:0, state:'idle',
      tune: loadTune() };
  }
  S = blank();
  // 镜头/形象调参：界面滑杆实时驱动，存 localStorage，刷新不丢
  // noseFix=1：把 rig.face.nose 压到近乎为 0，去掉运行库在鼻区合成的黑色方块 + 白点
  function defaultTune(){ return { frac:0.5, zoom:1, offX:0, offY:0, gaze:1, mouth:1, breath:1, noseFix:1 }; }
  function loadTune(){
    var t = defaultTune();
    try { var s = localStorage.getItem('jj.cp.tune'); if (s){ var o = JSON.parse(s); for (var k in t) if (typeof o[k] === 'number') t[k] = o[k]; } } catch (e) {}
    return t;
  }
  function saveTune(){ try { localStorage.setItem('jj.cp.tune', JSON.stringify(S.tune)); } catch (e) {} }
  function applyMeshTune(){
    if (!S || !S.canvas) return;
    var T = S.tune;
    S.canvas.style.transformOrigin = 'center center';
    S.canvas.style.transform = 'translate(' + T.offX + 'px,' + T.offY + 'px) scale(' + T.zoom + ')';
  }
  function remount(){ if (S && S.mountArgs) mount.apply(null, S.mountArgs); }
  function setTune(patch){
    if (!S) return;
    var needRemount = false;
    for (var k in patch) {
      if (typeof patch[k] !== 'number' || !(k in S.tune)) continue;
      if (k === 'noseFix' && S.kind === 'mesh' && !!S.tune.noseFix !== !!patch[k]) needRemount = true;
      S.tune[k] = patch[k];
    }
    saveTune();
    if (S.kind === 'cubism') fitCubism(); else applyMeshTune();
    if (needRemount) remount();
  }
  function getTune(){ return S ? S.tune : defaultTune(); }
  function resetTune(){
    var was = S ? S.tune.noseFix : 1;
    S.tune = defaultTune(); saveTune();
    if (S.kind === 'cubism') fitCubism(); else applyMeshTune();
    if (S.kind === 'mesh' && !!was !== !!S.tune.noseFix) remount();
    return S.tune;
  }

  function loadScript(src){
    return new Promise(function(res, rej){
      var s = document.createElement('script');
      s.src = src; s.onload = function(){ res(); }; s.onerror = function(){ rej(new Error('加载失败 ' + src)); };
      document.head.appendChild(s);
    });
  }
  function guidance(container, e){
    // 只放自己的文案 + 错误 message，用 textContent 拼，不把网络来的字符串当 HTML 解析
    container.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'nb-empty'; box.style.lineHeight = '1.9';
    box.textContent = '形象没加载出来：' + (e && e.message ? String(e.message) : '资源缺失') +
      '（在设置 · 陪伴里重新导入形象包，或换回内置鲸鱼娘）';
    container.appendChild(box);
  }

  // ── 口型/发声 ─────────────────────────────────────────────
  function cleanupAudio(){
    if (S.audio){ try { S.audio.pause(); } catch (e) {} S.audio = null; }
    if (S.audioUrl){ URL.revokeObjectURL(S.audioUrl); S.audioUrl = null; }
    if (S.audioCtx){ try { S.audioCtx.close(); } catch (e) {} S.audioCtx = null; }
    S.analyser = null; S.mouth = 0;
  }
  function playBlob(blob){
    return new Promise(function(resolve){
      cleanupAudio();
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      S.audio = audio; S.audioUrl = url;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx){
        try {
          var ctx = new Ctx();
          var src = ctx.createMediaElementSource(audio);
          var analyser = ctx.createAnalyser(); analyser.fftSize = 256;
          src.connect(analyser); analyser.connect(ctx.destination);
          S.audioCtx = ctx; S.analyser = analyser;
          var data = new Uint8Array(analyser.frequencyBinCount);
          var tick = function(){
            if (!S.analyser) return;
            analyser.getByteFrequencyData(data);
            var sum = 0; for (var i = 0; i < data.length; i++) sum += data[i];
            // 说话时把口型拉起来：纯响度会在句尾掉到 0，补一个下限
            var amp = Math.min(1, (sum / data.length) / 110);
            S.mouth = amp > 0.04 ? 0.25 + amp * 0.75 : 0;
            S.rafMouth = requestAnimationFrame(tick);
          };
          audio.onplay = function(){ tick(); };
        } catch (e) { /* 口型同步失败也不挡发声 */ }
      }
      audio.onended = function(){ cleanupAudio(); if (S.rafMouth) cancelAnimationFrame(S.rafMouth); setState('idle'); resolve(); };
      audio.onerror = function(){ cleanupAudio(); setState('idle'); resolve(); };
      audio.play().catch(function(){ cleanupAudio(); setState('idle'); resolve(); });
    });
  }
  function speak(text){
    if (!text || !String(text).trim()) return Promise.resolve();
    setState('speaking');
    return fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json', 'x-jj': '1' }, body: JSON.stringify({ text: String(text) }) })
      .then(function(r){ if (!r.ok) return r.json().then(function(j){ throw new Error(j.error || 'TTS 失败'); }); return r.blob(); })
      .then(function(blob){ return playBlob(blob); })
      .catch(function(e){ setState('idle'); throw e; });
  }
  function stop(){ cleanupAudio(); if (S.rafMouth){ cancelAnimationFrame(S.rafMouth); S.rafMouth = 0; } setState('idle'); }

  // ── 每帧：呼吸/眨眼/视线/口型 → 参数 ────────────────────
  function frame(){
    if (!S || S.dead) return;
    if (S.kind === 'cubism'){ cubismFrame(); return; }
    if (!S.avatar) return;
    var now = performance.now();
    var dt = Math.min(0.05, (now - S.last) / 1000) || 0.016;
    S.last = now; S.t += dt;

    // 视线平滑跟随
    var k = Math.min(1, dt * 5);
    S.gazeX += (S.wantX - S.gazeX) * k;
    S.gazeY += (S.wantY - S.gazeY) * k;

    // 眨眼：2.4–6 秒一次，0.16 秒闭合
    var eye = 1;
    if (S.blinkAt < 0 && S.t >= S.nextBlink){ S.blinkAt = S.t; }
    if (S.blinkAt >= 0){
      var p = (S.t - S.blinkAt) / 0.16;
      if (p >= 1){ S.blinkAt = -1; S.nextBlink = S.t + 2.4 + Math.random() * 3.6; }
      else { eye = p < 0.5 ? 1 - p * 2 : (p - 0.5) * 2; }
    }

    S.avatar.setParameters({
      angleX: -S.gazeY * 2.4 * S.tune.gaze,
      angleY: S.gazeX * 4.2 * S.tune.gaze,
      angleZ: Math.sin(S.t * 0.9) * 1.1,
      bodyAngleZ: Math.sin(S.t * 0.62) * 1.2 + S.gazeX * 1.4,
      breath: (Math.sin(S.t * 1.35) + 1) * 0.42 * S.tune.breath,
      eyeLOpen: eye, eyeROpen: eye,
      mouthOpen: Math.min(1, S.mouth * S.tune.mouth), mouthForm: 0,
      gazeX: S.gazeX * S.tune.gaze, gazeY: S.gazeY * S.tune.gaze,
    });
    S.avatar.advance(dt, 60);
    S.raf = requestAnimationFrame(frame);
  }
  function onMove(e){
    if (!S || !S.stage) return;
    var r = S.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    S.wantX = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2));
    S.wantY = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - 0.5) * 2));
  }

  function setState(s){ S.state = s; }
  function setExpression(name){
    if (S.kind === 'cubism' && S.model){ try { S.model.expression(name); } catch (e) {} }
  }
  function setMouth(v){ S.mouth = Math.max(0, Math.min(1, v || 0)); }
  function expressions(){
    if (S.kind !== 'cubism' || !S.model) return [];
    try { return (S.model.internalModel.settings.expressions || []).map(function(x){ return x.Name || x.name; }); } catch (e) { return []; }
  }
  function motions(){
    if (S.kind !== 'cubism' || !S.model) return [];
    try {
      var g = S.model.internalModel.settings.motions || {};
      var out = [];
      Object.keys(g).forEach(function(k){ (g[k] || []).forEach(function(m, i){ out.push({ group: k, index: i, name: (m.File || '').split('/').pop().replace(/\.motion3\.json$/i, '') }); }); });
      return out;
    } catch (e) { return []; }
  }
  function playMotion(group, index){
    if (S.kind === 'cubism' && S.model){ try { S.model.motion(group, index); } catch (e) {} }
  }

  // ── Cubism（Live2D 公皮）渲染 ───────────────────────────
  function cubismFrame(){
    if (!S.model) return;
    var now = performance.now();
    var dt = Math.min(0.05, (now - S.last) / 1000) || 0.016;
    S.last = now; S.t += dt;
    var k = Math.min(1, dt * 5);
    S.gazeX += (S.wantX - S.gazeX) * k;
    S.gazeY += (S.wantY - S.gazeY) * k;
    var core = S.model.internalModel && S.model.internalModel.coreModel;
    if (core){
      try {
        core.setParameterValueById('ParamMouthOpenY', Math.min(1, S.mouth * S.tune.mouth));
        core.setParameterValueById('ParamBreath', (Math.sin(S.t * 1.35) + 1) * 0.5 * S.tune.breath);
        core.setParameterValueById('ParamAngleX', S.gazeX * 12 * S.tune.gaze);
        core.setParameterValueById('ParamAngleY', -S.gazeY * 8 * S.tune.gaze);
        core.setParameterValueById('ParamEyeBallX', S.gazeX * S.tune.gaze);
        core.setParameterValueById('ParamEyeBallY', -S.gazeY * S.tune.gaze);
      } catch (e) { /* 个别模型参数名不同，忽略 */ }
      applyHideParams();
    }
    S.raf = requestAnimationFrame(cubismFrame);
  }
  // 公皮自带的「加载」部件会在脸上盖一个黑方块 + 白点（cdi3.json 里名字含"加载"的开关参数）。
  // 每帧压回 0，否则模型的 motion/expression 会把它重新点亮。
  function applyHideParams(){
    if (!S || !S.tune.noseFix || !S.model) return;
    var core = S.model.internalModel && S.model.internalModel.coreModel;
    if (!core) return;
    var i;
    for (i = 0; i < (S.hideParams || []).length; i++) {
      try { core.setParameterValueById(S.hideParams[i], 0); } catch (e) {}
    }
    // 黑方块是「加载」部件本身，不是参数：设部件透明度才藏得掉（setPartOpacityById）
    for (i = 0; i < (S.hideParts || []).length; i++) {
      try { core.setPartOpacityById(S.hideParts[i], 0); } catch (e) {}
    }
  }
  function fitCubism(){
    if (!S.model || !S.stage) return;
    var w = S.stage.clientWidth, h = S.stage.clientHeight;
    if (!w || !h) return;
    var reserve = Math.min(210, Math.max(150, h * 0.2));
    var availH = Math.max(120, h - reserve);
    var ow = S.mw || 1, oh = S.mh || 1;
    var T = S.tune;
    // 半身效果：frac 越小越紧（只到胸口）、越大越松（露到大腿）；zoom/offX/offY 由界面滑杆实时调
    var scale = Math.min(availH / (oh * T.frac), (w * 0.98) / ow) * T.zoom;
    S.model.scale.set(scale);
    S.model.x = w / 2 + T.offX;
    S.model.y = (oh * scale) / 2 + 10 + T.offY;
  }
  async function mountCubism(container, base, entry){
    var V = '?v=20261113b';
    if (!window.PIXI) await loadScript('/static/pal/cubism/pixi.min.js' + V);
    if (!window.PIXI || !window.PIXI.live2d){
      await loadScript('/static/pal/cubism/live2dcubismcore.min.js' + V);
      await loadScript('/static/pal/cubism/pixi-live2d-display.cubism4.min.js' + V);
    }
    if (!window.PIXI || !window.PIXI.live2d) throw new Error('Live2D 运行库没加载出来');
    var PIXI = window.PIXI;
    var app = new PIXI.Application({ backgroundAlpha: 0, resizeTo: container, antialias: true, autoDensity: true, premultipliedAlpha: false, resolution: Math.min(2, window.devicePixelRatio || 1) });
    container.innerHTML = '';
    container.appendChild(app.view);
    PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);
    var model = await PIXI.live2d.Live2DModel.from(base + entry, { autoUpdate: true });
    app.stage.addChild(model);
    model.anchor.set(0.5, 0.5);
    S.mw = (model.internalModel && model.internalModel.width) || model.width || 1;
    S.mh = (model.internalModel && model.internalModel.height) || model.height || 1;
    S.app = app; S.model = model; S.kind = 'cubism'; S.state = 'idle';
    // 从 DisplayInfo（cdi3.json）里找出名字含"加载 / load"的开关参数，交给 applyHideParams 每帧压 0
    S.hideParams = []; S.hideParts = [];
    try {
      var m3 = await fetch(base + entry).then(function(r){ return r.json(); });
      var di = m3.FileReferences && m3.FileReferences.DisplayInfo;
      if (di) {
        var cdi = await fetch(base + di).then(function(r){ return r.json(); });
        (cdi.Parameters || []).forEach(function(p){
          if (/加载|load/i.test(String(p.Name || ''))) S.hideParams.push(p.Id);
        });
        (cdi.Parts || []).forEach(function(p){
          if (/鼻子|加载|load/i.test(String(p.Name || ''))) S.hideParts.push(p.Id);
        });
      }
    } catch (e) { /* 没有 DisplayInfo 的模型跳过，不影响渲染 */ }
    fitCubism();
    applyHideParams();
    S.onResize = fitCubism; window.addEventListener('resize', S.onResize);
    S.onMove = function(e){
      var r = app.view.getBoundingClientRect();
      try { model.focus(e.clientX - r.left, e.clientY - r.top); } catch (err) {}
      var sr = container.getBoundingClientRect();
      S.wantX = Math.max(-1, Math.min(1, ((e.clientX - sr.left) / sr.width - 0.5) * 2));
      S.wantY = Math.max(-1, Math.min(1, ((e.clientY - sr.top) / sr.height - 0.5) * 2));
    };
    container.addEventListener('pointermove', S.onMove);
    // 有待机动作就播待机，让公皮自己动起来
    try { if ((model.internalModel.settings.motions || {}).Idle) model.motion('Idle', 0); } catch (e) {}
    S.last = performance.now();
    S.raf = requestAnimationFrame(cubismFrame);
  }

  async function mount(container, base, kind, entry){
    destroy();
    S = blank();
    S.stage = container;
    S.mountArgs = [container, base, kind, entry];
    container.innerHTML = '<div class="nb-empty">正在准备形象…</div>';
    base = base || '/static/pal/ruic/';
    if (base.charAt(base.length - 1) !== '/') base += '/';
    try {
      if (kind === 'cubism' && entry){ await mountCubism(container, base, entry); return; }
      // 运行库永远用内置那份（导入包只带 rig/built，不带运行库）
      if (!window.MeshAvatar) await loadScript('/static/pal/ruic/vendor/mesh-avatar.js');
      if (!window.MeshAvatar) throw new Error('mesh-avatar 没加载出来');
      var rig = await fetch(base + 'rig.json?t=' + Date.now()).then(function(r){
        if (!r.ok) throw new Error('rig.json ' + r.status); return r.json();
      });
      // 鼻影修复（默认开）：运行库会按 face.nose 这个椭圆区域合成一块鼻影/高光，
      // 当前素材上会渲染成黑方块 + 白点。压到近乎为 0 即从源头去掉，底图那块本就是干净肤色。
      if (S.tune.noseFix && rig.face && rig.face.nose) { rig.face.nose.rx = 0.01; rig.face.nose.ry = 0.01; }
      container.innerHTML = '';
      var cv = document.createElement('canvas');
      cv.className = 'cp-canvas';
      container.appendChild(cv);
      var av = await window.MeshAvatar.createMeshAvatar(cv, {
        rig: rig, assetsBase: base + 'built/', manual: true,
        padTop: rig.view.padTop, padSide: rig.view.padSide,
      });
      av.setAutoIdle(false); av.setAutoMotion(false);
      S.canvas = cv; S.avatar = av; S.kind = 'mesh'; S.state = 'idle';
      applyMeshTune();
      S.last = performance.now();
      S.onMove = onMove; container.addEventListener('pointermove', S.onMove);
      S.raf = requestAnimationFrame(frame);
    } catch (e) { guidance(container, e); }
  }

  function destroy(){
    if (!S) return;
    S.dead = true;
    if (S.raf) cancelAnimationFrame(S.raf);
    if (S.rafMouth) cancelAnimationFrame(S.rafMouth);
    cleanupAudio();
    if (S.stage && S.onMove) S.stage.removeEventListener('pointermove', S.onMove);
    if (S.onResize) window.removeEventListener('resize', S.onResize);
    if (S.app){ try { S.app.destroy(true, { children: true }); } catch (e) {} }
    else if (S.avatar){ try { S.avatar.destroy(); } catch (e) {} }
    S = blank();
  }

  window.JJPal = {
    mount: mount,
    speak: speak,
    stop: stop,
    setExpression: setExpression,
    setState: setState,
    setMouth: setMouth,
    expressions: expressions,
    motions: motions,
    playMotion: playMotion,
    setTune: setTune,
    getTune: getTune,
    resetTune: resetTune,
    destroy: destroy,
    hasModel: function(){ return !!(S && (S.avatar || S.model)); },
    kind: function(){ return S ? S.kind : 'mesh'; },
  };
})();
