import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { SIDECAR_GET_STATUS, SIDECAR_RESTART, SIDECAR_STATUS } from "../shared/channels";
import { platform } from "./platform";
import { SidecarSupervisor } from "./sidecar-supervisor";

const devUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = join(import.meta.dirname, "../renderer/index.html");

/** The only origin the window may navigate to: the dev server or the packaged renderer file. */
function isAppUrl(url: string): boolean {
  if (devUrl) return new URL(url).origin === new URL(devUrl).origin;
  const parsed = new URL(url);
  return parsed.protocol === "file:" && decodeURIComponent(parsed.pathname) === rendererFile;
}

const SIDECAR_BINARY = "omp-app-sidecar";

/**
 * Packaged: shipped as an extra resource. Dev: the binary built by `bun run build:sidecar`;
 * `OMP_APP_SIDECAR_BIN` overrides it (never honoured in a packaged app).
 */
function sidecarCommand(): string {
  if (app.isPackaged) return join(process.resourcesPath, SIDECAR_BINARY);
  return (
    process.env.OMP_APP_SIDECAR_BIN ??
    join(app.getAppPath(), "../../packages/sidecar/dist", SIDECAR_BINARY)
  );
}

let supervisor: SidecarSupervisor | undefined;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(rendererFile);
  }
}

app.whenReady().then(() => {
  const sidecar = new SidecarSupervisor({ command: sidecarCommand() });
  supervisor = sidecar;
  sidecar.onStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(SIDECAR_STATUS, status);
  });
  ipcMain.handle(SIDECAR_GET_STATUS, () => sidecar.status);
  ipcMain.handle(SIDECAR_RESTART, () => sidecar.restart());
  void sidecar.start();

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (platform.quitWhenAllWindowsClosed) app.quit();
});

// Quit only after the sidecar is gone, so no process outlives the app.
let sidecarStopped = false;
app.on("before-quit", (event) => {
  if (sidecarStopped || !supervisor) return;
  event.preventDefault();
  void supervisor.stop().finally(() => {
    sidecarStopped = true;
    app.quit();
  });
});

// If main dies without `before-quit` (crash), kill the child synchronously. The sidecar also
// exits by itself when its socket closes or its parent changes.
process.on("exit", () => supervisor?.killNow());
