"use strict";
const path = require("node:path");
const { BrowserWindow } = require("electron");

/** 首次配置（welcome）窗口，自持 welcomeWin。 */
let welcomeWin = null;
let saved = false;
let h = { readConfig: () => null, finalizeStartup: () => {}, preloadPath: "" };

function createWelcomeWindow(opts) {
  saved = false;
  if (opts) h = { ...h, ...opts };
  welcomeWin = new BrowserWindow({
    width: 560, height: 640, resizable: false, autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    backgroundColor: "#0b1020", title: "MemoryOS 首次配置",
    webPreferences: {
      preload: h.preloadPath || path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  welcomeWin.loadFile(path.join(__dirname, "..", "welcome.html"));
  welcomeWin.on("closed", () => {
    welcomeWin = null;
    if (!saved && !h.readConfig()) Promise.resolve(h.finalizeStartup({})).catch((e) => {
      require("electron").dialog.showErrorBox("MemoryOS 启动失败", e.message);
    });
  });
  return welcomeWin;
}

function getWelcomeWindow() {
  return welcomeWin;
}

function closeWelcomeWindow() {
  saved = true;
  if (welcomeWin) welcomeWin.close();
}

module.exports = { createWelcomeWindow, getWelcomeWindow, closeWelcomeWindow };