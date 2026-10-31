// 鲸鲸 · Trianon 真数据层（iframe 桥）
//
// 为什么是 iframe：Trianon 在 window 捕获层 `stopImmediatePropagation()`，
// 会吞掉**所有**点击与按键（实测连 `el.click()` 都不触发 `onclick`）。
// 放进 iframe 后，事件不冒泡到父文档，两边互不干扰：
//   · Trianon 管"长什么样"（原样保留，demo 照跑）
//   · `/desk/live` 管"真数据"（对话 / 工具卡 / 审批 / 引擎状态）
(function () {
  if (window.__jjDesk) return;
  window.__jjDesk = true;

  var style = document.createElement("style");
  style.textContent = [
    "#jj-real{position:fixed;right:0;top:0;bottom:0;width:min(46vw,620px);z-index:2147483000;",
    "border-left:1px solid #c9cddb;box-shadow:-18px 0 40px rgba(60,70,110,.12);background:#fbfaf6}",
    "#jj-real iframe{width:100%;height:100%;border:0;display:block}",
  ].join("");
  document.head.appendChild(style);

  var root = document.createElement("div");
  root.id = "jj-real";
  var frame = document.createElement("iframe");
  frame.id = "jj-frame";
  frame.src = "/desk/live";
  frame.title = "真数据层";
  root.appendChild(frame);
  document.body.appendChild(root);
})();
