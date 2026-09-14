"use strict";
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const { portOpen } = require("./port");

/**
 * 内核进程生命周期服务。
 * deps: { nodeExe, getKernel, dataDir, readConfig, getPort, getToken, isQuitting, log, dialog }
 * 内部持有 coreChildren，暴露 startCore / restartCore / killAll。
 */
function createCore(deps) {
  const { nodeExe, getKernel, dataDir, readConfig, getPort, getToken, isQuitting, log, dialog } = deps;
  let coreChildren = [];

  function spawnCore(script, extraEnv) {
    const KERNEL = getKernel();
    const child = spawn(nodeExe(), [path.join(KERNEL, "dist", script)], {
      cwd: KERNEL,
      env: {
        ...process.env,
        MEMORY_DB: path.join(dataDir(), "data", "memory.db"),
        MEMORY_PORT: String(getPort()),
        EMBED_MODE: "local",
        EMBED_CACHE_DIR: path.join(KERNEL, "models"),
        MEMORYOS_SERVER: path.join(KERNEL, "dist", "server.js"),
        MEMORY_TOKEN: getToken(),
        ...(extraEnv || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (d) => log(`[${script}]`, String(d).trimEnd()));
    child.stderr.on("data", (d) => log(`[${script}][err]`, String(d).trimEnd()));
    child.on("exit", (code) => {
      log(`${script} 退出（code=${code}）`);
      if (!isQuitting()) {
        dialog.showMessageBox({
          type: "error", title: "MemoryOS",
          message: `核心服务（${script}）意外退出（code=${code}）。`,
          detail: "可点击托盘图标 → 退出后重新启动应用。",
        });
      }
    });
    coreChildren.push(child);
    return child;
  }

  async function startCore() {
    const cfg = readConfig() || {};
    log(`启动内核（端口 ${getPort()}）…`);
    const llmEnv = {};
    if (cfg.llmUrl) {
      llmEnv.MIMOS_URL = cfg.llmUrl;
      if (cfg.llmModel) llmEnv.INGEST_MODEL = cfg.llmModel;
      if (cfg.llmKey) llmEnv.INGEST_KEY = cfg.llmKey;
    }
    // 受限模式：桌面版默认关闭（MEMORY_RESTRICTED=0）——用户可在「笔记」页自建笔记、
    // 在任务看板建卡。若 config.json 显式写 "restricted": true，则恢复「仅系统采集」。
    llmEnv.MEMORY_RESTRICTED = cfg.restricted === true ? "1" : "0";
    spawnCore("dashboard.js", llmEnv);
    spawnCore("daemon.js", llmEnv);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      await new Promise((r) => setTimeout(r, 400));
      if (await portOpen(getPort())) return;
    }
    throw new Error("内核 60s 未就绪，请查看日志");
  }

  function restartCore() {
    for (const c of coreChildren) {
      try {
        if (process.platform === "win32") execSync(`taskkill /PID ${c.pid} /T /F`, { stdio: "ignore" });
        else c.kill("SIGTERM");
      } catch { /* 已退出 */ }
    }
    coreChildren = [];
    return startCore().then(() => log("内核已重启（热更新生效）"));
  }

  function killAll() {
    for (const c of coreChildren) {
      try {
        if (process.platform === "win32") execSync(`taskkill /PID ${c.pid} /T /F`, { stdio: "ignore" });
        else c.kill("SIGTERM");
      } catch { /* 已退出 */ }
    }
    coreChildren = [];
  }

  return { startCore, restartCore, killAll };
}

module.exports = { createCore };