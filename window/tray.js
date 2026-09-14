"use strict";
const path = require("node:path");
const { app, Tray, Menu, nativeImage } = require("electron");

/** 托盘（自持 tray） */
let tray = null;

function createTray(o) {
  const { shell, port, TOKEN, trayIconPath, onShowMain, onUpdateCheck, onRestartCore, onRestartMcp, onQuit } = o;
  const img = nativeImage.createFromPath(trayIconPath || path.join(__dirname, "..", "assets", "tray.png"));
  tray = new Tray(img);
  const menu = Menu.buildFromTemplate([
    { label: "打开 MemoryOS", click: () => onShowMain() },
    { label: "在浏览器打开", click: () => shell.openExternal(`http://127.0.0.1:${port}/?token=${encodeURIComponent(TOKEN)}`) },
    { label: "检查更新", click: () => onUpdateCheck() },
    { label: "重启内核", click: () => { if (onRestartCore) onRestartCore(); } },
    // ★ 2026-09-13：整应用重启（relaunch + quit；before-quit 钩子先 killChildren 释放 8787，新实例复用原端口）
        { label: "重启 MCP 服务", click: () => { if (onRestartMcp) onRestartMcp(); } },
    { label: "重新启动", click: () => { app.relaunch(); app.quit(); } },
    { type: "separator" },
    { label: "退出", click: () => { if (onQuit) onQuit(); else app.quit(); } },
  ]);
  tray.setToolTip("MemoryOS 记忆系统");
  tray.setContextMenu(menu);
  tray.on("double-click", () => onShowMain());
  return tray;
}

module.exports = { createTray };