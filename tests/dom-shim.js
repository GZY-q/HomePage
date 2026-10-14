/* 极简 DOM 实现：仅供 node:test 在无浏览器环境下验证 markdown.js 的
   GB.sanitize 白名单策略（Node 无内置 DOMParser）。
   仅实现 sanitize 用到的子集：parseFromString(html,'text/html') → {body}，
   节点含 nodeType / tagName / attributes / childNodes / firstChild /
   getAttribute / setAttribute / removeAttribute / remove / parentNode.insertBefore /
   innerHTML 序列化。测试输入保持常规 HTML，不追求完整规范兼容。 */
"use strict";

const VOID = new Set(["br", "hr", "img", "input", "link", "meta", "area",
  "base", "col", "embed", "source", "track", "wbr"]);

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = [];
    this.childNodes = [];
    this.parentNode = null;
  }
  get firstChild() { return this.childNodes[0] || null; }
  getAttribute(n) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; }
  setAttribute(n, v) {
    const a = this.attributes.find((x) => x.name === n);
    if (a) a.value = String(v); else this.attributes.push({ name: n, value: String(v) });
  }
  removeAttribute(n) { this.attributes = this.attributes.filter((x) => x.name !== n); }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (i >= 0) this.parentNode.childNodes.splice(i, 1);
    this.parentNode = null;
  }
  insertBefore(node, ref) {
    // 规范语义：插入前先把 node 从原父节点摘除，否则「上提子节点」循环会死循环
    const old = node.parentNode;
    if (old) {
      const j = old.childNodes.indexOf(node);
      if (j >= 0) old.childNodes.splice(j, 1);
    }
    node.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(node); else this.childNodes.splice(i, 0, node);
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  get innerHTML() { return this.childNodes.map(serialize).join(""); }
}
class TextNode { constructor(t) { this.nodeType = 3; this.nodeValue = t; this.parentNode = null; } }
class CommentNode { constructor(t) { this.nodeType = 8; this.nodeValue = t; this.parentNode = null; } }

function parseAttrs(el, s) {
  const re = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let a;
  while ((a = re.exec(s))) {
    if (!a[1]) continue;
    const value = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : "";
    el.attributes.push({ name: a[1].toLowerCase(), value });
  }
}

function parse(html) {
  const body = new El("body");
  const stack = [body];
  const re = /<!--([\s\S]*?)-->|<\/\s*([a-zA-Z][\w:-]*)\s*>|<\s*([a-zA-Z][\w:-]*)((?:\s+[^<>]*?)?)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.appendChild(new CommentNode(m[1])); continue; }
    if (m[2] !== undefined) { // 闭合标签：回退到匹配层级
      const name = m[2].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === name) { stack.length = i; break; }
      }
      continue;
    }
    if (m[3] !== undefined) { // 开标签
      const name = m[3].toLowerCase();
      const el = new El(name);
      parseAttrs(el, m[4] || "");
      top.appendChild(el);
      if (!m[5] && !VOID.has(name)) stack.push(el);
      continue;
    }
    if (m[6] !== undefined) { top.appendChild(new TextNode(m[6])); continue; }
  }
  return { body };
}

function serialize(n) {
  if (n.nodeType === 3) return esc(n.nodeValue);
  if (n.nodeType === 8) return "";
  const attrs = n.attributes.map((a) => ` ${a.name}="${esc(a.value)}"`).join("");
  const tag = n.tagName.toLowerCase();
  if (VOID.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>` + n.childNodes.map(serialize).join("") + `</${tag}>`;
}

class DOMParser {
  parseFromString(html) { return parse(String(html)); }
}

module.exports = { DOMParser, El, TextNode, CommentNode };
