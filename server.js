/* ============================================================
   GlassBlog 后端服务（零依赖 Node.js，node >= 16）

   功能：
   - 静态文件服务（gzip 压缩 / 缓存头 / 安全响应头）
   - POST /api/login    登录（防爆破：同 IP 连错 5 次锁定 10 分钟）
   - POST /api/logout   注销令牌
   - GET  /api/content  读取内容（公开；旧版数据自动迁移到当前 schema）
   - PUT  /api/content  保存内容（鉴权；rev 乐观锁防多端覆盖，冲突返回 409；
                        写入前自动备份到 data/backups/，按分级策略保留）
   - POST /api/upload?dir=images|packages&name=文件名
                        文件上传（鉴权；扩展名白名单 + 分目录大小限制 + 文件头魔数校验）
   - POST /api/hit      页面访问计数（公开，隐私友好：仅路径，无 Cookie，同访客同页 30 分钟内不重复计）
   - GET  /api/stats    近 30 天访问统计（鉴权）
   - GET  /api/backups  备份历史列表（鉴权；分级保留：近 7 天每天 1 份 / 近 4 周每周 1 份 / 更早每月 1 份）
   - POST /api/restore  恢复到指定备份（鉴权；恢复前会把当前内容再备份一份）
   - GET  /api/health   健康检查（版本 / 运行时长 / memo 与任务计数 / 调度器状态 / 最近备份）
   - /api/memos*        备忘录：列表 / 标签云 / 单条 / 创建 / 更新 / 删除 / 分享链接
                        （写操作鉴权 + 备份 + 原子写入 + 审计；私密备忘支持 share 令牌免登录查看）
   - /api/agent/tasks*  Agent 定时任务：列表 / 新建 / 更新 / 立即执行 / 删除（全鉴权）
   - GET  /api/agent/logs  Agent 执行日志（鉴权，倒序分页）
   - POST /api/bot/chat  Bot 指令对话（鉴权；白名单指令引擎，≤2000 字；
                        私密备忘内容含 @bot 时自动触发指令并追加回复）

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
     TOKEN_BIND_IP=true（开启后令牌与登录 IP 绑定，换 IP 视为未登录）
     TZ=Asia/Shanghai（全局时区：统计日期 / 调度规则 / 日志时间均按此时区解释）
     TRUST_PROXY=false（置 true 时客户端 IP 取 X-Forwarded-For 最右侧值，
                    仅在本服务位于可信反向代理之后时开启）
     BACKUP_MIN_INTERVAL=300（节流备份最小间隔秒数；删除/导入/迁移前的强制备份不受限）
     WEBHOOK_ALLOW_HOSTS=host1,host2（webhook 动作允许的目标主机白名单，空 = 不额外限制）
   ============================================================ */
// 全局时区必须在任何 Date 使用前设定（Node 启动后读取 process.env.TZ 生效）
process.env.TZ = process.env.TZ || "Asia/Shanghai";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const dns = require("dns");
const net = require("net");
const GBSchema = require("./assets/js/schema"); // 数据契约：migrate / normalize（与前端共用）

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8899;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "glass123";
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");
const TOKEN_TTL = Number(process.env.TOKEN_TTL_DAYS || 30) * 864e5;
// 令牌 IP 绑定：开启后请求 IP 与登录时不一致视为未登录（默认关闭，适配反代/移动网络）
const TOKEN_BIND_IP = String(process.env.TOKEN_BIND_IP || "").toLowerCase() === "true";
// 可信反代开关：仅在可信代理之后开启，客户端 IP 取 X-Forwarded-For 最右侧值
const TRUST_PROXY = String(process.env.TRUST_PROXY || "").toLowerCase() === "true";
// 节流备份最小间隔（秒）：同一文件在该窗口内最多产生 1 份节流备份
const BACKUP_MIN_INTERVAL = Math.max(0, Number(process.env.BACKUP_MIN_INTERVAL) || 300);
// webhook 动作目标主机白名单（逗号分隔，空 = 不额外限制；内网/回环地址始终拒绝）
const WEBHOOK_ALLOW_HOSTS = new Set(
  String(process.env.WEBHOOK_ALLOW_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);

const CONTENT_FILE = path.join(ROOT, "data", "content.json");
const SESSIONS_FILE = path.join(ROOT, "data", "sessions.json");
const STATS_FILE = path.join(ROOT, "data", "stats.json");
const BACKUP_DIR = path.join(ROOT, "data", "backups");
const AUDIT_LOG = path.join(ROOT, "data", "audit.log");
const AGENT_LOGS_DIR = path.join(ROOT, "data");
// Agent 任务运行态（lastRunAt/nextRunAt/lastStatus）：与定义分离存储，不参与备份
const AGENT_STATE_FILE = path.join(ROOT, "data", "agent-state.json");

// 上传白名单与大小限制（参考常见开源 CMS 的分目录策略）
const UPLOAD_DIRS = {
  images:   { dir: "uploads",   max: 20 * 1024 * 1024,  exts: [".png", ".jpg", ".jpeg", ".gif", ".webp"] }, // 禁 SVG（可携带脚本，XSS 风险）
  packages: { dir: "downloads", max: 500 * 1024 * 1024, exts: [".zip", ".dmg", ".exe", ".msi", ".gz", ".7z", ".apk"] },
};

/* 文件头（魔数）校验：落盘后读取前 1KB 比对文件头，防止改扩展名伪装上传 */
function sniffOK(buf, ext) {
  const has = (hex, off = 0) => {
    const t = Buffer.from(hex, "hex");
    return buf.length >= off + t.length && buf.slice(off, off + t.length).equals(t);
  };
  switch (ext) {
    case ".png":  return has("89504E47");
    case ".jpg":
    case ".jpeg": return has("FFD8FF");
    case ".gif":  return has("47494638");                       // GIF8
    case ".webp": return has("52494646") && has("57454250", 8);  // RIFF....WEBP
    case ".zip":
    case ".apk":  return has("504B0304");                       // PK\x03\x04
    case ".gz":   return has("1F8B");
    case ".7z":   return has("377ABCAF271C");
    case ".exe":  return has("4D5A");                           // MZ
    case ".msi":  return has("D0CF11E0A1B11AE1");               // OLE 复合文档
    case ".dmg": {                                              // 放宽：拒绝纯文本伪装（要求含二进制字节）
      const head = buf.slice(0, 512);
      if (!head.length) return false;
      let printable = 0;
      for (const b of head) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) printable++;
      return printable / head.length < 0.9;
    }
    default: return true;                                       // 未定义规则的类型放行
  }
}

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
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // 站点全部资源自托管；页面使用内联 script/style 为既有架构，故 script/style-src
  // 保留 'unsafe-inline'（已知偏差）。img-src 放行 https 以兼容文章正文外链图片。
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; media-src 'self'; connect-src 'self'; font-src 'self' data:; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

/* ---------- JSON 文件读写（写入做节流合并，退出前落盘） ---------- */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/* 原子落盘：同目录 ${file}.${pid}.tmp 临时文件 + fsync + rename。
   rename 在同目录下是原子操作，写入中断不会留下半个 JSON；
   pid 命名避免多实例/并发写同一 tmp 文件互相覆盖。 */
function atomicWriteSync(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd); // 确保持久化后再 rename，掉电不丢已应答的数据
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/* 启动清理：上次异常退出可能残留 ${file}.${pid}.tmp 临时文件 */
function cleanupTmpFiles() {
  try {
    for (const f of fs.readdirSync(AGENT_LOGS_DIR))
      if (/\.\d+\.tmp$/.test(f)) { try { fs.unlinkSync(path.join(AGENT_LOGS_DIR, f)); } catch {} }
  } catch {}
}

/* ---------- 统一串行写入层 ----------
   所有结构化数据（content.json / agent-state.json / agent-logs 等）的写操作
   必须经此层：同一文件的写任务进入 per-file Promise 队列严格串行执行，
   杜绝并发 read-modify-write 互相覆盖。
   用法：writeContent(file, mutate) —— mutate 可以是：
     - 函数：fn(currentData) => nextData（返回 undefined 表示放弃本次写入）
     - 数据对象：直接作为 nextData 全量写入（调用方已完成读改写时使用）
   返回 Promise，写操作需要先应答的场景请 await。 */
const writeQueues = new Map(); // file -> Promise（队尾）
function writeContent(file, mutate) {
  const prev = writeQueues.get(file) || Promise.resolve();
  const job = prev.catch(() => {}).then(() => {
    const next = (typeof mutate === "function")
      ? mutate(readJSON(file, {}))
      : mutate;
    if (next === undefined) return; // mutate 放弃写入
    atomicWriteSync(file, next);
  });
  writeQueues.set(file, job);
  return job;
}
/* 等待全部写入队列排空（优雅退出用） */
function drainWriteQueues() {
  return Promise.all([...writeQueues.values()].map((p) => p.catch(() => {})));
}

/* 运行时小文件（sessions / stats）的节流合并写：3 秒内多次写合并为一次，
   物理写同样走原子落盘；退出前 flushWrites 兜底 */
const pendingData = {};
const pendingTimer = {};
function writeJSON(file, data, throttle = true) {
  if (!throttle) { try { atomicWriteSync(file, data); } catch {} return; } // 立即落盘即终态，不进 pendingData，避免 flushWrites 用陈旧快照重复落盘
  pendingData[file] = data;
  clearTimeout(pendingTimer[file]);
  pendingTimer[file] = setTimeout(() => { try { atomicWriteSync(file, pendingData[file]); } catch {} }, 3000);
}
function flushWrites() {
  for (const file of Object.keys(pendingData)) {
    clearTimeout(pendingTimer[file]);
    try { atomicWriteSync(file, pendingData[file]); } catch {}
  }
}

/* ---------- 全局事件总线（供 agent / bot / memo 等模块订阅内容变更） ----------
   统一 payload 格式：{ source: 'user'|'bot'|'agent'|'system', actor, id, data }
   - source 事件来源；订阅方必须忽略自身 source，防止事件回环
   - actor  具体操作者（登录用户名 / 'bot' / 'agent' / 'system' / 'anonymous'）
   emit 异步派发（setImmediate）：发布者同步流程不被订阅者阻塞，
   单个 handler 异常独立捕获，不影响其他订阅者。 */
const GBEvent = {
  _h: {},
  on(e, fn) { (this._h[e] = this._h[e] || []).push(fn); },
  emit(e, payload) {
    const p = (payload && typeof payload === "object" && payload.source)
      ? payload
      : { source: "system", actor: "system", id: null, data: payload }; // 兼容裸数据发布
    setImmediate(() => {
      (this._h[e] || []).forEach((f) => {
        try { f(p); } catch (err) { console.error(`[GBEvent] ${e} 处理异常:`, err); }
      });
    });
  },
};
global.GBEvent = GBEvent;
/* 构造规范事件 payload 的便捷函数 */
function eventPayload(source, actor, id, data) { return { source, actor, id, data }; }
/* 从请求解析操作者身份（登录用户名为 actor；未登录为 anonymous） */
function actorOf(req) {
  const sess = req && sessionOf(req);
  return (sess && sess.user) || "anonymous";
}

/* ---------- 会话令牌（有效期滑动续期；sessions.json 仅存令牌 SHA-256） ---------- */
function tokenOf(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
  return m && m[1];
}
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
/* 会话查找：令牌先哈希再作为键查表（哈希查找本身不泄露令牌时序信息） */
function sessionOf(req) {
  const t = tokenOf(req);
  if (!t) return null;
  const sessions = readJSON(SESSIONS_FILE, {});
  const sess = sessions[hashToken(t)];
  if (!sess) return null;
  return sess;
}
function authOK(req) {
  const t = tokenOf(req);
  if (!t) return false;
  const sessions = readJSON(SESSIONS_FILE, {});
  const key = hashToken(t);
  const sess = sessions[key];
  if (!sess) return false;
  if (TOKEN_BIND_IP && sess.ip && sess.ip !== clientIP(req)) return false; // IP 绑定：不一致视为未登录
  if (Date.now() - sess.touched > TOKEN_TTL) {          // 过期清除
    delete sessions[key];
    writeJSON(SESSIONS_FILE, sessions, false);
    return false;
  }
  if (Date.now() - sess.touched > 36e5) {               // 每小时滑动续期一次（节流）
    sess.touched = Date.now();
    writeJSON(SESSIONS_FILE, sessions);
  }
  return true;
}

/* 无效 Token 限速：同一 IP 每分钟最多容忍 60 次无效令牌请求，超出回 429。
   防止用伪造令牌暴力探测接口。 */
const invalidTokenHits = new Map(); // ip -> { count, windowStart }
function invalidTokenLimited(req) {
  if (!tokenOf(req) || authOK(req)) return false; // 无令牌或令牌有效不纳入
  const ip = clientIP(req);
  const now = Date.now();
  let r = invalidTokenHits.get(ip);
  if (!r || now - r.windowStart >= 60e3) { r = { count: 0, windowStart: now }; invalidTokenHits.set(ip, r); }
  r.count += 1;
  return r.count > 60;
}
setInterval(() => { // 定期清理过期窗口，防内存缓慢增长
  const now = Date.now();
  for (const [ip, r] of invalidTokenHits) if (now - r.windowStart >= 60e3) invalidTokenHits.delete(ip);
}, 60e3).unref();

/* 通用鉴权中间件：未登录统一回 401，返回 false 时调用方直接 return */
function authRequired(req, res) {
  if (!authOK(req)) {
    if (invalidTokenLimited(req)) return sendJSON(req, res, 429, { error: "无效凭证请求过于频繁" }), false;
    sendJSON(req, res, 401, { error: "未登录" });
    return false;
  }
  return true;
}

/* 可选鉴权（公开接口兼容匿名与登录两种身份）：
   - 无 Token           → 匿名（返回 false，不报错）
   - 有 Token 且有效     → 登录（返回 true）
   - 有 Token 但无效/过期 → 不当匿名放行，直接 401（超限速则 429），返回 null 表示已应答 */
function optionalAuth(req, res) {
  if (!tokenOf(req)) return false;
  if (authOK(req)) return true;
  if (invalidTokenLimited(req)) { sendJSON(req, res, 429, { error: "无效凭证请求过于频繁" }); return null; }
  sendJSON(req, res, 401, { error: "凭证无效或已过期" });
  return null;
}

/* 启动迁移：sessions.json 旧格式以明文令牌为键 → 统一改为 SHA-256(令牌) 为键 */
function migrateSessions() {
  const sessions = readJSON(SESSIONS_FILE, null);
  if (!sessions) return;
  let changed = false;
  for (const key of Object.keys(sessions)) {
    if (!/^[0-9a-f]{64}$/.test(key)) { // 旧格式键即明文令牌
      sessions[hashToken(key)] = sessions[key];
      delete sessions[key];
      changed = true;
    }
  }
  if (changed) writeJSON(SESSIONS_FILE, sessions, false);
}

/* ---------- 登录防爆破（内存态，重启清零） ---------- */
const loginFails = new Map(); // ip -> { count, lockUntil }
function clientIP(req) {
  if (!req || !req.headers) return ""; // agent 等内部调用无请求上下文
  // 仅在明确位于可信反代之后（TRUST_PROXY=true）才采信 X-Forwarded-For，
  // 且取最右侧值（由离本服务最近的可信代理追加，伪造成本最高）；
  // 默认不采信，防止客户端伪造 XFF 绕过登录锁定/限速。
  if (TRUST_PROXY) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",")
      .map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || "";
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

/* ---------- 审计日志（按行 JSON 追加到 data/audit.log，SHA-256 哈希链防篡改） ----------
   行格式：{ ts, actor, ip, type, targetId, ok, prev, h }
   - prev  上一行的 h（首行/裁剪后首行的 prev 为 "GENESIS" 或裁剪锚点）
   - h     sha256(prev + 本行除 h 外的 JSON)
   校验脚本：scripts/verify-audit.js（裁剪后从现存首行的 prev 锚点开始验链）。
   红线：审计日志绝不记录密码、令牌、Webhook 敏感 body。 */
let auditWrites = 0;
let auditLastHash = "GENESIS";
function loadAuditTail() { // 启动时读取最后一行的 h 作为续链锚点
  try {
    const lines = fs.readFileSync(AUDIT_LOG, "utf8").split("\n").filter(Boolean);
    if (lines.length) {
      const last = JSON.parse(lines[lines.length - 1]);
      if (last && typeof last.h === "string") auditLastHash = last.h;
    }
  } catch {}
}
function pruneAuditLog() {
  try {
    const cutoff = new Date(Date.now() - 90 * 864e5).toISOString();
    const lines = fs.readFileSync(AUDIT_LOG, "utf8").split("\n").filter(Boolean);
    const kept = lines.filter((l) => { try { return JSON.parse(l).ts >= cutoff; } catch { return false; } });
    if (kept.length !== lines.length)
      fs.writeFileSync(AUDIT_LOG, kept.length ? kept.join("\n") + "\n" : "");
  } catch {}
}
/* actor 解析优先级：显式传入 > 请求会话用户 > 无请求上下文时的 system */
function auditLog(type, req, targetId, ok = true, actor = null) {
  const entry = {
    ts: new Date().toISOString(),
    actor: actor || (req ? actorOf(req) : "system"),
    ip: clientIP(req),
    type,
    targetId: targetId == null ? null : String(targetId),
    ok: !!ok,
    prev: auditLastHash,
  };
  entry.h = crypto.createHash("sha256").update(entry.prev + JSON.stringify(entry)).digest("hex");
  auditLastHash = entry.h;
  fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n");
  if (++auditWrites >= 50) { auditWrites = 0; pruneAuditLog(); }
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

/* ---------- 访问统计（隐私友好，参考 Plausible/Umami 思路） ----------
   stats.json 按天存 { pv, uv, pages: { 路径: 次数 } }；
   UV 用 sha256(IP|UA) 当日去重，哈希集合仅驻留内存不落盘（隐私友好）；
   内存中每分钟批量落盘一次，进程退出前兜底 flush。
   爬虫 UA 与 /api/* 不计入（/api/* 在 /api/hit 入口已拦截）。 */
let stats = readJSON(STATS_FILE, {});   // { "2026-10-12": { pv, uv, pages } }
const uvSets = new Map();               // 日期 -> Set<sha256(ip|ua)>（仅内存）
let statsDirty = false;
const recentHits = new Map();           // ip|path -> 时间戳（30 分钟同页不重复计 PV）
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of recentHits) if (now - ts > 36e5) recentHits.delete(k);
}, 600e3).unref();
/* 旧格式迁移：{ 日期: { 路径: 次数 } } → { 日期: { pv, uv, pages } }（uv 不可回溯记 0） */
(function migrateStats() {
  for (const [day, v] of Object.entries(stats)) {
    if (v && typeof v === "object" && !v.pages) {
      const pages = v, pv = Object.values(pages).reduce((s, n) => s + (Number(n) || 0), 0);
      stats[day] = { pv, uv: 0, pages };
    }
  }
})();
function statDay(day) {
  return stats[day] || { pv: 0, uv: 0, pages: {} };
}
const BOT_UA = /bot|spider|crawl|slurp|bingpreview|facebookexternal|twitterbot|curl|wget|python|headless|monitor|uptime/i;
/* 每分钟批量落盘（有变更才写）；只保留 90 天 */
setInterval(() => {
  if (!statsDirty) return;
  statsDirty = false;
  const days = Object.keys(stats).sort();
  while (days.length > 90) delete stats[days.shift()];
  writeJSON(STATS_FILE, stats, false);
}, 60e3).unref();

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
const sendJSON = (req, res, code, obj, extra) => send(req, res, code, JSON.stringify(obj), "application/json; charset=utf-8", extra);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        const e = new Error("请求体超过大小限制");
        e.status = 413; // Payload Too Large，由路由统一 catch 转成响应
        reject(e);
        req.destroy();
      } else chunks.push(c);
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

/* ---------- 内容备份（PUT / 恢复前调用；分级保留） ---------- */
/* 分级保留：近 7 天每天最新 1 份、近 4 周每周最新 1 份、更早每月最新 1 份（月度档封顶 12 份），其余删除 */
function pruneBackups() {
  let files;
  try { files = fs.readdirSync(BACKUP_DIR).filter((f) => /^content-[\d-]+\.json$/.test(f)).sort().reverse(); }
  catch { return; }
  const parseMs = (f) => {
    const m = /^content-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.json$/.exec(f);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
  };
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const weekKey = (ms) => {                       // 所在周的周一日期
    const d = new Date(ms);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    return monday.toISOString().slice(0, 10);
  };
  const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7);
  const now = Date.now(), dayCut = now - 7 * 864e5, weekCut = now - 28 * 864e5;
  const keep = new Set(), seenDay = new Set(), seenWeek = new Set(), seenMonth = new Set();
  let monthKept = 0;                              // 月度档计数：封顶 12 份（6.3-2）
  for (const f of files) {                        // 已按时间倒序：各分组首个即最新
    const ms = parseMs(f);
    let k;
    if (ms >= dayCut) { k = dayKey(ms); if (!seenDay.has(k)) { seenDay.add(k); keep.add(f); } }
    else if (ms >= weekCut) { k = weekKey(ms); if (!seenWeek.has(k)) { seenWeek.add(k); keep.add(f); } }
    else if (monthKept < 12) {                    // 月度档未满才继续保留（倒序即最近月份优先）
      k = monthKey(ms);
      if (!seenMonth.has(k)) { seenMonth.add(k); monthKept++; keep.add(f); }
    }
  }
  files.filter((f) => !keep.has(f)).forEach((f) => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {} });
}
function lastBackupFile() {
  try { return fs.readdirSync(BACKUP_DIR).filter((f) => /^content-[\d-]+\.json$/.test(f)).sort().reverse()[0] || null; }
  catch { return null; }
}
/* 备份分两级：
   - 强制备份（force=true）：删除 / 导入（全量 PUT）/ 恢复 / 迁移前调用，不受间隔限制
   - 节流备份（默认）：同一文件 BACKUP_MIN_INTERVAL 秒内最多 1 份，防高频写撑爆磁盘
   间隔判定基于最新备份文件 mtime（重启后不丢失节流状态）。 */
function backupContent(force = false) {
  if (!fs.existsSync(CONTENT_FILE)) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!force && BACKUP_MIN_INTERVAL > 0) {
    const last = lastBackupFile();
    if (last) {
      try {
        const mt = fs.statSync(path.join(BACKUP_DIR, last)).mtimeMs;
        if (Date.now() - mt < BACKUP_MIN_INTERVAL * 1000) return null; // 窗口内跳过
      } catch {}
    }
  }
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const fname = `content-${stamp}.json`;
  fs.copyFileSync(CONTENT_FILE, path.join(BACKUP_DIR, fname));
  pruneBackups();
  return fname;
}

/* ============================================================
   Agent 定时任务系统（零依赖调度器）

   调度规则（schedule 字符串）：
     daily@HH:mm             每天指定时刻
     weekly@mon@HH:mm        每周指定星期与时刻（mon..sun）
     monthly@D@HH:mm         每月指定日与时刻（D 超过当月天数时取月末）
     once@YYYY-MM-DDTHH:mm   一次性指定时刻（无时区偏移按 TZ 解释；执行后自动禁用）
     interval@秒             固定间隔（最小 60 秒，基准为上次开始时间）

   可靠性设计：
   - 单 setInterval 分钟级巡检（60s，对齐整分钟，触发误差 ≤ 1 分钟）
   - 执行中互斥锁：同一任务不并发执行；所有任务经同一队列串行运行
   - 单任务超时 60 秒记为失败；失败重试：retry 次、间隔 retryDelay 秒
   - 重启后错过的任务默认直接跳过（重排到未来），catchUp=true 补跑一次；
     一次性任务错过标记 missed 并禁用
   - SIGTERM：停止巡检并等待执行中任务结束后退出（最长 30 秒）
   ============================================================ */

const AGENT_TICK_MS = 60e3; // 分钟级巡检：60s，对齐整分钟，误差 ≤ 1 分钟
const AGENT_TASK_TIMEOUT_MS = 60e3; // 单任务超时：60 秒记为失败
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h <= 23 && mi <= 59 ? { h, mi } : null;
}

/* 计算下次执行时刻；规则非法或一次性时间已过期返回 null */
function computeNextRun(schedule, from = new Date()) {
  const parts = String(schedule || "").split("@");
  switch (parts[0]) {
    case "interval": {
      const sec = Number(parts[1]);
      return Number.isFinite(sec) && sec >= 60 ? new Date(from.getTime() + sec * 1000) : null; // 最小 60 秒
    }
    case "once": {
      const ts = parts.slice(1).join("@");
      // 严格格式：YYYY-MM-DDTHH:mm(:ss)(Z|±HH:mm)?；无时区偏移时 new Date 按本地（TZ）解释
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(ts)) return null;
      const t = new Date(ts);
      return !isNaN(t) && t > from ? t : null;
    }
    case "daily": {
      const hm = parseHM(parts[1]);
      if (!hm) return null;
      const d = new Date(from);
      d.setHours(hm.h, hm.mi, 0, 0);
      if (d <= from) d.setDate(d.getDate() + 1);
      return d;
    }
    case "weekly": {
      const wd = WEEKDAYS[String(parts[1] || "").toLowerCase()];
      const hm = parseHM(parts[2]);
      if (wd === undefined || !hm) return null;
      const d = new Date(from);
      d.setHours(hm.h, hm.mi, 0, 0);
      let delta = (wd - d.getDay() + 7) % 7;
      if (delta === 0 && d <= from) delta = 7;
      d.setDate(d.getDate() + delta);
      return d;
    }
    case "monthly": {
      const day = Number(parts[1]);
      const hm = parseHM(parts[2]);
      if (!Number.isInteger(day) || day < 1 || day > 31 || !hm) return null;
      const clamp = (y, mo) => Math.min(day, new Date(y, mo + 1, 0).getDate()); // 小月取月末
      const d = new Date(from);
      d.setHours(hm.h, hm.mi, 0, 0);
      d.setDate(clamp(d.getFullYear(), d.getMonth()));
      if (d <= from) {
        d.setMonth(d.getMonth() + 1, 1);
        d.setDate(clamp(d.getFullYear(), d.getMonth()));
      }
      return d;
    }
  }
  return null;
}

/* 备忘字段校验：正文 ≤100KB；标签 ≤20 个、单个 ≤32 字符 */
function validateMemoFields(body) {
  if (body.content !== undefined) {
    const c = String(body.content);
    if (Buffer.byteLength(c, "utf8") > 100 * 1024) return "正文超出 100KB 限制";
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) return "标签格式无效";
    if (body.tags.length > 20) return "标签最多 20 个";
    for (const t of body.tags)
      if (typeof t !== "string" || t.length > 32) return "单个标签最长 32 字符";
  }
  return null;
}

/* 匿名/分享视图：剥离 share 与 botReplies（防令牌哈希与内部回复外泄） */
function publicMemo(m) {
  const { share, botReplies, ...rest } = m;
  return rest;
}

/* 备忘创建（API 与 agent / bot 动作共用）：备份 + 串行写入 + 缓存失效 + 事件抛出
   meta.source/meta.actor 用于事件总线与审计溯源（user / bot / agent / system） */
async function createMemoInternal(fields, meta = {}) {
  const now = GBSchema.nowISO();
  const memo = GBSchema.normalizeMemo({
    id: GBSchema.genId("memo"),
    content: String(fields.content || ""),
    tags: Array.isArray(fields.tags) ? fields.tags : [],
    visibility: fields.visibility, // normalizeMemo 白名单兜底为 private
    pinned: !!fields.pinned,
    archived: false,
    attachments: [],
    share: { enabled: false, tokenHash: "", expireAt: null },
    createdAt: now,
    updatedAt: now,
    rev: 1,
  });
  backupContent(); // 节流备份
  await writeContent(CONTENT_FILE, (cur) => {
    const data = GBSchema.migrate(cur);
    data.memos.unshift(memo); // 最新在前
    return data;
  });
  rssCache = null;
  sitemapCache = null;
  GBEvent.emit("memo:create", eventPayload(meta.source || "system", meta.actor || meta.source || "system", memo.id, memo));
  return memo;
}

/* ---------- Webhook SSRF 防护 ----------
   1. 仅允许 http/https 协议
   2. DNS 解析后校验 IP：拒绝回环 / 内网 / 链路本地 / 0.0.0.0 等保留地址
   3. 用解析出的 IP 直接发起连接（Host 头与 TLS SNI 仍用原域名），
      防止 DNS 重绑定；不自动跟随重定向
   4. 超时 10 秒；响应体最大 1MB，仅保留状态码与前 2KB 文本
   5. 配置 WEBHOOK_ALLOW_HOSTS 时仅允许白名单域名（不配置仍做 IP 校验）
   6. method 仅允许 GET/POST */

/* 判断 IP 是否为回环 / 内网 / 链路本地 / 保留地址（含 IPv4-mapped IPv6） */
function isPrivateIP(ip) {
  let s = String(ip || "").toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s); // IPv4-mapped IPv6 还原为 v4 再校验
  if (mapped) s = mapped[1];
  if (net.isIPv4(s)) {
    const p = s.split(".").map(Number);
    return p[0] === 0 ||                    // 0.0.0.0/8 本网络
      p[0] === 10 ||                        // 10/8 内网
      p[0] === 127 ||                       // 127/8 回环
      (p[0] === 169 && p[1] === 254) ||     // 169.254/16 链路本地
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || // 172.16/12 内网
      (p[0] === 192 && p[1] === 168) ||     // 192.168/16 内网
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || // 100.64/10 CGNAT
      p[0] >= 224;                          // 组播 / 保留 / 广播
  }
  if (net.isIPv6(s)) {
    return s === "::" || s === "::1" ||     // 未指定 / 回环
      /^fe[89ab]/.test(s) ||                // fe80::/10 链路本地
      s.startsWith("fc") || s.startsWith("fd"); // fc00::/7 唯一本地
  }
  return true; // 无法识别的格式一律拒绝
}

/* 解析并校验目标主机：白名单 → DNS → IP 黑名单；返回可直接连接的安全 IP */
async function resolveWebhookIP(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new Error("目标主机为空");
  if (WEBHOOK_ALLOW_HOSTS.size && !WEBHOOK_ALLOW_HOSTS.has(host))
    throw new Error("目标主机不在 WEBHOOK_ALLOW_HOSTS 白名单");
  let ip = host;
  if (!net.isIP(host)) {
    const { address } = await dns.promises.lookup(host); // 解析一次，后续用该 IP 直连
    ip = address;
  }
  if (isPrivateIP(ip)) throw new Error("目标为回环/内网/保留地址，已拒绝: " + host);
  return ip;
}

/* 零依赖 HTTP 请求（Node 16 无全局 fetch，仅用 http/https；10s 超时，响应截断） */
async function httpRequest(urlStr, { method, body } = {}, timeoutMs = 10000) {
  let u;
  try { u = new URL(String(urlStr || "")); } catch { throw new Error("url 无效"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("仅支持 http/https");
  const m = String(method || (body != null ? "POST" : "GET")).toUpperCase();
  if (m !== "GET" && m !== "POST") throw new Error("method 仅允许 GET/POST");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ip = await resolveWebhookIP(host); // SSRF 防护：白名单 + DNS 解析 + IP 校验
  const lib = u.protocol === "https:" ? require("https") : http;
  const payload = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const r = lib.request({
      protocol: u.protocol,
      host: ip, // 用解析出的 IP 直连，防 DNS 重绑定
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: m,
      servername: u.protocol === "https:" ? host : undefined, // SNI / 证书校验仍用原域名
      headers: {
        Host: u.host,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
      timeout: timeoutMs,
    }, (res2) => { // 不跟随 3xx 重定向，原样返回状态码
      const chunks = [];
      let size = 0, limited = false, done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ status: res2.statusCode, body: Buffer.concat(chunks).toString("utf8").slice(0, 2048) });
      };
      res2.on("data", (c) => {
        const remain = 1048576 - size; // 响应体上限 1MB
        if (remain <= 0) return;
        chunks.push(c.length <= remain ? c : c.subarray(0, remain));
        size += Math.min(c.length, remain);
        if (size >= 1048576) { limited = true; res2.destroy(); }
      });
      res2.on("end", finish);
      res2.on("close", () => { if (limited) finish(); });
      res2.on("error", (e) => { if (limited) finish(); else reject(e); });
    });
    r.on("timeout", () => r.destroy(new Error("请求超时")));
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/* ---------- Agent 动作库：每个动作一个异步函数，注册到映射表 ---------- */
const GBActions = {
  /* 发布一条备忘（ctx.source 标记来源：agent 调度 / bot 指令） */
  async memo_publish(params, ctx = {}) {
    if (!String(params.content || "").trim()) throw new Error("content 不能为空");
    const memo = await createMemoInternal(params, { source: ctx.source || "agent", actor: ctx.actor || ctx.source || "agent" });
    return { memoId: memo.id, visibility: memo.visibility };
  },

  /* 汇总近 7 天备忘生成周报（tags 过滤范围；autoPublish 公开，否则私密） */
  async memo_weekly_report(params) {
    const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
    const since = new Date(Date.now() - 7 * 864e5);
    const tags = Array.isArray(params.tags) ? params.tags.filter(Boolean) : [];
    const list = (data.memos || [])
      .filter((m) => new Date(m.createdAt) >= since)
      .filter((m) => !tags.length || (m.tags || []).some((t) => tags.includes(t)))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const range = `${GBSchema.localDateStr(since)} ~ ${GBSchema.localDateStr()}`;
    const lines = [`# 备忘周报（${range}）`, "", `本周共 ${list.length} 条备忘。`, ""];
    const byDay = {};
    list.forEach((m) => {
      const day = String(m.createdAt).slice(0, 10);
      const first = String(m.content || "").split("\n").find((l) => l.trim()) || "（空）";
      (byDay[day] ||= []).push(`- ${(m.tags || []).map((t) => `[${t}]`).join("")}${first}`);
    });
    Object.keys(byDay).sort().forEach((d) => { lines.push(`## ${d}`, ...byDay[d], ""); });
    const memo = await createMemoInternal({
      content: lines.join("\n"),
      tags: ["周报"],
      visibility: params.autoPublish ? "public" : "private",
    }, { source: "agent", actor: "agent" });
    return { count: list.length, memoId: memo.id };
  },

  /* 发布指定博客草稿（postId 支持 id 或 slug；已发布则幂等返回 already） */
  async post_publish(params, ctx = {}) {
    let post = null, already = false;
    await writeContent(CONTENT_FILE, (cur) => {
      const data = GBSchema.migrate(cur);
      post = (data.posts || []).find((x) => x.id === params.postId || x.slug === params.postId);
      if (!post || post.status === "published") { already = !!post; return undefined; } // 不落盘
      post.status = "published";
      post.updatedAt = GBSchema.nowISO();
      backupContent(); // 节流备份
      return data;
    });
    if (!post) throw new Error("文章不存在: " + params.postId);
    if (already) return { postId: post.id, slug: post.slug, already: true };
    rssCache = null;
    sitemapCache = null;
    GBEvent.emit("post:update", eventPayload(ctx.source || "agent", ctx.actor || ctx.source || "agent", post.id, { slug: post.slug }));
    auditLog("agent:post_publish", null, post.id, true, ctx.actor || ctx.source || "agent");
    return { postId: post.id, slug: post.slug };
  },

  /* 全站数据备份（仅 content.json；按分级策略保留；任务触发的备份不受节流限制） */
  async system_backup() {
    const fname = backupContent(true);
    return { ok: true, file: fname ? "data/backups/" + fname : null };
  },

  /* 访问统计日报（当日 PV/UV 与 Top 页面，结果写入执行日志） */
  async stats_daily() {
    const day = GBSchema.localDateStr();
    const s = statDay(day);
    const pages = Object.entries(s.pages).map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count);
    return { date: day, pv: s.pv, uv: s.uv, top: pages.slice(0, 5) };
  },

  /* 调用通用 Webhook */
  async webhook(params) {
    const r = await httpRequest(params.url, { method: params.method, body: params.body });
    if (r.status >= 400) throw new Error(`Webhook 返回 HTTP ${r.status}`);
    return r;
  },
};

/* 任务对外序列化：隐藏内部运行时字段，附加 running 状态 */
function serializeTask(t) {
  const { _running, _deleted, ...pub } = t;
  return { ...pub, running: !!_running };
}

/* 任务字段拆分：定义（schedule/action/params 等）存 content.json 参与备份；
   运行态（lastRunAt/nextRunAt/lastStatus）存 agent-state.json 不备份（可随时重建） */
const TASK_RUNTIME_FIELDS = ["lastRunAt", "nextRunAt", "lastStatus"];
function taskDefinition(t) {
  const def = serializeTask(t);
  delete def.running;
  for (const f of TASK_RUNTIME_FIELDS) delete def[f];
  return def;
}
function taskRuntime(t) {
  return { lastRunAt: t.lastRunAt || null, nextRunAt: t.nextRunAt || null, lastStatus: t.lastStatus || null };
}

/* 任务持久化：定义 → content.json（串行写入层），运行态 → agent-state.json */
async function persistTask(task) {
  const def = taskDefinition(task);
  await writeContent(CONTENT_FILE, (cur) => {
    const data = GBSchema.migrate(cur);
    const i = (data.agentTasks || []).findIndex((t) => t.id === task.id);
    // 定义未变化（仅运行态更新）时放弃写入：Agent 状态更新不触发 content.json 写入与备份
    if (i >= 0 && JSON.stringify(data.agentTasks[i]) === JSON.stringify(def)) return undefined;
    if (i < 0) data.agentTasks.push(def);
    else data.agentTasks[i] = def;
    return data;
  });
  await writeContent(AGENT_STATE_FILE, (cur) => {
    const state = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
    state.tasks = state.tasks && typeof state.tasks === "object" ? state.tasks : {};
    state.tasks[task.id] = taskRuntime(task);
    return state;
  });
}

/* 删除任务运行态记录 */
async function removeTaskState(id) {
  await writeContent(AGENT_STATE_FILE, (cur) => {
    const state = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
    if (state.tasks) delete state.tasks[id];
    return state;
  });
}

/* 启动迁移：content.json 的 agentTasks 中夹带的运行态字段剥离到 agent-state.json */
async function migrateAgentState() {
  const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
  const state = readJSON(AGENT_STATE_FILE, null) || { tasks: {} };
  state.tasks = state.tasks && typeof state.tasks === "object" ? state.tasks : {};
  let changed = false;
  for (const t of data.agentTasks || []) {
    if (t.lastRunAt || t.nextRunAt || t.lastStatus) {
      state.tasks[t.id] = {
        lastRunAt: t.lastRunAt || null, nextRunAt: t.nextRunAt || null,
        lastStatus: t.lastStatus || null, ...(state.tasks[t.id] || {}),
      };
      delete t.lastRunAt; delete t.nextRunAt; delete t.lastStatus;
      changed = true;
    }
  }
  if (!changed) return;
  backupContent(true); // 迁移前强制备份
  await writeContent(CONTENT_FILE, data);
  await writeContent(AGENT_STATE_FILE, state);
  console.log("[migrate] agentTasks 运行态已剥离到 data/agent-state.json");
}

/* ---------- 调度器（内存 registry 为运行时权威状态） ---------- */
const GBScheduler = {
  registry: new Map(), // id -> 任务对象
  timer: null,
  stopping: false,
  _queue: Promise.resolve(), // 串行执行队列：所有任务经同一队列依次运行，避免并发写文件

  /* 启动：从 content.json 加载任务定义，叠加 agent-state.json 运行态，并开启巡检 */
  load() {
    const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
    let state = {};
    try { state = readJSON(AGENT_STATE_FILE, {}) || {}; } catch { state = {}; }
    (data.agentTasks || []).forEach((t) => {
      const rt = state[t.id];
      if (rt) TASK_RUNTIME_FIELDS.forEach((f) => { if (rt[f] !== undefined) t[f] = rt[f]; });
      this.register(t, true);
    });
    // 对齐整分钟后开始分钟级巡检（误差 ≤ 1 分钟）
    const delay = AGENT_TICK_MS - (Date.now() % AGENT_TICK_MS);
    this.timer = setTimeout(() => {
      this.tick();
      this.timer = setInterval(() => this.tick(), AGENT_TICK_MS);
    }, delay);
  },

  /* 注册/更新任务；boot=true 表示服务启动恢复（错过的任务按 catchUp/missed 处理） */
  register(task, boot = false) {
    GBSchema.normalizeAgentTask(task);
    const now = new Date();
    if (task.enabled) {
      const missed = boot && task.nextRunAt && new Date(task.nextRunAt) <= now;
      if (missed && /^once@/.test(task.schedule)) {
        // 一次性任务错过：标记 missed 并禁用（不重排、不补跑）
        task.enabled = false;
        task.lastStatus = "missed";
        task.nextRunAt = null;
        persistTask(task);
      } else {
        task.nextRunAt = this.nextISO(task.schedule, now); // 重排到未来：错过默认直接跳过
        if (missed && task.catchUp) setTimeout(() => this.run(task, "catchUp"), 1000); // 仅补跑一次
      }
    } else {
      task.nextRunAt = null;
    }
    this.registry.set(task.id, task);
    return task;
  },

  nextISO(schedule, from) {
    const d = computeNextRun(schedule, from || new Date());
    return d ? GBSchema.nowISO(d) : null;
  },

  unregister(id) {
    const t = this.registry.get(id);
    if (t) t._deleted = true; // 执行中删除：完成后不再持久化状态
    this.registry.delete(id);
  },

  /* 周期巡检：到点且未在执行的任务触发执行 */
  tick() {
    if (this.stopping) return;
    const now = Date.now();
    for (const t of this.registry.values()) {
      if (!t.enabled || t._running || !t.nextRunAt) continue;
      if (new Date(t.nextRunAt).getTime() <= now) this.run(t, "schedule");
    }
  },

  /* 执行任务：先入串行队列（同任务不并发、多任务串行），再执行 */
  run(task, trigger) {
    if (task._running || task._deleted) return this._queue;
    task._running = true; // 互斥锁同步置位：排队期间 tick 不会重复触发
    this._queue = this._queue.catch(() => {}).then(() => this._exec(task, trigger));
    return this._queue;
  },

  /* 实际执行：互斥锁 + 单任务 60s 超时 + 失败重试 + 状态持久化 + 日志 */
  async _exec(task, trigger) {
    const startedAt = new Date();
    let status = "failed", result = null, error = null, attempt = 0;
    const maxAttempts = 1 + (task.retry || 0);
    while (attempt < maxAttempts) {
      attempt++;
      let timeout;
      try {
        const action = GBActions[task.action];
        if (!action) throw new Error("未知动作: " + task.action);
        result = await Promise.race([ // 单任务超时 60 秒记为失败
          action(task.params || {}, { task, trigger, attempt, source: "agent", actor: "agent" }),
          new Promise((_, rej) => { timeout = setTimeout(() => rej(new Error("任务超时（60秒）")), AGENT_TASK_TIMEOUT_MS); }),
        ]);
        status = "success";
        error = null;
        break;
      } catch (e) {
        error = String((e && e.message) || e);
        if (attempt < maxAttempts)
          await new Promise((r) => setTimeout(r, Math.max(1, task.retryDelay || 60) * 1000));
      } finally {
        clearTimeout(timeout);
      }
    }
    task._running = false;
    task.lastRunAt = GBSchema.nowISO(startedAt);
    task.lastStatus = status;
    if (/^once@/.test(task.schedule)) task.enabled = false; // 一次性任务执行后自动禁用
    // interval 基准为上次开始时间（相位对齐）；若已过期则按周期顺推到未来
    let next = task.enabled ? computeNextRun(task.schedule, /^interval@/.test(task.schedule) ? startedAt : new Date()) : null;
    if (next && /^interval@/.test(task.schedule)) {
      const sec = Number(String(task.schedule).split("@")[1]);
      while (next.getTime() <= Date.now()) next = new Date(next.getTime() + sec * 1000);
    }
    task.nextRunAt = next ? GBSchema.nowISO(next) : null;
    if (!task._deleted) persistTask(task);
    writeAgentLog({
      t: GBSchema.nowISO(), taskId: task.id, name: task.name, action: task.action,
      trigger, status, attempts: attempt,
      result: result == null ? null : JSON.stringify(result).slice(0, 500),
      error,
    });
  },

  /* 优雅退出：停巡检，等待执行中任务（最多 ms 毫秒） */
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
  },
  async drain(ms = 3000) {
    const until = Date.now() + ms;
    while ([...this.registry.values()].some((t) => t._running) && Date.now() < until)
      await new Promise((r) => setTimeout(r, 100));
  },
};

/* ============================================================
   Bot 指令交互系统（注册制白名单引擎，无动态代码执行）

   内置指令：备忘 / 搜博客 / 新建任务 / 统计 / 发布 / 备份 / 别名管理 / 帮助。
   多步会话：裸「新建任务」进入 规则→动作 分步提示，会话状态仅存内存
   （按 Token 隔离），5 分钟过期，发送「取消」随时退出。
   快捷别名：存 content.json 的 botAliases（上限 20 条，单层替换禁递归）。
   @bot 备忘联动（防循环）：订阅 memo:create / memo:update，忽略 source 为
   bot/agent 的事件，仅私密备忘触发；取 @bot 之后到行尾为指令文本，
   SHA-256(cmdHash) 对 botReplies 做幂等；回复仅追加 botReplies[]
   （不改 content、不增 rev），上限 20 条，单指令 30 秒超时，失败也记录。
   ============================================================ */

/* Bot 新建任务（完整指令与分步引导共用）：注册 → 持久化 → 返回文案 */
async function createTaskByBot(schedule, action) {
  const task = GBScheduler.register({
    id: GBSchema.genId("task"),
    name: `Bot任务-${action}`,
    schedule, action, params: {},
    retry: 0, retryDelay: 60, catchUp: false,
    enabled: true, createdAt: GBSchema.nowISO(),
  });
  persistTask(task);
  auditLog("bot:task_create", null, task.id, true, "bot");
  return `任务已创建：${task.name}（${schedule}）\n下次执行：${task.nextRunAt || "—"}`;
}

const BOT_CMD_TIMEOUT_MS = 30e3; // @bot 单条指令执行超时（5.4 规则 6）
const BOT_REPLY_LIMIT = 20;      // 同一备忘 Bot 回复上限（5.4 规则 6）
const BOT_ALIAS_LIMIT = 20;      // 快捷别名上限（5.3）

const GBBot = {
  _cmds: [], // { name, pattern, help, handler(match, ctx) }
  _steps: new Map(), // sessionKey -> { stage, schedule, ts }
  STEP_TTL: 5 * 60e3,

  /* 注册制白名单：{ name, pattern(正则), help, handler }，按注册顺序匹配 */
  register(cmd) {
    if (!cmd || !(cmd.pattern instanceof RegExp) || typeof cmd.handler !== "function")
      throw new Error("Bot 指令注册无效：需 { name, pattern, help, handler }");
    this._cmds.push({ name: cmd.name || "", pattern: cmd.pattern, help: cmd.help || "", handler: cmd.handler });
  },

  _step(key) {
    const s = this._steps.get(key);
    if (s && Date.now() - s.ts > this.STEP_TTL) { this._steps.delete(key); return null; }
    return s || null;
  },

  /* 快捷别名查找（整句匹配别名名；数据存 content.json botAliases） */
  _alias(input) {
    const list = GBSchema.migrate(readJSON(CONTENT_FILE, {})).botAliases || [];
    const hit = list.find((a) => a && a.name === input);
    return hit ? String(hit.command || "").trim() : null;
  },

  async exec(text, ctx = {}) {
    let input = String(text || "").trim();
    if (!input) return "请输入指令，发送「帮助」查看全部指令。";
    if (input.length > 2000) return "指令过长（≤2000 字）。";
    const key = ctx.sessionKey || ctx.token || "anon"; // 会话按 Token 隔离

    /* 多步会话：有未完成的新建任务引导时，输入优先作为分步答案 */
    const step = this._step(key);
    if (step) {
      if (input === "取消") { this._steps.delete(key); return "已取消新建任务。"; }
      if (step.stage === "schedule") {
        if (!computeNextRun(input))
          return "调度规则无效（支持 daily@HH:mm / weekly@mon@HH:mm / monthly@D@HH:mm / once@ISO / interval@秒），请重新回复，或发送「取消」。";
        step.schedule = input; step.stage = "action"; step.ts = Date.now();
        return `规则已记录：${input}。请回复动作名（${Object.keys(GBActions).join(" / ")}），或发送「取消」。`;
      }
      if (step.stage === "action") {
        if (!GBActions[input])
          return `未知动作：${input}。可选：${Object.keys(GBActions).join(" / ")}，或发送「取消」。`;
        this._steps.delete(key);
        return await createTaskByBot(step.schedule, input);
      }
    }

    /* 快捷别名：整句匹配后单层替换为映射指令（不再二次解析，禁止递归别名） */
    const aliased = this._alias(input);
    if (aliased) input = aliased;

    for (const c of this._cmds) {
      const m = input.match(c.pattern);
      if (!m) continue;
      // Bot 触发的写操作统一溯源：事件 source / 审计 actor 均为 bot（5.1 规则 6）
      try { return await c.handler(m, { ...ctx, sessionKey: key, source: "bot", actor: "bot" }); }
      catch (e) { return `执行出错：${String((e && e.message) || e)}`; } // 不泄漏堆栈
    }
    return `未识别指令：${input.slice(0, 30)}。发送「帮助」查看全部指令。`;
  },
};

/* ---------- 内置指令集（白名单注册） ---------- */

/* 备忘 <内容>：记录一条私密备忘 */
GBBot.register({
  name: "memo",
  pattern: /^备忘\s+([\s\S]+)$/,
  help: "备忘 <内容> — 记录一条私密备忘",
  handler: async (m, ctx) => {
    const r = await GBActions.memo_publish({ content: m[1].trim(), visibility: "private" },
      { source: ctx.source, actor: ctx.actor });
    return `已记录备忘（id: ${r.memoId}）`;
  },
});

/* 搜博客 <关键词>：已发布文章标题/摘要匹配，返回前 5 条 */
GBBot.register({
  name: "search",
  pattern: /^搜博客\s+(.+)$/,
  help: "搜博客 <关键词> — 搜索已发布文章",
  handler: async (m) => {
    const kw = m[1].trim().toLowerCase();
    const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
    const hits = (data.posts || [])
      .filter((p) => p.status === "published")
      .filter((p) => `${p.title || ""}\n${p.excerpt || ""}`.toLowerCase().includes(kw))
      .slice(0, 5);
    if (!hits.length) return `没有找到与「${m[1].trim()}」相关的文章。`;
    return "找到以下文章：\n" + hits.map((p) => `- [${p.title}](/blog.html?p=${p.slug || p.id})`).join("\n");
  },
});

/* 新建任务 <规则> <动作>：完整形式直接创建 */
GBBot.register({
  name: "task:create",
  pattern: /^新建任务\s+(\S+)\s+(\S+)$/,
  help: "新建任务 <规则> <动作> — 创建定时任务",
  handler: async (m) => {
    if (!computeNextRun(m[1])) return `调度规则无效或一次性时间已过去：${m[1]}`;
    if (!GBActions[m[2]]) return `未知动作：${m[2]}。可选：${Object.keys(GBActions).join(" / ")}`;
    return await createTaskByBot(m[1], m[2]);
  },
});

/* 新建任务（裸指令）：进入分步引导 */
GBBot.register({
  name: "task:wizard",
  pattern: /^新建任务$/,
  help: "",
  handler: async (m, ctx) => {
    GBBot._steps.set(ctx.sessionKey, { stage: "schedule", ts: Date.now() });
    return "好的，开始创建定时任务。请回复调度规则（daily@HH:mm / weekly@mon@HH:mm / monthly@D@HH:mm / once@ISO / interval@秒），或发送「取消」。";
  },
});

/* 统计 [今天|本周|本月]：聚合 stats.json 页面 PV（缺省今天） */
GBBot.register({
  name: "stats",
  pattern: /^统计(?:\s+(\S+))?$/,
  help: "统计 [今天|本周|本月] — 访问统计摘要",
  handler: async (m) => {
    const range = (m[1] || "今天").trim();
    const today = GBSchema.localDateStr();
    const sum = {};
    let label = "";
    let total = 0;
    const acc = (d) => {
      const rec = statDay(d);
      total += rec.pv;
      Object.entries(rec.pages).forEach(([k, v]) => { sum[k] = (sum[k] || 0) + v; });
    };
    if (range === "今天") {
      acc(today);
      label = today;
    } else if (range === "本周") {
      for (let i = 0; i < 7; i++) acc(GBSchema.localDateStr(new Date(Date.now() - i * 864e5)));
      label = "近 7 天";
    } else if (range === "本月") {
      const prefix = today.slice(0, 7);
      Object.keys(stats).filter((d) => d.startsWith(prefix)).forEach(acc);
      label = prefix;
    } else {
      return "用法：统计 [今天|本周|本月]";
    }
    const pages = Object.entries(sum).sort((a, b) => b[1] - a[1]);
    if (!total) return `${label}暂无访问记录。`;
    return `${label}访问统计：共 ${total} 次\nTop 页面：\n` +
      pages.slice(0, 5).map(([p, c]) => `- ${p}：${c} 次`).join("\n");
  },
});

/* 发布 <文章ID/slug>：发布草稿文章 */
GBBot.register({
  name: "post:publish",
  pattern: /^发布\s+(\S+)$/,
  help: "发布 <文章ID/slug> — 发布草稿文章",
  handler: async (m, ctx) => {
    const r = await GBActions.post_publish({ postId: m[1] }, { source: ctx.source, actor: ctx.actor });
    return r.already
      ? `文章已是发布状态：[${r.slug}](/blog.html?p=${r.slug})`
      : `文章已发布：[${r.slug}](/blog.html?p=${r.slug})`;
  },
});

/* 备份：全站数据备份，返回备份文件名 */
GBBot.register({
  name: "backup",
  pattern: /^备份$/,
  help: "备份 — 全站数据备份",
  handler: async () => {
    const fname = backupContent();
    return fname ? `备份完成：data/backups/${fname}` : "备份失败：数据文件不存在";
  },
});

/* 别名 <名称> = <指令>：设置快捷别名（上限 20 条；command 不得为既有别名，禁止递归） */
GBBot.register({
  name: "alias:set",
  pattern: /^别名\s+([^\s=]{1,32})\s*=\s*([\s\S]{1,2000})$/,
  help: "别名 <名称> = <指令> — 设置快捷别名（≤20 条）",
  handler: async (m) => {
    const name = m[1].trim(), command = m[2].trim();
    let err = null;
    await writeContent(CONTENT_FILE, (cur) => {
      const data = GBSchema.migrate(cur);
      if (!Array.isArray(data.botAliases)) data.botAliases = [];
      if (data.botAliases.some((a) => a.name === command)) {
        err = `禁止递归别名：「${command}」已是别名。`; return undefined;
      }
      const i = data.botAliases.findIndex((a) => a.name === name);
      if (i < 0 && data.botAliases.length >= BOT_ALIAS_LIMIT) {
        err = `别名已达上限（${BOT_ALIAS_LIMIT} 条），请先「删除别名」。`; return undefined;
      }
      if (i >= 0) data.botAliases[i].command = command;
      else data.botAliases.push({ name, command });
      return data;
    });
    if (err) return err;
    backupContent();
    auditLog("bot:alias_set", null, name, true, "bot");
    return `别名已设置：「${name}」→「${command.slice(0, 50)}」`;
  },
});

/* 删除别名 <名称> */
GBBot.register({
  name: "alias:del",
  pattern: /^删除别名\s+(\S+)$/,
  help: "删除别名 <名称> — 删除快捷别名",
  handler: async (m) => {
    const name = m[1].trim();
    let found = false;
    await writeContent(CONTENT_FILE, (cur) => {
      const data = GBSchema.migrate(cur);
      const list = Array.isArray(data.botAliases) ? data.botAliases : [];
      const next = list.filter((a) => a.name !== name);
      if (next.length === list.length) return undefined;
      found = true;
      data.botAliases = next;
      return data;
    });
    if (!found) return `别名不存在：「${name}」。`;
    backupContent();
    auditLog("bot:alias_del", null, name, true, "bot");
    return `别名已删除：「${name}」`;
  },
});

/* 别名列表 */
GBBot.register({
  name: "alias:list",
  pattern: /^别名列表$/,
  help: "别名列表 — 查看全部快捷别名",
  handler: async () => {
    const list = GBSchema.migrate(readJSON(CONTENT_FILE, {})).botAliases || [];
    if (!list.length) return "尚未设置别名。用「别名 <名称> = <指令>」设置。";
    return "已设置的别名：\n" + list.map((a) => `- ${a.name} → ${a.command.slice(0, 50)}`).join("\n");
  },
});

/* 帮助：列出全部已注册指令（help 为快捷入口，同一 handler 挂多个正则） */
const botHelpHandler = async () =>
  "可用指令：\n" + GBBot._cmds.filter((c) => c.help).map((c) => `- ${c.help}`).join("\n") +
  "\n\n也可以在私密备忘中写 @bot + 指令（如「@bot 统计 本周」），我会把回复记入该备忘的 Bot 回复记录。";
GBBot.register({ name: "help", pattern: /^帮助$/, help: "帮助 — 列出全部指令", handler: botHelpHandler });
GBBot.register({ name: "help:en", pattern: /^help$/i, help: "", handler: botHelpHandler });

/* ---------- @bot 备忘联动（防循环 7 条规则，必须 100% 遵守） ---------- */
async function handleBotMemo(payload) {
  try {
    // 兼容解包：事件总线规范 payload { source, actor, id, data }；裸对象按旧格式处理
    const env = payload && payload.data && payload.source ? payload : { source: "system", data: payload };
    if (env.source === "bot" || env.source === "agent") return; // 规则 1：忽略 bot/agent 触发的事件
    const memo = env.data;
    if (!memo || memo.visibility !== "private") return; // 规则 2：仅私密备忘，公开一律忽略
    const content = String(memo.content || "");
    const at = content.indexOf("@bot");
    if (at < 0) return;
    const cmdText = content.slice(at + 4).split("\n")[0].trim(); // 规则 3：@bot 之后到行尾
    if (!cmdText) return;
    const cmdHash = hashToken(cmdText); // 规则 4：SHA-256(指令文本) 幂等键
    const replies = Array.isArray(memo.botReplies) ? memo.botReplies : [];
    if (replies.some((r) => r && r.cmdHash === cmdHash)) return; // 已执行过相同指令：跳过
    if (replies.length >= BOT_REPLY_LIMIT) return; // 规则 6：同一备忘回复上限 20 条

    let reply;
    try {
      reply = await Promise.race([ // 规则 6：单条指令执行超时 30 秒
        GBBot.exec(cmdText, { sessionKey: "memo:" + memo.id }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("指令执行超时（30秒）")), BOT_CMD_TIMEOUT_MS)),
      ]);
    } catch (e) {
      reply = `执行失败：${String((e && e.message) || e)}`; // 规则 7：失败也记录一条回复
    }
    const entry = { id: GBSchema.genId("bot"), cmdHash, text: String(reply).slice(0, 2000), ts: GBSchema.nowISO() };

    let target = null;
    await writeContent(CONTENT_FILE, (cur) => {
      const data = GBSchema.migrate(cur);
      const t = (data.memos || []).find((x) => x.id === memo.id);
      if (!t) return undefined;
      t.botReplies = Array.isArray(t.botReplies) ? t.botReplies : [];
      // 串行写入层内二次校验：并发事件与跨重启重放都不会重复执行
      if (t.botReplies.some((r) => r && r.cmdHash === cmdHash)) return undefined;
      if (t.botReplies.length >= BOT_REPLY_LIMIT) return undefined;
      t.botReplies.push(entry); // 规则 5：仅追加 botReplies，不改 content、不增 rev
      target = t;
      return data;
    });
    if (!target) return;
    backupContent();
    GBEvent.emit("memo:update", eventPayload("bot", "bot", memo.id, target)); // source=bot，不会二次触发
    auditLog("bot:memo", null, memo.id, true, "bot");
  } catch (e) {
    console.error("[GBBot] @bot 备忘处理异常:", e);
  }
}
GBEvent.on("memo:create", handleBotMemo);
GBEvent.on("memo:update", handleBotMemo);

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
    /* 健康检查（6.3-1）：
       公开版仅 {ok:true} —— 供前端探测运行模式与外部存活监控，不泄露内部状态；
       持有效 Token 时返回调度器 / 备份 / 版本 / 统计详情（无效凭证按公开版处理，不 401） */
    if (p === "/api/health") {
      if (!(tokenOf(req) && authOK(req))) return sendJSON(req, res, 200, { ok: true });
      const data = readJSON(CONTENT_FILE, {});
      return sendJSON(req, res, 200, {
        ok: true, version: GBSchema.SCHEMA_VERSION, uptime: process.uptime(),
        memos: (data.memos || []).length, tasks: (data.agentTasks || []).length,
        schemaVersion: GBSchema.SCHEMA_VERSION,
        scheduler: {
          enabled: !!GBScheduler.timer,
          running: [...GBScheduler.registry.values()].filter((t) => t._running).length,
        },
        lastBackup: lastBackupFile(),
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
    /* 分享令牌直达：GET /api/share/:token → 校验哈希与过期，返回剥离后的备忘
       响应防泄露：no-referrer + noindex */
    const shareMatch = p.match(/^\/api\/share\/([^/]+)$/);
    if (shareMatch && req.method === "GET") {
      const tokenHash = hashToken(decodeURIComponent(shareMatch[1]));
      const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
      const memo = (data.memos || []).find((m) => {
        const sh = m.share || {};
        return sh.enabled && sh.tokenHash && sh.tokenHash === tokenHash &&
          (!sh.expireAt || new Date(sh.expireAt) > new Date());
      });
      const headers = { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
      if (!memo) return sendJSON(req, res, 404, { error: "分享链接无效或已过期" }, headers);
      return sendJSON(req, res, 200, publicMemo(memo), headers);
    }

    const memoMatch = p.match(/^\/api\/memos(?:\/([^/]+))?(?:\/(share))?$/);
    if (memoMatch) {
      const memoId = memoMatch[1] ? decodeURIComponent(memoMatch[1]) : null;
      const isShare = memoMatch[2] === "share";
      const authed = optionalAuth(req, res); // 三态：true 登录 / false 匿名 / null 已应答（401/429）
      if (authed === null) return;

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

      /* 列表：置顶优先，其余按创建时间倒序；匿名剥离 share / botReplies */
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
        // cursor 分页：cursor=上一页最后一条 id；limit 缺省不截断
        const cursor = url.searchParams.get("cursor");
        if (cursor) {
          const ci = list.findIndex((m) => m.id === cursor);
          if (ci >= 0) list = list.slice(ci + 1);
        }
        const limit = Number(url.searchParams.get("limit"));
        if (limit > 0) list = list.slice(0, Math.min(limit, 200));
        if (!authed) list = list.map(publicMemo);
        return sendJSON(req, res, 200, { memos: list });
      }

      /* 单条详情：公开任意人可看；私密需登录，或携带有效分享令牌（响应均剥离 share/botReplies） */
      if (memoId && !isShare && req.method === "GET") {
        const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
        const memo = (data.memos || []).find((m) => m.id === memoId);
        if (!memo) return sendJSON(req, res, 404, { error: "备忘不存在" });
        if (authed) return sendJSON(req, res, 200, memo);
        if (memo.visibility === "public") return sendJSON(req, res, 200, publicMemo(memo));
        const shareToken = url.searchParams.get("share") || "";
        const sh = memo.share || {};
        const valid = sh.enabled && sh.tokenHash && shareToken &&
          sh.tokenHash === hashToken(shareToken) &&
          (!sh.expireAt || new Date(sh.expireAt) > new Date());
        if (valid) return sendJSON(req, res, 200, publicMemo(memo));
        return sendJSON(req, res, 403, { error: "无权访问" });
      }

      /* 创建备忘（逻辑收敛到 createMemoInternal，与 agent 动作共用） */
      if (!memoId && req.method === "POST") {
        if (!authRequired(req, res)) return;
        const body = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString() || "{}");
        const err = validateMemoFields(body);
        if (err) return sendJSON(req, res, 400, { error: err });
        const memo = await createMemoInternal({
          content: body.content, tags: body.tags,
          visibility: body.visibility, pinned: body.pinned,
        }, { source: "user", actor: actorOf(req) });
        auditLog("memo:create", req, memo.id);
        return sendJSON(req, res, 200, memo);
      }

      /* 更新备忘：rev 乐观锁，防多端覆盖 */
      if (memoId && !isShare && req.method === "PUT") {
        if (!authRequired(req, res)) return;
        const body = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString() || "{}");
        const err = validateMemoFields(body);
        if (err) return sendJSON(req, res, 400, { error: err });
        let memo = null, conflict = false, curRev = 0;
        await writeContent(CONTENT_FILE, (cur) => {
          const data = GBSchema.migrate(cur);
          memo = (data.memos || []).find((m) => m.id === memoId);
          if (!memo) return undefined;
          curRev = memo.rev;
          if (typeof body.rev !== "number" || body.rev !== memo.rev) { conflict = true; return undefined; }
          if (body.content !== undefined) memo.content = String(body.content);
          if (body.tags !== undefined) memo.tags = Array.isArray(body.tags) ? body.tags : [];
          if (body.visibility !== undefined) memo.visibility = body.visibility;
          if (body.pinned !== undefined) memo.pinned = !!body.pinned;
          if (body.archived !== undefined) memo.archived = !!body.archived;
          memo.rev += 1;
          memo.updatedAt = GBSchema.nowISO();
          GBSchema.normalizeMemo(memo); // 字段规范化（visibility 白名单等）
          return data;
        });
        if (!memo) return sendJSON(req, res, 404, { error: "备忘不存在" });
        if (conflict) {
          // 409 带服务端最新数据，供前端做差异对比（三选一处理）
          const fresh = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
          const serverMemo = (fresh.memos || []).find((m) => m.id === memoId) || null;
          return sendJSON(req, res, 409, { error: "备忘已被其他窗口修改，请刷新后重试", rev: curRev, memo: serverMemo });
        }
        backupContent();
        rssCache = null;
        sitemapCache = null;
        GBEvent.emit("memo:update", eventPayload("user", actorOf(req), memo.id, memo));
        auditLog("memo:update", req, memo.id);
        return sendJSON(req, res, 200, memo);
      }

      /* 删除备忘 */
      if (memoId && !isShare && req.method === "DELETE") {
        if (!authRequired(req, res)) return;
        let removed = false;
        await writeContent(CONTENT_FILE, (cur) => {
          const data = GBSchema.migrate(cur);
          const idx = (data.memos || []).findIndex((m) => m.id === memoId);
          if (idx < 0) return undefined;
          data.memos.splice(idx, 1);
          removed = true;
          return data;
        });
        if (!removed) return sendJSON(req, res, 404, { error: "备忘不存在" });
        backupContent(true); // 删除属高风险操作，强制备份
        rssCache = null;
        sitemapCache = null;
        GBEvent.emit("memo:delete", eventPayload("user", actorOf(req), memoId, { id: memoId }));
        auditLog("memo:delete", req, memoId);
        return send(req, res, 204, "", "text/plain; charset=utf-8");
      }

      /* 生成分享链接：随机令牌 + 过期时间 */
      if (memoId && isShare && req.method === "POST") {
        if (!authRequired(req, res)) return;
        const body = JSON.parse((await readBody(req, 1e5)).toString() || "{}");
        // expireDays 优先，兼容旧参数 expireHours；默认 24 小时
        const hours = Number(body.expireDays) > 0 ? Number(body.expireDays) * 24
          : (Number(body.expireHours) > 0 ? Number(body.expireHours) : 24);
        const data = GBSchema.migrate(readJSON(CONTENT_FILE, {}));
        const memo = (data.memos || []).find((m) => m.id === memoId);
        if (!memo) return sendJSON(req, res, 404, { error: "备忘不存在" });
        const shareToken = crypto.randomBytes(16).toString("hex"); // 明文只返回这一次，不落盘
        memo.share = {
          enabled: true,
          tokenHash: hashToken(shareToken),
          expireAt: new Date(Date.now() + hours * 36e5).toISOString(),
        };
        memo.updatedAt = GBSchema.nowISO();
        backupContent();
        writeContent(CONTENT_FILE, data);
        rssCache = null;
        sitemapCache = null;
        GBEvent.emit("memo:update", eventPayload("user", actorOf(req), memo.id, memo));
        auditLog("memo:share", req, memo.id);
        return sendJSON(req, res, 200, { url: `/memos.html?share=${shareToken}&id=${memo.id}` });
      }

      /* 关闭分享：清空分享令牌，已发链接即刻失效 */
      if (memoId && isShare && req.method === "DELETE") {
        if (!authRequired(req, res)) return;
        let memo = null;
        await writeContent(CONTENT_FILE, (cur) => {
          const data = GBSchema.migrate(cur);
          memo = (data.memos || []).find((m) => m.id === memoId);
          if (!memo) return undefined;
          memo.share = { enabled: false, tokenHash: "", expireAt: null };
          memo.updatedAt = GBSchema.nowISO();
          return data;
        });
        if (!memo) return sendJSON(req, res, 404, { error: "备忘不存在" });
        rssCache = null;
        sitemapCache = null;
        GBEvent.emit("memo:update", eventPayload("user", actorOf(req), memo.id, memo));
        auditLog("memo:unshare", req, memo.id);
        return sendJSON(req, res, 200, { ok: true });
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
      sessions[hashToken(token)] = { user, touched: Date.now(), ip: clientIP(req) };
      writeJSON(SESSIONS_FILE, sessions, false);
      auditLog("login", req, user);
      return sendJSON(req, res, 200, { token });
    }

    if (p === "/api/logout" && req.method === "POST") {
      const t = tokenOf(req);
      const sessions = readJSON(SESSIONS_FILE, {});
      const key = t ? hashToken(t) : "";
      if (key && sessions[key]) {
        auditLog("logout", req, sessions[key].user);
        delete sessions[key];
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

      // 写入前自动备份旧版本（按分级策略保留：近 7 天每天 / 近 4 周每周 / 更早每月 各 1 份）
      backupContent(true); // 全量覆盖属高风险操作，强制备份
      writeContent(CONTENT_FILE, data); // 原子写入
      rssCache = null;                  // 内容变更，RSS / Sitemap 缓存失效
      sitemapCache = null;
      auditLog("content:update", req, `rev=${data.rev}`);
      GBEvent.emit("post:update", eventPayload("user", actorOf(req), null, { rev: data.rev }));
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

      // 文件头魔数校验：读取前 1KB 比对文件头，改扩展名伪装的文件直接删除并拒绝
      try {
        const ext = conf.exts.find((e) => rawName.endsWith(e));
        const fd = fs.openSync(abs, "r");
        const buf = Buffer.alloc(1024);
        const n = fs.readSync(fd, buf, 0, 1024, 0);
        fs.closeSync(fd);
        if (!sniffOK(buf.slice(0, n), ext)) {
          fs.unlinkSync(abs);
          auditLog("upload:reject", req, conf.dir + "/" + filename);
          return sendJSON(req, res, 400, { error: "文件内容与扩展名不符，已拒绝" });
        }
      } catch {
        fs.unlink(abs, () => {});
        return sendJSON(req, res, 400, { error: "文件校验失败" });
      }

      auditLog("upload", req, conf.dir + "/" + filename);
      return sendJSON(req, res, 200, { url: conf.dir + "/" + filename, size });
    }

    // 访问计数：本地时区按天统计 pv/uv/页面；爬虫与 API 路径不计
    if (p === "/api/hit" && req.method === "POST") {
      const { path: hp } = JSON.parse((await readBody(req, 1e5)).toString() || "{}");
      if (typeof hp !== "string" || !hp.startsWith("/") || hp.startsWith("/api") ||
          hp.length > 120 || hp.includes(".."))
        return send(req, res, 204, "", "text/plain");
      const ua = String(req.headers["user-agent"] || "");
      if (BOT_UA.test(ua)) return send(req, res, 204, "", "text/plain");
      const key = clientIP(req) + "|" + hp;
      const last = recentHits.get(key) || 0;
      if (Date.now() - last < 30 * 60e3) return send(req, res, 204, "", "text/plain");
      recentHits.set(key, Date.now());
      const day = GBSchema.localDateStr();
      const rec = statDay(day);
      rec.pv++;
      rec.pages[hp] = (rec.pages[hp] || 0) + 1;
      // UV：sha256(ip|ua) 去重，集合只在内存，不落盘（隐私）
      const uvKey = crypto.createHash("sha256").update(clientIP(req) + "|" + ua).digest("hex");
      let set = uvSets.get(day);
      if (!set) { set = new Set(); uvSets.set(day, set); }
      if (!set.has(uvKey)) { set.add(uvKey); rec.uv = set.size; }
      const days = Object.keys(stats).sort();
      while (days.length > 90) { const d = days.shift(); delete stats[d]; uvSets.delete(d); }
      statsDirty = true; // 60 秒批量落盘，避免每次访问都写盘
      return send(req, res, 204, "", "text/plain");
    }

    if (p === "/api/stats" && req.method === "GET") {
      if (!authRequired(req, res)) return;
      const since = GBSchema.localDateStr(new Date(Date.now() - 29 * 864e5));
      const pages = {};
      let total = 0;
      for (const day of Object.keys(stats)) {
        if (day < since) continue;
        const rec = statDay(day);
        total += rec.pv;
        for (const [k, v] of Object.entries(rec.pages)) pages[k] = (pages[k] || 0) + v;
      }
      // 近 30 天按天序列（无访问的日期补 0，供趋势图使用；本地时区日期）
      const days = [];
      for (let i = 29; i >= 0; i--) {
        const d = GBSchema.localDateStr(new Date(Date.now() - i * 864e5));
        const rec = statDay(d);
        days.push({ date: d, count: rec.pv, uv: rec.uv });
      }
      return sendJSON(req, res, 200, {
        total,
        days,
        pages: Object.entries(pages).map(([path, count]) => ({ path, count }))
          .sort((a, b) => b.count - a.count).slice(0, 20),
      });
    }

    /* 备份历史：列出 data/backups/ 下的备份（分级保留后总量有限，字典序即时间序） */
    if (p === "/api/backups" && req.method === "GET") {
      if (!authRequired(req, res)) return;
      let list = [];
      try {
        list = fs.readdirSync(BACKUP_DIR)
          .filter((f) => /^content-[\d-]+\.json$/.test(f))
          .sort().reverse().slice(0, 100)
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
      backupContent(true); // 恢复属高风险操作：先把当前内容强制备份，恢复本身可反悔
      GBSchema.migrate(data); // 旧备份可能是老 schema，恢复即迁移到当前版本
      data.rev = current.rev + 1; // rev 只增不减，避免其他窗口持旧 rev 继续写入
      writeContent(CONTENT_FILE, data);
      rssCache = null;
      sitemapCache = null;
      auditLog("restore", req, file);
      GBEvent.emit("post:update", eventPayload("user", actorOf(req), null, { rev: data.rev, restored: file }));
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

    /* ===== Agent 任务 API（全部鉴权） =====
       GET    /api/agent/tasks           任务列表（含 running / nextRunAt / 可用动作）
       POST   /api/agent/tasks           新建任务（自动计算 nextRunAt）
       PUT    /api/agent/tasks/:id       更新任务配置（执行中拒绝修改）
       POST   /api/agent/tasks/:id/run   立即执行一次（异步，结果见日志）
       DELETE /api/agent/tasks/:id       删除任务
       GET    /api/agent/logs            执行日志（倒序；offset/limit 分页，month=YYYY-MM 查历史月） */
    if (p === "/api/agent/logs" && req.method === "GET") {
      if (!authRequired(req, res)) return;
      const qMonth = url.searchParams.get("month") || "";
      const logs = /^\d{4}-\d{2}$/.test(qMonth)
        ? readJSON(path.join(AGENT_LOGS_DIR, `agent-logs-${qMonth}.json`), [])
        : readAgentLogs();
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      return sendJSON(req, res, 200, { total: logs.length, logs: logs.slice(offset, offset + limit) });
    }

    const taskMatch = p.match(/^\/api\/agent\/tasks(?:\/([^/]+))?(?:\/(run))?$/);
    if (taskMatch) {
      if (!authRequired(req, res)) return;
      const taskId = taskMatch[1] ? decodeURIComponent(taskMatch[1]) : null;
      const isRun = taskMatch[2] === "run";

      /* 任务列表 */
      if (!taskId && req.method === "GET") {
        const tasks = [...GBScheduler.registry.values()].map(serializeTask)
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        return sendJSON(req, res, 200, { tasks, actions: Object.keys(GBActions) });
      }

      /* 新建任务 */
      if (!taskId && req.method === "POST") {
        const body = JSON.parse((await readBody(req, 1e5)).toString() || "{}");
        if (!GBActions[body.action])
          return sendJSON(req, res, 400, { error: "未知动作: " + (body.action || "") });
        const enabled = body.enabled !== false;
        if (enabled && !computeNextRun(String(body.schedule || "")))
          return sendJSON(req, res, 400, { error: "调度规则无效或一次性时间已过去" });
        const task = GBScheduler.register({
          id: GBSchema.genId("task"),
          name: String(body.name || "").slice(0, 60),
          schedule: String(body.schedule || ""),
          action: body.action,
          params: body.params,
          retry: body.retry,
          retryDelay: body.retryDelay,
          catchUp: !!body.catchUp,
          enabled,
          createdAt: GBSchema.nowISO(),
        });
        persistTask(task);
        auditLog("agent:task_create", req, task.id);
        return sendJSON(req, res, 200, serializeTask(task));
      }

      /* 更新任务配置：执行中拒绝修改（避免完成时旧快照覆盖新配置） */
      if (taskId && !isRun && req.method === "PUT") {
        const body = JSON.parse((await readBody(req, 1e5)).toString() || "{}");
        const task = GBScheduler.registry.get(taskId);
        if (!task) return sendJSON(req, res, 404, { error: "任务不存在" });
        if (task._running) return sendJSON(req, res, 409, { error: "任务执行中，请稍后再试" });
        if (body.action !== undefined && !GBActions[body.action])
          return sendJSON(req, res, 400, { error: "未知动作: " + body.action });
        if (body.name !== undefined) task.name = String(body.name).slice(0, 60) || task.name;
        if (body.schedule !== undefined) task.schedule = String(body.schedule);
        if (body.action !== undefined) task.action = body.action;
        if (body.params !== undefined) task.params = body.params;
        if (body.retry !== undefined) task.retry = body.retry;
        if (body.retryDelay !== undefined) task.retryDelay = body.retryDelay;
        if (body.catchUp !== undefined) task.catchUp = !!body.catchUp;
        if (body.enabled !== undefined) task.enabled = !!body.enabled;
        GBSchema.normalizeAgentTask(task);
        if (task.enabled && !computeNextRun(task.schedule))
          return sendJSON(req, res, 400, { error: "调度规则无效或一次性时间已过去" });
        GBScheduler.register(task); // 重算 nextRunAt
        persistTask(task);
        auditLog("agent:task_update", req, taskId);
        return sendJSON(req, res, 200, serializeTask(task));
      }

      /* 立即执行一次：异步触发，结果写入日志 */
      if (taskId && isRun && req.method === "POST") {
        const task = GBScheduler.registry.get(taskId);
        if (!task) return sendJSON(req, res, 404, { error: "任务不存在" });
        if (task._running) return sendJSON(req, res, 409, { error: "任务正在执行中" });
        auditLog("agent:task_run", req, taskId);
        GBScheduler.run(task, "manual");
        return sendJSON(req, res, 200, { ok: true, message: "已触发执行，结果见执行日志" });
      }

      /* 删除任务：registry 注销 + 定义与运行态一并清除 */
      if (taskId && !isRun && req.method === "DELETE") {
        if (!GBScheduler.registry.has(taskId)) return sendJSON(req, res, 404, { error: "任务不存在" });
        GBScheduler.unregister(taskId);
        await removeTaskState(taskId); // content.json 定义 + agent-state.json 运行态
        auditLog("agent:task_delete", req, taskId);
        return send(req, res, 204, "", "text/plain; charset=utf-8");
      }

      return sendJSON(req, res, 405, { error: "方法不允许" });
    }

    /* ===== Bot 指令对话（鉴权，text ≤2000 字，审计） ===== */
    if (p === "/api/bot/chat" && req.method === "POST") {
      if (!authRequired(req, res)) return;
      const body = JSON.parse((await readBody(req, 1e5)).toString() || "{}");
      const text = String(body.text || "");
      if (text.length > 2000) return sendJSON(req, res, 400, { error: "指令过长（≤2000 字）" });
      const reply = await GBBot.exec(text, { req, token: tokenOf(req) });
      auditLog("bot:chat", req, text.slice(0, 50));
      return sendJSON(req, res, 200, { reply });
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
    // 模块清单与模块文件按版本演进，长缓存会导致老访客拿不到新模块，故豁免长缓存
    if (p.startsWith("/assets/") || p.startsWith("/uploads/")) cache = "public, max-age=86400";
    if (p.startsWith("/assets/js/modules/")) cache = "no-cache";
    else if (p.startsWith("/downloads/")) cache = "public, max-age=3600";

    fs.stat(file, (stErr, st) => {
      const mtime = !stErr && st ? st.mtime : null;
      // 协商缓存：配合 no-cache 路径（如模块文件）快速 304，无需整包重下
      if (mtime && req.headers["if-modified-since"] &&
          new Date(req.headers["if-modified-since"]) >= mtime) {
        res.writeHead(304, { ...SEC_HEADERS, "Cache-Control": cache });
        return res.end();
      }
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
          { "Cache-Control": cache, ...(mtime ? { "Last-Modified": mtime.toUTCString() } : {}) });
      });
    });
  } catch (e) {
    // 畸形 JSON 请求体：JSON.parse 抛 SyntaxError（无 status），按 400 处理；
    // 其余异常（含 readBody 抛出的 413）沿用其 status，缺省 500
    if (e instanceof SyntaxError && !e.status)
      return sendJSON(req, res, 400, { error: "请求体 JSON 格式错误" });
    sendJSON(req, res, e.status || 500, { error: String(e.message || e) });
  }
});

/* 启动序列：清理临时文件 → 会话/审计锚点恢复 → schema 与运行态迁移（失败中止）→ 监听 */
function startServer() {
  cleanupTmpFiles();
  migrateSessions();
  loadAuditTail();
  (async () => {
    try {
    // 启动迁移写回 content.json 前强制备份；迁移失败直接中止，不带病运行
      const raw = readJSON(CONTENT_FILE, null);
      if (raw) {
        const before = JSON.stringify(raw); // 先快照原始状态，确保明文令牌换算差异能被检测
        // 遗留明文分享令牌 → tokenHash（须在 migrate 前换算，normalizeMemo 会丢弃 token 字段）
        (raw.memos || []).forEach((m) => {
          const sh = m && m.share;
          if (sh && sh.token) { sh.tokenHash = hashToken(sh.token); delete sh.token; }
        });
      const data = GBSchema.migrate(raw);
      if (JSON.stringify(data) !== before) {
        backupContent(true);
        writeJSON(CONTENT_FILE, data, false); // 启动迁移立即落盘，不走 3s 节流
        console.log("[migrate] content.json 已迁移到 schema v" + data.schemaVersion);
      }
    }
      await migrateAgentState();
    } catch (e) {
      console.error("[startup] 启动迁移失败，服务中止：", e);
      process.exit(1);
    }
    server.listen(PORT, () => {
      GBScheduler.load(); // 恢复定时任务并启动分钟级巡检
      console.log(`GlassBlog 已启动: http://127.0.0.1:${PORT}`);
      console.log(`后台入口: http://127.0.0.1:${PORT}/admin.html （账号 ${ADMIN_USER}）`);
    });
  })();
}

if (require.main === module) startServer();

// 优雅退出（SIGINT/SIGTERM）：停调度器 → 等执行中任务 → 排空写入队列 → 落盘 → 退出
function gracefulShutdown() {
  GBScheduler.stop();
  GBScheduler.drain(30000).finally(async () => {
    await drainWriteQueues();
    flushWrites();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

/* 供 node:test 集成测试引用（不触发 listen） */
module.exports = {
  server, startServer, readJSON, writeJSON, writeContent, drainWriteQueues,
  atomicWriteSync, backupContent, hashToken, clientIP, statDay, validateMemoFields,
  createMemoInternal, GBScheduler, GBActions, GBBot, GBEvent, eventPayload,
  computeNextRun, taskDefinition, taskRuntime, migrateAgentState, removeTaskState,
  httpRequest, isPrivateIP, resolveWebhookIP, AGENT_TICK_MS, AGENT_TASK_TIMEOUT_MS,
  BOT_CMD_TIMEOUT_MS, BOT_REPLY_LIMIT, BOT_ALIAS_LIMIT,
};
