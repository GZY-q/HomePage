/* node:test 集成测试：真实启动服务，走 HTTP 验证
   覆盖：登录 / health 分级 / 鉴权 / 静态穿越拦截 / 畸形 JSON / 超大请求体 /
        内容 rev 乐观锁 / 备忘 @bot 幂等 / Agent 任务调度全链路
   注意：本文件会读写 data/，before 快照、after 还原；须与其它 data/ 测试串行执行
        （node --test --test-concurrency=1 tests/） */
"use strict";
process.env.PORT = "18899";
process.env.TZ = "Asia/Shanghai";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { snapData, restoreData, request, sleep, waitFor } = require("./helpers");
const server = require("../server");

const PORT = Number(process.env.PORT);
let snap, token;

before(async () => {
  snap = snapData();
  server.startServer();
  const up = await waitFor(async () => {
    try { return (await request(PORT, "GET", "/api/health")).status === 200; }
    catch { return false; }
  }, { timeout: 15000, interval: 100 });
  assert.ok(up, "服务器应在超时前开始监听");
  const r = await request(PORT, "POST", "/api/login", { body: { user: "admin", pass: "glass123" } });
  assert.equal(r.status, 200, "管理员登录应成功");
  token = r.json.token;
  assert.ok(token, "登录应返回 token");
});

after(async () => {
  server.GBScheduler.stop();
  await server.GBScheduler.drain(5000);
  await server.drainWriteQueues();
  await new Promise((res) => server.server.close(res));
  restoreData(snap); // 还原 data/，保证零污染
});

/* ---------- 登录 ---------- */
test("POST /api/login：密码错误回 401", async () => {
  const r = await request(PORT, "POST", "/api/login", { body: { user: "admin", pass: "wrong" } });
  assert.equal(r.status, 401);
});

/* ---------- health 分级 ---------- */
test("GET /api/health：匿名仅 {ok:true}，不泄露内部状态", async () => {
  const r = await request(PORT, "GET", "/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.version, undefined, "匿名不应返回版本等内部字段");
});

test("GET /api/health：持 Token 返回版本与调度器状态", async () => {
  const r = await request(PORT, "GET", "/api/health", { token });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 3);
  assert.ok(r.json.scheduler && typeof r.json.scheduler.enabled === "boolean");
});

/* ---------- 鉴权 ---------- */
test("受保护接口无 Token 回 401", async () => {
  assert.equal((await request(PORT, "GET", "/api/agent/tasks")).status, 401);
  assert.equal((await request(PORT, "POST", "/api/bot/chat", { body: { text: "帮助" } })).status, 401);
  assert.equal((await request(PORT, "GET", "/api/backups")).status, 401);
});

/* ---------- 静态资源安全 ---------- */
test("点文件 / 服务端代码 / 运行时数据一律 404", async () => {
  assert.equal((await request(PORT, "GET", "/data/content.json")).status, 404);
  assert.equal((await request(PORT, "GET", "/server.js")).status, 404);
  assert.equal((await request(PORT, "GET", "/.git/config")).status, 404);
  assert.equal((await request(PORT, "GET", "/deploy/glassblog.service")).status, 404);
});

/* ---------- 异常请求 ---------- */
test("畸形 JSON 请求体回 400", async () => {
  const r = await request(PORT, "POST", "/api/login", { raw: "{bad json" });
  assert.equal(r.status, 400);
});

test("超大请求体被拒（413 或连接重置）", async () => {
  let got;
  try {
    got = await request(PORT, "POST", "/api/bot/chat", { token, raw: "x".repeat(200000) });
  } catch (e) {
    got = { status: "reset" }; // readBody 超限会 destroy 连接，客户端可能收到 ECONNRESET
  }
  assert.ok(got.status === 413 || got.status === "reset", "超大体积应被拒绝，实际: " + got.status);
});

/* ---------- 内容 rev 乐观锁 ---------- */
test("PUT /api/content：rev 陈旧回 409（不覆盖）", async () => {
  const cur = await request(PORT, "GET", "/api/content");
  assert.equal(cur.status, 200);
  const body = { profile: cur.json.profile, posts: cur.json.posts, projects: cur.json.projects, rev: (cur.json.rev || 0) + 999 };
  const r = await request(PORT, "PUT", "/api/content", { token, body });
  assert.equal(r.status, 409);
});

/* ---------- e2e：备忘 @bot + Agent 任务 ---------- */
test("e2e：备忘 @bot 触发幂等回复 → Agent 备份任务执行成功", async () => {
  /* 1. 建私密备忘，含 @bot 指令 */
  const created = await request(PORT, "POST", "/api/memos", {
    token, body: { content: "今天待办\n@bot 帮助", visibility: "private" },
  });
  assert.equal(created.status, 200);
  const id = created.json.id;
  assert.ok(id, "应返回备忘 id");

  /* 2. Bot 异步追加 1 条回复 */
  const replied = await waitFor(async () => {
    const g = await request(PORT, "GET", "/api/memos/" + id, { token });
    return g.json && Array.isArray(g.json.botReplies) && g.json.botReplies.length === 1 ? g.json : null;
  }, { timeout: 8000 });
  assert.ok(replied, "Bot 应追加 1 条回复");
  assert.equal(replied.botReplies[0].cmdHash.length, 64, "应记录指令哈希");

  /* 3. 幂等：重复投递同一 memo:create 事件不再追加 */
  server.GBEvent.emit("memo:create", server.eventPayload("user", "admin", id, created.json));
  await sleep(200);
  const again = await request(PORT, "GET", "/api/memos/" + id, { token });
  assert.equal(again.json.botReplies.length, 1, "相同指令不得重复执行");

  /* 4. 新建并立即执行备份任务 */
  const t = await request(PORT, "POST", "/api/agent/tasks", {
    token, body: { name: "测试备份", schedule: "interval@3600", action: "system_backup" },
  });
  assert.equal(t.status, 200);
  const tid = t.json.id;
  assert.ok(tid);

  const run = await request(PORT, "POST", `/api/agent/tasks/${tid}/run`, { token });
  assert.equal(run.status, 200);

  const log = await waitFor(async () => {
    const r = await request(PORT, "GET", "/api/agent/logs?limit=50", { token });
    return ((r.json && r.json.logs) || []).find((l) => l.taskId === tid && l.status === "success") || null;
  }, { timeout: 10000 });
  assert.ok(log, "任务应执行成功并写入日志");
  assert.ok(String(log.result).includes("content-"), "备份结果应含备份文件名");

  /* 5. 备份列表非空 */
  const bk = await request(PORT, "GET", "/api/backups", { token });
  assert.ok(bk.json.backups.length >= 1, "应至少存在 1 份备份");

  /* 6. 删除任务 → 204 */
  const del = await request(PORT, "DELETE", `/api/agent/tasks/${tid}`, { token });
  assert.equal(del.status, 204);
});

/* ---------- 安全响应头（6.4） ---------- */
test("安全响应头：API 响应带 nosniff / DENY / CSP", async () => {
  const r = await request(PORT, "GET", "/api/health");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.ok(String(r.headers["content-security-policy"] || "").includes("default-src 'self'"));
});

/* ---------- 登录锁定（6.4：同 IP 连续失败触发限流） ----------
   放在文件末尾：触发锁定后本进程内该 IP 的登录会被拒绝，避免影响其它用例 */
test("登录锁定：同 IP 连续失败达到阈值后回 429", async () => {
  let locked = false;
  for (let i = 0; i < 7 && !locked; i++) {
    const r = await request(PORT, "POST", "/api/login", { body: { user: "admin", pass: "bad-" + i } });
    if (r.status === 429) locked = true;
  }
  assert.ok(locked, "连续失败应触发登录锁定（429）");
});
