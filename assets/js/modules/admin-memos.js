/* ============================================================
   模块：admin-memos 后台「备忘管理」Tab
   挂载点：admin.html <section id="tab-memos">
   挂钩：
     GB.on("admin:ready", { isApi })  —— 记录运行模式
     GB.on("admin:tab", { tab })      —— tab === "memos" 时惰性构建
   功能：快速发布、筛选列表、完整 Markdown 编辑器（三模/工具栏/快捷键/
        自动草稿/图片上传/rev 乐观锁冲突面板）、静态模式导入导出
   ============================================================ */
GB.register("admin-memos", {
  init(ctx) {
    const esc = (s) => GB.esc(String(s == null ? "" : s));
    let isApi = false;
    let built = false;

    /* ---------- 数据层 ---------- */
    // 下沉到 GB.store（store.js）双驱动：后端 /api/memos、静态 localStorage，
    // 与 memos.html 共用同一实现（v3 6.2）。isApi 仅用于本地 UI 降级判断。
    const store = GB.store.memos;

    /* ---------- 状态 ---------- */
    let all = [];            // 含归档的全量（客户端再分流）
    let cur = null;          // 正在编辑的备忘对象（null = 新建）
    let filter = { q: "", status: "all", tag: "" };

    /* ---------- DOM（构建后缓存） ---------- */
    let el = {};
    const $ = (k) => el[k];

    function build() {
      const root = document.getElementById("tab-memos");
      root.innerHTML = `
      <div class="grid lg:grid-cols-5 gap-5">
        <!-- 左列：快速发布 + 筛选 + 列表 -->
        <div class="lg:col-span-2 space-y-4">
          <div class="glass p-4">
            <textarea id="mmQuick" rows="3" placeholder="快速记录… 支持 Markdown（回车发布，Shift+回车换行）"
              class="glass-sm w-full px-3 py-2 text-sm bg-transparent outline-none resize-y"></textarea>
            <div class="mt-2 flex flex-wrap gap-2 items-center">
              <input id="mmQuickTags" placeholder="标签（逗号分隔，可空）"
                class="glass-sm flex-1 min-w-[8rem] px-3 py-1.5 text-xs bg-transparent outline-none" />
              <select id="mmQuickVis" class="glass-sm px-2 py-1.5 text-xs bg-transparent outline-none">
                <option value="private">私密</option>
                <option value="public">公开</option>
              </select>
              <button id="mmQuickBtn" class="glass-sm glass-hover px-3 py-1.5 text-xs text-accent">发布</button>
            </div>
          </div>

          <input id="mmSearch" placeholder="搜索备忘…"
            class="glass-sm w-full px-4 py-2 text-sm bg-transparent outline-none" />
          <div class="flex gap-1.5 flex-wrap" id="mmStatusChips">
            <button class="chip on" data-s="all">全部</button>
            <button class="chip" data-s="public">公开</button>
            <button class="chip" data-s="private">私密</button>
            <button class="chip" data-s="archived">归档</button>
          </div>
          <select id="mmTagSel" class="glass-sm w-full px-3 py-2 text-sm bg-transparent outline-none">
            <option value="">全部标签</option>
          </select>
          <div id="mmStaticIO" class="hidden glass p-3 text-xs space-y-2">
            <p class="text-secondary">静态演示模式：备忘仅保存在本机浏览器，可导出备份。</p>
            <div class="flex gap-2">
              <button id="mmExport" class="glass-sm glass-hover px-3 py-1.5">导出备忘 JSON</button>
              <button id="mmImport" class="glass-sm glass-hover px-3 py-1.5">导入备忘 JSON</button>
              <input id="mmImportFile" type="file" accept=".json,application/json" class="hidden" />
            </div>
          </div>
          <div id="mmList" class="space-y-3"></div>
        </div>

        <!-- 右列：编辑器 -->
        <div class="lg:col-span-3">
          <div class="glass p-5">
            <div class="flex items-center gap-2 flex-wrap">
              <input id="mmTags" placeholder="标签（逗号分隔）"
                class="glass-sm flex-1 min-w-[10rem] px-3 py-2 text-sm bg-transparent outline-none" />
              <select id="mmVis" class="glass-sm px-3 py-2 text-sm bg-transparent outline-none">
                <option value="private">私密</option>
                <option value="public">公开</option>
              </select>
              <label class="glass-sm px-3 py-2 text-xs flex items-center gap-1.5 cursor-pointer">
                <input id="mmPinned" type="checkbox" class="accent-current" /> 置顶
              </label>
              <label class="glass-sm px-3 py-2 text-xs flex items-center gap-1.5 cursor-pointer">
                <input id="mmArchived" type="checkbox" class="accent-current" /> 归档
              </label>
            </div>

            <!-- Markdown 工具栏 -->
            <div id="mmToolbar" class="md-toolbar mt-3">
              <button data-act="bold" title="加粗 ⌘B"><b>B</b></button>
              <button data-act="italic" title="斜体 ⌘I"><i>I</i></button>
              <button data-act="strike" title="删除线"><s>S</s></button>
              <span class="md-sep"></span>
              <button data-act="h2" title="标题">H2</button>
              <button data-act="quote" title="引用">❝</button>
              <span class="md-sep"></span>
              <button data-act="ul" title="无序列表">• 列表</button>
              <button data-act="ol" title="有序列表">1. 列表</button>
              <button data-act="task" title="任务列表">☑ 任务</button>
              <span class="md-sep"></span>
              <button data-act="code" title="行内代码">&lt;/&gt;</button>
              <button data-act="codeblock" title="代码块">{ }</button>
              <button data-act="table" title="表格">⊞</button>
              <span class="md-sep"></span>
              <button data-act="link" title="链接 ⌘K">🔗</button>
              <button data-act="image" title="插入图片">🖼</button>
              <span class="flex-1"></span>
              <div id="mmViewBtns" class="inline-flex gap-1">
                <button class="md-view-btn on" data-v="edit">编辑</button>
                <button class="md-view-btn" data-v="split">分屏</button>
                <button class="md-view-btn" data-v="preview">预览</button>
              </div>
            </div>

            <div id="mmSplit" class="grid gap-0">
              <div id="mmLeft">
                <textarea id="mmContent" rows="16" placeholder="备忘内容，支持 Markdown…（⌘S 保存）"
                  class="md-editor-area w-full px-4 py-3 text-sm bg-transparent outline-none resize-y"></textarea>
              </div>
              <div id="mmPreview" class="hidden prose-glass text-sm leading-relaxed border border-[var(--glass-border)] rounded-b-2xl px-4 py-3 min-h-[16rem]"></div>
            </div>

            <input id="mmImageInput" type="file" accept="image/*" multiple class="hidden" />

            <!-- 乐观锁冲突面板 -->
            <div id="mmConflict" class="hidden mt-3 glass-sm p-4 text-sm border border-red-400/40">
              <p class="text-red-400 font-medium">保存冲突：该备忘已在其他地方被修改。</p>
              <p class="mt-1 text-xs text-secondary">服务端最新内容预览：</p>
              <pre id="mmConflictBody" class="mt-1 max-h-32 overflow-auto text-xs whitespace-pre-wrap opacity-80"></pre>
              <div class="mt-3 flex gap-2 text-xs">
                <button id="mmConflictLoad" class="glass-sm glass-hover px-3 py-1.5">放弃本地修改，载入服务端版本</button>
                <button id="mmConflictForce" class="glass-sm glass-hover px-3 py-1.5 text-red-400">以我的内容覆盖服务端</button>
              </div>
            </div>

            <div class="mt-3 flex items-center gap-3 text-xs text-secondary">
              <span id="mmWordCount">0 字</span>
              <span id="mmMeta"></span>
              <span class="flex-1"></span>
              <button id="mmNew" class="glass-sm glass-hover px-3 py-1.5">新建</button>
              <button id="mmSave" class="glass-sm glass-hover px-4 py-1.5 text-accent font-medium">保存 ⌘S</button>
            </div>
          </div>
        </div>
      </div>`;

      el = {
        quick: root.querySelector("#mmQuick"),
        quickTags: root.querySelector("#mmQuickTags"),
        quickVis: root.querySelector("#mmQuickVis"),
        quickBtn: root.querySelector("#mmQuickBtn"),
        search: root.querySelector("#mmSearch"),
        statusChips: root.querySelector("#mmStatusChips"),
        tagSel: root.querySelector("#mmTagSel"),
        staticIO: root.querySelector("#mmStaticIO"),
        export: root.querySelector("#mmExport"),
        import: root.querySelector("#mmImport"),
        importFile: root.querySelector("#mmImportFile"),
        list: root.querySelector("#mmList"),
        tags: root.querySelector("#mmTags"),
        vis: root.querySelector("#mmVis"),
        pinned: root.querySelector("#mmPinned"),
        archived: root.querySelector("#mmArchived"),
        toolbar: root.querySelector("#mmToolbar"),
        viewBtns: root.querySelector("#mmViewBtns"),
        split: root.querySelector("#mmSplit"),
        left: root.querySelector("#mmLeft"),
        content: root.querySelector("#mmContent"),
        preview: root.querySelector("#mmPreview"),
        imageInput: root.querySelector("#mmImageInput"),
        conflict: root.querySelector("#mmConflict"),
        conflictBody: root.querySelector("#mmConflictBody"),
        conflictLoad: root.querySelector("#mmConflictLoad"),
        conflictForce: root.querySelector("#mmConflictForce"),
        wordCount: root.querySelector("#mmWordCount"),
        meta: root.querySelector("#mmMeta"),
        newBtn: root.querySelector("#mmNew"),
        saveBtn: root.querySelector("#mmSave"),
      };
      bindEvents();
      el.staticIO.classList.toggle("hidden", isApi);
    }

    /* ---------- Markdown 编辑辅助 ---------- */
    function mdWrap(before, after = "", placeholder = "") {
      const ta = el.content;
      const { selectionStart: s, selectionEnd: e, value: v } = ta;
      const sel = v.slice(s, e) || placeholder;
      ta.value = v.slice(0, s) + before + sel + after + v.slice(e);
      ta.selectionStart = s + before.length;
      ta.selectionEnd = s + before.length + sel.length;
      ta.focus();
      onContentInput();
    }
    function mdLine(prefix) {
      const ta = el.content;
      const { selectionStart: s, value: v } = ta;
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      ta.value = v.slice(0, lineStart) + prefix + v.slice(lineStart);
      ta.selectionStart = ta.selectionEnd = s + prefix.length;
      ta.focus();
      onContentInput();
    }
    const MD_ACTIONS = {
      bold: () => mdWrap("**", "**", "加粗文字"),
      italic: () => mdWrap("*", "*", "斜体文字"),
      strike: () => mdWrap("~~", "~~", "删除线"),
      h2: () => mdLine("## "),
      quote: () => mdLine("> "),
      ul: () => mdLine("- "),
      ol: () => mdLine("1. "),
      task: () => mdLine("- [ ] "),
      code: () => mdWrap("`", "`", "代码"),
      codeblock: () => mdWrap("\n```\n", "\n```\n", "代码"),
      table: () =>
        mdWrap("\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| ", " |  |  |\n", "内容"),
      link: () => mdWrap("[", "](https://)", "链接文字"),
      image: () => el.imageInput.click(),
    };

    /* ---------- 视图三模切换 ---------- */
    function setMdView(v) {
      el.viewBtns.querySelectorAll(".md-view-btn").forEach((b) =>
        b.classList.toggle("on", b.dataset.v === v));
      const showEdit = v !== "preview", showPrev = v !== "edit";
      el.left.classList.toggle("hidden", !showEdit);
      el.preview.classList.toggle("hidden", !showPrev);
      el.split.classList.toggle("md:grid-cols-2", showEdit && showPrev);
      if (showPrev) renderPreview();
    }
    function renderPreview() {
      el.preview.innerHTML = GB.mdLite(el.content.value);
      GB.enhanceCode(el.preview);
    }

    /* ---------- 自动草稿（防抖 500ms） ---------- */
    const DRAFT_KEY = () => "gb_memo_draft_" + (cur ? cur.id : "new");
    let draftTimer;
    function onDraftInput() {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(saveDraft, 500);
    }
    function saveDraft() {
      try {
        localStorage.setItem(DRAFT_KEY(), JSON.stringify({
          content: el.content.value, tags: el.tags.value,
          vis: el.vis.value, pinned: el.pinned.checked, archived: el.archived.checked,
        }));
      } catch (e) {}
    }
    function loadDraft() {
      try {
        const d = JSON.parse(localStorage.getItem(DRAFT_KEY()) || "null");
        if (!d) return false;
        // 编辑已有备忘时，草稿比服务端新才提示恢复
        if (d.content && d.content !== el.content.value &&
            confirm("检测到未保存的草稿，是否恢复？")) {
          el.content.value = d.content || "";
          el.tags.value = d.tags || "";
          el.vis.value = d.vis || "private";
          el.pinned.checked = !!d.pinned;
          el.archived.checked = !!d.archived;
          onContentInput();
          return true;
        }
      } catch (e) {}
      return false;
    }
    function clearDraft() {
      try { localStorage.removeItem(DRAFT_KEY()); } catch (e) {}
    }

    function onContentInput() {
      el.wordCount.textContent = el.content.value.length + " 字";
      if (!el.preview.classList.contains("hidden")) renderPreview();
      onDraftInput();
    }

    /* ---------- 编辑器载入 / 保存 ---------- */
    function loadEditor(m) {
      cur = m || null;
      el.conflict.classList.add("hidden");
      if (m) {
        el.tags.value = (m.tags || []).join(", ");
        el.vis.value = m.visibility || "private";
        el.pinned.checked = !!m.pinned;
        el.archived.checked = !!m.archived;
        el.content.value = m.content || "";
        el.meta.textContent =
          "id: " + m.id + " · rev " + (m.rev || 1) + " · 更新于 " + GB.fmtDate(m.updatedAt);
      } else {
        el.tags.value = "";
        el.vis.value = "private";
        el.pinned.checked = false;
        el.archived.checked = false;
        el.content.value = "";
        el.meta.textContent = "新备忘";
      }
      loadDraft();
      onContentInput();
      el.content.focus();
    }

    function fieldsFromEditor() {
      return {
        content: el.content.value,
        tags: el.tags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        visibility: el.vis.value,
        pinned: el.pinned.checked,
        archived: el.archived.checked,
      };
    }

    async function saveMemo() {
      const fields = fieldsFromEditor();
      if (!fields.content.trim()) { alert("内容不能为空"); return; }
      el.saveBtn.disabled = true;
      try {
        if (cur) {
          const saved = await store.update(cur.id, fields, cur.rev);
          cur = saved;
          clearDraft();
          el.meta.textContent =
            "id: " + saved.id + " · rev " + saved.rev + " · 更新于 " + GB.fmtDate(saved.updatedAt);
        } else {
          const saved = await store.create(fields);
          clearDraft();
          cur = saved;
        }
        el.conflict.classList.add("hidden");
        await reload();
      } catch (e) {
        if (e && e.code === 409) {
          showConflict(e);
        } else {
          alert("保存失败：" + (e.message || e));
        }
      } finally {
        el.saveBtn.disabled = false;
      }
    }

    function showConflict(e) {
      const server = e.serverMemo;
      el.conflictBody.textContent = server ? server.content : "（服务端 rev 已更新，可在刷新后查看最新内容）";
      el.conflict.classList.remove("hidden");
      // 以本地内容覆盖：改用服务端 rev 再保存一次
      el.conflictForce.onclick = async () => {
        try {
          const saved = await store.update(cur.id, fieldsFromEditor(), e.rev);
          cur = saved;
          clearDraft();
          el.conflict.classList.add("hidden");
          await reload();
          el.meta.textContent =
            "id: " + saved.id + " · rev " + saved.rev + " · 更新于 " + GB.fmtDate(saved.updatedAt);
        } catch (e2) {
          alert("覆盖失败：" + (e2.message || e2));
        }
      };
      el.conflictLoad.onclick = async () => {
        if (server) { loadEditor(server); return; }
        await reload();
        const m = all.find((x) => x.id === cur.id);
        if (m) loadEditor(m);
      };
    }

    /* ---------- 图片上传（选择 / 粘贴 / 拖拽） ---------- */
    async function insertImages(files) {
      for (const f of files) {
        if (!f.type.startsWith("image/")) continue;
        const ph = `![上传中 ${f.name}…]()`;
        mdWrap(ph, "");
        try {
          const { url } = await GB.upload(f, "images");
          el.content.value = el.content.value.replace(ph, `![${f.name}](${url})`);
        } catch (e) {
          el.content.value = el.content.value.replace(ph, "");
          alert("图片上传失败：" + e.message);
        }
        onContentInput();
      }
    }

    /* ---------- 列表渲染 ---------- */
    function stripMd(s) {
      return String(s || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[#>*`~|-]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    function fmtTime(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      return (
        d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0") + " " + String(d.getHours()).padStart(2, "0") +
        ":" + String(d.getMinutes()).padStart(2, "0")
      );
    }

    function filtered() {
      return all
        .filter((m) => {
          if (filter.status === "archived") { if (!m.archived) return false; }
          else if (filter.status === "all") { if (m.archived) return false; }
          else if (m.visibility !== filter.status || m.archived) return false;
          if (filter.tag && !(m.tags || []).includes(filter.tag)) return false;
          if (filter.q) {
            const q = filter.q.toLowerCase();
            if ((m.content || "").toLowerCase().indexOf(q) < 0) return false;
          }
          return true;
        })
        .sort((a, b) => {
          if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
          return new Date(b.createdAt) - new Date(a.createdAt);
        });
    }

    function renderList() {
      const list = filtered();
      el.list.innerHTML = list.length
        ? list.map((m) => `
          <div class="glass p-4 ${cur && cur.id === m.id ? "ring-1 ring-[var(--accent)]" : ""}" data-id="${esc(m.id)}">
            <div class="flex items-center gap-1.5 flex-wrap">
              ${m.pinned ? '<span class="glass-sm px-2 py-0.5 text-xs text-accent">置顶</span>' : ""}
              <span class="glass-sm px-2 py-0.5 text-xs ${m.visibility === "public" ? "text-accent" : "text-secondary"}">
                ${m.visibility === "public" ? "公开" : "私密"}</span>
              ${m.archived ? '<span class="glass-sm px-2 py-0.5 text-xs text-secondary">已归档</span>' : ""}
              <span class="text-xs text-secondary ml-auto">${esc(fmtTime(m.createdAt))}</span>
            </div>
            <p class="mt-1.5 text-sm leading-snug line-clamp-2">${esc(stripMd(m.content).slice(0, 80)) || "（空）"}</p>
            ${(m.tags || []).length ? `<div class="mt-1 text-xs text-secondary">${m.tags.map((t) => "#" + esc(t)).join(" ")}</div>` : ""}
            <div class="mt-3 flex gap-2 flex-wrap text-xs">
              <button class="glass-sm px-3 py-1" data-op="edit">编辑</button>
              <button class="glass-sm px-3 py-1" data-op="pin">${m.pinned ? "取消置顶" : "置顶"}</button>
              <button class="glass-sm px-3 py-1" data-op="archive">${m.archived ? "取消归档" : "归档"}</button>
              <button class="glass-sm px-3 py-1" data-op="vis">${m.visibility === "public" ? "设为私密" : "设为公开"}</button>
              <button class="glass-sm px-3 py-1" data-op="share">分享</button>
              <button class="glass-sm px-3 py-1 text-red-500" data-op="del">删除</button>
            </div>
          </div>`).join("")
        : '<div class="glass p-6 text-center text-sm text-secondary">没有匹配的备忘</div>';
    }

    function renderTagSel() {
      const set = new Set();
      all.forEach((m) => (m.tags || []).forEach((t) => set.add(t)));
      const opts = ['<option value="">全部标签</option>'].concat(
        [...set].sort().map((t) => `<option value="${esc(t)}"${filter.tag === t ? " selected" : ""}>#${esc(t)}</option>`));
      el.tagSel.innerHTML = opts.join("");
    }

    async function reload() {
      try {
        all = await store.list({ archived: true });
        renderTagSel();
        renderList();
      } catch (e) {
        el.list.innerHTML = `<div class="glass p-4 text-sm text-secondary">加载失败：${esc(e.message || e)}</div>`;
      }
    }

    /* ---------- 快速发布 ---------- */
    async function quickPublish() {
      const content = el.quick.value.trim();
      if (!content) { el.quick.focus(); return; }
      const tags = el.quickTags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      el.quickBtn.disabled = true;
      try {
        await store.create({ content, tags, visibility: el.quickVis.value });
        el.quick.value = "";
        el.quickTags.value = "";
        await reload();
      } catch (e) {
        alert("发布失败：" + (e.message || e));
      } finally {
        el.quickBtn.disabled = false;
      }
    }

    /* ---------- 列表操作 ---------- */
    async function onListOp(id, op) {
      const m = all.find((x) => x.id === id);
      if (!m) return;
      try {
        if (op === "edit") { loadEditor(m); return; }
        if (op === "del") {
          if (!confirm("确定删除这条备忘？")) return;
          await store.del(id);
          if (cur && cur.id === id) loadEditor(null);
        } else if (op === "pin") {
          await store.update(id, { pinned: !m.pinned }, m.rev);
        } else if (op === "archive") {
          await store.update(id, { archived: !m.archived }, m.rev);
        } else if (op === "vis") {
          await store.update(id, { visibility: m.visibility === "public" ? "private" : "public" }, m.rev);
        } else if (op === "share") {
          const d = await store.share(id, 72);
          if (!d) { alert("静态托管模式下不支持分享（无服务端令牌校验），可改用「导入/导出」迁移数据。"); return; }
          const url = location.origin + location.pathname.replace(/[^/]*$/, "") + d.url.replace(/^\//, "");
          try { await navigator.clipboard.writeText(url); alert("分享链接已复制（72 小时有效）：\n" + url); }
          catch (e2) { prompt("分享链接（72 小时有效）：", url); }
          return;
        }
        await reload();
      } catch (e) {
        if (e && e.code === 409) alert("该备忘已在其他地方被修改，正在刷新…");
        else alert("操作失败：" + (e.message || e));
        await reload();
      }
    }

    /* ---------- 静态模式导入 / 导出 ---------- */
    function exportMemos() {
      const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "memos-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
    }
    async function importMemos(file) {
      try {
        const arr = JSON.parse(await file.text());
        if (!Array.isArray(arr)) throw new Error("JSON 必须是备忘数组");
        if (!confirm(`将导入 ${arr.length} 条备忘（按 id 合并，同 id 覆盖）。继续？`)) return;
        const c = await GB.load();
        const map = new Map((c.memos || []).map((m) => [m.id, m]));
        arr.forEach((m) => {
          const n = GBSchema.normalizeMemo(m);
          map.set(n.id, n);
        });
        c.memos = [...map.values()];
        await GB.save(c);
        await reload();
      } catch (e) {
        alert("导入失败：" + (e.message || e));
      }
    }

    /* ---------- 事件绑定 ---------- */
    function bindEvents() {
      el.quickBtn.addEventListener("click", quickPublish);
      el.quick.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); quickPublish(); }
      });
      el.search.addEventListener("input", () => { filter.q = el.search.value.trim(); renderList(); });
      el.statusChips.addEventListener("click", (e) => {
        const b = e.target.closest("[data-s]");
        if (!b) return;
        el.statusChips.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b));
        filter.status = b.dataset.s;
        renderList();
      });
      el.tagSel.addEventListener("change", () => { filter.tag = el.tagSel.value; renderList(); });

      el.list.addEventListener("click", (e) => {
        const b = e.target.closest("[data-op]");
        if (!b) return;
        const id = e.target.closest("[data-id]").dataset.id;
        onListOp(id, b.dataset.op);
      });

      el.toolbar.addEventListener("click", (e) => {
        const b = e.target.closest("[data-act]");
        if (b) { e.preventDefault(); MD_ACTIONS[b.dataset.act] && MD_ACTIONS[b.dataset.act](); }
      });
      el.viewBtns.addEventListener("click", (e) => {
        const b = e.target.closest(".md-view-btn");
        if (b) setMdView(b.dataset.v);
      });
      el.content.addEventListener("input", onContentInput);
      el.content.addEventListener("keydown", (e) => {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && !e.shiftKey) {
          const k = e.key.toLowerCase();
          if (k === "b") { e.preventDefault(); MD_ACTIONS.bold(); }
          else if (k === "i") { e.preventDefault(); MD_ACTIONS.italic(); }
          else if (k === "k") { e.preventDefault(); MD_ACTIONS.link(); }
          else if (k === "s") { e.preventDefault(); saveMemo(); }
        } else if (e.key === "Tab") {
          e.preventDefault(); mdWrap("  ", "");
        }
      });
      [el.tags, el.vis, el.pinned, el.archived].forEach((x) =>
        x.addEventListener("change", onDraftInput));
      el.tags.addEventListener("input", onDraftInput);

      el.imageInput.addEventListener("change", () => {
        insertImages(el.imageInput.files);
        el.imageInput.value = "";
      });
      el.content.addEventListener("paste", (e) => {
        const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
        if (files.length) { e.preventDefault(); insertImages(files); }
      });
      el.content.addEventListener("dragover", (e) => e.preventDefault());
      el.content.addEventListener("drop", (e) => {
        const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
        if (files.length) { e.preventDefault(); insertImages(files); }
      });

      el.newBtn.addEventListener("click", () => loadEditor(null));
      el.saveBtn.addEventListener("click", saveMemo);

      el.export.addEventListener("click", exportMemos);
      el.import.addEventListener("click", () => el.importFile.click());
      el.importFile.addEventListener("change", () => {
        if (el.importFile.files[0]) importMemos(el.importFile.files[0]);
        el.importFile.value = "";
      });
    }

    /* ---------- 挂钩：惰性构建 ---------- */
    // 注意：模块异步加载完成时 admin:ready / 首次 admin:tab 可能已发过，
    // 构建时以 GB.isApi() 实测为准，并依据 window.GB_ADMIN_TAB 补构建
    function maybeBuild(tab) {
      if (tab !== "memos" || built) return;
      built = true;
      try { isApi = GB.isApi(); } catch (e) {}
      build();
      loadEditor(null);
      reload();
    }
    ctx.on("admin:ready", ({ isApi: api } = {}) => { isApi = !!api; });
    ctx.on("admin:tab", ({ tab } = {}) => maybeBuild(tab));
    maybeBuild(window.GB_ADMIN_TAB);
  },
});
