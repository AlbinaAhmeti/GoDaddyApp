const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { runBot, requestStop } = require("./bot");

function createWindow() {
  const win = new BrowserWindow({
    width: 950,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile("index.html");
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle("start-bot", async (event) => {
    try {
      await runBot((message) => {
        event.sender.send("bot-log", message);
      });

      return { ok: true };
    } catch (err) {
      event.sender.send("bot-log", `Fatal error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("stop-bot", async () => {
    requestStop();
    return { ok: true };
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});