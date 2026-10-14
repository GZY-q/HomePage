#!/usr/bin/env node
/* GlassBlog 审计日志哈希链校验脚本（零依赖）
 *
 * 校验 data/audit.log 的完整性：
 *   1. 每行是合法 JSON；新格式行含 ts/actor/ip/type/ok/prev/h 字段
 *   2. 每行 h = SHA-256(prev + JSON.stringify(不含 h 的行对象)) —— 自洽性
 *   3. 第 i 行 prev === 第 i-1 行 h —— 链式连续性
 *   4. 允许两种历史前缀，自此重新起链校验（仅提示，不算失败）：
 *      - 旧格式行（{t, action, target}，哈希链启用前写入）仅可出现在文件开头
 *      - 首条新格式行的 prev 为 "GENESIS" 或 90 天裁剪锚点（指向已删除行）
 *
 * 用法：node scripts/verify-audit.js [audit.log 路径]
 * 退出码：0 完整 / 1 发现篡改或损坏 / 2 用法或文件错误
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const file = path.resolve(process.argv[2] || path.join(__dirname, "..", "data", "audit.log"));

if (!fs.existsSync(file)) {
  console.error(`[verify-audit] 文件不存在：${file}`);
  process.exit(2);
}

const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
if (!lines.length) {
  console.log("[verify-audit] 审计日志为空，无需校验。");
  process.exit(0);
}

const REQUIRED = ["ts", "actor", "ip", "type", "ok", "prev", "h"];
let legacy = 0;   // 旧格式前缀行数（哈希链启用前写入）
let anchor = null; // 首条新格式行的 prev（GENESIS 或裁剪锚点）
let chainStart = -1;

for (let i = 0; i < lines.length; i++) {
  const at = `第 ${i + 1} 行`;
  let e;
  try { e = JSON.parse(lines[i]); }
  catch (err) { console.error(`[verify-audit] ${at}：JSON 解析失败（${err.message}）`); process.exit(1); }

  /* 旧格式行（{t, action, target}）：仅允许出现在哈希链之前的前缀位置 */
  if (!("h" in e) && !("prev" in e) && ("action" in e || "t" in e)) {
    if (chainStart >= 0) {
      console.error(`[verify-audit] ${at}：旧格式行出现在哈希链之后（异常混入）`);
      process.exit(1);
    }
    legacy++;
    continue;
  }

  const missing = REQUIRED.filter((k) => !(k in e));
  if (missing.length) {
    console.error(`[verify-audit] ${at}：缺少字段 ${missing.join(", ")}`);
    process.exit(1);
  }

  /* 自洽性：重算 h（JSON.parse 保持键序，删 h 后重序列化与写入时一致） */
  const expected = e.h;
  const body = { ...e };
  delete body.h;
  const actual = crypto.createHash("sha256").update(e.prev + JSON.stringify(body)).digest("hex");
  if (actual !== expected) {
    console.error(`[verify-audit] ${at}：哈希不自洽（记录被篡改？）\n  期望 ${expected}\n  实算 ${actual}`);
    process.exit(1);
  }

  /* 链式连续性 */
  if (chainStart < 0) {
    chainStart = i;
    anchor = e.prev; // 链起点：GENESIS 或裁剪/旧格式后的锚点，无法回溯仅记录
  } else {
    const prevH = JSON.parse(lines[i - 1]).h;
    if (e.prev !== prevH) {
      console.error(`[verify-audit] ${at}：链断裂（prev 与上一行 h 不一致，可能存在删改）`);
      process.exit(1);
    }
  }
}

const chained = lines.length - (chainStart < 0 ? lines.length : chainStart);
if (legacy) console.log(`[verify-audit] 跳过 ${legacy} 行旧格式前缀（哈希链启用前写入）`);
if (chainStart < 0) {
  console.log("[verify-audit] 全为旧格式日志，无哈希链可校验。");
  process.exit(0);
}
if (anchor !== "GENESIS")
  console.log(`[verify-audit] 链起点 prev 为锚点 ${String(anchor).slice(0, 12)}…（旧格式/90 天裁剪所致，自此起链校验）`);
console.log(`[verify-audit] 校验通过：${chained} 行哈希链完整。`);
process.exit(0);
