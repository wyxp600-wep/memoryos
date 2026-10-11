"use strict";
const { app, dialog } = require("electron");
const fs = require("node:fs");

/**
 * 应用生命周期（单实例锁 / ready / before-quit / window-all-closed / uncaughtException）。
 * ctx: { kernelDir, nodeExe, findFreePort, readConfig, finalizeStartup, createWelcome,
 *        showMain, setKernel, setPort, setQuitting, killChildren, log }
 */
function createLifecycle(ctx) {
  const {
    kernelDir, nodeExe, findFreePort, readConfig, finalizeStartup, createWelcome,
    showMain, setKernel, setPort, setQuitting, killChildren, log,
  } = ctx;

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => showMain());

  app.whenReady().then(async () => {
    // ★ 2026-10-10 诊断：同 main.js，AUMID 暂撤做 A/B（托盘注册被 Win11 吞，getBounds 恒 0）
    // if (process.platform === "win32") app.setAppUserModelId("com.memoryos.desktop");
    setKernel(kernelDir());
    if (!fs.existsSync(nodeExe())) {
      dialog.showMessageBox({
        type: "error", title: "MemoryOS",
        message: "程序不完整：未找到内核运行时。",
        detail: `缺少 ${nodeExe()}，请重新安装。`,
      });
      app.quit();
      return;
    }
    const cfg = readConfig();
    if (cfg) {
      const port = await findFreePort(8787);
      setPort(port);
      finalizeStartup(cfg);
    } else {
      createWelcome();
    }
  }).catch((e) => {
    log("启动时发生未处理的异常:", e instanceof Error ? e.message : String(e));
    dialog.showMessageBox({ type: "error", title: "MemoryOS", message: "启动失败：\n" + (e instanceof Error ? e.message : String(e)) });
    app.quit();
  });

  app.on("before-quit", () => {
    setQuitting(true);
    killChildren();
  });

  app.on("window-all-closed", () => { /* 托盘驻留，不退出 */ });

  process.on("uncaughtException", (e) => log("未捕获异常:", e));
  process.on("unhandledRejection", (reason) => log("未处理的 Promise 拒绝:", reason instanceof Error ? reason.message : String(reason)));
}

module.exports = { createLifecycle };