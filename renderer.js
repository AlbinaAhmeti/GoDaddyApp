const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const logEl = document.getElementById("log");

function addLog(message) {
  logEl.textContent += message + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

window.appAPI.onLog(addLog);

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  addLog("Starting bot...");
  await window.appAPI.startBot();
  startBtn.disabled = false;
});

stopBtn.addEventListener("click", async () => {
  await window.appAPI.stopBot();
  addLog("Stop requested. The bot will stop after the current domain finishes.");
});