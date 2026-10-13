/* ============================================================
   GlassBlog 后端服务（零依赖 Node.js，node >= 16）

   功能：
   - 静态文件服务（gzip 压缩 / 缓存头 / 安全响应头）
   - POST /api/login    登录（防爆破：同 IP 连错 5 次锁定 10 分钟）
   - POST /api/logout   注销令牌
   - GET  /api/content  读取内容（公开；旧版数据自动迁移到当前 schema）
   - PUT  /api/content  保存内容（鉴权；rev 乐观锁防多端覆盖，冲突返回 409；
                        写入前自动备份到 data/backups/，保留最近 20 份）
   - POST /api/upload?dir=images|packages&name=文件名
                        文件上传（鉴权；扩展名白名单 + 分目录大小限制）
   - POST /api/hit      页面访问计数（公开，隐私友好：仅路径，无 Cookie，同访客同页 30 分钟内不重复计）
   - GET  /api/stats    近 30 天访问统计（鉴权）
   - GET  /api/backups  备份历史列表（鉴权，最近 20 份）
   - POST /api/restore  恢复到指定备份（鉴权；恢复前会把当前内容再备份一份）
   - GET  /api/health   健康检查（含版本 / 运行时长 / memo 与任务计数）
   - /api/memos*        备忘录：列表 / 标签云 / 单条 / 创建 / 更新 / 删除 / 分享链接
                        （写操作鉴权 + 备份 + 原子写入 + 审计；私密备忘支持 share 令牌免登录查看）

   底座：
   - global.GBEvent      全局事件总线（内容更新、备份恢复时 emit "post:update"）
   - global.GBAgentLogs  agent 运行日志读写（按月切割为 data/agent-logs-YYYY-MM.json，
                         每月最多 500 条，自动清理 90 天前的旧文件）
   - data/audit.log      审计日志（登录 / 注销 / 内容保存 / 上传 / 恢复，按行 JSON）
   - GET  /rss.xml      RSS 订阅（参考 Hexo 由内容自动生成）
   - GET  /blog.html?p=<slug>
                        文章页服务端注入 og:/twitter: meta（爬虫不执行 JS，
                        分享到微信/Twitter 才能出标题/摘要/封面卡片）

   环境变量：
     PORT=8899  ADMIN_USER=admin  ADMIN_PASS=glass123
     SITE_URL=https://你的域名（RSS 链接用）
     TOKEN_TTL_DAYS=30（令牌有效期，滑动续期）
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const GBSchema = require("./assets/js/schema"); // 数据契约：migrate / normalize（与前端共用）

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8899;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "glass123";
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");
const TOKEN_TTL = Number(process.env.TOKEN_TTL_DAYS || 30) * 864e5;

const CONTENT_FILE = path.join(ROOT, "data", "content.json");
const SESSIONS_FILE = path.join(ROOT, "data", "sessions.json");
const STATS_FILE = path.join(ROOT, "data", "stats.json");
const BACKUP_DIR = path.join(ROOT, "data", "backups");
const AUDIT_LOG = path.join(ROOT, "data", "audit.log");
const AGENT_LOGS_DIR = path.join(ROOT, "data");

// 上传白名单与大小限制（参考常见开源 CMS 的分目录策略）
const UPLOAD_DIRS = {
  images:   { dir: "uploads",   max: 20 * 1024 * 1024,  exts: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"] },
  packages: { dir: "downloads", max: 500 * 1024 * 1024, exts: [".zip", ".dmg", ".exe", ".msi", ".gz", ".7z", ".apk"] },
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/rss+xml; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".mp4": "video/mp4",
  ".zip": "application/zip", ".dmg": "application/octet-stream", ".exe": "application/octet-stream",
};

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/* ---------- JSON 文件读写（写入做节流合并，退出前落盘） ---------- */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
const pendingData = {};
const pendingTimer = {};
function writeJSON(file, data, throttle = true) {
  pendingData[file] = data;
  if (!throttle) { fs.writeFileSync(file, JSON.stringify(data)); return; }
  clearTimeout(pendingTimer[file]);
  pendingTimer[file] = setTimeout(() => fs.writeFile(file, JSON.stringify(data), () => {}), 3000);
}
function flushWrites() {
  for (const file of Object.keys(pendingData)) {
    clearTimeout(pendingTimer[file]);
    try { fs.writeFileSync(file, JSON.stringify(pendingData[file])); } catch {}
  }
}

/* 原子写入：先写临时文件再 rename，避免写入中断产生半个 JSON */
function writeContent(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/* ---------- 全局事件总线（供后续 agent / memo 等模块订阅内容变更） ---------- */
const GBEvent = {
  _h: {},
  on(e, fn) { (this._h[e] = this._h[e] || []).push(fn); },
  emit(e, d) { (this._h[e] || []).forEach((f) => { try { f(d); } catch (err) { console.error(`[GBEvent] ${e} 处理异常:`, err); } }); },
};
global.GBEvent = GBEvent;

/* ---------- 会话令牌（有效期滑动续期） ---------- */
function tokenOf(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
  return m && m[1];
}
function authOK(req) {
  const t = tokenOf(req);
  if (!t) return false;
  const sessions = readJSON(SESSIONS_FILE, {});
  const sess = sessions[t];
  if (!sess) return false;
  if (Date.now() - sess.touched > TOKEN_TTL) {          // 过期清除
    delete sessions[t];
    writeJSON(SESSIONS_FILE, sessions, false);
    return false;
  }
  if (Date.now() - sess.touched > 36e5) {               // 每小时滑动续期一次
    sess.touched = Date.now();
    writeJSON(SESSIONS_FILE, sessions);
  }
  return true;
}

/* 通用鉴权中间件：未登录统一回 401，返回 false 时调用方直接 return */
function authRequired(req, res) {
  if (!authOK(req)) {
    sendJSON(req, res, 401, { error: "未登录" });
    return false;
  }
  return true;
}

/* ---------- 登录防爆破（内存态，重启清零） ---------- */
const loginFails = new Map(); // ip -> { count, lockUntil }
function clientIP(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
}
function loginLocked(ip) {
  const r = loginFails.get(ip);
  return !!r && r.lockUntil > Date.now();
}
function recordLoginFail(ip) {
  const r = loginFails.get(ip) || { count: 0, lockUntil: 0 };
  r.count += 1;
  if (r.count >= 5) { r.count = 0; r.lockUntil = Date.now() + 10 * 60e3; } // 锁 10 分钟
  loginFails.set(ip, r);
}

/* ---------- 审计日志（按行 JSON 追加到 data/audit.log） ---------- */
function auditLog(action, req, target) {
  const entry = JSON.stringify({ t: new Date().toISOString(), ip: clientIP(req), action, target }) + "\n";
  fs.appendFileSync(AUDIT_LOG, entry);
}

/* ---------- agent 运行日志（按月切割，每月最多 500 条，保留 90 天） ---------- */
function agentLogFile() {
  const m = new Date().toISOString().slice(0, 7); // "2026-10"
  return path.join(AGENT_LOGS_DIR, `agent-logs-${m}.json`);
}
function readAgentLogs() { return readJSON(agentLogFile(), []); }
function writeAgentLog(entry) {
  const file = agentLogFile();
  const logs = readJSON(file, []);
  logs.unshift(entry); // 最新在前
  if (logs.length > 500) logs.length = 500; // 每月最多 500 条
  writeContent(file, logs);
  // 清理 90 天前的旧日志
  try {
    const cutoff = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 7);
    fs.readdirSync(AGENT_LOGS_DIR).filter((f) => f.startsWith("agent-logs-") && f.slice(11, 18) < cutoff)
      .forEach((f) => fs.unlinkSync(path.join(AGENT_LOGS_DIR, f)));
  } catch {}
}
global.GBAgentLogs = { readAgentLogs, writeAgentLog }; // 供后续 agent 模块使用

/* ---------- 访问统计（隐私友好，参考 Plausible/Umami 思路） ---------- */
let stats = readJSON(STATS_FILE, {}); // { "2026-10-12": { "/": 3 } }
const recentHits = new Map();         // ip|path -> 时间戳
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of recentHits) if (now - ts > 36e5) recentHits.delete(k);
}, 600e3).unref();

/* ---------- 响应工具（自动 gzip） ---------- */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|rss\+xml|xml))/;
function send(req, res, code, body, type, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { "Content-Type": type, ...SEC_HEADERS, ...extra };
  const ae = req.headers["accept-encoding"] || "";
  if (buf.length > 1024 && COMPRESSIBLE.test(type) && ae.includes("gzip")) {
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    res.writeHead(code, headers);
    return res.end(zlib.gzipSync(buf));
  }
  res.writeHead(code, headers);
  res.end(buf);
}
const sendJSON = (req, res, code, obj) => send(req, res, code, JSON.stringify(obj), "application/json; charset=utf-8");

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function safeName(name) {
  const base = path.basename(String(name || "file")).replace(/[^\w.\-一-龥]/g, "_");
  return Date.now().toString(36) + "-" + base;
}

/* ---------- RSS（参考 Hexo：由内容文件自动生成订阅源） ---------- */
let rssCache = null; // { base, xml, ts }
const xmlEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

/* 轻量 Markdown → HTML（仅用于 RSS 全文输出，覆盖常用语法，保持零依赖） */
function mdToHtml(md) {
  const inline = (s) => xmlEsc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" />')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln.trim()) { i++; continue; }
    if (/^```/.test(ln)) { // 围栏代码块
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push(`<pre><code>${xmlEsc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    let m;
    if ((m = ln.match(/^(#{1,4})\s+(.*)/))) { // 标题
      const lv = m[1].length;
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`); i++; continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(ln)) { out.push("<hr />"); i++; continue; } // 分隔线
    if (/^>\s?/.test(ln)) { // 引用块
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${buf.map(inline).join("<br />")}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(ln)) { // 无序列表（含任务列表）
      const buf = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]))
        buf.push(`<li>${inline(lines[i++].replace(/^\s*[-*]\s+/, ""))}</li>`);
      out.push(`<ul>${buf.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(ln)) { // 有序列表
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]))
        buf.push(`<li>${inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
      out.push(`<ol>${buf.join("")}</ol>`);
      continue;
    }
    // 普通段落：合并连续非空行
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>\s?|\s*[-*]\s+|\s*\d+[.)]\s+)/.test(lines[i]))
      buf.push(lines[i++]);
    out.push(`<p>${buf.map(inline).join("<br />")}</p>`);
  }
  return out.join("\n");
}
function renderRSS(data, base) {
  const posts = data.posts
    .filter((p) => p.status === "published")
    .sort((a, b) => new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date))
    .slice(0, 50);
  const items = posts.map((p) => `
    <item>
      <title>${xmlEsc(p.title)}</title>
      <link>${base}/blog.html?p=${encodeURIComponent(p.slug || p.id)}</link>
      <guid>${base}/blog.html?p=${encodeURIComponent(p.slug || p.id)}</guid>
      <pubDate>${new Date(p.createdAt || p.date).toUTCString()}</pubDate>
      <description><![CDATA[${String(p.excerpt || "").replace(/\]\]>/g, "]] >")}]]></description>
      <content:encoded><![CDATA[${mdToHtml(p.content).replace(/\]\]>/g, "]] >")}]]></content:encoded>
      ${(p.tags || []).map((t) => `<category>${xmlEsc(t)}</category>`).join("\n      ")}
    </item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${xmlEsc(data.profile.name)} · GlassBlog</title>
    <link>${base}</link>
    <description>${xmlEsc(data.profile.bio)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>`;
}

/* ---------- Sitemap（与 RSS 同模式：由内容文件生成 + 60s 缓存） ---------- */
let sitemapCache = null; // { base, xml, ts }
function renderSitemap(data, base) {
  const posts = data.posts.filter((p) => p.status === "published");
  const today = new Date().toISOString().slice(0, 10);
  const url = (loc, lastmod, pri) =>
    `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><priority>${pri}</priority></url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${url(base + "/", today, "1.0")}
${url(base + "/blog.html", today, "0.8")}
${url(base + "/apps.html", today, "0.6")}
${posts.map((p) => url(`${base}/blog.html?p=${encodeURIComponent(p.slug || p.id)}`, String(p.updatedAt || p.date).slice(0, 10), "0.7")).join("\n")}
</urlset>`;
}

/* ---------- 内容备份（PUT / 恢复前调用；保留最近 20 份，字典序即时间序） ---------- */
function backupContent() {
  if (!fs.existsSync(CONTENT_FILE)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  fs.copyFileSync(CONTENT_FILE, path.join(BACKUP_DIR, `content-${stamp}.json`));
  fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("content-")).sort().reverse()
    .slice(20).forEach((f) => fs.unlinkSync(path.join(BACKUP_DIR, f)));
}

/* ---------- 文章页 OG meta 注入（分享卡片：爬虫不执行 JS，必须服务端输出） ---------- */
function servePostPage(req, res, key) {
  fs.readFile(path.join(ROOT, "blog.html"), (err, buf) => {
    if (err) return send(req, res, 404, "404", "text/plain; charset=utf-8");
    const headers = { "Cache-Control": "no-cache" };
    const data = GBSchema.migrate(readJSON(CONTENT_FILE, { posts: [] }));
    // 草稿/不存在的 slug 不注入，回退原页面（前端路由会正常处理）
    const post = (data.posts || []).find((x) => (x.slug === key || x.id === key) && x.status === "published");
    if (!post) return send(req, res, 200, buf, "text/html; charset=utf-8", headers);

    const base = SITE_URL || `http://${req.headers.host || "localhost:" + PORT}`;
    const pageUrl = `${base}/blog.html?p=${encodeURIComponent(post.slug || post.id)}`;
    const cover = post.cover
      ? (post.cover.startsWith("http") ? post.cover : base + "/" + String(post.cover).replace(/^\/+/, ""))
      : "";
    const title = xmlEsc(post.title);
    const desc = xmlEsc(post.excerpt || post.title);

    const og = [
      `<meta property="og:type" content="article" />`,
      `<meta property="og:title" content="${title}" />`,
      `<meta property="og:description" content="${desc}" />`,
      `<meta property="og:url" content="${xmlEsc(pageUrl)}" />`,
      cover ? `<meta property="og:image" content="${xmlEsc(cover)}" />` : "",
      `<meta property="article:published_time" content="${xmlEsc(post.createdAt || post.date)}" />`,
      `<meta property="article:modified_time" content="${xmlEsc(post.updatedAt || post.createdAt || post.date)}" />`,
      `<meta name="twitter:card" content="${cover ? "summary_large_image" : "summary"}" />`,
    ].filter(Boolean).join("\n  ");

    // 用函数替换，避免标题含 $& 等字符被 replace 当成特殊模式
    const html = buf.toString("utf8")
      .replace(/<title>[^<]*<\/title>/, () => `<title>${title} · GlassBlog</title>`)
      .replace(/(<meta name="description"[^>]*content=")[^"]*(")/, (m, pre, post) => `${pre}${desc}${post}`)
      .replace(/<meta property="og:type" content="website" \/>/, () => og);
    send(req, res, 200, html, "text/html; charset=utf-8", headers);
  });
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    /* ===== API ===== */
    if (p === "/api/health") {
      const data = readJSON(CONTENT_FILE, {});
      return sendJSON(req, res, 200, {
        ok: true, version: GBSchema.SCHEMA_VERSION, uptime: process.uptime(),
        memos: (data.memos || []).length, tasks: (data.agentTasks || []).length,
      });
    }

    /* ===== 备忘录 API =====
       GET    /api/memos              列表（未登录仅 public；支持 tag/q/from/to/includeArchived 筛选）
       GET    /api/memos/tags         标签云（未登录只统计 public）
       GET    /api/memos/:id          单条详情（私密需登录，或 ?share=有效令牌）
       POST   /api/memos              创建（鉴权）
       PUT    /api/memos/:id          更新（鉴权，rev 乐观锁）
       DELETE /api/memos/:id          删除（鉴权）
       POST   /api/memos/:id/share    生成分享链接（鉴权，expireHours 默认 24） */
    const memoMatch = p.match(/^\/api\/memos(?:\/([^/]+))?(?:\/(share))?$/);
    if (memoMatch) {
      const memoId = memoMatch[1] ? decodeURIComponent(memoMatch[1]) : null;
      const isShare = memoMatch[2] === "share";
      const authed = authOK(req); // 只判断登录态，是否强制 401 由各接口自行决定

      /* 标签云（需先于 :id 分支匹配，避免 "tags" 被当成备忘 id） */
      if (memoId === "tags" && !isShare && req.method === "GET") {
        const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
        const counts = {};
        (data.memos || [])
          .filter((m) => authed || m.visibility === "public")
          .forEach((m) => (m.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
        const tags = Object.entries(counts).map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count);
        return sendJSON(req, res, 200, { tags });
      }

      /* 列表：置顶优先，其余按创建时间倒序 */
      if (!memoId && req.method === "GET") {
        const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
        let list = (data.memos || []).slice();
        // 未登录仅公开；已登录默认排除归档（?includeArchived=true 时包含）
        if (!authed) list = list.filter((m) => m.visibility === "public");
        else if (url.searchParams.get("includeArchived") !== "true") list = list.filter((m) => !m.archived);
        const tag = url.searchParams.get("tag");
        if (tag) list = list.filter((m) => (m.tags || []).includes(tag));
        const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (q) list = list.filter((m) => String(m.content || "").toLowerCase().includes(q));
        const from = url.searchParams.get("from"); // YYYY-MM-DD
        const to = url.searchParams.get("to");
        if (from) list = list.filter((m) => String(m.createdAt || "").slice(0, 10) >= from);
        if (to) list = list.filter((m) => String(m.createdAt || "").slice(0, 10) <= to);
        list.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) ||
          (new Date(b.createdAt) - new Date(a.createdAt)));
        return sendJSON(req, res, 200, { memos: list });
      }

      /* 单条详情：公开任意人可看；私密需登录，或携带有效分享令牌 */
      if (memoId && !isShare && req.method === "GET") {
        const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
        const memo = (data.memos || []).find((m) => m.id === memoId);
        if (!memo) return sendJSON(req, res, 404, { error: "备忘不存在" });
        if (authed || memo.visibility === "public") return sendJSON(req, res, 200, memo);
        const shareToken = url.searchParams.get("share") || "";
        const sh = memo.share || {};
        const valid = sh.enabled && sh.token && sh.token === shareToken &&
          (!sh.expireAt || new Date(sh.expireAt) > new Date());
        if (valid) return sendJSON(req, res, 200, memo);
        return sendJSON(req, res, 403, { error: "无权访问" });
      }

      /* 创建备忘 */
      if (!memoId && req.method === "POST") {
        if (!authRequired(req, res)) return;
        const body = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString() || "{}");
        const now = GBSchema.nowISO();
        const memo = GBSchema.normalizeMemo({
          id: GBSchema.genId("memo"),
          content: String(body.content || ""),
          tags: Array.isArray(body.tags) ? body.tags : [],
          visibility: body.visibility, // normalizeMemo 白名单兜底为 private
          pinned: !!body.pinned,
          archived: false,
          attachments: [],
          share: { enabled: false, token: "", expireAt: null },
          createdAt: now,
          updatedAt: now,
          rev: 1,
        });
        const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
        data.memos.unshift(memo); // 最新在前
        backupContent();
        writeContent(CONTENT_FILE, data); // 原子写入
        rssCache = null;                  // 内容变更，RSS / Sitemap 缓存失效
        sitemapCache = null;
        GBEvent.emit("memo:create", memo);
        auditLog("memo:create", req, memo.id);
        return sendJSON(req, res, 200, memo);
      }

      /* 更新备忘：rev 乐观锁，防多端覆盖 */
      if (memoId && !isShare && req.method === "PUT") {
        if (!authRequired(req, res)) return;
        const body = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString() || "{}");
        const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
        const memo = (data.memos || []).find((m) => m.id === memoId);
        if (!memo) return sendJSON(req, res, 404, { error: "备忘不存在" });
        if (typeof body.rev !== "number" || body.rev !== memo.rev)
          return sendJSON(req, res, 409, { error: "备忘已被其他窗口修改，请刷新后重试", rev: memo.rev });
        if (body.content !== undefined) memo.content = String(body.content);
        if (body.tags !== undefined) memo.tags = Array.isArray(body.tags) ? body.tags : [];
        if (body.visibility !== undefined) memo.visibility = body.visibility;
        if (body.pinned !== undefined) memo.pinned = !!body.pinned;
        if (body.archived !== undefined) memo.archived = !!body.archived;
        memo.rev += 1;
        memo.updatedAt = GBSchema.nowISO();
        GBSchema.normalizeMemo(memo); // 字段规范化（visibility 白名单等）
        backupContent();
        writeContent(CONTENT_FILE, data);
        rssCache = null;
        sitemapCache = null;
        GBEvent.emit("memo:update", memo);
        auditLog("memo:update", req, memo.id);
        return sendJSON(req, res, 200, memo);
      }

      /* 删除备忘 */
      if (memoId && !isShare && req.method === "DELETE") {
        if (!authRequired(req, res)) return;
        const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
        const idx = (data.memos || []).findIndex((m) => m.id === memoId);
        if (idx < 0) return sendJSON(req, res, 404, { error: "备忘不存在" });
        backupContent();
        data.memos.splice(idx, 1);
        writeContent(CONTENT_FILE, data);
        rssCache = null;
        sitemapCache = null;
        GBEvent.emit("memo:delete", { id: memoId });
        auditLog("memo:delete", req, memoId);
        return send(req, res, 204, "", "text/plain; charset=utf-8");
      }

      /* 生成分享链接：随机令牌 + 过期时间 */
      if (memoId && isShare && req.method === "POST") {
        if (!authRequired(req, res)) return;
        const body = JSON.parse((await readBody(req, 1e5)).toString() || "{}");
        const hours = Number(body.expireHours) > 0 ? Number(body.expireHours) : 24; // 默认 24 小时
        const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
        const memo = (data.memos || []).find((m) => m.id === memoId);
        if (!memo) return sendJSON(req, res, 404, { error: "备忘不存在" });
        memo.share = {
          enabled: true,
          token: crypto.randomBytes(16).toString("hex"),
          expireAt: new Date(Date.now() + hours * 36e5).toISOString(),
        };
        memo.updatedAt = GBSchema.nowISO();
        backupContent();
        writeContent(CONTENT_FILE, data);
        rssCache = null;
        sitemapCache = null;
        GBEvent.emit("memo:update", memo);
        auditLog("memo:update", req, memo.id);
        return sendJSON(req, res, 200, { url: `/memos.html?share=${memo.share.token}&id=${memo.id}` });
      }

      return sendJSON(req, res, 405, { error: "方法不允许" });
    }

    if (p === "/api/login" && req.method === "POST") {
      const ip = clientIP(req);
      if (loginLocked(ip)) return sendJSON(req, res, 429, { error: "尝试次数过多，请 10 分钟后再试" });
      const { user, pass } = JSON.parse((await readBody(req, 1e6)).toString() || "{}");
      if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
        recordLoginFail(ip);
        return sendJSON(req, res, 401, { error: "账号或密码错误" });
      }
      loginFails.delete(ip);
      const token = crypto.randomBytes(24).toString("hex");
      const sessions = readJSON(SESSIONS_FILE, {});
      sessions[token] = { user, touched: Date.now() };
      writeJSON(SESSIONS_FILE, sessions, false);
      auditLog("login", req, user);
      return sendJSON(req, res, 200, { token });
    }

    if (p === "/api/logout" && req.method === "POST") {
      const t = tokenOf(req);
      const sessions = readJSON(SESSIONS_FILE, {});
      if (t && sessions[t]) {
        auditLog("logout", req, sessions[t].user);
        delete sessions[t];
        writeJSON(SESSIONS_FILE, sessions, false);
      }
      return sendJSON(req, res, 200, { ok: true });
    }

    if (p === "/api/content" && req.method === "GET") {
      // 读取时迁移：旧版备份/手工编辑过的文件也按当前 schema 输出（不落盘，PUT 时才落）
      const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
      return sendJSON(req, res, 200, data, { "Cache-Control": "no-cache" });
    }

    if (p === "/api/content" && req.method === "PUT") {
      if (!authRequired(req, res)) return;
      const data = JSON.parse((await readBody(req, 50 * 1024 * 1024)).toString());
      if (!data.profile || !Array.isArray(data.posts) || !Array.isArray(data.projects))
        return sendJSON(req, res, 400, { error: "内容结构不完整" });

      // rev 乐观锁：客户端必须基于服务端当前版本保存，
      // 否则说明另一窗口/设备已先写入，直接覆盖会静默丢数据 → 409 让前端刷新
      const current = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
      const clientRev = typeof data.rev === "number" ? data.rev : null;
      if (clientRev === null || clientRev !== current.rev)
        return sendJSON(req, res, 409, { error: "内容已被其他窗口修改，请刷新后重试", rev: current.rev });

      GBSchema.migrate(data); // 写入前规范化：补齐 slug / createdAt / updatedAt / schemaVersion
      data.rev = current.rev + 1;

      // 写入前自动备份旧版本（保留最近 20 份）
      backupContent();
      writeContent(CONTENT_FILE, data); // 原子写入
      rssCache = null;                  // 内容变更，RSS / Sitemap 缓存失效
      sitemapCache = null;
      auditLog("content:update", req, `rev=${data.rev}`);
      GBEvent.emit("post:update", { rev: data.rev });
      return sendJSON(req, res, 200, { ok: true, rev: data.rev });
    }

    if (p === "/api/upload" && req.method === "POST") {
      if (!authRequired(req, res)) return;
      const conf = UPLOAD_DIRS[url.searchParams.get("dir")];
      if (!conf) return sendJSON(req, res, 400, { error: "dir 参数无效（images / packages）" });
      const rawName = String(url.searchParams.get("name") || "").toLowerCase();
      if (!conf.exts.some((e) => rawName.endsWith(e)))
        return sendJSON(req, res, 400, { error: "不支持的文件类型，允许：" + conf.exts.join(" ") });
      if (Number(req.headers["content-length"] || 0) > conf.max)
        return sendJSON(req, res, 413, { error: "文件超出大小限制" });

      const filename = safeName(url.searchParams.get("name"));
      const absDir = path.join(ROOT, conf.dir);
      fs.mkdirSync(absDir, { recursive: true });
      const abs = path.join(absDir, filename);

      let size = 0, tooBig = false;
      req.on("data", (c) => {
        size += c.length;
        if (size > conf.max && !tooBig) { tooBig = true; req.destroy(); }
      });
      const ws = fs.createWriteStream(abs);
      await new Promise((resolve, reject) => {
        req.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
        req.on("error", reject);
      });
      if (tooBig) { fs.unlink(abs, () => {}); return sendJSON(req, res, 413, { error: "文件超出大小限制" }); }
      auditLog("upload", req, conf.dir + "/" + filename);
      return sendJSON(req, res, 200, { url: conf.dir + "/" + filename, size });
    }

    // 访问计数：仅记录路径，同访客同页 30 分钟内只计一次
    if (p === "/api/hit" && req.method === "POST") {
      const { path: hp } = JSON.parse((await readBody(req, 1e5)).toString() || "{}");
      if (typeof hp !== "string" || !hp.startsWith("/") || hp.startsWith("/api") ||
          hp.length > 120 || hp.includes(".."))
        return send(req, res, 204, "", "text/plain");
      const key = clientIP(req) + "|" + hp;
      const last = recentHits.get(key) || 0;
      if (Date.now() - last < 30 * 60e3) return send(req, res, 204, "", "text/plain");
      recentHits.set(key, Date.now());
      const day = new Date().toISOString().slice(0, 10);
      (stats[day] ||= {})[hp] = (stats[day][hp] || 0) + 1;
      const days = Object.keys(stats).sort();
      while (days.length > 90) delete stats[days.shift()]; // 只保留 90 天
      writeJSON(STATS_FILE, stats);
      return send(req, res, 204, "", "text/plain");
    }

    if (p === "/api/stats" && req.method === "GET") {
      if (!authRequired(req, res)) return;
      const since = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
      const pages = {};
      let total = 0;
      for (const [day, pv] of Object.entries(stats)) {
        if (day < since) continue;
        for (const [k, v] of Object.entries(pv)) { pages[k] = (pages[k] || 0) + v; total += v; }
      }
      // 近 30 天按天序列（无访问的日期补 0，供趋势图使用；与 hit 写入同为 UTC 日期）
      const days = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
        const pv = stats[d] || {};
        let c = 0;
        for (const v of Object.values(pv)) c += v;
        days.push({ date: d, count: c });
      }
      return sendJSON(req, res, 200, {
        total,
        days,
        pages: Object.entries(pages).map(([path, count]) => ({ path, count }))
          .sort((a, b) => b.count - a.count).slice(0, 20),
      });
    }

    /* 备份历史：列出 data/backups/ 下最近 20 份（字典序即时间序） */
    if (p === "/api/backups" && req.method === "GET") {
      if (!authRequired(req, res)) return;
      let list = [];
      try {
        list = fs.readdirSync(BACKUP_DIR)
          .filter((f) => /^content-[\d-]+\.json$/.test(f))
          .sort().reverse().slice(0, 20)
          .map((f) => {
            const st = fs.statSync(path.join(BACKUP_DIR, f));
            return { file: f, size: st.size, mtime: st.mtime.toISOString() };
          });
      } catch {}
      return sendJSON(req, res, 200, { backups: list });
    }

    /* 一键恢复：校验文件名防路径穿越 → 校验结构 → 当前内容再备份一份（可反悔）→ 原子写入 */
    if (p === "/api/restore" && req.method === "POST") {
      if (!authRequired(req, res)) return;
      const { file } = JSON.parse((await readBody(req, 1e5)).toString() || "{}");
      if (!/^content-[\d-]+\.json$/.test(String(file || "")))
        return sendJSON(req, res, 400, { error: "备份文件名无效" });
      const abs = path.join(BACKUP_DIR, file);
      if (!fs.existsSync(abs)) return sendJSON(req, res, 404, { error: "备份不存在" });

      let data;
      try { data = JSON.parse(fs.readFileSync(abs, "utf8")); }
      catch { return sendJSON(req, res, 400, { error: "备份文件已损坏" }); }
      if (!data.profile || !Array.isArray(data.posts) || !Array.isArray(data.projects))
        return sendJSON(req, res, 400, { error: "备份内容结构不完整" });

      const current = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
      backupContent(); // 恢复前把当前内容也备份一份，恢复本身可反悔
      GBSchema.migrate(data); // 旧备份可能是老 schema，恢复即迁移到当前版本
      data.rev = current.rev + 1; // rev 只增不减，避免其他窗口持旧 rev 继续写入
      writeContent(CONTENT_FILE, data);
      rssCache = null;
      sitemapCache = null;
      auditLog("restore", req, file);
      GBEvent.emit("post:update", { rev: data.rev, restored: file });
      return sendJSON(req, res, 200, { ok: true, rev: data.rev });
    }

    if (p === "/rss.xml" && req.method === "GET") {
      const base = SITE_URL || `http://${req.headers.host || "localhost:" + PORT}`;
      if (!rssCache || rssCache.base !== base || Date.now() - rssCache.ts > 60e3)
        rssCache = { base, xml: renderRSS(GBSchema.migrate(readJSON(CONTENT_FILE, { posts: [], profile: {} })), base), ts: Date.now() };
      return send(req, res, 200, rssCache.xml, "application/rss+xml; charset=utf-8",
        { "Cache-Control": "public, max-age=300" });
    }

    if (p === "/sitemap.xml" && req.method === "GET") {
      const base = SITE_URL || `http://${req.headers.host || "localhost:" + PORT}`;
      if (!sitemapCache || sitemapCache.base !== base || Date.now() - sitemapCache.ts > 60e3)
        sitemapCache = { base, xml: renderSitemap(GBSchema.migrate(readJSON(CONTENT_FILE, { posts: [] })), base), ts: Date.now() };
      return send(req, res, 200, sitemapCache.xml, "application/xml; charset=utf-8",
        { "Cache-Control": "public, max-age=300" });
    }

    if (p === "/robots.txt" && req.method === "GET") {
      const base = SITE_URL || `http://${req.headers.host || "localhost:" + PORT}`;
      return send(req, res, 200,
        `User-agent: *\nAllow: /\nDisallow: /admin.html\n\nSitemap: ${base}/sitemap.xml\n`,
        "text/plain; charset=utf-8", { "Cache-Control": "public, max-age=3600" });
    }

    if (p.startsWith("/api/")) return sendJSON(req, res, 404, { error: "接口不存在" });

    /* ===== 安全：不对外暴露点文件、服务端代码与运行时数据 ===== */
    if (p.split("/").some((s) => s.startsWith(".")) ||
        p === "/server.js" || p.startsWith("/data/") || p.startsWith("/deploy/")) {
      return send(req, res, 404, "404", "text/plain; charset=utf-8");
    }

    /* ===== 文章页 OG 注入（仅带 ?p= 的 blog.html 请求，其余走静态文件） ===== */
    if (p === "/blog.html" && req.method === "GET") {
      const key = (url.searchParams.get("p") || "").trim();
      if (key) return servePostPage(req, res, key);
    }

    /* ===== 静态文件 ===== */
    let file = path.normalize(path.join(ROOT, decodeURIComponent(p)));
    if (!file.startsWith(ROOT)) return send(req, res, 403, "403", "text/plain; charset=utf-8");
    if (fs.existsSync(file) && fs.statSync(file).isDirectory())
      file = path.join(file, "index.html");

    let cache = "no-cache";
    if (p.startsWith("/assets/") || p.startsWith("/uploads/")) cache = "public, max-age=86400";
    else if (p.startsWith("/downloads/")) cache = "public, max-age=3600";

    fs.readFile(file, (err, buf) => {
      if (err) {
        // 页面类请求回退到玻璃风 404 页；资源类请求保持纯文本 404
        if (!path.extname(file) || p.endsWith(".html")) {
          return fs.readFile(path.join(ROOT, "404.html"), (e2, b2) =>
            send(req, res, 404, e2 ? "404" : b2, "text/html; charset=utf-8"));
        }
        return send(req, res, 404, "404", "text/plain; charset=utf-8");
      }
      send(req, res, 200, buf,
        MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        { "Cache-Control": cache });
    });
  } catch (e) {
    sendJSON(req, res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`GlassBlog 已启动: http://127.0.0.1:${PORT}`);
  console.log(`后台入口: http://127.0.0.1:${PORT}/admin.html （账号 ${ADMIN_USER}）`);
});

// 优雅退出（systemd stop 发 SIGTERM）：先落盘再退出
process.on("SIGTERM", () => {
  flushWrites();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
