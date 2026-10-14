/* ============================================================
   GlassBlog 模块清单：按页登记要加载的模块
   "*"     = 所有页面都加载
   其余键  = 页面标识（GB.renderNav(key) 的 key）：home / blog / memos / apps / admin

   【如何添加新模块】
   1. 在本目录新建 xxx.js，文件内调用：GB.register("xxx", { init(ctx) { ... } })
   2. 在下方清单中按页登记模块名（无需改任何其他文件）
   ============================================================ */
window.GB_MODULES = {
  "*": ["back-to-top", "auth"], // 全站：回到顶部 + 全局认证
  blog: ["image-zoom"],         // 博客详情：正文图片灯箱
  memos: ["markdown", "image-zoom", "memos-list", "memos-detail"], // 备忘：原生渲染 + 灯箱 + 任务复选框 + 分享视图
  admin: ["markdown", "admin-memos", "admin-agent", "admin-bot"],  // 后台：原生渲染 + 备忘管理 + Agent 任务 + Bot 控制台
};
