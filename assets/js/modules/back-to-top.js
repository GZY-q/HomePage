/* ============================================================
   模块：back-to-top 回到顶部（全站）
   滚动超过一屏后，右下角浮出玻璃圆形按钮，点击平滑回顶
   ============================================================ */
GB.register("back-to-top", {
  init() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "↑";
    btn.setAttribute("aria-label", "回到顶部");
    btn.className =
      "glass fixed right-5 z-40 w-10 h-10 !rounded-full flex items-center justify-center " +
      "text-sm text-secondary hover:text-accent opacity-0 pointer-events-none transition-all duration-300 translate-y-3";
    // 底部留出安全区（iPhone 横条），不遮挡系统手势
    btn.style.bottom = "calc(1.5rem + env(safe-area-inset-bottom, 0px))";
    document.body.appendChild(btn);

    let shown = false;
    const toggle = () => {
      const show = window.scrollY > window.innerHeight;
      if (show === shown) return;
      shown = show;
      btn.classList.toggle("opacity-0", !show);
      btn.classList.toggle("pointer-events-none", !show);
      btn.classList.toggle("translate-y-3", !show);
    };
    window.addEventListener("scroll", toggle, { passive: true });
    toggle();

    btn.onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
  },
});
