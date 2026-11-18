"use strict";
const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");

/** 访问令牌文件（与内核库同目录，壳与内核共用一个令牌） */
function tokenFilePath() {
  if (process.env.MEMORYOS_DATA_DIR) return path.join(process.env.MEMORYOS_DATA_DIR, "data", "token");
  return path.join(app.getPath("appData"), "MemoryOS", "data", "token");
}

function _log(...a) {
  console.log(`[MemoryOS-Desktop] ${new Date().toLocaleString("zh-CN")}`, ...a);
}

/** ★ 2026-11-16（M-9）：Windows 上写文件不带 ACL 控制 —— 令牌文件会继承目录权限。
 *  这里用 icacls 去掉继承、只授当前用户完全控制；失败只记日志，不影响鉴权。 */
function hardenTokenFile(f) {
  try {
    if (process.platform === "win32") {
      const user = process.env.USERNAME;
      if (!user) return;
      spawnSync("icacls", [f, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    } else {
      fs.chmodSync(f, 0o600);
    }
  } catch (e) {
    _log("令牌文件权限收紧失败（鉴权仍生效）:", e && e.message ? e.message : String(e));
  }
}

/**
 * 读/生成本机访问令牌（P1-2 / P0 硬化：改走 safeStorage 见路线图 §4）。
 * 已存在则复用，否则生成 48 位十六进制随机串并落盘。
 */
function ensureToken() {
  const f = tokenFilePath();
  try {
    const t = fs.readFileSync(f, "utf8").trim();
    if (t) { hardenTokenFile(f); return t; } // ★ M-9：存量文件同样收紧（幂等）
  } catch { /* 首次运行：下面生成 */ }
  const t = randomBytes(24).toString("hex");
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, t, "utf8");
    hardenTokenFile(f);
  } catch (e) {
    _log("令牌落盘失败（鉴权仍生效）:", e && e.message ? e.message : String(e));
  }
  return t;
}

module.exports = { tokenFilePath, ensureToken };