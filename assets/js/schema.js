/* ============================================================
   GlassBlog 内容数据契约（schema v2）

   单点职责：所有「字段规范化 / 版本迁移 / slug 与时间语义」
   只在本文件定义，浏览器与 Node 服务端共用（UMD）：
   - 浏览器：window.GBSchema（需在 common.js 之前引入）
   - Node  ：const GBSchema = require("../assets/js/schema")

   content.json 顶层结构：
   {
     "schemaVersion": 2,     // 契约版本；缺失视为 v0，load/save 时自动迁移
     "rev": 1,               // 服务端维护的修订号，PUT 乐观锁（防多端覆盖）
     "profile":  { name, bio, avatar, socials[] },
     "posts":    [ Post ],
     "projects": [ Project ],
     "memos":      [ Memo ],      // v2 新增：碎片笔记
     "agentTasks": [ AgentTask ]  // v2 新增：定时任务定义
   }

   Post 字段（v1）：
     id         内部主键，创建后不变（"post-xxx"），不出现于 URL
     slug       永久链接键：blog.html?p=<slug>，发布后不应再改（建议英文）
     title      标题
     date       展示用日期 "YYYY-MM-DD"（本地时区），归档/界面分组用它
     createdAt  创建时刻 ISO 8601 带时区偏移（排序 / RSS pubDate 用它）
     updatedAt  最近更新时刻（sitemap lastmod 用它）
     tags       字符串数组
     status     "draft" | "published" | "offline"
     excerpt    摘要（后台留空时自动生成）
     cover      封面图 URL，可空
     content    Markdown 正文

   Project 字段（v1 不变）：
    id, name, version, date, desc, changelog, screenshots[], platforms[]

   Memo 字段（v2 新增）：
     id          内部主键（"memo-xxx"）
     content     Markdown 正文
     tags        字符串数组
     visibility  "public" | "private"（默认 private）
     pinned      置顶标记（默认 false）
     archived    归档标记（默认 false）
     share       分享配置 { enabled, token, expireAt }
     createdAt / updatedAt  创建与最近更新时刻（ISO 8601 带时区偏移）
     attachments 附件数组
     rev         单条修订号（默认 1，单独更新 memo 时自增）

   AgentTask 字段（v2 新增）：
     id         内部主键（"task-xxx"）
     name       任务名
     schedule   调度表达式（cron 或间隔描述）
     action     动作标识
     params     动作参数对象（默认 {}）
     retry      失败重试次数（默认 0）
     retryDelay 重试间隔秒数（默认 60）
     catchUp    停机期间漏跑是否补跑（默认 false）
     enabled    启用标记（默认 true）
     createdAt  创建时刻（ISO 8601 带时区偏移）
     lastRunAt / nextRunAt / lastStatus  运行时状态（默认 null，由调度器维护）

   迁移约定：migrate() 幂等，可把任意旧版数据升到当前版本；
   v0 → v1：补 slug / createdAt / updatedAt；v1 → v2：补 memos / agentTasks。
   调用时机 = 每次 load 后（前端/服务端 GET）与每次 PUT 写入前。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; // Node
  else root.GBSchema = api;                                               // 浏览器
})(typeof self !== "undefined" ? self : this, function () {
  const SCHEMA_VERSION = 2;

  /* ---------- 本地时区工具 ----------
     new Date().toISOString() 是 UTC，东八区 0–8 点会得到"昨天"。
     这里统一用本地时区生成日期与时刻，修正该偏差。 */
  const pad = (n) => String(n).padStart(2, "0");
  function tzOffsetStr(d = new Date()) {
    const off = -d.getTimezoneOffset(); // 分钟；东八区 = +480
    const abs = Math.abs(off);
    return (off >= 0 ? "+" : "-") + pad(Math.floor(abs / 60)) + ":" + pad(abs % 60);
  }
  function localDateStr(d = new Date()) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function nowISO(d = new Date()) {
    return localDateStr(d) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) +
      ":" + pad(d.getSeconds()) + tzOffsetStr(d);
  }

  /* ---------- 标识 ---------- */
  // 从标题派生 slug：小写、去变音、非标点转连字符；纯中文标题得到空串（由调用方兜底）
  function deriveSlug(title) {
    return String(title || "")
      .toLowerCase()
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }
  function genId(prefix) {
    return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function uniqueSlug(base, taken) {
    let s = base, i = 2;
    while (taken.has(s)) s = base + "-" + i++;
    return s;
  }

  /* ---------- 单条记录规范化（v2 新增，幂等） ----------
     导出给服务端单独规范化一条 memo / agentTask 使用（如新增、单条更新接口）。 */
  function normalizeMemo(m) {
    if (!m || typeof m !== "object") return m;
    m.id = m.id || genId("memo");
    m.content = m.content || "";
    m.tags = Array.isArray(m.tags) ? m.tags : [];
    m.visibility = ["public", "private"].includes(m.visibility) ? m.visibility : "private";
    m.pinned = !!m.pinned;
    m.archived = !!m.archived;
    const sh = m.share && typeof m.share === "object" ? m.share : {};
    m.share = {
      enabled: !!sh.enabled,
      token: sh.token || "",
      expireAt: sh.expireAt || null,
    };
    m.createdAt = m.createdAt || nowISO();
    m.updatedAt = m.updatedAt || m.createdAt;
    m.attachments = Array.isArray(m.attachments) ? m.attachments : [];
    m.rev = typeof m.rev === "number" ? m.rev : 1;
    return m;
  }
  function normalizeAgentTask(t) {
    if (!t || typeof t !== "object") return t;
    t.id = t.id || genId("task");
    t.name = t.name || "未命名任务";
    t.schedule = t.schedule || "";
    t.action = t.action || "";
    t.params = t.params && typeof t.params === "object" && !Array.isArray(t.params) ? t.params : {};
    t.retry = typeof t.retry === "number" && t.retry >= 0 ? t.retry : 0;
    t.retryDelay = typeof t.retryDelay === "number" && t.retryDelay >= 0 ? t.retryDelay : 60;
    t.catchUp = !!t.catchUp;
    t.enabled = t.enabled !== false; // 缺省启用
    t.createdAt = t.createdAt || nowISO();
    t.lastRunAt = t.lastRunAt || null;
    t.nextRunAt = t.nextRunAt || null;
    t.lastStatus = t.lastStatus || null;
    return t;
  }

  /* ---------- 字段规范化（幂等） ----------
     把「补齐缺失字段」集中在这里，取代散落在后台导入逻辑中的隐式 schema。 */
  function normalize(data) {
    if (!data || typeof data !== "object") return data;
    const pf = data.profile || {};
    data.profile = {
      name: pf.name || "GlassBlog",
      bio: pf.bio || "",
      avatar: pf.avatar || "",
      socials: Array.isArray(pf.socials) ? pf.socials : [],
    };
    if (!Array.isArray(data.posts)) data.posts = [];
    if (!Array.isArray(data.projects)) data.projects = [];
    if (!Array.isArray(data.memos)) data.memos = [];         // v2 新增
    if (!Array.isArray(data.agentTasks)) data.agentTasks = []; // v2 新增

    const taken = new Set(); // 保证全站 slug 唯一
    data.posts.forEach((p) => {
      p.tags = Array.isArray(p.tags) ? p.tags : [];
      p.title = p.title || "未命名";
      p.content = p.content || "";
      p.excerpt = p.excerpt || "";
      p.cover = p.cover || "";
      p.status = ["draft", "published", "offline"].includes(p.status) ? p.status : "draft";
      // date（展示）↔ createdAt（排序/RSS）互为兜底
      p.date = p.date || (p.createdAt ? String(p.createdAt).slice(0, 10) : localDateStr());
      if (!p.createdAt) {
        const d = new Date(p.date + "T00:00:00"); // 本地时区解析展示日期
        p.createdAt = nowISO(isNaN(d) ? new Date() : d);
      }
      p.updatedAt = p.updatedAt || p.createdAt;
      p.id = p.id || genId("post");
      // 永久链接键：优先既有 slug，其次 id（旧数据 id 即 slug），再退到标题派生
      const base = String(p.slug || p.id || deriveSlug(p.title));
      p.slug = uniqueSlug(base, taken);
      taken.add(p.slug);
    });

    data.projects.forEach((p) => {
      p.screenshots = Array.isArray(p.screenshots) ? p.screenshots : [];
      p.platforms = Array.isArray(p.platforms) ? p.platforms : [];
      p.name = p.name || "未命名";
      p.version = p.version || "1.0.0";
      p.desc = p.desc || "";
      p.changelog = p.changelog || "";
      p.date = p.date || localDateStr();
      p.id = p.id || genId("app");
    });

    data.memos.forEach(normalizeMemo);         // v2：逐条规范化
    data.agentTasks.forEach(normalizeAgentTask);
    return data;
  }

  /* ---------- 版本迁移（幂等） ----------
     无 schemaVersion 视为 v0。v0 → v1 补 slug / createdAt / updatedAt；
     v1 → v2 补 memos / agentTasks。两步均由 normalize 幂等完成，
     重复调用安全。后续版本在此追加分支。 */
  function migrate(data) {
    if (!data || typeof data !== "object") return data;
    if (typeof data.schemaVersion !== "number" || data.schemaVersion < SCHEMA_VERSION) {
      normalize(data);
      data.schemaVersion = SCHEMA_VERSION;
    }
    data.rev = typeof data.rev === "number" ? data.rev : 0; // 乐观锁修订号
    return data;
  }

  return {
    SCHEMA_VERSION,
    migrate, normalize,
    normalizeMemo, normalizeAgentTask,
    deriveSlug, genId, uniqueSlug,
    nowISO, localDateStr, tzOffsetStr,
  };
});
