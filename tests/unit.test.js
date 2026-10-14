/* node:test 单元测试：纯函数与隔离逻辑（不涉及 data/ 目录）
   覆盖：串行写入层并发 / schema 迁移幂等 / calcNextRun / SSRF 校验 /
        备忘字段校验 / HTML 消毒白名单
   运行：node --test tests/unit.test.js （单独进程，可与集成测试并行） */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const server = require("../server");
const GBSchema = require("../assets/js/schema");

/* ---------- 串行写入层 ---------- */
test("writeContent：100 次并发自增严格串行，结果不丢写", async () => {
  const file = path.join(os.tmpdir(), `gb-unit-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ n: 0 }));
  try {
    const jobs = [];
    for (let i = 0; i < 100; i++)
      jobs.push(server.writeContent(file, (cur) => { cur.n = (cur.n || 0) + 1; return cur; }));
    await Promise.all(jobs);
    await server.drainWriteQueues();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).n, 100, "并发自增应严格累加到 100");
  } finally { fs.unlinkSync(file); }
});

test("writeContent：mutate 返回 undefined 放弃写入（文件不创建）", async () => {
  const file = path.join(os.tmpdir(), `gb-unit-skip-${process.pid}-${Date.now()}.json`);
  await server.writeContent(file, () => undefined);
  await server.drainWriteQueues();
  assert.equal(fs.existsSync(file), false, "返回 undefined 不应产生文件");
});

test("writeContent：传对象形式直接全量写入", async () => {
  const file = path.join(os.tmpdir(), `gb-unit-obj-${process.pid}-${Date.now()}.json`);
  try {
    await server.writeContent(file, { a: 1, b: [2, 3] });
    await server.drainWriteQueues();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1, b: [2, 3] });
  } finally { fs.unlinkSync(file); }
});

/* ---------- schema 迁移（幂等） ---------- */
test("GBSchema.migrate：v0 数据升到 v3 并补齐字段", () => {
  const data = { posts: [{ title: "Hello World", date: "2024-01-02" }], projects: [] };
  const out = GBSchema.migrate(data);
  assert.equal(out.schemaVersion, 3);
  assert.deepEqual(out.memos, []);
  assert.deepEqual(out.agentTasks, []);
  assert.deepEqual(out.botAliases, []);
  assert.equal(out.rev, 0);
  assert.ok(typeof out.posts[0].slug === "string" && out.posts[0].slug.length > 0, "应补齐非空 slug");
  assert.ok(typeof out.posts[0].id === "string" && out.posts[0].id.length > 0, "应补齐 id");
  assert.ok(out.posts[0].createdAt, "应补齐 createdAt");
  assert.ok(out.posts[0].updatedAt, "应补齐 updatedAt");
});

test("GBSchema.migrate：重复迁移幂等（两次结果深等）", () => {
  const once = GBSchema.migrate({ posts: [{ title: "A B" }] });
  const twice = GBSchema.migrate(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once, "migrate 必须幂等");
});

test("GBSchema.migrate：botAliases 过滤非法项 / 截断上限 / 限长", () => {
  const aliases = [
    { name: "", command: "x" },            // name 空 → 过滤
    { name: "ok", command: "" },           // command 空 → 过滤
    { name: "  sp  ", command: "  cmd  " },// 应 trim
    { name: "n".repeat(40), command: "c".repeat(2100) }, // 超长 → 截断
  ];
  for (let i = 0; i < 25; i++) aliases.push({ name: "a" + i, command: "c" + i });
  const out = GBSchema.migrate({ botAliases: aliases });
  assert.equal(out.botAliases.length, 20, "上限 20 条");
  assert.equal(out.botAliases[0].name, "sp");
  assert.equal(out.botAliases[0].command, "cmd");
  assert.equal(out.botAliases[1].name.length, 32, "name 截断到 32");
  assert.equal(out.botAliases[1].command.length, 2000, "command 截断到 2000");
});

/* ---------- computeNextRun ---------- */
const ymd = (d) => d.getFullYear() + "-" +
  String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const hm = (d) => d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");

test("computeNextRun：interval 最小 60 秒，非法/过小返回 null", () => {
  const from = new Date(2026, 9, 14, 10, 0, 0);
  assert.equal(server.computeNextRun("interval@30", from), null, "小于 60 秒非法");
  const n = server.computeNextRun("interval@3600", from);
  assert.ok(n && n.getTime() === from.getTime() + 3600e3, "interval 应为 from + 秒数");
});

test("computeNextRun：daily 当天已过则顺延到次日", () => {
  const from = new Date(2026, 9, 14, 10, 0, 0); // 2026-10-14 周三 10:00
  const n = server.computeNextRun("daily@09:00", from);
  assert.equal(ymd(n), "2026-10-15");
  assert.equal(hm(n), "9:00");
});

test("computeNextRun：weekly 计算下一个指定星期", () => {
  const from = new Date(2026, 9, 14, 10, 0, 0); // 周三
  const n = server.computeNextRun("weekly@mon@08:00", from);
  assert.equal(ymd(n), "2026-10-19", "下一个周一");
  assert.equal(hm(n), "8:00");
});

test("computeNextRun：monthly 小月 clamp 到月末", () => {
  const a = server.computeNextRun("monthly@31@00:00", new Date(2026, 1, 1, 0, 0, 0));
  assert.equal(ymd(a), "2026-02-28", "2 月无 31 日 → 28 日");
  const b = server.computeNextRun("monthly@31@00:00", new Date(2026, 1, 28, 0, 0, 0));
  assert.equal(ymd(b), "2026-03-31", "已到 2/28 则顺延至 3/31");
});

test("computeNextRun：once 严格格式且过期返回 null", () => {
  const from = new Date(2026, 9, 14, 10, 0, 0);
  assert.equal(server.computeNextRun("once@2020-01-01T00:00:00+08:00", from), null, "过期");
  assert.equal(server.computeNextRun("once@2027/01/01", from), null, "格式非法");
  const n = server.computeNextRun("once@2027-01-01T00:00:00+08:00", from);
  assert.ok(n instanceof Date && !isNaN(n), "未来时间应返回 Date");
});

test("computeNextRun：未知规则返回 null", () => {
  assert.equal(server.computeNextRun("yearly@1", new Date()), null);
  assert.equal(server.computeNextRun("", new Date()), null);
});

/* ---------- SSRF：isPrivateIP 矩阵 ---------- */
test("isPrivateIP：内网/回环/保留地址全部识别为私有", () => {
  const priv = ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "172.31.255.255",
    "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "not-an-ip"];
  for (const ip of priv) assert.equal(server.isPrivateIP(ip), true, ip + " 应判为私有");
});

test("isPrivateIP：公网地址判为非私有", () => {
  const pub = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "203.0.113.10", "2606:4700::1111"];
  for (const ip of pub) assert.equal(server.isPrivateIP(ip), false, ip + " 应判为公网");
});

/* ---------- SSRF：resolveWebhookIP / httpRequest（校验在连接前抛错，无需网络） ---------- */
test("resolveWebhookIP：回环/内网字面量拒绝，公网字面量直通", async () => {
  await assert.rejects(() => server.resolveWebhookIP("127.0.0.1"), /回环|内网|保留/);
  await assert.rejects(() => server.resolveWebhookIP("192.168.1.10"), /回环|内网|保留/);
  assert.equal(await server.resolveWebhookIP("8.8.8.8"), "8.8.8.8");
});

test("httpRequest：拒绝非法协议 / 方法 / 内网目标", async () => {
  await assert.rejects(() => server.httpRequest("ftp://example.com"), /仅支持 http\/https/);
  await assert.rejects(() => server.httpRequest("http://8.8.8.8/", { method: "DELETE" }), /GET\/POST/);
  await assert.rejects(() => server.httpRequest("http://127.0.0.1/"), /回环|内网|保留/);
});

/* ---------- validateMemoFields ---------- */
test("validateMemoFields：正文 / 标签上限校验", () => {
  assert.equal(server.validateMemoFields({ content: "hi", tags: ["a"] }), null);
  assert.match(server.validateMemoFields({ content: "x".repeat(100 * 1024 + 1) }), /100KB/);
  assert.match(server.validateMemoFields({ tags: new Array(21).fill("t") }), /最多 20/);
  assert.match(server.validateMemoFields({ tags: ["y".repeat(33)] }), /32 字符/);
  assert.match(server.validateMemoFields({ tags: "not-array" }), /格式无效/);
});

/* ---------- HTML 消毒（加载前端模块，注入 DOM shim） ---------- */
let sanitize = null;
test("加载 markdown 模块并取得 GB.sanitize", () => {
  const { DOMParser } = require("./dom-shim");
  global.DOMParser = DOMParser;
  global.GB = { register(name, m) { if (m && m.init) m.init(); } };
  require("../assets/js/modules/markdown.js");
  assert.equal(typeof global.GB.sanitize, "function", "init 应挂载 GB.sanitize");
  sanitize = global.GB.sanitize;
});

test("GB.sanitize：危险标签整体删除", () => {
  assert.equal(sanitize('<p>a</p><script>alert(1)</script>'), "<p>a</p>");
  assert.equal(sanitize('<iframe src="x"></iframe><p>b</p>'), "<p>b</p>");
  assert.equal(sanitize("<style>body{}</style>ok"), "ok");
});

test("GB.sanitize：剥离事件属性与 style", () => {
  assert.equal(sanitize('<p onclick="x()">a</p>'), "<p>a</p>");
  assert.equal(sanitize('<span style="color:red">a</span>'), "<span>a</span>");
  assert.equal(sanitize('<img src="https://x/y.png" onerror="alert(1)">'), '<img src="https://x/y.png">');
});

test("GB.sanitize：链接协议白名单 + 外链补 target/rel", () => {
  assert.equal(sanitize('<a href="javascript:alert(1)">x</a>'),
    '<a rel="noopener noreferrer nofollow">x</a>', "javascript: 协议应被去除");
  assert.equal(sanitize('<a href="https://example.com">x</a>'),
    '<a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">x</a>');
  assert.equal(sanitize('<a href="/memos.html">x</a>'),
    '<a href="/memos.html" rel="noopener noreferrer nofollow">x</a>', "站内链接不加 target");
});

test("GB.sanitize：input 仅保留只读 checkbox", () => {
  assert.equal(sanitize('<input type="checkbox">'), '<input type="checkbox" disabled="">');
  assert.equal(sanitize('<input type="text">'), "");
});

test("GB.sanitize：非白名单标签剥壳保文本", () => {
  assert.equal(sanitize("<blink>b</blink>"), "b");
  assert.equal(sanitize("<custom>c</custom>"), "c");
});
