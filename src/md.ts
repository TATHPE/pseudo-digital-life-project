/** 极简 Markdown → HTML（够用、可测、零依赖；所有文本先转义） */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string): string {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_m, a) => `<code>${a}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, "$1<i>$2</i>");
  t = t.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_m, a, u) => `<a href="${u}" target="_blank" rel="noreferrer">${a}</a>`);
  return t;
}

/** 返回 HTML 片段；代码块带语言标记便于样式 */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let inCode = false;
  let code: string[] = [];
  let lang = "";
  let list: "ul" | "ol" | null = null;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      if (!inCode) { inCode = true; lang = fence[1] ?? ""; code = []; }
      else {
        out.push(`<pre class="code" data-lang="${esc(lang)}"><code>${esc(code.join("\n"))}</code></pre>`);
        inCode = false;
      }
      i++; continue;
    }
    if (inCode) { code.push(line); i++; continue; }

    if (!line.trim()) { closeList(); i++; continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); const n = h[1]!.length; out.push(`<h${n}>${inline(h[2] ?? "")}</h${n}>`); i++; continue; }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { closeList(); out.push("<hr>"); i++; continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(ul[1] ?? "")}</li>`); i++; continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(ol[1] ?? "")}</li>`); i++; continue; }

    if (line.startsWith(">")) { closeList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`); i++; continue; }

    // 段落：合并连续非空行
    const buf = [line];
    i++;
    while (i < lines.length) {
      const nxt = lines[i] ?? "";
      if (!nxt.trim() || /^(#{1,4}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|>)/.test(nxt)) break;
      buf.push(nxt); i++;
    }
    closeList();
    out.push(`<p>${inline(buf.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  if (inCode) out.push(`<pre class="code"><code>${esc(code.join("\n"))}</code></pre>`);
  closeList();
  return out.join("\n");
}
