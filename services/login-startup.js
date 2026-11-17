"use strict";

// Windows 登录项是唯一真源，不另存一份可能失真的配置。
function createLoginStartup(app, platform = process.platform, execPath = process.execPath) {
  const options = { path: execPath, args: [] };
  function read() {
    if (platform !== "win32") return { supported: false, enabled: false };
    const state = app.getLoginItemSettings(options);
    const blocked = state.openAtLogin && state.executableWillLaunchAtLogin === false;
    return { supported: true, enabled: !!state.openAtLogin && !blocked, blocked: !!blocked };
  }
  function set(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("开机自启参数必须是布尔值");
    if (platform !== "win32") throw new Error("当前系统不支持此开机自启开关");
    app.setLoginItemSettings({ ...options, openAtLogin: enabled, enabled });
    const state = read();
    return { ...state, error: state.enabled !== enabled ? "Windows 未应用此更改，请检查系统的启动应用设置。" : null };
  }
  return { read, set };
}

module.exports = { createLoginStartup };
