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
    if (process.platform === "win32") app.setAppUserModelId("com.memoryos.desktop");
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
    if (readConfig()) {
      const port = await findFreePort(8787);
      setPort(port);
      finalizeStartup(readConfig());
    } else {
      createWelcome();
    }
  });

  app.on("before-quit", () => {
    setQuitting(true);
    killChildren();
  });

  app.on("window-all-closed", () => { /* 托盘驻留，不退出 */ });

  process.on("uncaughtException", (e) => log("未捕获异常:", e));
}

module.exports = { createLifecycle };