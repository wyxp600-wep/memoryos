"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

/**
 * 周期调度服务：共享记忆同步 + 自动增量采集。
 * deps: { nodeExe, getKernel, dataDir, log }
 * 内部闭包持有 __syncing / __ingesting 防重入。
 */
function createScheduler(deps) {
  const { nodeExe, getKernel, dataDir, log } = deps;

  /* ---------- 共享记忆同步（免 LLM 直读 jsonl → 桌面库，幂等增量） ---------- */
  let __syncing = false;
  async function runSharedSync() {
    if (__syncing) return;
    __syncing = true;
    try {
      const localScript = path.resolve(__dirname, "..", "shared-sync.mjs");
      const syncScript = fs.existsSync(localScript) ? localScript : path.join(process.resourcesPath, "shared-sync.mjs");
      if (!fs.existsSync(syncScript)) { log("共享记忆同步：脚本不存在，跳过", syncScript); __syncing = false; return; }
      const KERNEL = getKernel();
      const child = spawn(nodeExe(), [syncScript], { cwd: path.dirname(syncScript), env: { ...process.env, SYNC_DIST_DIR: path.join(KERNEL, "dist"), SYNC_MODELS_DIR: path.join(KERNEL, "models") }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let out = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (out += String(d)));
      child.on("error", (e) => log("共享记忆同步启动失败:", e.message));
      child.on("exit", (code) => { log("共享记忆同步", code === 0 ? "完成" : `退出码 ${code}`, out.trimEnd() || ""); __syncing = false; });
    } catch (e) {
      log("共享记忆同步异常:", String(e.message || e));
      __syncing = false;
    }
  }
  function scheduleSharedSync() {
    const ms = Math.max(60, Number(process.env.SHARED_SYNC_INTERVAL_MIN ?? 30) || 30) * 60 * 1000;
    setTimeout(runSharedSync, 5 * 1000);
    setInterval(runSharedSync, ms);
  }

  /* ---------- 自动增量采集 ---------- */
  let __ingesting = false;
  async function runAutoIngest() {
    if (__ingesting) return;
    __ingesting = true;
    try {
      const KERNEL = getKernel();
      const script = path.join(KERNEL, "dist", "ingest-cli.js");
      if (!fs.existsSync(script)) { log("自动采集：ingest-cli.js 不存在，跳过"); __ingesting = false; return; }
      const child = spawn(nodeExe(), [script, "--incremental"], {
        cwd: KERNEL,
        env: { ...process.env, MEMORY_DB: path.join(dataDir(), "data", "memory.db"), EMBED_MODE: "local", EMBED_CACHE_DIR: path.join(KERNEL, "models") },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (out += String(d)));
      child.on("error", (e) => { log("自动采集启动失败:", e.message); __ingesting = false; });
      child.on("exit", (code) => {
        const brief = out.trimEnd().split("\n").filter((l) => l.includes("[ingest")).pop() || "";
        log("自动采集", code === 0 ? "完成" : `退出码 ${code}`, brief);
        __ingesting = false;
      });
    } catch (e) {
      log("自动采集异常:", String(e.message || e));
      __ingesting = false;
    }
  }
  function scheduleAutoIngest() {
    const min = Math.max(1, Number(process.env.INGEST_INTERVAL_MIN ?? 5) || 5);
    setTimeout(runAutoIngest, 90 * 1000);
    setInterval(runAutoIngest, min * 60 * 1000);
    log(`自动采集已调度：每 ${min} 分钟增量一次（INGEST_INTERVAL_MIN 可调）`);
  }

  return { scheduleSharedSync, scheduleAutoIngest };
}

module.exports = { createScheduler };