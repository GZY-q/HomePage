# GlassBlog 功能整合实施计划（升级架构版 · 零依赖）

## 一、摘要

按指令文档实施 GlassBlog 四大阶段功能。经代码探索确认：**第一阶段底座与第二阶段后端已大部分就绪**，本次实施的剩余工作为：

- **阶段 A（补齐 Phase 2）**：备忘录前端 `memos.html` + 前台/后台模块 + 静态模式降级
- **阶段 B（Phase 3）**：Agent 定时任务系统（调度器 + 动作库 + API + 后台 Tab）
- **阶段 C（Phase 4）**：Bot 指令系统（注册制引擎 + 内置指令 + @bot 事件联动 + 控制台 Tab）
- **阶段 D（Phase 5）**：安全加固（魔数校验 / IP 绑定 / 分级备份）+ 部署配置更新

全程零依赖，遵循 `GB.register` 模块规范，业务联动走后端事件总线，不破坏既有 `posts / projects / profile` 结构。

---

## 二、现状分析（Phase 1 探索结论）

### 已完成（无需重做，仅复用/微调）

| 指令项 | 现状 | 位置 |
|---|---|---|
| 1.2.1 原子写入 `writeContent` | ✅ tmp + rename 已实现 | [server.js](file:///Users/gede/github/HomePage/server.js#L100-L105) |
| 1.2.2 schema 版本与迁移 | ✅ v2，`memos/agentTasks` 已在 normalize 中补全；`normalizeMemo/normalizeAgentTask` 可复用 | [schema.js](file:///Users/gede/github/HomePage/assets/js/schema.js#L130-L146) |
| 1.2.3 全局事件总线 | ✅ `global.GBEvent`，异常隔离 | [server.js](file:///Users/gede/github/HomePage/server.js#L107-L113) |
| 1.2.4 数据文件拆分 | ✅ `audit.log`（追加）、`agent-logs-YYYY-MM.json`（月切 500 条、90 天清理）、backups 仅 content | [server.js](file:///Users/gede/github/HomePage/server.js#L163-L188) |
| 1.2.5 通用鉴权中间件 | ✅ `authRequired` + 滑动续期 + 防爆破复用 | [server.js](file:///Users/gede/github/HomePage/server.js#L139-L145) |
| 2.1.1 auth 前端模块 | ✅ `GB.auth` 五方法 + 玻璃模态框（遮罩不关闭、回车提交） | [auth.js](file:///Users/gede/github/HomePage/assets/js/modules/auth.js) |
| 2.1.2 导航登录态 | ✅ renderNav 含「备忘」链接 + renderNavAuth 登录/下拉菜单 | [common.js](file:///Users/gede/github/HomePage/assets/js/common.js#L269-L329) |
| 2.2.2 备忘录后端 API | ✅ 全部 7 个接口（列表/标签云/单条/创建/更新 rev 锁/删除/分享）+ 备份 + 事件 + 审计 | [server.js](file:///Users/gede/github/HomePage/server.js#L400-L555) |

### 缺口清单（本次实施）

| # | 缺口 | 所属阶段 |
|---|---|---|
| 1 | `memos.html` 前台页面不存在（分享链接 `/memos.html?share=...` 当前 404） | A |
| 2 | `memos-list` / `memos-detail` 前台模块未实现，index.js 未登记 | A |
| 3 | admin.html 无「备忘管理」Tab，`admin-memos.js` 未实现 | A |
| 4 | 备忘录静态模式（localStorage）降级未实现 | A |
| 5 | Agent 调度器 / 动作库 / `/api/agent/*` 全部缺失 | B |
| 6 | admin.html 无「Agent 任务」Tab，`admin-agent.js` 未实现 | B |
| 7 | Bot 指令引擎 / `/api/bot/chat` / @bot 联动全部缺失 | C |
| 8 | admin.html 无「Bot 控制台」Tab，`admin-bot.js` 未实现 | C |
| 9 | 上传魔数校验、`TOKEN_BIND_IP`、audit.log 90 天清理缺失 | D |
| 10 | 备份策略为「保留 20 份」，未实现分级保留；`/api/health` 缺调度器状态/最近备份 | D |
| 11 | deploy 配置未覆盖 memos 缓存/安全头/systemd 日志限制 | D |

---

## 三、阶段 A：备忘录前端（Phase 2 剩余）

### A1. 新建 `memos.html`（骨架 + 数据层 + 路由）

复用 [blog.html](file:///Users/gede/github/HomePage/blog.html) 的页面骨架（导航、FOUC 防护、tailwind/marked/purify 引入、prose-glass、footer）。页面自身保持轻量，主体渲染交给模块：

- **DOM 结构**：
  - 工具栏：搜索框（`/` 快捷键聚焦）、标签 chips、时间快捷筛选（今天/本周/本月）、「归档」入口按钮
  - `#memoList` 时间线容器、`#memoPager` 分页
  - 右下角悬浮「+」快捷发布按钮（仅登录显示）→ 弹出极简发布框（Markdown 输入 + 标签 + 可见性切换；回车发布、Shift+回车换行）
  - `#memoShareView` 分享单条视图容器（默认隐藏）
- **数据层 `memoStore`（内联实现，双模式）**：
  - 后端模式（`GB.isApi()`）：走 `/api/memos*`，请求用 `GB.auth.request`（自动带 token、401 弹登录框）
  - 静态模式：复用 `GB.load()` 返回数据中的 `memos` 数组做 CRUD，写回用 `GB.save(data)`（localStorage，自带 rev+1）；单条 memo 的 rev 自增由前端维护，保持契约形态
- **路由**：
  - `?share=<token>&id=<id>` → 分享视图：仅渲染单条，隐藏列表/工具栏/导航操作区；后端模式直接 `GET /api/memos/:id?share=token`，静态模式从本地查找
  - 默认 → 列表视图
- **权限拦截**：未登录仅请求 public 数据、隐藏快捷发布与操作按钮、列表顶部提示「登录查看更多」；已登录显示全部
- **挂钩事件**：渲染完成时 `GB.emit("memos:list", {...})` / `GB.emit("memos:detail", { memo, body })`
- **页面标识**：`GB.renderNav("memos")`（导航已有该 key 的高亮支持）

### A2. 新建 `assets/js/modules/memos-list.js`

订阅页面挂钩，负责时间线交互增强：

- 任务列表 `- [ ]` 复选框点击切换：定位 memo → 改写 content 中对应行 → 乐观更新 DOM → 调 `PUT /api/memos/:id`（携带 rev；静态模式走本地保存）；409 时提示刷新
- 卡片图片懒加载属性补全；emit 渲染事件供 image-zoom 绑定

### A3. 新建 `assets/js/modules/memos-detail.js`

负责单条/分享视图渲染：Markdown 渲染（`GB.md` 消毒）、标签/时间/分享信息展示，渲染后 `ctx.emit("memos:detail:rendered", { body })`。

### A4. 修改 `assets/js/modules/image-zoom.js`（模块内扩展，不动核心）

在现有 `blog:detail` 订阅基础上，追加订阅 `memos:list` 与 `memos:detail:rendered`，复用 `bindImgs` 绑定正文图片灯箱。

### A5. admin.html 新增「备忘管理」Tab（最小侵入）

规格明确要求在 admin.html 加 Tab，对核心页面的改动控制在三处：

1. Tab 栏追加 `<button data-tab="memos" class="tabBtn ...">备忘</button>`（以及后续阶段 B/C 的「Agent 任务」「Bot 控制台」，一次加齐）
2. 追加空容器 `<section id="tab-memos" class="hidden">`（内容由模块渲染），同理 `tab-agent`、`tab-bot`
3. `switchTab` 的 key 数组 `["posts","apps","profile","stats"]` 扩为含 `memos/agent/bot`，并 `GB.emit("admin:tab", { tab })` 作为模块挂钩点

不改动任何既有文章/软件/个人信息/统计逻辑。

### A6. 新建 `assets/js/modules/admin-memos.js`

订阅 `admin:ready` 与 `admin:tab`，在 `#tab-memos` 内渲染完整管理 UI：

- **快速发布框**：置顶极简输入，回车发布（Shift+回车换行）
- **筛选区**：搜索框、状态 chips（全部/公开/私密/归档）、标签下拉
- **备忘列表**：摘要、标签、时间、操作按钮（编辑/删除/置顶/归档/切换可见性/生成分享链接——分享链接调 `POST /api/memos/:id/share` 并复制到剪贴板）
- **完整编辑器**（模块自实现，不依赖 admin.html 内联私有函数）：三模切换（编辑/分屏/预览）、精简工具栏、⌘S 保存快捷键、自动草稿（`gb_memo_draft_<id>`）、字数统计、标签编辑、图片粘贴/选择上传（复用 `GB.upload`）、可见性/归档切换；保存携带 rev，409 时提示并展示服务端当前内容供对比
- **双模式**：后端走 `/api/memos*` REST；静态走 `GB.load()/GB.save()` 本地 memos 数组，并提供「导出 memos JSON / 导入」按钮

### A7. 更新 `assets/js/modules/index.js`

```js
window.GB_MODULES = {
  "*": ["back-to-top", "auth"],
  blog: ["image-zoom"],
  memos: ["image-zoom", "memos-list", "memos-detail"],
  admin: ["admin-memos", "admin-agent", "admin-bot"],
};
```

---

## 四、阶段 B：Agent 定时任务系统（Phase 3）

### B1. server.js 追加：调度器 `GBScheduler`

在路由定义之前、`GBEvent` 之后插入调度器实现（约 120 行）：

- **`nextRun(rule, from)`**：解析五种规则字符串，返回下次执行时刻（Date 或 null）：
  - `daily@HH:mm`：下一个该时刻（今天已过则明天）
  - `weekly@<mon|tue|...>@HH:mm`：下一个匹配星期几的该时刻
  - `monthly@<D>@HH:mm`：下一个该日期的该时刻（月份无该日则顺延月末）
  - `once@<ISO>`：该时刻本身（已过则 null）
  - `interval@<秒>`：`from + N 秒`
- **分钟级巡检**：单个 `setInterval(tick, 60e3)`；tick 遍历 `enabled` 任务，`nextRunAt <= now && !running` 则执行，误差 ≤1 分钟
- **执行中锁**：`running` 内存标记（不落盘），执行完成/失败均释放
- **失败重试**：动作抛错 → 按 `retry` 次数、`retryDelay` 秒用 `setTimeout` 链式重试；最终失败记 `lastStatus: "fail"`
- **错过任务**：启动加载时若 `nextRunAt` 已过：`catchUp: true` 立即补跑一次并随后重算；默认直接重算到下一未来时刻（不批量补跑）
- **一次性任务**：执行成功后置 `enabled: false`
- **生命周期**：
  - `GBScheduler.load()`：服务启动时读取 content.json 的 `agentTasks` 注册
  - `GBScheduler.reload(tasks)`：API 增删改后热更新，无需重启
  - 执行完成更新 `lastRunAt / nextRunAt / lastStatus`（`writeContent` 原子写入，无需备份）并写 agent 日志
  - SIGTERM：清理巡检/重试定时器，等待 running 任务结束（挂入现有 SIGTERM 处理器，超时 3s 强退逻辑沿用）

### B2. server.js 追加：动作库 `GBActions`

动作映射表 `{ [actionId]: async (params, ctx) => resultString }`：

| 动作 | 实现要点 |
|---|---|
| `memo_publish` | 用 `GBSchema.normalizeMemo` 构造 memo → unshift → 备份 → `writeContent` → `GBEvent.emit("memo:create")` → 审计 |
| `memo_weekly_report` | 筛近 7 天 memos（可按 params.tags 过滤）→ 生成 Markdown 周报文本；`autoPublish` 时复用 memo_publish 发布，否则仅写日志 |
| `post_publish` | 按 `postId` 找文章置 `status:"published"` + `updatedAt` → 备份 → 写入 → emit `post:update` |
| `system_backup` | 调 `backupContent()`，再按 `params.keep`（默认沿用分级策略）清理 |
| `stats_daily` | 聚合 stats.json 当日数据生成摘要写入 agent 日志 |
| `webhook` | 用 `http/https` 模块发请求（5s 超时，仅允许 http/https URL），返回状态码 |

### B3. server.js 追加：API（全部 `authRequired`）

在 `/api/memos*` 路由块之后插入：

- `GET /api/agent/tasks`：返回任务数组（含 running 内存态合并）
- `POST /api/agent/tasks`：`GBSchema.normalizeAgentTask` 规范化 + 计算 `nextRunAt` → 备份 → 写入 → `GBScheduler.reload` → 审计
- `PUT /api/agent/tasks/:id`：更新字段（schedule 变更则重算 nextRunAt）→ 备份 → 写入 → reload → 审计
- `DELETE /api/agent/tasks/:id`：备份 → 删除 → 写入 → reload → 审计
- `POST /api/agent/tasks/:id/run`：立即执行一次（不改调度计划），同步返回执行结果
- `GET /api/agent/logs?page=&size=`：读当月 `GBAgentLogs.readAgentLogs()`，分页倒序返回

### B4. admin.html「Agent 任务」Tab + `assets/js/modules/admin-agent.js`

- **概览卡片**：运行中任务数（enabled 且 nextRunAt 存在）、今日执行次数、成功率、最近失败任务（取自日志）
- **任务列表**：名称、调度规则、动作、下次执行时间（本地化显示）、状态徽标、操作（启用/禁用、立即执行、编辑、删除）
- **新建/编辑表单**：动作下拉（选择后动态渲染参数表单）、调度规则可视化选择（类型下拉 + 时间/星期/日期/间隔输入，拼接为规则字符串）、retry/retryDelay/catchUp 配置
- **执行日志**：时间线展示，成功/失败状态色，错误详情可展开
- **静态模式**：整个 Tab 显示置灰占位「仅后端模式可用」（`ctx.on("admin:ready")` 拿 isApi 判断）

---

## 五、阶段 C：Bot 指令交互系统（Phase 4）

### C1. server.js 追加：指令引擎 `GBBot`（注册制 + 白名单）

```js
const GBBot = {
  _cmds: [], // { pattern: RegExp, desc, handler(match, ctx) }
  register(pattern, desc, handler) { ... },
  async exec(text, ctx) { /* 遍历匹配，无匹配返回「帮助」提示；异常捕获返回错误文案 */ },
};
```

`ctx` 携带 `{ req }` 供动作内审计/统计使用。全部指令白名单注册，无任何动态代码执行。

### C2. 内置指令集（在 GBBot 定义后注册）

| 指令 | 正则要点 | 实现 |
|---|---|---|
| `备忘 <内容>` | `^备忘\s+([\s\S]+)` | 调 GBActions.memo_publish（私密），返回成功 + id |
| `搜博客 <关键词>` | `^搜博客\s+(.+)` | 匹配已发布文章标题/摘要，返回前 5 条（标题 + `?p=` 链接） |
| `新建任务 <规则> <动作>` | `^新建任务\s+(\S+)\s+(\S+)` | 校验规则与动作合法性 → normalizeAgentTask → 写入 → reload → 返回下次执行时间 |
| `统计 [今天\|本周\|本月]` | `^统计(?:\s+(\S+))?` | 聚合 stats.json 对应范围 PV 返回摘要 |
| `发布 <文章ID/slug>` | `^发布\s+(\S+)` | 复用 GBActions.post_publish，返回结果 + 链接 |
| `备份` | `^备份$` | backupContent，返回备份文件名 |
| `帮助` | `^帮助$` | 列出全部已注册指令与说明 |

单轮上下文：`exec` 收到「新建任务」裸指令时返回分步提示（规则→动作），会话状态仅存内存 Map（token→step），5 分钟过期。快捷别名：注册表支持同一 handler 挂多个正则。

### C3. @bot 备忘联动（纯事件订阅，不改 memos 接口）

在 Bot 定义后：

```js
GBEvent.on("memo:create", handleBotMemo);
GBEvent.on("memo:update", handleBotMemo);
```

`handleBotMemo(memo)`：仅 `visibility === "private"` 且内容含 `@bot` 且未被处理标记时触发 → 提取 `@bot` 后指令文本 → `GBBot.exec` → 将「🤖 Bot 回复：结果」追加到 memo.content 末尾并写入（附加防循环标记，回复追加引发的 `memo:update` 不再二次触发）→ 公开备忘直接忽略。

### C4. `POST /api/bot/chat`

`authRequired` → body `{ text }`（≤2000 字）→ `GBBot.exec` → 返回 `{ reply }`；审计 `bot:chat`。

### C5. admin.html「Bot 控制台」Tab + `assets/js/modules/admin-bot.js`

- 对话式 UI：消息气泡（用户右/Bot 左），Bot 回复经 `GB.md` 渲染（DOMPurify 消毒）
- 输入框：回车发送、↑↓ 切换历史指令、输入「/」或「帮助」给出指令提示
- 历史存 `localStorage("gb_bot_history")`，刷新恢复
- 静态模式：本地模拟——「备忘」指令写本地 memos，「帮助」可用，其余指令回复「仅后端模式可用」

---

## 六、阶段 D：安全加固 + 部署联调（Phase 5）

### D1. server.js 安全增强

1. **上传魔数校验**：`/api/upload` 落盘后读取前 16 字节校验文件头，不匹配则删除并 400：
   - images：png `89504E47`、jpg `FFD8FF`、gif `GIF8`、webp `RIFF....WEBP`、svg 按文本嗅探（首非空白字符为 `<` 且含 `<svg`）
   - packages：zip 系 `PK\x03\x04`、gz `1F8B`、7z `377ABCAF271C`、dmg/exe/msi/apk 按各自魔数或放宽为「非可执行文本」检查
2. **`TOKEN_BIND_IP=true`**：登录时 session 记录 `ip`；`authOK` 校验当前请求 IP 与 session.ip 一致，不一致视为未登录
3. **audit.log 90 天清理**：每次 append 时概率性（如 1/50）或每日首次写入时截断 90 天前的行（按行首 ISO 时间过滤重写，保持追加语义）
4. **`/api/health` 增强**：追加 `{ scheduler: { enabled, running }, lastBackup, schemaVersion }`
5. **分级备份清理**：重写 `backupContent()` 的清理逻辑——保留「近 7 天每天最新 1 份、近 4 周每周最新 1 份、更早每月最新 1 份」（按文件名时间戳分组裁剪）；`/api/backups` 列表上限相应调整

### D2. deploy 配置更新

- `glassblog.service`：追加日志限额与重启策略注释（`StandardOutput=journal`、`SyslogIdentifier=glassblog`，并在注释中给出 journald `SystemMaxUse` 建议；`Restart=always` 已有）
- `Caddyfile` / `nginx.conf`：补充 `memos.html` 与 HTML 页面的 `no-cache` 规则、安全响应头（`X-Content-Type-Options` 等，与 server.js SEC_HEADERS 对齐）

### D3. README.md 更新

更新目录结构（memos.html、新模块、agent-logs）、API 表（memos/agent/bot 接口）、环境变量表（TOKEN_BIND_IP）、功能亮点（备忘录/Agent/Bot）。属交付说明的一部分。

---

## 七、假设与决策（与指令文档的偏差说明）

1. **memo id 格式**：指令写 `memo_毫秒时间戳`，现状 schema.js 已用 `genId("memo")` → `memo-xxx` 且后端 API 已上线该格式。**沿用现有格式**，不破坏一致性。
2. **memos 页面主体归属**：指令模块清单登记 `memos-list/memos-detail`，按规格将列表交互与单条/分享渲染放入两模块；页面保留骨架 + 数据层 + 路由（与 blog.html 内联风格折中，满足模块登记要求）。
3. **admin.html 三处最小改动**：指令禁止改 common.js/glass.css 核心，但明确要求 admin.html 新增三个 Tab——仅追加 Tab 按钮、空 section、switchTab key 数组与 `admin:tab` 事件埋点，不动既有逻辑。
4. **备忘录编辑器复用**：admin.html 文章编辑器的工具栏/快捷键为页面私有函数无法直接复用，`admin-memos.js` 自带精简实现（功能对齐：三模/快捷键/自动草稿/字数/上传），接受少量代码重复以换取零核心改动。
5. **静态模式备忘录**：复用 `GB.load()/GB.save()` 全量 content 中的 memos 数组（localStorage），无需独立存储键；Agent 置灰、Bot 本地模拟，与指令 5.2 一致。
6. **备份策略**：以指令「分级保留」替换现有「保留 20 份」；agent 调度器自身的任务状态写盘不触发备份（避免每分钟产生备份）。
7. **执行顺序**：A → B → C → D 串行，每阶段完成后做冒烟验证再进入下一阶段。

---

## 八、验证步骤

### 静态检查
- `node --check server.js` 语法通过；前端各新 JS 无语法错误（浏览器控制台无报错）

### 阶段 A 冒烟（后端模式，`node server.js`）
1. `curl localhost:8899/api/memos` 未登录仅返回 public；登录 admin 后访问 `/memos.html` 显示全部
2. 悬浮「+」发布一条带 `- [ ]` 任务的备忘 → 时间线出现 → 点击复选框状态切换并持久化
3. 搜索、标签、时间筛选、归档视图工作正常；`/` 聚焦搜索框
4. 生成分享链接 → 无痕窗口打开 `?share=...` 仅见单条
5. 后台「备忘」Tab：发布/编辑（409 冲突提示）/置顶/归档/可见性/删除/分享全通过
6. 静态模式（`python3 -m http.server`）：memos 完整可用、数据存 localStorage、可导入导出

### 阶段 B 冒烟
1. `curl -X POST /api/agent/tasks`（带 token）创建 `interval@60` + `memo_publish` 任务 → 1 分钟内 agent 日志出现执行记录、memos 新增一条
2. 手动 `POST /api/agent/tasks/:id/run` 同步返回结果
3. 错误动作触发重试并最终记 fail；`once@` 任务执行后自动禁用
4. 重启服务：错过任务默认跳过不补跑；`catchUp:true` 补跑一次
5. 后台 Agent Tab：概览/列表/表单/日志展示正确；静态模式置灰

### 阶段 C 冒烟
1. Bot 控制台依次发送：帮助 / 备忘 测试 / 搜博客 玻璃 / 统计 今天 / 备份 → 返回符合预期
2. 发布一条含 `@bot 统计 今天` 的私密备忘 → Bot 回复自动追加；公开备忘不触发
3. 无 token 调 `/api/bot/chat` 返回 401

### 阶段 D 冒烟
1. 改扩展名上传文本文件伪装 `.png` → 400 拒绝
2. `TOKEN_BIND_IP=true` 重启后换 IP 请求 → 401
3. `/api/health` 返回 scheduler/lastBackup/schemaVersion
4. 连续多次保存触发备份 → backups 目录符合分级保留
5. `curl -I` 检查 memos.html 缓存头与安全头

---

## 九、交付清单（预计）

**新增文件（7）**：`memos.html`、`assets/js/modules/memos-list.js`、`memos-detail.js`、`admin-memos.js`、`admin-agent.js`、`admin-bot.js`、（运行时生成 `data/agent-logs-YYYY-MM.json`）

**修改文件（7）**：`server.js`（调度器/动作库/agent API/Bot/魔数/IP 绑定/分级备份/health）、`admin.html`（三个 Tab 骨架）、`assets/js/modules/index.js`（清单）、`assets/js/modules/image-zoom.js`（memos 挂钩）、`deploy/glassblog.service`、`deploy/Caddyfile`、`deploy/nginx.conf`、`README.md`
