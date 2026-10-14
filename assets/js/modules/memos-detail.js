/* GlassBlog 模块：备忘录分享视图渲染
 * 职责：渲染 ?share=token&id=xxx 访问的单条备忘分享卡片
 *
 * 挂钩：GB.on("memos:detail", { memo, container })
 * 渲染完成后触发：GB.emit("memos:detail:rendered", { body, memo })（供 image-zoom 等模块接入）
 * 页面兜底：模块晚加载时从 window.GB_MEMOS.lastDetailPayload 补渲染
 */
GB.register("memos-detail", {
  init(ctx) {
    const esc = (s) => GB.esc(String(s == null ? "" : s));

    function fmtTime(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      return (
        d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0") + " " +
        String(d.getHours()).padStart(2, "0") + ":" +
        String(d.getMinutes()).padStart(2, "0")
      );
    }

    function render(payload) {
      if (!payload || !payload.container || !payload.memo) return;
      const { memo, container } = payload;
      const tags = (memo.tags || [])
        .map((t) => `<span class="chip">#${esc(t)}</span>`)
        .join(" ");
      const expire = memo.share && memo.share.expireAt
        ? `<p class="text-xs opacity-60 mt-4">本分享链接有效期至 ${esc(fmtTime(memo.share.expireAt))}</p>`
        : "";

      container.innerHTML = `
        <article class="glass rounded-2xl p-6 sm:p-8 fade-in">
          <div class="flex items-center gap-2 text-xs opacity-70 mb-4">
            <span class="chip on">分享</span>
            <time>${esc(fmtTime(memo.createdAt))}</time>
          </div>
          <div class="memo-body prose-glass leading-relaxed">${GB.mdLite(memo.content || "")}</div>
          ${tags ? `<div class="flex flex-wrap gap-1.5 mt-5">${tags}</div>` : ""}
          ${expire}
          <div class="mt-6 pt-4 border-t border-white/10 flex items-center justify-between">
            <a class="chip inline-block" href="memos.html">查看备忘时间线</a>
            <span class="text-xs opacity-50">由 GlassBlog 分享</span>
          </div>
        </article>`;

      const body = container.querySelector(".memo-body");
      body.querySelectorAll("img").forEach((img) => { img.loading = "lazy"; });
      GB.enhanceCode(body);
      GB.emit("memos:detail:rendered", { body, memo });
    }

    ctx.on("memos:detail", render);

    // 兜底：页面可能在模块加载前已发出 memos:detail
    if (window.GB_MEMOS && window.GB_MEMOS.lastDetailPayload) {
      render(window.GB_MEMOS.lastDetailPayload);
    }
  },
});
