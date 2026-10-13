/* ============================================================
   GlassBlog 公共逻辑：主题 / 数据 / 认证 / 上传 / 导航

   双模式数据策略（自动探测，无需配置）：
   - 后端模式（node server.js）：走 /api/* 接口，数据保存在服务端
     data/content.json，文件真实上传到服务器 → 多端同步
   - 静态模式（纯静态部署）：回退 localStorage 演示 + 本地 JSON，
     上传退化为 dataURL/blob 临时链接（仅当前会话有效）
   ============================================================ */
window.GB = (function () {
  const LS_KEY = "gb_content";   // 静态模式：后台编辑的本地演示数据
  const LS_THEME = "gb_theme";   // 主题偏好
  const TOKEN_KEY = "gb_token";  // 后端登录令牌 / 静态模式演示标记

  let _api = null; // 后端可用性探测缓存：null 未探测 / true / false

  /* ---------- 主题 ---------- */
  function initTheme() {
    const saved = localStorage.getItem(LS_THEME);
    const dark = saved ? saved === "dark" : false;
    document.documentElement.classList.toggle("dark", dark);
  }
  function toggleTheme() {
    const dark = document.documentElement.classList.toggle("dark");
    localStorage.setItem(LS_THEME, dark ? "dark" : "light");
    updateThemeIcon();
  }
  function updateThemeIcon() {
    const btn = document.getElementById("themeBtn");
    if (btn)
      btn.textContent = document.documentElement.classList.contains("dark") ? "☀︎" : "☾";
  }

  /* ---------- 数据 ---------- */
  // 数据契约迁移（schema.js 需先于本文件引入；缺失时降级为恒等，保证单文件可用）
  const mig = (d) => (window.GBSchema ? window.GBSchema.migrate(d) : d);

  async function load() {
    // 1) 尝试后端接口（成功即进入后端模式，服务端数据为准 → 多端同步）
    try {
      const r = await fetch("api/content");
      if (r.ok) {
        _api = true;
        return mig(await r.json());
      }
    } catch (e) { /* 无后端，走静态模式 */ }
    // 2) 静态模式：localStorage（后台演示编辑）→ content.json 默认内容
    _api = false;
    const cached = localStorage.getItem(LS_KEY);
    if (cached) {
      try { return mig(JSON.parse(cached)); } catch (e) { /* 损坏则回退 */ }
    }
    const res = await fetch("data/content.json");
    return mig(await res.json());
  }

  async function save(data) {
    if (_api) {
      const r = await fetch("api/content", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + (localStorage.getItem(TOKEN_KEY) || ""),
        },
        body: JSON.stringify(data),
      });
      if (r.status === 409) { // rev 乐观锁冲突：数据已被其他窗口/设备修改
        const err = new Error("内容已被其他窗口修改，请刷新页面后重试");
        err.code = 409;
        throw err;
      }
      if (!r.ok)
        throw new Error((await r.json().catch(() => ({}))).error || "保存失败");
      const res = await r.json().catch(() => ({}));
      if (typeof res.rev === "number") data.rev = res.rev; // 同步服务端修订号，供下次保存校验
      return;
    }
    // 静态模式：本地同样维护 rev，保持契约形态一致
    data.rev = (typeof data.rev === "number" ? data.rev : 0) + 1;
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  }

  async function reset() {
    localStorage.removeItem(LS_KEY);
    // 后端模式：重新拉取服务端数据；静态模式：回到 content.json 默认内容
    return load();
  }

  /* ---------- 认证 ---------- */
  async function login(user, pass) {
    if (_api === null) await load(); // 确保已探测后端
    if (_api) {
      const r = await fetch("api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, pass }),
      });
      if (!r.ok) return false;
      const { token } = await r.json();
      localStorage.setItem(TOKEN_KEY, token);
      return true;
    }
    // 静态演示模式：仅前端校验
    if (user === "admin" && pass === "glass123") {
      localStorage.setItem(TOKEN_KEY, "demo");
      return true;
    }
    return false;
  }
  // 注销：后端模式先通知服务端销毁令牌，再清本地
  async function logout() {
    if (_api) {
      try {
        await fetch("api/logout", {
          method: "POST",
          headers: { Authorization: "Bearer " + (localStorage.getItem(TOKEN_KEY) || "") },
        });
      } catch (e) { /* 网络异常也继续本地注销 */ }
    }
    localStorage.removeItem(TOKEN_KEY);
  }
  function isApi() {
    return _api === true;
  }

  /* ---------- 访问统计（隐私友好，仅后端模式） ---------- */
  // 页面浏览上报：仅路径，无 Cookie；服务端做 IP 去重与留存裁剪
  function track() {
    if (!_api) return;
    try {
      const body = JSON.stringify({ path: location.pathname });
      // sendBeacon：页面跳转/关闭时不被中断，避免 keepalive fetch 的 AbortError 噪音
      if (navigator.sendBeacon?.("api/hit", new Blob([body], { type: "application/json" })))
        return;
      fetch("api/hit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch (e) { /* 统计失败不影响页面 */ }
  }
  // 管理端拉取近 30 天聚合统计
  async function stats() {
    const r = await fetch("api/stats", {
      headers: { Authorization: "Bearer " + (localStorage.getItem(TOKEN_KEY) || "") },
    });
    if (!r.ok)
      throw new Error((await r.json().catch(() => ({}))).error || "获取统计失败");
    return r.json(); // { days, total, pages: [{ path, count }] }
  }

  /* ---------- 备份历史 / 一键恢复（仅后端模式可用） ---------- */
  async function backups() {
    const r = await fetch("api/backups", {
      headers: { Authorization: "Bearer " + (localStorage.getItem(TOKEN_KEY) || "") },
    });
    if (!r.ok)
      throw new Error((await r.json().catch(() => ({}))).error || "获取备份列表失败");
    return r.json(); // { backups: [{ file, size, mtime }] }
  }
  async function restore(file) {
    const r = await fetch("api/restore", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (localStorage.getItem(TOKEN_KEY) || ""),
      },
      body: JSON.stringify({ file }),
    });
    if (!r.ok)
      throw new Error((await r.json().catch(() => ({}))).error || "恢复失败");
    return r.json(); // { ok, rev }
  }

  /* ---------- 文件上传 ---------- */
  // dir: "images"（截图/头像 → uploads/）| "packages"（安装包 → downloads/）
  async function upload(file, dir) {
    if (_api) {
      const r = await fetch(`api/upload?dir=${dir}&name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { Authorization: "Bearer " + (localStorage.getItem(TOKEN_KEY) || "") },
        body: file, // 原始字节流，服务端直接落盘
      });
      if (!r.ok)
        throw new Error((await r.json().catch(() => ({}))).error || "上传失败");
      return r.json(); // { url, size }
    }
    // 静态演示回退：图片内嵌 dataURL，其他生成临时 blob 链接（仅当前会话有效）
    if (file.type.startsWith("image/")) {
      return new Promise((resolve) => {
        const rd = new FileReader();
        rd.onload = () => resolve({ url: rd.result, size: file.size });
        rd.readAsDataURL(file);
      });
    }
    return { url: URL.createObjectURL(file), size: file.size };
  }

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function fmtDate(d) {
    return new Date(d).toLocaleDateString("zh-CN", {
      year: "numeric", month: "long", day: "numeric",
    });
  }

  /* ---------- Markdown 渲染（marked 解析 + DOMPurify 消毒） ---------- */
  // 依赖页面引入 marked（必需）；DOMPurify 可选，缺省则直接输出（仅可信内容时）
  function md(text) {
    const html = marked.parse(text || "");
    return typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(html) : html;
  }

  /* 阅读时间估算：中文 400 字/分钟，英文 200 词/分钟（参考 Medium） */
  function readingTime(text) {
    const cn = (String(text || "").match(/[一-龥]/g) || []).length;
    const en = (String(text || "").replace(/[一-龥]/g, " ").match(/[a-zA-Z0-9]+/g) || []).length;
    return Math.max(1, Math.round(cn / 400 + en / 200));
  }

  /* 代码块增强：highlight.js 按需懒加载高亮 + 复制按钮（性能：无代码块零开销） */
  let _hljsPromise = null;
  function loadHljs() {
    if (window.hljs) return Promise.resolve(window.hljs);
    if (!_hljsPromise) {
      _hljsPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "assets/js/vendor/highlight.min.js?v=20261013"; // 本地化，避免 CDN 不稳定
        s.onload = () => resolve(window.hljs);
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    return _hljsPromise;
  }
  function enhanceCode(root) {
    const pres = root.querySelectorAll("pre");
    if (!pres.length) return;
    // 复制按钮
    pres.forEach((pre) => {
      if (pre.querySelector(".code-copy")) return;
      const btn = document.createElement("button");
      btn.className = "code-copy";
      btn.type = "button";
      btn.textContent = "复制";
      btn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(pre.querySelector("code")?.innerText || "");
          btn.textContent = "已复制 ✓";
        } catch (e) { btn.textContent = "失败"; }
        setTimeout(() => (btn.textContent = "复制"), 1200);
      };
      pre.appendChild(btn);
    });
    // 语法高亮（懒加载，主题色在 glass.css 用 CSS 变量定义，深浅色自适应）
    loadHljs().then((hljs) =>
      root.querySelectorAll("pre code").forEach((c) => {
        try { hljs.highlightElement(c); } catch (e) { /* 未知语言则跳过 */ }
      })
    ).catch(() => {});
  }

  /* ---------- 导航（极简玻璃顶栏） ---------- */
  function renderNav(active) {
    _page = active; // 记录当前页标识，模块清单按此加载
    const links = [
      { href: "index.html", label: "主页", key: "home" },
      { href: "blog.html", label: "博客", key: "blog" },
      { href: "apps.html", label: "软件", key: "apps" },
      { href: "admin.html", label: "管理", key: "admin" },
    ];
    const nav = document.getElementById("nav");
    // whitespace-nowrap：防窄屏下中文链接断行竖排撑高导航；
    // overflow-x-auto：极窄屏导航内横向滑动，不溢出屏幕；
    // 移动端加大触控目标（链接 40px / 按钮 36px 高），桌面端保持紧凑
    nav.className = "glass fixed left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 px-3 py-2 max-w-[calc(100vw-1.5rem)] overflow-x-auto";
    nav.style.top = "calc(1rem + env(safe-area-inset-top, 0px))"; // 避开刘海屏顶部安全区
    nav.style.borderRadius = "999px";
    nav.innerHTML =
      links.map((l) =>
        `<a href="${l.href}" class="px-4 py-2.5 sm:py-1.5 rounded-full text-sm whitespace-nowrap shrink-0 ${
          l.key === active ? "text-accent font-medium" : "text-secondary hover:text-[var(--text)]"
        }">${l.label}</a>`).join("") +
      `<button id="themeBtn" onclick="GB.toggleTheme()" aria-label="切换主题"
        class="ml-1 w-9 h-9 sm:w-8 sm:h-8 rounded-full glass-sm flex items-center justify-center text-sm shrink-0">☾</button>`;
    updateThemeIcon();
    loadModules(); // 导航就绪即加载当前页模块（异步，不阻塞页面）
  }

  /* ---------- 模块系统（框架核心） ----------
     添加新功能的标准流程（适合 AI 协作，全程不改核心文件）：
     1. 在 assets/js/modules/ 新建 xxx.js，文件内调用
        GB.register("xxx", { init(ctx) { ... } })
     2. 在 assets/js/modules/index.js 清单中按页登记一行
     页面在关键节点 emit 事件（事件表见 README），模块用 ctx.on 挂钩扩展。 */
  const _mods = {};       // 模块名 -> { init(ctx) }
  const _listeners = {};  // 事件名 -> [回调]
  let _page = "";         // 当前页标识（renderNav 时写入）
  let _modsLoading = false;

  function on(evt, fn) { (_listeners[evt] = _listeners[evt] || []).push(fn); }
  function emit(evt, data) {
    (_listeners[evt] || []).forEach((fn) => {
      try { fn(data); } catch (e) { console.error(`[GB] 事件 "${evt}" 处理异常：`, e); }
    });
  }
  function register(name, mod) {
    if (!name || typeof mod?.init !== "function")
      return console.error("[GB] 模块注册失败（需要模块名与 init(ctx) 方法）：", name);
    _mods[name] = mod;
  }
  function _loadScript(src) {
    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { console.error("[GB] 脚本加载失败：" + src); resolve(); };
      document.head.appendChild(s);
    });
  }
  // 按清单加载并初始化当前页模块（renderNav 时自动触发，仅执行一次）
  async function loadModules() {
    if (_modsLoading) return;
    _modsLoading = true;
    await _loadScript("assets/js/modules/index.js");
    const manifest = window.GB_MODULES || {};
    const names = [...new Set([...(manifest["*"] || []), ...(manifest[_page] || [])])];
    for (const n of names) await _loadScript("assets/js/modules/" + n + ".js");
    names.forEach((n) => {
      if (!_mods[n]) return console.error(`[GB] 模块 "${n}" 未注册（检查模块文件是否调用 GB.register）`);
      try { _mods[n].init({ page: _page, on, emit }); }
      catch (e) { console.error(`[GB] 模块 "${n}" 初始化失败：`, e); }
    });
  }

  initTheme();
  return {
    load, save, reset, login, logout, upload, isApi, track, stats, backups, restore,
    esc, fmtDate, md, readingTime, enhanceCode,
    renderNav, toggleTheme, initTheme,
    register, on, emit,
  };
})();
