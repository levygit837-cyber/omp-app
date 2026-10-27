import { join } from "node:path";
import { isSessionOpEvent } from "@omp-app/protocol";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import {
  SESSION_CANCEL,
  SESSION_CREATE,
  SESSION_OP,
  SESSION_PICK_DIRECTORY,
  SESSION_PROMPT,
  SESSION_SUBSCRIBE,
  SESSION_UNSUBSCRIBE,
  SIDECAR_GET_STATUS,
  SIDECAR_RESTART,
  SIDECAR_STATUS,
} from "../shared/channels";
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

/** IPC arguments come from the renderer: check their shape before they reach the sidecar. */
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a string`);
  return value;
}

/** Main is the single sidecar client; it relays explicit session calls and forwards the ops. */
function registerSessionRelay(sidecar: SidecarSupervisor): void {
  sidecar.onEvent((event) => {
    if (event.name !== "session.op" || !isSessionOpEvent(event.data)) return;
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(SESSION_OP, event.data);
  });
  ipcMain.handle(SESSION_PICK_DIRECTORY, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ["openDirectory" as const, "createDirectory" as const] };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(SESSION_CREATE, async (_event, cwd: unknown) => {
    const created = await sidecar.request("session.create", { cwd: text(cwd, "cwd") });
    return created.sessionId;
  });
  ipcMain.handle(SESSION_SUBSCRIBE, (_event, sessionId: unknown) =>
    sidecar.request("session.subscribe", { sessionId: text(sessionId, "sessionId") }),
  );
  ipcMain.handle(SESSION_UNSUBSCRIBE, async (_event, sessionId: unknown) => {
    await sidecar.request("session.unsubscribe", { sessionId: text(sessionId, "sessionId") });
  });
  ipcMain.handle(SESSION_PROMPT, async (_event, sessionId: unknown, prompt: unknown) => {
    await sidecar.request("session.prompt", {
      sessionId: text(sessionId, "sessionId"),
      text: text(prompt, "text"),
    });
  });
  ipcMain.handle(SESSION_CANCEL, async (_event, sessionId: unknown) => {
    await sidecar.request("session.cancel", { sessionId: text(sessionId, "sessionId") });
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    ...platform.windowChrome,
    width: 1440,
    height: 900,
    // Below this the three columns of the design no longer fit.
    minWidth: 960,
    minHeight: 600,
    // Matches `color-bg-base`, so the window never flashes white before the renderer paints.
    // The main process cannot read the CSS tokens; keep the two in step.
    backgroundColor: "#100908",
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
  // The app is dark only: never follow the system appearance.
  nativeTheme.themeSource = "dark";
  platform.installMenu();
  const sidecar = new SidecarSupervisor({ command: sidecarCommand() });
  supervisor = sidecar;
  sidecar.onStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(SIDECAR_STATUS, status);
  });
  ipcMain.handle(SIDECAR_GET_STATUS, () => sidecar.status);
  ipcMain.handle(SIDECAR_RESTART, () => sidecar.restart());
  registerSessionRelay(sidecar);
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
