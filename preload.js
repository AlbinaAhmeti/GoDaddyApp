const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("appAPI", {
  startBot: () => ipcRenderer.invoke("start-bot"),
  stopBot: () => ipcRenderer.invoke("stop-bot"),
  onLog: (callback) => ipcRenderer.on("bot-log", (_, message) => callback(message))
});