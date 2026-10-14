/* GlassBlog 模块：原生 Markdown 渲染 + HTML 消毒（零依赖，替代 marked / DOMPurify）
 *
 * 挂载：GB.sanitize(html)、GB.mdLite(markdown)
 * 用途：备忘录 / Bot 回复等 v3 新模块的内容渲染；blog / admin 文章渲染
 *       仍走 common.js 的 GB.md（vendor，红线豁免），本模块不受影响。
 *
 * GB.sanitize 规则（v3 指令 3.6）：
 *  - DOMParser 解析遍历；标签白名单 p br hr h1-h6 strong em del code pre
 *    blockquote ul ol li a img table thead tbody tr th td input span div
 *  - 属性白名单：a[href,title]、img[src,alt,title]、input[type,checked,disabled]、
 *    code/pre[class]（仅 language-*）
 *  - 链接仅允许 http/https/相对路径；图片额外允许 data:image/*
 *  - a 强制 rel="noopener noreferrer nofollow"，外链 target="_blank"
 *  - 删除 on* 事件、style、script、iframe、object、embed、form
 */
GB.register("markdown", {
  init() {
    const TAGS = new Set(("p br hr h1 h2 h3 h4 h5 h6 strong em del code pre " +
      "blockquote ul ol li a img table thead tbody tr th td input span div").split(" "));
  const ATTRS = {
    a: new Set(["href", "title"]),
    img: new Set(["src", "alt", "title"]),
    input: new Set(["type", "checked", "disabled"]),
    code: new Set(["class"]),
    pre: new Set(["class"]),
  };

  function urlOK(u, { image = false } = {}) {
    const s = String(u || "").trim();
    if (!s) return false;
    if (image && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return true;
    if (/^(https?:)?\/\//i.test(s)) return true;   // http/https/协议相对
    if (/^\//.test(s)) return true;                // 站内绝对路径
    if (/^[./#]/.test(s)) return true;             // 相对路径 / 锚点
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return true; // 无 scheme 的相对地址
    return false;                                  // javascript: data: vbscript: 等
  }

  /* 递归净化节点：白名单外标签剥壳保留文本，危险标签整体删除 */
  function cleanNode(node, doc) {
    if (node.nodeType === 8) { node.remove(); return; } // 注释
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (["script", "iframe", "object", "embed", "form", "style", "link", "meta"].includes(tag)) {
      el.remove();
      return;
    }
    if (!TAGS.has(tag)) { // 剥壳：子节点上提
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
      el.remove();
      return;
    }
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "style") { el.removeAttribute(attr.name); return; }
      const allowed = ATTRS[tag];
      if (!allowed || !allowed.has(name)) { el.removeAttribute(attr.name); return; }
      if (name === "class" && !/^language-[\w-]+$/.test(attr.value.trim())) el.removeAttribute(attr.name);
      if (name === "href" && !urlOK(attr.value)) el.removeAttribute(attr.name);
      if (name === "src" && !urlOK(attr.value, { image: tag === "img" })) el.removeAttribute(attr.name);
      if (tag === "input" && name === "type" && attr.value !== "checkbox") el.removeAttribute(attr.name);
    });
    if (tag === "input") { // 任务列表复选框：只读展示
      if (el.getAttribute("type") !== "checkbox") { el.remove(); return; }
      el.setAttribute("disabled", "");
    }
    if (tag === "a") {
      el.setAttribute("rel", "noopener noreferrer nofollow");
      const href = el.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) el.setAttribute("target", "_blank");
    }
    [...el.childNodes].forEach((c) => cleanNode(c, doc));
  }

  function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<div>${String(html == null ? "" : html)}</div>`, "text/html");
    const rootEl = doc.body.firstChild;
    [...rootEl.childNodes].forEach((c) => cleanNode(c, doc));
    return rootEl.innerHTML;
  }

  /* ---------- 轻量 Markdown（mdLite） ----------
     覆盖备忘/Bot 场景：标题、粗斜体、删除线、行内代码、代码块、链接、
     图片、引用、有序/无序/任务列表、表格、分割线、段落。输出经 sanitize。 */
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function inline(s) {
    let out = esc(s);
    const codes = [];
    out = out.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (_, alt, src, title) => `<img src="${esc(src)}" alt="${alt}"${title ? ` title="${esc(title)}"` : ""}>`);
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (_, text, href, title) => `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}>${text}</a>`);
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
    return out;
  }

  function mdLite(src) {
    const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
    const html = [];
    let i = 0;
    const para = [];
    const flushPara = () => {
      if (para.length) { html.push("<p>" + para.map(inline).join("<br>") + "</p>"); para.length = 0; }
    };
    while (i < lines.length) {
      const line = lines[i];
      // 代码块 ```lang
      let m = line.match(/^```(\w*)\s*$/);
      if (m) {
        flushPara();
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        html.push(`<pre><code${m[1] ? ` class="language-${esc(m[1])}"` : ""}>${esc(buf.join("\n"))}</code></pre>`);
        continue;
      }
      // 分割线
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); html.push("<hr>"); i++; continue; }
      // 标题
      m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) { flushPara(); html.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
      // 引用块
      if (/^>\s?/.test(line)) {
        flushPara();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
        html.push("<blockquote>" + mdLite(buf.join("\n")) + "</blockquote>");
        continue;
      }
      // 列表（含任务列表），支持一级缩进嵌套
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        flushPara();
        const items = [];
        let ordered = /^\s*\d+\.\s+/.test(line);
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i]);
          i++;
        }
        const renderItems = (arr) => arr.map((it) => {
          let text = it.replace(/^\s*([-*+]|\d+\.)\s+/, "");
          const task = text.match(/^\[([ xX])\]\s+(.*)$/);
          if (task) {
            const box = `<input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}>`;
            return `<li class="task-item">${box} ${inline(task[2])}</li>`;
          }
          return `<li>${inline(text)}</li>`;
        }).join("");
        html.push(ordered ? `<ol>${renderItems(items)}</ol>` : `<ul>${renderItems(items)}</ul>`);
        continue;
      }
      // 表格：| a | b |\n|---|---|
      if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        flushPara();
        const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        html.push("<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>");
        continue;
      }
      // 空行断段
      if (/^\s*$/.test(line)) { flushPara(); i++; continue; }
      para.push(line);
      i++;
    }
    flushPara();
    return sanitize(html.join("\n"));
  }

  GB.sanitize = sanitize;
  GB.mdLite = mdLite;
  },
});
