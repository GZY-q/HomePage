/* ============================================================
   模块：admin-agent 后台「Agent 任务」Tab
   挂载点：admin.html <section id="tab-agent">
   挂钩：
     GB.on("admin:ready", { isApi })  —— 记录运行模式
     GB.on("admin:tab", { tab })      —— tab === "agent" 时惰性构建
   功能：概览卡片、任务 CRUD（可视化调度规则 + 动作参数表单 + 重试配置）、
        启用/禁用/立即执行、执行日志时间线；静态模式整体置灰
   说明：Agent 依赖 server.js 调度器，静态模式（纯托管）下不可用
   ============================================================ */
GB.register("admin-agent", {
  init(ctx) {
    const esc = (s) => GB.esc(String(s == null ? "" : s));
    let isApi = false;
    let built = false;

    /* ---------- API ---------- */
    async function apiJSON(url, options = {}) {
      const res = await GB.auth.request(url, {
        headers: { "Content-Type": "application/json" }, ...options,
      });
      if (res.status === 204) return null;
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        const err = new Error((data && data.error) || ("请求失败 " + res.status));
        err.code = res.status;
        throw err;
      }
      return data;
    }

    /* ---------- 动作元数据（参数表单按动作渲染） ---------- */
    const ACTION_META = {
      memo_publish: { label: "发布备忘", params: [
        { k: "content", label: "内容（支持 Markdown）", type: "textarea", required: true },
        { k: "tags", label: "标签（逗号分隔）", type: "text" },
        { k: "visibility", label: "可见性", type: "select", options: [["private", "私密"], ["public", "公开"]] },
      ]},
      memo_weekly_report: { label: "备忘周报", params: [
        { k: "tags", label: "标签筛选（逗号分隔，空为全部）", type: "text" },
        { k: "autoPublish", label: "公开周报", type: "checkbox" },
      ]},
      post_publish: { label: "发布博客草稿", params: [
        { k: "postId", label: "文章 ID 或 slug", type: "text", required: true },
      ]},
      system_backup: { label: "全站备份", params: [] },
      stats_daily: { label: "访问统计日报", params: [] },
      webhook: { label: "调用 Webhook", params: [
        { k: "url", label: "URL", type: "text", required: true },
        { k: "method", label: "方法", type: "select", options: [["POST", "POST"], ["GET", "GET"]] },
        { k: "body", label: "请求体（仅 POST 发送）", type: "textarea" },
      ]},
    };
    const actionLabel = (a) => (ACTION_META[a] || {}).label || a;
    const TRIGGER_LABEL = { schedule: "自动", manual: "手动", catchUp: "补跑" };
    const WEEKDAYS_CN = ["日", "一", "二", "三", "四", "五", "六"];

    /* ---------- 状态 ---------- */
    let tasks = [];
    let logs = [];
    let editingId = null; // 表单正在编辑的任务 id（null = 新建）

    /* ---------- DOM ---------- */
    let el = {};

    function fmtTime(iso) {
      if (!iso) return "—";
      const d = new Date(iso);
      if (isNaN(d)) return "—";
      return (
        d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0") + " " + String(d.getHours()).padStart(2, "0") +
        ":" + String(d.getMinutes()).padStart(2, "0")
      );
    }

    /* 调度规则 → 人类可读描述 */
    function describeSchedule(s) {
      const p = String(s || "").split("@");
      if (p[0] === "daily") return `每天 ${p[1] || ""}`;
      if (p[0] === "weekly") {
        const wd = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[p[1]];
        return `每周${wd != null ? WEEKDAYS_CN[wd] : "?"} ${p[2] || ""}`;
      }
      if (p[0] === "monthly") return `每月 ${p[1] || "?"} 日 ${p[2] || ""}`;
      if (p[0] === "once") return "一次性 " + fmtTime(p.slice(1).join("@"));
      if (p[0] === "interval") {
        const sec = Number(p[1]);
        if (sec % 3600 === 0) return `每 ${sec / 3600} 小时`;
        if (sec % 60 === 0) return `每 ${sec / 60} 分钟`;
        return `每 ${sec} 秒`;
      }
      return s || "—";
    }

    function build() {
      const root = document.getElementById("tab-agent");
      root.innerHTML = `
      <div id="agStatic" class="hidden glass p-8 text-center">
        <p class="text-lg font-medium">Agent 定时任务仅在后端模式可用</p>
        <p class="mt-2 text-sm text-secondary">当前为静态演示模式：没有 server.js 调度器，任务无法注册与执行。</p>
      </div>
      <div id="agMain" class="space-y-5">
        <!-- 概览卡片 -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div class="glass p-4"><p class="text-xs text-secondary">运行中任务</p><p id="agcRunning" class="mt-1 text-2xl font-semibold">0</p></div>
          <div class="glass p-4"><p class="text-xs text-secondary">今日执行次数</p><p id="agcToday" class="mt-1 text-2xl font-semibold">0</p></div>
          <div class="glass p-4"><p class="text-xs text-secondary">近期成功率</p><p id="agcRate" class="mt-1 text-2xl font-semibold">—</p></div>
          <div class="glass p-4"><p class="text-xs text-secondary">最近失败任务</p><p id="agcFail" class="mt-1 text-sm font-medium truncate">无</p><p id="agcFailTime" class="text-xs text-secondary"></p></div>
        </div>

        <div class="grid lg:grid-cols-5 gap-5">
          <!-- 左列：任务列表 -->
          <div class="lg:col-span-3 space-y-3">
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-medium">任务列表</h3>
              <span class="flex-1"></span>
              <button id="agRefresh" class="glass-sm glass-hover px-3 py-1 text-xs">刷新</button>
            </div>
            <div id="agList" class="space-y-3"></div>
          </div>

          <!-- 右列：新建 / 编辑表单 -->
          <div class="lg:col-span-2">
            <div class="glass p-5 space-y-3">
              <h3 id="agFormTitle" class="text-sm font-medium">新建任务</h3>
              <input id="agName" placeholder="任务名称" class="glass-sm w-full px-3 py-2 text-sm bg-transparent outline-none" />
              <div>
                <label class="text-xs text-secondary">动作</label>
                <select id="agAction" class="glass-sm w-full mt-1 px-3 py-2 text-sm bg-transparent outline-none"></select>
              </div>
              <div id="agParams" class="space-y-2"></div>

              <div class="pt-1">
                <label class="text-xs text-secondary">调度规则</label>
                <div class="mt-1 flex gap-2 flex-wrap items-center">
                  <select id="agSchType" class="glass-sm px-3 py-2 text-sm bg-transparent outline-none">
                    <option value="daily">每天</option>
                    <option value="weekly">每周</option>
                    <option value="monthly">每月</option>
                    <option value="once">一次性</option>
                    <option value="interval">固定间隔</option>
                  </select>
                  <select id="agSchWeek" class="glass-sm hidden px-3 py-2 text-sm bg-transparent outline-none">
                    <option value="mon">周一</option><option value="tue">周二</option>
                    <option value="wed">周三</option><option value="thu">周四</option>
                    <option value="fri">周五</option><option value="sat">周六</option>
                    <option value="sun">周日</option>
                  </select>
                  <input id="agSchDay" type="number" min="1" max="31" placeholder="日" class="glass-sm hidden w-20 px-3 py-2 text-sm bg-transparent outline-none" />
                  <input id="agSchTime" type="time" value="09:00" class="glass-sm px-3 py-2 text-sm bg-transparent outline-none" />
                  <input id="agSchOnce" type="datetime-local" class="glass-sm hidden px-3 py-2 text-sm bg-transparent outline-none" />
                  <span id="agSchIntWrap" class="hidden flex items-center gap-2">
                    <input id="agSchInt" type="number" min="1" value="1" class="glass-sm w-20 px-3 py-2 text-sm bg-transparent outline-none" />
                    <select id="agSchIntUnit" class="glass-sm px-3 py-2 text-sm bg-transparent outline-none">
                      <option value="3600">小时</option><option value="60">分钟</option><option value="1">秒</option>
                    </select>
                  </span>
                </div>
                <p id="agSchPreview" class="mt-1.5 text-xs text-secondary"></p>
              </div>

              <div class="flex gap-2 flex-wrap items-center text-xs">
                <label class="glass-sm px-3 py-2 flex items-center gap-1.5">重试
                  <input id="agRetry" type="number" min="0" max="5" value="0" class="w-12 bg-transparent outline-none" /> 次
                </label>
                <label class="glass-sm px-3 py-2 flex items-center gap-1.5">间隔
                  <input id="agRetryDelay" type="number" min="1" value="60" class="w-14 bg-transparent outline-none" /> 秒
                </label>
                <label class="glass-sm px-3 py-2 flex items-center gap-1.5 cursor-pointer">
                  <input id="agCatchUp" type="checkbox" class="accent-current" /> 重启后补跑
                </label>
                <label class="glass-sm px-3 py-2 flex items-center gap-1.5 cursor-pointer">
                  <input id="agEnabled" type="checkbox" class="accent-current" checked /> 启用
                </label>
              </div>

              <div class="flex gap-2 pt-1">
                <button id="agSubmit" class="glass-sm glass-hover px-4 py-2 text-sm text-accent font-medium">创建任务</button>
                <button id="agCancel" class="glass-sm glass-hover px-4 py-2 text-sm hidden">取消编辑</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 执行日志 -->
        <div class="glass p-5">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-medium">执行日志</h3>
            <span id="agLogTotal" class="text-xs text-secondary"></span>
            <span class="flex-1"></span>
            <button id="agLogRefresh" class="glass-sm glass-hover px-3 py-1 text-xs">刷新</button>
          </div>
          <div id="agLogs" class="mt-3 space-y-2"></div>
        </div>
      </div>`;

      el = {
        static: root.querySelector("#agStatic"),
        main: root.querySelector("#agMain"),
        cRunning: root.querySelector("#agcRunning"),
        cToday: root.querySelector("#agcToday"),
        cRate: root.querySelector("#agcRate"),
        cFail: root.querySelector("#agcFail"),
        cFailTime: root.querySelector("#agcFailTime"),
        refresh: root.querySelector("#agRefresh"),
        list: root.querySelector("#agList"),
        formTitle: root.querySelector("#agFormTitle"),
        name: root.querySelector("#agName"),
        action: root.querySelector("#agAction"),
        params: root.querySelector("#agParams"),
        schType: root.querySelector("#agSchType"),
        schWeek: root.querySelector("#agSchWeek"),
        schDay: root.querySelector("#agSchDay"),
        schTime: root.querySelector("#agSchTime"),
        schOnce: root.querySelector("#agSchOnce"),
        schIntWrap: root.querySelector("#agSchIntWrap"),
        schInt: root.querySelector("#agSchInt"),
        schIntUnit: root.querySelector("#agSchIntUnit"),
        schPreview: root.querySelector("#agSchPreview"),
        retry: root.querySelector("#agRetry"),
        retryDelay: root.querySelector("#agRetryDelay"),
        catchUp: root.querySelector("#agCatchUp"),
        enabled: root.querySelector("#agEnabled"),
        submit: root.querySelector("#agSubmit"),
        cancel: root.querySelector("#agCancel"),
        logTotal: root.querySelector("#agLogTotal"),
        logs: root.querySelector("#agLogs"),
        logRefresh: root.querySelector("#agLogRefresh"),
      };
      // 动作下拉
      el.action.innerHTML = Object.keys(ACTION_META)
        .map((a) => `<option value="${a}">${esc(actionLabel(a))}</option>`).join("");
      bindEvents();
      renderParamFields();
      syncScheduleUI();
      el.static.classList.toggle("hidden", isApi);
      el.main.classList.toggle("hidden", !isApi);
    }

    /* ---------- 参数表单 ---------- */
    function renderParamFields() {
      const meta = ACTION_META[el.action.value] || { params: [] };
      el.params.innerHTML = meta.params.length
        ? meta.params.map((p) => {
            const id = "agp_" + p.k;
            if (p.type === "textarea")
              return `<div><label class="text-xs text-secondary">${esc(p.label)}</label>
                <textarea id="${id}" data-k="${p.k}" rows="3" class="glass-sm w-full mt-1 px-3 py-2 text-sm bg-transparent outline-none resize-y"></textarea></div>`;
            if (p.type === "select")
              return `<div><label class="text-xs text-secondary">${esc(p.label)}</label>
                <select id="${id}" data-k="${p.k}" class="glass-sm w-full mt-1 px-3 py-2 text-sm bg-transparent outline-none">
                  ${p.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
                </select></div>`;
            if (p.type === "checkbox")
              return `<label class="glass-sm px-3 py-2 text-xs flex items-center gap-1.5 cursor-pointer w-fit">
                <input id="${id}" data-k="${p.k}" type="checkbox" class="accent-current" /> ${esc(p.label)}</label>`;
            return `<div><label class="text-xs text-secondary">${esc(p.label)}</label>
              <input id="${id}" data-k="${p.k}" type="${p.type === "number" ? "number" : "text"}"
                class="glass-sm w-full mt-1 px-3 py-2 text-sm bg-transparent outline-none" /></div>`;
          }).join("")
        : '<p class="text-xs text-secondary">该动作无需参数</p>';
    }

    function collectParams() {
      const meta = ACTION_META[el.action.value] || { params: [] };
      const params = {};
      for (const p of meta.params) {
        const node = el.params.querySelector('[data-k="' + p.k + '"]');
        if (!node) continue;
        let v = p.type === "checkbox" ? node.checked : node.value.trim();
        if (p.k === "tags" && p.type === "text")
          v = v ? v.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : undefined;
        else if (p.type === "number") v = v === "" ? undefined : Number(v);
        else if (p.type === "text" || p.type === "textarea") v = v === "" ? undefined : v;
        if (p.required && (v === undefined || v === "")) {
          throw new Error("请填写：" + p.label);
        }
        if (v !== undefined) params[p.k] = v;
      }
      return params;
    }

    function fillParams(action, params = {}) {
      const meta = ACTION_META[action] || { params: [] };
      for (const p of meta.params) {
        const node = el.params.querySelector('[data-k="' + p.k + '"]');
        if (!node) continue;
        const v = params[p.k];
        if (p.type === "checkbox") node.checked = !!v;
        else if (Array.isArray(v)) node.value = v.join(", ");
        else node.value = v == null ? "" : v;
      }
    }

    /* ---------- 调度规则表单 ---------- */
    function syncScheduleUI() {
      const t = el.schType.value;
      el.schWeek.classList.toggle("hidden", t !== "weekly");
      el.schDay.classList.toggle("hidden", t !== "monthly");
      el.schTime.classList.toggle("hidden", !(t === "daily" || t === "weekly" || t === "monthly"));
      el.schOnce.classList.toggle("hidden", t !== "once");
      el.schIntWrap.classList.toggle("hidden", t !== "interval");
      let s = null;
      try { s = buildSchedule(); } catch (e) {}
      el.schPreview.textContent = s ? "规则：" + s + "（" + describeSchedule(s) + "）" : "";
    }

    function buildSchedule() {
      const t = el.schType.value;
      if (t === "daily" || t === "weekly" || t === "monthly") {
        const time = el.schTime.value;
        if (!/^\d{2}:\d{2}$/.test(time)) throw new Error("请选择执行时间");
        if (t === "daily") return "daily@" + time;
        if (t === "weekly") return "weekly@" + el.schWeek.value + "@" + time;
        const day = Number(el.schDay.value);
        if (!(day >= 1 && day <= 31)) throw new Error("请输入每月几号（1-31）");
        return "monthly@" + day + "@" + time;
      }
      if (t === "once") {
        if (!el.schOnce.value) throw new Error("请选择一次性执行时间");
        const d = new Date(el.schOnce.value);
        if (isNaN(d)) throw new Error("一次性时间无效");
        if (d.getTime() <= Date.now()) throw new Error("一次性时间必须在未来");
        const p = (n) => String(n).padStart(2, "0");
        return `once@${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
      }
      // interval
      const n = Number(el.schInt.value), unit = Number(el.schIntUnit.value);
      const sec = Math.floor(n * unit);
      if (!(sec >= 60)) throw new Error("间隔最小 60 秒");
      return "interval@" + sec;
    }

    function parseScheduleIntoForm(s) {
      const p = String(s || "").split("@");
      const t = ["daily", "weekly", "monthly", "once", "interval"].includes(p[0]) ? p[0] : "daily";
      el.schType.value = t;
      if (t === "weekly") el.schWeek.value = p[1] || "mon";
      if (t === "monthly") el.schDay.value = p[1] || "";
      if (t === "daily" || t === "weekly" || t === "monthly")
        el.schTime.value = p[t === "daily" ? 1 : 2] || "09:00";
      if (t === "once") {
        const d = new Date(p.slice(1).join("@"));
        if (!isNaN(d)) {
          const pad = (n) => String(n).padStart(2, "0");
          el.schOnce.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
      }
      if (t === "interval") {
        const sec = Number(p[1]) || 3600;
        if (sec % 3600 === 0) { el.schInt.value = sec / 3600; el.schIntUnit.value = "3600"; }
        else if (sec % 60 === 0) { el.schInt.value = sec / 60; el.schIntUnit.value = "60"; }
        else { el.schInt.value = sec; el.schIntUnit.value = "1"; }
      }
      syncScheduleUI();
    }

    /* ---------- 渲染 ---------- */
    function renderOverview() {
      el.cRunning.textContent = tasks.filter((t) => t.running).length;
      const today = GBSchema.localDateStr();
      const todayLogs = logs.filter((l) => String(l.t || "").slice(0, 10) === today);
      el.cToday.textContent = todayLogs.length;
      const done = logs.filter((l) => l.status === "success" || l.status === "failed");
      el.cRate.textContent = done.length
        ? Math.round((done.filter((l) => l.status === "success").length / done.length) * 100) + "%"
        : "—";
      const fail = logs.find((l) => l.status === "failed");
      el.cFail.textContent = fail ? (fail.name || fail.taskId) : "无";
      el.cFailTime.textContent = fail ? fmtTime(fail.t) : "";
    }

    function renderTasks() {
      el.list.innerHTML = tasks.length
        ? tasks.map((t) => `
          <div class="glass p-4" data-id="${esc(t.id)}">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-sm font-medium">${esc(t.name || "(未命名)")}</span>
              ${t.running ? '<span class="glass-sm px-2 py-0.5 text-xs text-accent">执行中…</span>' : ""}
              <span class="glass-sm px-2 py-0.5 text-xs ${t.enabled ? "text-accent" : "text-secondary"}">${t.enabled ? "启用" : "禁用"}</span>
              ${t.lastStatus ? `<span class="glass-sm px-2 py-0.5 text-xs ${t.lastStatus === "success" ? "text-green-500" : "text-red-500"}">${t.lastStatus === "success" ? "上次成功" : "上次失败"}</span>` : ""}
            </div>
            <p class="mt-1 text-xs text-secondary">
              ${esc(describeSchedule(t.schedule))} · ${esc(actionLabel(t.action))}
            </p>
            <p class="mt-0.5 text-xs text-secondary">
              下次执行：${esc(fmtTime(t.nextRunAt))}${t.lastRunAt ? " · 上次：" + esc(fmtTime(t.lastRunAt)) : ""}
            </p>
            <div class="mt-3 flex gap-2 flex-wrap text-xs">
              <button class="glass-sm px-3 py-1" data-op="toggle">${t.enabled ? "禁用" : "启用"}</button>
              <button class="glass-sm px-3 py-1 text-accent" data-op="run">立即执行</button>
              <button class="glass-sm px-3 py-1" data-op="edit">编辑</button>
              <button class="glass-sm px-3 py-1 text-red-500" data-op="del">删除</button>
            </div>
          </div>`).join("")
        : '<div class="glass p-6 text-center text-sm text-secondary">暂无任务，用右侧表单创建一个</div>';
    }

    function renderLogs() {
      el.logs.innerHTML = logs.length
        ? logs.map((l) => `
          <div class="glass-sm px-4 py-3">
            <div class="flex items-center gap-2 flex-wrap text-xs">
              <span class="${l.status === "success" ? "text-green-500" : "text-red-500"} font-medium">
                ${l.status === "success" ? "成功" : "失败"}</span>
              <span class="font-medium">${esc(l.name || l.taskId || "")}</span>
              <span class="text-secondary">${esc(actionLabel(l.action))}</span>
              <span class="glass-sm px-1.5 py-0.5 text-secondary">${esc(TRIGGER_LABEL[l.trigger] || l.trigger || "")}</span>
              ${l.attempts > 1 ? `<span class="text-secondary">尝试 ${l.attempts} 次</span>` : ""}
              <span class="ml-auto text-secondary">${esc(fmtTime(l.t))}</span>
            </div>
            ${l.error || l.result ? `
            <details class="mt-1.5 text-xs">
              <summary class="cursor-pointer text-secondary">详情</summary>
              ${l.error ? `<pre class="mt-1 whitespace-pre-wrap text-red-400">${esc(l.error)}</pre>` : ""}
              ${l.result ? `<pre class="mt-1 whitespace-pre-wrap text-secondary">${esc(l.result)}</pre>` : ""}
            </details>` : ""}
          </div>`).join("")
        : '<div class="text-sm text-secondary text-center py-4">暂无执行日志</div>';
    }

    /* ---------- 数据加载 ---------- */
    async function reload() {
      try {
        const [t, l] = await Promise.all([
          apiJSON("api/agent/tasks"),
          apiJSON("api/agent/logs?limit=100"),
        ]);
        tasks = t.tasks || [];
        logs = l.logs || [];
        el.logTotal.textContent = "共 " + (l.total || 0) + " 条";
        renderOverview();
        renderTasks();
        renderLogs();
      } catch (e) {
        el.list.innerHTML = `<div class="glass p-4 text-sm text-secondary">加载失败：${esc(e.message || e)}</div>`;
      }
    }

    /* ---------- 表单 ---------- */
    function resetForm() {
      editingId = null;
      el.formTitle.textContent = "新建任务";
      el.submit.textContent = "创建任务";
      el.cancel.classList.add("hidden");
      el.name.value = "";
      el.action.selectedIndex = 0;
      renderParamFields();
      el.schType.value = "daily";
      el.schTime.value = "09:00";
      el.retry.value = 0;
      el.retryDelay.value = 60;
      el.catchUp.checked = false;
      el.enabled.checked = true;
      syncScheduleUI();
    }

    function fillForm(t) {
      editingId = t.id;
      el.formTitle.textContent = "编辑任务";
      el.submit.textContent = "保存修改";
      el.cancel.classList.remove("hidden");
      el.name.value = t.name || "";
      el.action.value = t.action;
      renderParamFields();
      fillParams(t.action, t.params);
      parseScheduleIntoForm(t.schedule);
      el.retry.value = t.retry || 0;
      el.retryDelay.value = t.retryDelay || 60;
      el.catchUp.checked = !!t.catchUp;
      el.enabled.checked = t.enabled !== false;
    }

    async function submitForm() {
      let payload;
      try {
        payload = {
          name: el.name.value.trim(),
          action: el.action.value,
          params: collectParams(),
          schedule: buildSchedule(),
          retry: Math.max(0, Number(el.retry.value) || 0),
          retryDelay: Math.max(1, Number(el.retryDelay.value) || 60),
          catchUp: el.catchUp.checked,
          enabled: el.enabled.checked,
        };
        if (!payload.name) throw new Error("请填写任务名称");
      } catch (e) {
        alert(e.message);
        return;
      }
      el.submit.disabled = true;
      try {
        if (editingId) {
          await apiJSON("api/agent/tasks/" + encodeURIComponent(editingId), {
            method: "PUT", body: JSON.stringify(payload),
          });
        } else {
          await apiJSON("api/agent/tasks", { method: "POST", body: JSON.stringify(payload) });
        }
        resetForm();
        await reload();
      } catch (e) {
        alert((editingId ? "保存" : "创建") + "失败：" + (e.message || e));
      } finally {
        el.submit.disabled = false;
      }
    }

    /* ---------- 任务操作 ---------- */
    async function onTaskOp(id, op) {
      const t = tasks.find((x) => x.id === id);
      if (!t) return;
      try {
        if (op === "edit") { fillForm(t); return; }
        if (op === "del") {
          if (!confirm(`确定删除任务「${t.name || t.id}」？`)) return;
          await apiJSON("api/agent/tasks/" + encodeURIComponent(id), { method: "DELETE" });
          if (editingId === id) resetForm();
        } else if (op === "toggle") {
          await apiJSON("api/agent/tasks/" + encodeURIComponent(id), {
            method: "PUT", body: JSON.stringify({ enabled: !t.enabled }),
          });
        } else if (op === "run") {
          await apiJSON("api/agent/tasks/" + encodeURIComponent(id) + "/run", { method: "POST" });
          // 异步执行：稍候拉取日志与状态（重试场景再补拉一次）
          setTimeout(reload, 1500);
          setTimeout(reload, 5000);
        }
        await reload();
      } catch (e) {
        alert("操作失败：" + (e.message || e));
        await reload();
      }
    }

    /* ---------- 事件绑定 ---------- */
    function bindEvents() {
      el.refresh.addEventListener("click", reload);
      el.logRefresh.addEventListener("click", reload);
      el.action.addEventListener("change", renderParamFields);
      [el.schType, el.schWeek, el.schDay, el.schTime, el.schOnce, el.schInt, el.schIntUnit]
        .forEach((n) => n.addEventListener("input", syncScheduleUI));
      el.submit.addEventListener("click", submitForm);
      el.cancel.addEventListener("click", resetForm);
      el.list.addEventListener("click", (e) => {
        const b = e.target.closest("[data-op]");
        if (!b) return;
        const row = e.target.closest("[data-id]");
        if (row) onTaskOp(row.dataset.id, b.dataset.op);
      });
    }

    /* ---------- 挂钩：惰性构建 ---------- */
    function maybeBuild(tab) {
      if (tab !== "agent" || built) return;
      built = true;
      try { isApi = GB.isApi(); } catch (e) {}
      build();
      if (isApi) reload();
    }
    ctx.on("admin:ready", ({ isApi: api } = {}) => { isApi = !!api; });
    ctx.on("admin:tab", ({ tab } = {}) => maybeBuild(tab));
    maybeBuild(window.GB_ADMIN_TAB);
  },
});
