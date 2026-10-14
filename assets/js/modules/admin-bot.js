/* ============================================================
   模块：admin-bot 后台「Bot 控制台」Tab
   挂载点：admin.html <section id="tab-bot">
   挂钩：
     GB.on("admin:ready", { isApi })  —— 记录运行模式
     GB.on("admin:tab", { tab })      —— tab === "bot" 时惰性构建
   功能：对话式指令控制台（用户右侧 / Bot 左侧气泡，回复经 GB.md 渲染）、
        回车发送、↑↓ 切换历史、输入「/」给出指令提示；
        历史存 localStorage("gb_bot_history")，刷新恢复
   说明：后端模式走 POST /api/bot/chat；静态模式本地模拟
        （「帮助」可用、「备忘」写本地备忘，其余回复「仅后端模式可用」）
   ============================================================ */
GB.register("admin-bot", {
  init(ctx) {
    const esc = (s) => GB.esc(String(s == null ? "" : s));
    const HIST_KEY = "gb_bot_history";
    let isApi = false;
    let built = false;

    /* ---------- 指令提示（客户端副本，静态模式也可用） ---------- */
    const HINTS = [
      ["帮助", "列出全部指令"],
      ["备忘 <内容>", "记录一条私密备忘"],
      ["搜博客 <关键词>", "搜索已发布文章"],
      ["新建任务 <规则> <动作>", "创建定时任务"],
      ["统计 [今天|本周|本月]", "访问统计摘要"],
      ["发布 <文章ID/slug>", "发布草稿文章"],
      ["备份", "全站数据备份"],
    ];

    /* ---------- 状态 ---------- */
    let history = []; // 已发送指令（旧 → 新）
    let histIdx = -1; // -1 = 未在历史浏览中
    let draft = "";
    let sending = false;

    /* ---------- DOM ---------- */
    let el = {};

    async function apiJSON(url, options = {}) {
      const res = await GB.auth.request(url, {
        headers: { "Content-Type": "application/json" }, ...options,
      });
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const err = new Error((data && data.error) || ("请求失败 " + res.status));
        err.code = res.status;
        throw err;
      }
      return data;
    }

    /* ---------- 历史持久化 ---------- */
    function loadHistory() {
      try {
        const h = JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
        history = Array.isArray(h) ? h.filter((x) => typeof x === "string").slice(-50) : [];
      } catch (e) { history = []; }
    }
    function pushHistory(text) {
      history = history.concat(text).slice(-50);
      histIdx = -1;
      try { localStorage.setItem(HIST_KEY, JSON.stringify(history)); } catch (e) {}
    }

    /* ---------- 消息渲染 ---------- */
    function addMsg(role, content) {
      const wrap = document.createElement("div");
      wrap.className = "flex " + (role === "user" ? "justify-end" : "justify-start");
      const bubble = document.createElement("div");
      bubble.className = "glass-sm px-3 py-2 text-sm max-w-[85%] " +
        (role === "user" ? "whitespace-pre-wrap" : "prose-glass");
      if (role === "user") bubble.textContent = content;
      else bubble.innerHTML = GB.mdLite(String(content || ""));
      wrap.appendChild(bubble);
      el.msgs.appendChild(wrap);
      el.msgs.scrollTop = el.msgs.scrollHeight;
    }

    function addSystem(text) {
      const p = document.createElement("p");
      p.className = "text-center text-xs text-secondary py-1";
      p.textContent = text;
      el.msgs.appendChild(p);
      el.msgs.scrollTop = el.msgs.scrollHeight;
    }

    function setBusy(on) {
      sending = on;
      el.send.disabled = on;
      el.send.textContent = on ? "…" : "发送";
    }

    /* ---------- 静态模式本地模拟 ---------- */
    async function staticExec(text) {
      const t = text.trim();
      if (/^(帮助|help)$/i.test(t))
        return "可用指令（静态模式）：\n" + HINTS.map(([c, d]) => `- ${c} — ${d}`).join("\n") +
          "\n\n静态模式仅「帮助」「备忘」可用，其余指令需启动 server.js 后端。";
      const m = t.match(/^备忘\s+([\s\S]+)$/);
      if (m) {
        const c = await GB.load();
        const now = GBSchema.nowISO();
        const memo = GBSchema.normalizeMemo({
          id: GBSchema.genId("memo"), content: m[1].trim(), tags: [], visibility: "private",
          pinned: false, archived: false, attachments: [], share: { enabled: false, token: "", expireAt: null },
          createdAt: now, updatedAt: now, rev: 1,
        });
        c.memos = c.memos || [];
        c.memos.unshift(memo);
        await GB.save(c);
        return `已记录备忘（本地，id: ${memo.id}）`;
      }
      return "该指令仅后端模式可用，请使用 node server.js 启动后端。";
    }

    /* ---------- 发送 ---------- */
    async function send() {
      if (sending) return;
      const text = el.input.value.trim();
      if (!text) return;
      addMsg("user", text);
      pushHistory(text);
      el.input.value = "";
      el.input.style.height = "";
      hideHints();
      setBusy(true);
      try {
        const reply = isApi
          ? (await apiJSON("api/bot/chat", { method: "POST", body: JSON.stringify({ text }) })).reply
          : await staticExec(text);
        addMsg("bot", reply);
      } catch (e) {
        addMsg("bot", "请求失败：" + (e.message || e));
      } finally {
        setBusy(false);
        el.input.focus();
      }
    }

    /* ---------- 指令提示 ---------- */
    function showHints() {
      const kw = el.input.value.trim().toLowerCase();
      const list = HINTS.filter(([c]) => !kw || kw === "/" || c.toLowerCase().includes(kw.replace(/^\//, "")));
      el.hint.innerHTML = list.length
        ? list.map(([c, d]) =>
            `<button type="button" data-cmd="${esc(c.replace(/ <.*>| \[.*\]/g, ""))}"
              class="glass-sm glass-hover px-2 py-1 text-xs text-left">
              <span class="font-medium">${esc(c)}</span><span class="text-secondary"> — ${esc(d)}</span>
            </button>`).join("")
        : '<p class="text-xs text-secondary">无匹配指令</p>';
      el.hint.classList.remove("hidden");
    }
    function hideHints() { el.hint.classList.add("hidden"); }

    /* ---------- 构建 ---------- */
    function build() {
      const root = document.querySelector("#tab-bot");
      if (!root) return;
      root.innerHTML = `
        <div id="botStatic" class="hidden glass px-4 py-3 space-y-1">
          <p class="text-sm">静态演示模式</p>
          <p class="text-xs text-secondary">仅本地「帮助」「备忘」可用，其余指令需启动 server.js 后端。</p>
        </div>
        <div id="botMain" class="space-y-4">
          <div class="glass p-5 flex flex-col" style="height:min(70vh,640px)">
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-medium">Bot 控制台</h3>
              <span class="text-xs text-secondary">指令对话 · 回车发送 · ↑↓ 历史 · 输入「/」查看提示</span>
              <span class="flex-1"></span>
              <button id="botClear" class="glass-sm glass-hover px-3 py-1 text-xs">清空对话</button>
            </div>
            <div id="botMsgs" class="flex-1 overflow-y-auto mt-3 space-y-2 pr-1"></div>
            <div id="botHint" class="hidden mt-2 flex flex-wrap gap-1.5"></div>
            <div class="mt-2 flex items-end gap-2">
              <textarea id="botInput" rows="1" placeholder="输入指令，如：统计 本周"
                class="glass-sm flex-1 px-3 py-2 text-sm bg-transparent outline-none resize-none"></textarea>
              <button id="botSend" class="glass-sm glass-hover px-4 py-2 text-sm">发送</button>
            </div>
          </div>
        </div>`;

      el = {
        static: root.querySelector("#botStatic"),
        main: root.querySelector("#botMain"),
        msgs: root.querySelector("#botMsgs"),
        hint: root.querySelector("#botHint"),
        input: root.querySelector("#botInput"),
        send: root.querySelector("#botSend"),
        clear: root.querySelector("#botClear"),
      };
      bindEvents();
      el.static.classList.toggle("hidden", isApi);
      addSystem("发送「帮助」查看全部指令。" + (isApi ? "" : "（静态模式：仅「帮助」「备忘」可用）"));
    }

    function bindEvents() {
      el.send.addEventListener("click", send);
      el.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); return; }
        if (e.key === "ArrowUp") {
          if (!history.length) return;
          e.preventDefault();
          if (histIdx === -1) draft = el.input.value;
          histIdx = Math.min(histIdx + 1, history.length - 1);
          el.input.value = history[history.length - 1 - histIdx];
          autoGrow();
          return;
        }
        if (e.key === "ArrowDown") {
          if (histIdx === -1) return;
          e.preventDefault();
          histIdx -= 1;
          el.input.value = histIdx < 0 ? draft : history[history.length - 1 - histIdx];
          autoGrow();
          return;
        }
        if (e.key === "Escape") { hideHints(); return; }
      });
      el.input.addEventListener("input", () => {
        autoGrow();
        const v = el.input.value.trim();
        if (v === "/" || (v && v.length <= 6)) showHints();
        else hideHints();
      });
      el.input.addEventListener("blur", () => setTimeout(hideHints, 150));
      el.hint.addEventListener("mousedown", (e) => {
        const b = e.target.closest("[data-cmd]");
        if (!b) return;
        e.preventDefault();
        el.input.value = b.dataset.cmd + " ";
        hideHints();
        el.input.focus();
      });
      el.clear.addEventListener("click", () => {
        el.msgs.innerHTML = "";
        addSystem("对话已清空。发送「帮助」查看全部指令。");
      });
    }

    function autoGrow() {
      el.input.style.height = "";
      el.input.style.height = Math.min(el.input.scrollHeight, 160) + "px";
    }

    /* ---------- 挂钩：惰性构建 ---------- */
    // 模块异步加载完成时 admin:ready / 首次 admin:tab 可能已发过，
    // 构建时以 GB.isApi() 实测为准，并依据 window.GB_ADMIN_TAB 补构建
    function maybeBuild(tab) {
      if (tab !== "bot" || built) return;
      built = true;
      try { isApi = GB.isApi(); } catch (e) {}
      loadHistory();
      build();
      if (isApi && el.input) el.input.focus();
    }
    ctx.on("admin:ready", ({ isApi: api } = {}) => { isApi = !!api; if (built && el.static) {
      el.static.classList.toggle("hidden", isApi);
    } });
    ctx.on("admin:tab", ({ tab } = {}) => maybeBuild(tab));
    maybeBuild(window.GB_ADMIN_TAB);
  },
});
