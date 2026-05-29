const { app, BrowserWindow } = require("electron");
const path = require("path");

const PORT = 3456;

function createWindow() {
  process.chdir(__dirname);
  process.env.PORT = PORT;

  require(path.join(__dirname, "server.js"));

  const win = new BrowserWindow({
    width: 1200,
    height: 800
  });

  setTimeout(() => {
    win.loadURL(`http://127.0.0.1:${PORT}`);
  }, 2000);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});