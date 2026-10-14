/* node:test 集成测试：令牌 IP 绑定（TOKEN_BIND_IP）+ 可信反代（TRUST_PROXY）
   独立进程，模块加载前设定环境变量；与 api.test.js 使用不同端口，须串行执行。 */
"use strict";
process.env.PORT = "18898";
process.env.TOKEN_BIND_IP = "true";
process.env.TRUST_PROXY = "true";
process.env.TZ = "Asia/Shanghai";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { snapData, restoreData, request, waitFor } = require("./helpers");
const server = require("../server");

const PORT = Number(process.env.PORT);
const IP_A = "1.2.3.4";
const IP_B = "5.6.7.8";
let snap, token;

before(async () => {
  snap = snapData();
  server.startServer();
  const up = await waitFor(async () => {
    try { return (await request(PORT, "GET", "/api/health")).status === 200; }
    catch { return false; }
  }, { timeout: 15000, interval: 100 });
  assert.ok(up, "服务器应在超时前开始监听");
  const r = await request(PORT, "POST", "/api/login", {
    body: { user: "admin", pass: "glass123" },
    headers: { "X-Forwarded-For": IP_A },
  });
  assert.equal(r.status, 200);
  token = r.json.token;
});

after(async () => {
  server.GBScheduler.stop();
  await server.GBScheduler.drain(5000);
  await server.drainWriteQueues();
  await new Promise((res) => server.server.close(res));
  restoreData(snap);
});

test("TRUST_PROXY：XFF 取最右侧值作为客户端 IP", async () => {
  // 左侧伪造值被忽略，最右侧才是最近可信代理追加的真实 IP
  const r = await request(PORT, "GET", "/api/agent/tasks", {
    token, headers: { "X-Forwarded-For": "9.9.9.9, " + IP_A },
  });
  assert.equal(r.status, 200, "最右侧与登录 IP 一致应放行");
});

test("TOKEN_BIND_IP：登录 IP 一致时令牌有效", async () => {
  const r = await request(PORT, "GET", "/api/agent/tasks", { token, headers: { "X-Forwarded-For": IP_A } });
  assert.equal(r.status, 200);
});

test("TOKEN_BIND_IP：换 IP 后同一令牌视为未登录", async () => {
  const r = await request(PORT, "GET", "/api/agent/tasks", { token, headers: { "X-Forwarded-For": IP_B } });
  assert.equal(r.status, 401, "IP 不一致应回 401");
});
