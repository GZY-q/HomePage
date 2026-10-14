/* ============================================================
   模块：image-zoom 正文图片灯箱（博客详情页）
   点击文章正文 / 封面图片，全屏毛玻璃灯箱查看；
   点击图片外区域或按 ESC 关闭；移动端支持点击关闭
   ============================================================ */
GB.register("image-zoom", {
  init(ctx) {
    /* 灯箱 DOM（惰性创建一次） */
    let box = null, boxImg = null;
    function ensureBox() {
      if (box) return;
      box = document.createElement("div");
      box.className =
        "fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-10 cursor-zoom-out";
      box.style.background = "rgba(0,0,0,0.55)";
      box.style.backdropFilter = "blur(18px) saturate(160%)";
      box.style.webkitBackdropFilter = "blur(18px) saturate(160%)";
      boxImg = document.createElement("img");
      boxImg.alt = "";
      boxImg.className = "max-w-full max-h-full rounded-2xl shadow-2xl object-contain";
      box.appendChild(boxImg);
      box.addEventListener("click", close);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    }
    function open(src) {
      ensureBox();
      boxImg.src = src;
      document.body.appendChild(box);
      document.body.style.overflow = "hidden"; // 锁定背景滚动
    }
    function close() {
      box?.remove();
      document.body.style.overflow = "";
    }

    /* 绑定一组图片（去重：已绑定过的跳过） */
    function bindImgs(imgs) {
      imgs.forEach((img) => {
        if (img.dataset.gbZoom) return;
        img.dataset.gbZoom = "1";
        img.style.cursor = "zoom-in";
        img.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation(); // 防止触发外层卡片链接
          open(img.currentSrc || img.src);
        });
      });
    }

    // 页面在详情渲染完成时 emit("blog:detail", { post, body })，模块挂钩即可
    ctx.on("blog:detail", ({ body } = {}) => {
      if (body) bindImgs(body.querySelectorAll("img"));
      const cover = document.getElementById("dCover");
      if (cover && !cover.classList.contains("hidden")) bindImgs([cover]);
    });

    // 备忘录时间线图片同样支持灯箱
    ctx.on("memos:list", ({ container } = {}) => {
      if (container) bindImgs(container.querySelectorAll(".memo-body img"));
    });
    // 备忘录分享视图渲染完成后挂钩
    ctx.on("memos:detail:rendered", ({ body } = {}) => {
      if (body) bindImgs(body.querySelectorAll("img"));
    });
  },
});
