"use strict";
const { ipcMain, app } = require("electron");
const { createLoginStartup } = require("../services/login-startup");

/**
 * 注册主进程 IPC（P0§4：严格校验 event.sender，只接受来自可信窗口的调用）。
 * deps: { getWelcomeWin, onSaveConfig }
 */
function registerIpc(deps) {
  const { getWelcomeWin, onSaveConfig, getMainWin, getPort } = deps;
  const startup = createLoginStartup(app);
  function trustedMain(event) {
    const w = getMainWin && getMainWin();
    if (!w || w.isDestroyed() || event.sender !== w.webContents) return false;
    const frame = event.senderFrame;
    if (!frame || frame !== w.webContents.mainFrame) return false;
    try { return new URL(frame.url).origin === `http://127.0.0.1:${getPort()}`; }
    catch { return false; }
  }
  for (const [channel, action] of [
    ["desktop:login-startup:get", () => startup.read()],
    ["desktop:login-startup:set", (value) => startup.set(value)],
  ]) {
    ipcMain.handle(channel, (event, value) => {
      if (!trustedMain(event)) return { supported: false, enabled: false, error: "仅允许桌面主窗口修改启动设置" };
      try { return action(value); }
      catch (e) { return { supported: true, enabled: false, error: "无法读取或更改 Windows 启动项，请稍后重试。" }; }
    });
  }

  ipcMain.on("welcome-save-config", (e, cfg) => {
    // sender 校验：仅接受 welcome 窗口自身的 webContents 发起的调用
    const w = getWelcomeWin && getWelcomeWin();
    if (!w || w.isDestroyed() || !w.webContents || e.sender.id !== w.webContents.id) {
      return; // 来源不可信，忽略
    }
    onSaveConfig(cfg || {});
  });
}

module.exports = { registerIpc };