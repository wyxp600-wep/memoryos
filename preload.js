// MemoryOS 桌面版 preload — 仅向引导页暴露保存配置的桥
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("memoryos", {
  saveConfig: (cfg) => ipcRenderer.send("welcome-save-config", cfg),
});