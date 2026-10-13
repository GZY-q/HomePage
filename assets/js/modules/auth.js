/* ============================================================
   模块：auth 全局认证（全站）
   - GB.auth.check()         是否已登录（本地有令牌即视为已登录）
   - GB.auth.login(u, p)     登录，成功触发 auth:changed 并重绘导航
   - GB.auth.logout()        注销，触发 auth:changed 后跳回主页
   - GB.auth.requireLogin()  未登录弹出玻璃风登录模态框，返回 false
   - GB.auth.request(url, o) fetch 封装：自动带令牌，401 自动弹登录框
   ============================================================ */
GB.register("auth", {
  init(ctx) {
    const TOKEN_KEY = "gb_token"; // 与 common.js 保持一致

    /* ---------- 登录态 ---------- */
    function check() {
      return !!localStorage.getItem(TOKEN_KEY);
    }

    async function login(user, pass) {
      const ok = await GB.login(user, pass);
      if (ok) {
        GB.emit("auth:changed", { loggedIn: true });
        GB.renderNav(ctx.page || ""); // 重绘导航右侧登录态
      }
      return ok;
    }

    async function logout() {
      await GB.logout();
      GB.emit("auth:changed", { loggedIn: false });
      location.href = "index.html";
    }

    function requireLogin() {
      if (check()) return true;
      showModal();
      return false;
    }

    /* ---------- fetch 封装：自动携带 Authorization，401 弹登录框 ---------- */
    async function request(url, options = {}) {
      const headers = Object.assign({}, options.headers, {
        Authorization: "Bearer " + (localStorage.getItem(TOKEN_KEY) || ""),
      });
      const res = await fetch(url, Object.assign({}, options, { headers }));
      if (res.status === 401) showModal();
      return res;
    }

    /* ---------- 登录模态框（玻璃风，样式内联复用 CSS 变量，不改 glass.css） ---------- */
    let _modal = null;
    function buildModal() {
      const wrap = document.createElement("div");
      wrap.id = "gbAuthModal";
      wrap.hidden = true;
      // 全屏遮罩：点击遮罩不关闭，必须主动登录或点取消
      wrap.style.cssText =
        "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;" +
        "background:rgba(0,0,0,0.28);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);";
      wrap.innerHTML = `
        <div style="width:min(360px,calc(100vw - 2.5rem));padding:2rem 1.75rem;border-radius:24px;
          background:var(--glass-bg);border:1px solid var(--glass-border);
          -webkit-backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-saturate));
          backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-saturate));
          box-shadow:var(--glass-shadow), var(--glass-highlight);">
          <div style="font-size:1.05rem;font-weight:600;margin-bottom:1.25rem;text-align:center;">登录 GlassBlog</div>
          <input id="gbAuthUser" type="text" placeholder="账号" autocomplete="username"
            style="width:100%;box-sizing:border-box;margin-bottom:.75rem;padding:.65rem .9rem;font-size:.9rem;
            color:var(--text);background:transparent;border:1px solid var(--glass-border);border-radius:12px;outline:none;" />
          <input id="gbAuthPass" type="password" placeholder="密码" autocomplete="current-password"
            style="width:100%;box-sizing:border-box;margin-bottom:.75rem;padding:.65rem .9rem;font-size:.9rem;
            color:var(--text);background:transparent;border:1px solid var(--glass-border);border-radius:12px;outline:none;" />
          <div id="gbAuthErr" style="min-height:1.2em;margin-bottom:.5rem;font-size:.8rem;color:#e64545;text-align:center;"></div>
          <button id="gbAuthBtn" type="button"
            style="width:100%;padding:.65rem 0;font-size:.9rem;font-weight:500;color:#fff;cursor:pointer;
            background:var(--accent);border:none;border-radius:12px;">登 录</button>
        </div>`;
      document.body.appendChild(wrap);

      const userEl = wrap.querySelector("#gbAuthUser");
      const passEl = wrap.querySelector("#gbAuthPass");
      const errEl = wrap.querySelector("#gbAuthErr");
      const btnEl = wrap.querySelector("#gbAuthBtn");

      async function submit() {
        errEl.textContent = "";
        btnEl.disabled = true;
        btnEl.textContent = "登录中…";
        try {
          const ok = await login(userEl.value.trim(), passEl.value);
          if (ok) { hideModal(); return; }
          errEl.textContent = "账号或密码错误";
        } catch (e) {
          errEl.textContent = "网络异常，请稍后重试";
        } finally {
          btnEl.disabled = false;
          btnEl.textContent = "登 录";
        }
      }
      btnEl.onclick = submit;
      // 回车提交
      [userEl, passEl].forEach((el) =>
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); }));
      return wrap;
    }

    function showModal() {
      if (!_modal) _modal = buildModal();
      _modal.hidden = false;
      _modal.querySelector("#gbAuthErr").textContent = "";
      setTimeout(() => _modal.querySelector("#gbAuthUser").focus(), 0);
    }
    function hideModal() {
      if (_modal) _modal.hidden = true;
    }

    /* ---------- 挂到 GB.auth 供全局调用 ---------- */
    GB.auth = { check, login, logout, requireLogin, request };
  },
});
