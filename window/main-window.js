"use strict";
const { BrowserWindow, session } = require("electron");

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

  /* P0-3：令牌经 session cookie 注入后再加载裸 URL —— 令牌不出现在地址栏 / 会话历史 / 请求 URL，
     消除内核 302 剥离之前的窗口期。内核已原生支持 cookie 鉴权（dashboard.js installAccessControl，
     与前端 app.js 依赖同源 cookie 的现状一致）。种 cookie 失败则回退旧的 ?token= 方式。 */
  const base = `http://127.0.0.1:${cfg.port}/`;
  if (!cfg.TOKEN) {
    mainWin.loadURL(base);
  } else {
    session.defaultSession.cookies
      .set({ url: base, name: "memoryos_token", value: cfg.TOKEN, httpOnly: true, sameSite: "strict" })
      .then(() => { if (mainWin) mainWin.loadURL(base); })
      .catch(() => { if (mainWin) mainWin.loadURL(`${base}?token=${encodeURIComponent(cfg.TOKEN)}`); });
  }
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