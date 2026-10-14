/* GlassBlog 模块：备忘录时间线增强
 * 职责：
 *  1. 列表渲染后的二次增强（代码高亮等）
 *  2. Markdown 任务列表复选框点击切换（- [ ] / - [x]），自动保存
 *
 * 挂钩：GB.on("memos:list", { list, container, store, reload })
 * 页面兜底：模块晚加载时从 window.GB_MEMOS.lastListPayload 补渲染
 */
GB.register("memos-list", {
  init(ctx) {
    const esc = (s) => GB.esc(String(s == null ? "" : s));

    // 将源文中第 idx 个任务行（- [ ] / - [x]）的勾选态翻转，返回新源文
    function toggleTaskInSource(src, idx) {
      let n = -1;
      return String(src || "").replace(
        /^(\s*[-*]\s+\[)([ xX])(\])/gm,
        (match, pre, mark, post) => {
          n += 1;
          if (n !== idx) return match;
          return pre + (mark === " " ? "x" : " ") + post;
        }
      );
    }

    async function onToggle(cb) {
      const card = cb.closest(".memo-card");
      if (!card) return;
      const id = card.dataset.id;
      const rev = parseInt(card.dataset.rev || "1", 10);
      const idx = parseInt(cb.dataset.idx || "0", 10);
      const payload = (window.GB_MEMOS && window.GB_MEMOS.lastListPayload) || {};
      const store = payload.store;
      if (!store) return;

      // 未登录：回退勾选态并弹出登录框
      if (!GB.auth || !GB.auth.check()) {
        cb.checked = !cb.checked;
        GB.auth && GB.auth.requireLogin();
        return;
      }

      cb.disabled = true; // 保存期间防重复点击
      try {
        // 找到当前源文：优先用页面缓存的最新数据
        const list = (payload.list || []).concat((window.GB_MEMOS._allCache || []));
        let memo = list.find((m) => m.id === id);
        if (!memo && store.get) memo = await store.get(id);
        if (!memo) throw new Error("未找到备忘");

        const next = toggleTaskInSource(memo.content, idx);
        if (next === memo.content) return; // 未匹配到任务行
        const saved = await store.update(id, { content: next }, rev);
        card.dataset.rev = saved.rev;
      } catch (e) {
        cb.checked = !cb.checked; // 失败回退
        if (e && e.code === 409) {
          alert("该备忘已在其他地方被修改，正在刷新…");
          payload.reload && payload.reload();
        } else {
          alert("保存失败：" + (e.message || e));
        }
      } finally {
        cb.disabled = false;
      }
    }

    function bindCard(card) {
      if (card.dataset.gbTask) return; // 防重复绑定
      card.dataset.gbTask = "1";
      card.querySelectorAll(".memo-task-cb").forEach((cb) => {
        cb.addEventListener("change", () => onToggle(cb));
      });
    }

    function enhance(payload) {
      if (!payload || !payload.container) return;
      const { container } = payload;
      container.querySelectorAll(".memo-card").forEach(bindCard);
      GB.enhanceCode(container);
      container.querySelectorAll(".memo-body img").forEach((img) => {
        img.loading = "lazy";
      });
    }

    ctx.on("memos:list", enhance);

    // 兜底：页面可能在模块加载前已完成首次渲染
    if (window.GB_MEMOS && window.GB_MEMOS.lastListPayload) {
      enhance(window.GB_MEMOS.lastListPayload);
    }
  },
});
