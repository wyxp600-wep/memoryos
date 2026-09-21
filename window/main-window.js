"use strict";
const { BrowserWindow } = require("electron");

/** 主窗口管理（自持 mainWin 与一次性配置） */
let mainWin = null;
let cfg = { port: 0, TOKEN: "", shell: null };

/** 启动时注入端口/令牌（showMain 可能先于 createMainWindow 被触发，需要兜底配置） */
function prepareMainWindow(o) {
  if (o) cfg = { ...cfg, ...o };
  return cfg;
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1080, minHeight: 680,
    autoHideMenuBar: true, backgroundColor: "#0b1020", title: "MemoryOS", show: false,
    /* P0 加固：显式声明安全基线（与 Electron 20+ 默认一致，防未来默认漂移；对齐 welcome-window 风格） */
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWin.loadURL(`http://127.0.0.1:${cfg.port}/?token=${encodeURIComponent(cfg.TOKEN)}`);
  mainWin.once("ready-to-show", () => mainWin.show());
  mainWin.on("close", (e) => { if (!(cfg.isQuitting && cfg.isQuitting())) { e.preventDefault(); mainWin.hide(); } });
  mainWin.on("closed", () => (mainWin = null));
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) cfg.shell.openExternal(url);
    return { action: "deny" };
  });
  mainWin.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${cfg.port}/`)) e.preventDefault();
  });
}

function showMain() {
  if (!mainWin) createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function getMainWindow() {
  return mainWin;
}

module.exports = { prepareMainWindow, createMainWindow, showMain, getMainWindow };