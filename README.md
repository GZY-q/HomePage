# GlassBlog

极简苹果液态玻璃（Glassmorphism）风格的个人主页 + 博客 + 软件发布站。
技术栈：HTML + TailwindCSS（已本地化为 `assets/js/tailwind.min.js`，无外部 CDN 依赖）+ 原生 JavaScript + 零依赖 Node.js 后端。
内容管理思路参考 Hexo / Astro / VitePress 的「内容即数据」理念——所有内容集中在 `data/content.json`；
RSS 生成参考 Hexo、访问统计参考 Umami/Plausible 的隐私友好做法（仅路径计数、无 Cookie、IP 去重）。
后台编辑器参考 [Memos](https://github.com/usememos/memos) 的轻量 Markdown 编辑体验；文章管理参考 WordPress / Halo / Ghost
（搜索、状态筛选、标签快选、封面与摘要）。现成轮子全部走 CDN：marked（解析）+ DOMPurify（XSS 消毒）+
highlight.js（代码高亮，仅页面含代码块时按需懒加载，主题用 CSS 变量自适应深浅色，零额外请求）。

## 功能亮点

**后台 · Memos 风格 Markdown 编辑器**

- 工具栏快捷插入（加粗/斜体/标题/列表/代码块/表格/链接/图片等 14 项）
- 快捷键：`⌘/Ctrl + B` 加粗、`+ I` 斜体、`+ K` 链接、`+ S` 保存；`Tab` 缩进两空格
- **直接粘贴 / 拖拽图片到编辑区即自动上传并插入 Markdown**（后端模式）
- 编辑 / 分屏 / 预览 三视图切换，预览经 DOMPurify 消毒，代码块自动高亮 + 一键复制
- 自动草稿：输入防抖 500ms 存 localStorage，意外关闭后重开可一键恢复
- 实时字数统计与预计阅读时间（中文 400 字/分钟、英文 200 词/分钟）

**后台 · 文章管理**

- 标题搜索 + 全部/已发布/草稿/已下架 状态筛选
- 已有标签 chips 一键点选填入；封面图 URL 或本地上传（带预览）；摘要留空自动生成

**前台 · 博客页**

- 文章搜索（标题/摘要/正文，`/` 键快速聚焦）、标签筛选 chips、阅读时间、封面图（懒加载）
- 文章页代码高亮 + 复制按钮，渲染统一走 DOMPurify 消毒
- 文章详情页：阅读进度条、宽屏 TOC 目录（IntersectionObserver scroll-spy 高亮当前小节）、
  上一篇/下一篇、同标签相关文章推荐、复制直链按钮、正文图片懒加载、动态 `document.title` 与 meta description
- 归档视图：按年月分组的时间线，与列表视图一键切换
- SEO 友好链接：每篇文章有 `blog.html?p=文章ID` 直链（hash 路由页内跳转、query 路由对外分享）

**SEO 与数据安全**

- `/sitemap.xml`（已发布文章 + 三个主页面，60 秒缓存）与 `/robots.txt`（屏蔽后台、声明 sitemap）
- 三页均有 description / OG meta；RSS 输出全文（`content:encoded`，服务端零依赖 Markdown 渲染）且链接为 `?p=` 直链
- 玻璃风 404 页：页面类请求 404 时自动回退渲染 `404.html`，资源类请求保持纯文本 404
- 后台「个人信息」页内置数据备份：整站 JSON 导出下载、导入恢复（结构校验 + 二次确认）、一键恢复默认
- 服务端每次保存前自动备份 `data/backups/`（保留 20 份），双保险

支持两种运行模式，**自动探测，无需任何配置**：

| 模式 | 启动方式 | 数据保存 | 文件上传 | 适用 |
| --- | --- | --- | --- | --- |
| 后端模式 | `node server.js` | 服务端 `data/content.json`（多端同步） | 真实上传到服务器 | 自用正式版 |
| 静态模式 | 任意静态服务器 | 浏览器 localStorage（仅本机演示） | 临时 blob/dataURL 链接 | 纯静态托管演示 |

## 目录结构

```
├── index.html            # 前台 · 个人主页
├── blog.html             # 前台 · 博客列表 + 归档 + 文章详情（hash / ?p= 双路由）
├── apps.html             # 前台 · 软件发布下载页
├── 404.html              # 玻璃风 404 页（server.js 对页面类 404 自动回退）
├── admin.html            # 后台管理系统（文章/软件/个人信息/访问统计）
├── server.js             # 零依赖 Node 后端（静态服务 + API + 上传 + 认证 + 统计 + RSS）
├── assets/
│   ├── css/glass.css     # 液态玻璃主题核心（所有样式参数集中在顶部 CSS 变量）
│   └── js/
│       ├── common.js         # 公共逻辑：主题、双模式数据、认证、上传、访问上报、导航、模块系统（register/on/emit）
│       ├── tailwind.min.js   # Tailwind 运行时（本地化，已移除生产警告；升级时从 cdn.tailwindcss.com 下载同名替换）
│       └── modules/          # 功能模块目录（框架化扩展点，见「模块化开发指南」）
│           ├── index.js          # 模块清单：按页登记要加载的模块
│           ├── back-to-top.js    # 内置模块：回到顶部按钮（全站）
│           └── image-zoom.js     # 内置模块：正文图片灯箱（博客详情页）
├── data/
│   ├── content.json      # 内容数据源（个人资料 / 文章 / 软件项目）
│   ├── sessions.json     # 登录令牌（运行时自动生成，勿入库）
│   ├── stats.json        # 访问统计（运行时自动生成，勿入库）
│   └── backups/          # 内容自动备份（每次保存前一份，保留 20 份）
├── uploads/              # 后台上传的图片（截图/头像）
├── downloads/            # 软件安装包
└── deploy/               # Ubuntu 生产部署件（systemd / Caddy / Nginx）
```

## 本地运行

**后端模式（推荐，支持真实上传与多端同步）：**

```bash
node server.js
# 打开 http://127.0.0.1:8899
```

**静态模式（仅演示）：**

```bash
python3 -m http.server 8899
```

后台入口：`/admin.html`，默认账号 `admin`，密码 `glass123`。

环境变量（均有默认值）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8899` | 监听端口 |
| `ADMIN_USER` | `admin` | 管理账号 |
| `ADMIN_PASS` | `glass123` | 管理密码（生产必改） |
| `SITE_URL` | `http://localhost:8899` | 站点对外 URL（用于 RSS / Sitemap / robots 链接） |
| `TOKEN_TTL_DAYS` | `30` | 登录令牌有效期（天），活跃自动续期 |

## 后端 API

| 接口 | 说明 | 鉴权 |
| --- | --- | --- |
| `POST /api/login` | 登录，body `{user, pass}`，返回 `{token}`；同 IP 连错 5 次锁 10 分钟（429） | 否 |
| `POST /api/logout` | 注销并销毁令牌 | Bearer token |
| `GET /api/content` | 读取全部内容 | 否 |
| `PUT /api/content` | 保存全部内容（先备份再原子写入） | Bearer token |
| `POST /api/upload?dir=images\|packages&name=文件名` | 原始字节上传，返回 `{url, size}` | Bearer token |
| `POST /api/hit` | 访问上报，body `{path}`（同 IP 同页 30 分钟去重，保留 90 天） | 否 |
| `GET /api/stats` | 近 30 天聚合统计 `{days, total, pages[]}` | Bearer token |
| `GET /api/health` | 健康检查 `{ok, uptime}` | 否 |
| `GET /rss.xml` | RSS 2.0 订阅源（仅已发布文章，含 `content:encoded` 全文，60 秒缓存） | 否 |
| `GET /sitemap.xml` | XML 站点地图（主页/博客/软件页 + 全部已发布文章 `?p=` 直链，60 秒缓存） | 否 |
| `GET /robots.txt` | 爬虫协议（允许全站、屏蔽 `/admin.html`、声明 Sitemap） | 否 |

上传位置：图片 → `uploads/`，安装包 → `downloads/`，文件名自动加时间戳防重名。
白名单与上限：图片 `.png .jpg .jpeg .gif .webp .svg` ≤ 20MB；安装包 `.zip .dmg .exe .msi .gz .7z .apk` ≤ 500MB。

内置安全与性能：令牌 30 天滑动过期、登录防爆破、安全响应头、gzip 压缩、静态资源缓存分级、
目录穿越与敏感路径（`/data/`、`/server.js`）拦截、写入前自动备份、SIGTERM 优雅落盘退出。

## Ubuntu 云服务器部署（生产推荐）

架构：`systemd 守护 Node 服务（127.0.0.1:8899） + Caddy/Nginx 反向代理（自动 HTTPS）`。

### 1. 准备环境

```bash
# Node.js 18+（Ubuntu 22.04/24.04）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 上传代码
sudo mkdir -p /opt/glassblog && sudo chown $USER /opt/glassblog
cd /opt/glassblog && git clone <你的仓库> .
# 或用 scp/rsync 把本地目录传上去
```

### 2. 配置 systemd 守护

```bash
sudo cp deploy/glassblog.service /etc/systemd/system/
sudo nano /etc/systemd/system/glassblog.service
# 必改：ADMIN_PASS（强密码）、SITE_URL（你的域名）
# 确保运行账号对目录可写：
sudo chown -R www-data:www-data /opt/glassblog

sudo systemctl daemon-reload
sudo systemctl enable --now glassblog
journalctl -u glassblog -f   # 查看日志，确认 listening
```

### 3. 反向代理 + HTTPS（二选一）

**Caddy（推荐，自动申请/续期证书）：**

```bash
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile    # 把 blog.example.com 改成你的域名
sudo systemctl reload caddy
```

**Nginx + certbot：**

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/glassblog
sudo ln -s /etc/nginx/sites-available/glassblog /etc/nginx/sites-enabled/
sudo nano /etc/nginx/sites-available/glassblog   # 改域名
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d blog.example.com          # 自动签发并配置 HTTPS
```

### 4. 防火墙

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # 或 Caddy: sudo ufw allow 80,443/tcp
sudo ufw enable
# 8899 只监听本机回环，无需对外开放
```

### 5. 验证

```bash
curl -I https://blog.example.com           # 200 + 安全头
curl https://blog.example.com/api/health   # {"ok":true,...}
curl https://blog.example.com/rss.xml | head -5
```

### 日常运维

```bash
sudo systemctl restart glassblog    # 改代码后重启
journalctl -u glassblog -n 100      # 查日志
ls data/backups/                    # 内容自动备份（误删可恢复）
```

## 静态托管（纯演示）

整个目录即静态产物，无需打包：Vercel 拖拽目录、Netlify `netlify deploy --dir=. --prod`、
Gitee Pages 选根目录。静态托管不会运行 `server.js`，站点自动进入静态演示模式
（编辑仅存本机 localStorage，无统计/RSS/上传）。

## 二次修改指南

| 需求 | 做法 |
| --- | --- |
| 新增/修改文章、软件（不用后台） | 直接编辑 `data/content.json`，往 `posts` / `projects` 数组追加对象；文章支持可选 `cover`（封面图 URL）与 `excerpt`（摘要）字段 |
| 手动添加安装包 | 文件放入 `downloads/`，下载地址填 `downloads/xxx.zip` |
| 调整玻璃质感 | 只改 `assets/css/glass.css` 顶部变量：`--glass-blur`（模糊度）、`--glass-bg`（透明度）、`--glass-radius`（圆角）、`--glass-border`（描边） |
| 修改登录账号密码 | 环境变量 `ADMIN_USER` / `ADMIN_PASS`（推荐），或 systemd 单元中的 Environment |
| 调整上传限制 | 改 `server.js` 顶部 `UPLOAD_DIRS` 白名单与 `max` |
| 换数据库 | 重写 `server.js` 中 `/api/content` 的读写逻辑即可，前端无需改动 |
| **添加新功能** | **优先写成模块（见下节），不改任何核心文件** |

## 模块化开发指南（框架化扩展）

本站是一个小框架：核心文件（HTML 页面 / `common.js` / `glass.css`）稳定不变，
**新功能一律以模块形式添加**——新增一个 JS 文件 + 清单登记一行即可，非常适合 AI 协作开发
（AI 只需创建新文件、改清单，不触碰既有代码，冲突与回归风险最小）。

### 模块契约

模块就是一个文件，放在 `assets/js/modules/` 下，调用 `GB.register` 注册：

```js
// assets/js/modules/my-feature.js
GB.register("my-feature", {
  init(ctx) {
    // ctx.page —— 当前页标识："home" / "blog" / "apps" / "admin" / ""
    // ctx.on(evt, fn) —— 订阅页面事件（见下方事件表）
    // ctx.emit(evt, data) —— 触发事件（模块间通信）
    // 可直接使用 GB 全部公共方法（GB.load / GB.esc / GB.md 等）
  },
});
```

然后在清单 `assets/js/modules/index.js` 按页登记一行：

```js
window.GB_MODULES = {
  "*": ["back-to-top"],        // 所有页面加载
  blog: ["image-zoom"],        // 仅博客页加载
  admin: ["my-feature"],       // 仅后台加载 ← 新模块登记在这里
};
```

页面加载时 `GB.renderNav()` 会自动读取清单、按顺序注入模块脚本并完成初始化，
失败只会在 console 报警，不影响页面其他功能。

### 页面事件表（模块的挂钩点）

页面在关键节点通过 `GB.emit` 广播事件，模块用 `ctx.on` 订阅即可扩展，无需改页面代码：

| 事件 | 触发时机 | 携带数据 |
| --- | --- | --- |
| `home:render` | 主页数据渲染完成 | 完整 content 数据 |
| `blog:list` | 博客列表/搜索/翻页渲染完成 | `{ list, page, total }` 当前页文章 |
| `blog:detail` | 文章详情渲染完成 | `{ post, body }` 文章对象与正文 DOM |
| `apps:render` | 软件页渲染完成 | projects 数组 |
| `admin:ready` | 后台登录并初始化完成 | `{ isApi }` 是否后端模式 |

> 需要新的挂钩点？在对应页面渲染完成后加一行 `GB.emit("page:event", data)` 即可，
> 这算「埋点」而非功能改动，一个 PR 一件事。

### 给 AI 的添加新功能标准流程

1. **判断挂钩方式**：功能由页面事件驱动 → 用 `ctx.on` 挂钩（如灯箱）；
   全局/独立功能 → `init` 里直接执行（如回到顶部）。
2. **新建模块文件** `assets/js/modules/xxx.js`，照抄上方契约模板实现 `init`。
3. **登记清单**：在 `assets/js/modules/index.js` 对应页面数组追加 `"xxx"`。
4. 如需新页面事件，在页面渲染完成处补一行 `GB.emit(...)` 并在上表登记。
5. 不要修改 `common.js` / 页面既有逻辑 / 其他模块。

内置示例可参考：`back-to-top.js`（全局型）、`image-zoom.js`（事件挂钩型）。

## 移动端兼容说明

已按 Memos 的移动端适配思路处理（无需任何配置，全局生效）：

- **视口**：所有页面 `viewport-fit=cover`，刘海屏内容延展至屏幕边缘
- **安全区**：导航栏顶部自动避开刘海（`env(safe-area-inset-top)`），
  body 左右留出横屏安全区，回到顶部按钮避开底部横条
- **防聚焦缩放**：移动端所有输入框字号强制 ≥16px（iOS 聚焦不再自动放大页面）
- **触控目标**：导航链接/按钮移动端加大到 36–40px 高，桌面端保持紧凑
- **细节**：禁用点按灰色闪烁（`-webkit-tap-highlight-color`）、禁止横屏自动放大文字
  （`text-size-adjust`）、`100dvh` 修复 iOS 地址栏高度问题、长 URL/代码自动断行不撑破布局
- **防断行**：导航链接 `white-space: nowrap`，窄屏中文不再竖排；极窄屏导航可横向滑动

## 限制说明

- 单账号 + 随机令牌（存 `data/sessions.json`），无多用户/权限体系；公网使用务必改强密码并启用 HTTPS
- 多端同步为「保存即覆盖 content.json」的乐观模型，两人同时编辑会互相覆盖（个人单作者场景无影响）
- 上传做扩展名白名单但未做文件内容校验，请勿把管理后台暴露给不可信用户
- 访问统计为隐私友好的页面计数，不是全量日志分析；需要更细数据可另接 Umami

## 可扩展方向

- 评论系统：Giscus / Waline（静态站友好）
- 全文搜索：Pagefind（静态索引）
- 实时同步：把 content 变更用 SSE/WebSocket 推送到在线页面
- 多用户与权限：在 `server.js` 的令牌层扩展用户表
- CI/CD：GitHub Actions push 后 rsync 到服务器并 `systemctl restart`
