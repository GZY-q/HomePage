/* node:test 公共辅助：data/ 目录快照还原 + HTTP 请求 + 轮询等待
   所有集成测试在 before 快照、after 还原，保证 data/ 零污染。 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

/* ---------- data/ 快照与还原 ---------- */
function snapDir(dir, base, out) {
  base = base || dir; out = out || {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = path.relative(base, p);
    if (fs.statSync(p).isDirectory()) snapDir(p, base, out);
    else out[rel] = fs.readFileSync(p);
  }
  return out;
}
function snapData() { return snapDir(DATA_DIR); }
function restoreData(snap) {
  if (!fs.existsSync(DATA_DIR)) { fs.mkdirSync(DATA_DIR, { recursive: true }); return; }
  for (const name of fs.readdirSync(DATA_DIR)) {
    const p = path.join(DATA_DIR, name);
    if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  }
  for (const [rel, buf] of Object.entries(snap || {})) {
    const p = path.join(DATA_DIR, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  }
}

/* ---------- HTTP 请求（agent:false 避免 keep-alive 连接拖住退出） ---------- */
function request(port, method, p, { token, body, raw, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw != null ? raw : (body == null ? null : JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1", port, method, path: p, agent: false,
      headers: {
        "Content-Type": "application/json",
        "Connection": "close",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 轮询直到 fn 返回真值或超时 */
async function waitFor(fn, { timeout = 5000, interval = 50 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(interval);
  }
}

module.exports = { ROOT, DATA_DIR, snapData, restoreData, request, sleep, waitFor };
