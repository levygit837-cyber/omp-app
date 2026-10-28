import { join } from "node:path";
import { isAskContent, isSessionOpEvent, type SettingsTarget } from "@omp-app/protocol";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import {
  APP_OPEN_LINK,
  MCP_ADD,
  MCP_LIST,
  MCP_REMOVE,
  MCP_REVEAL,
  MCP_SET_ENABLED,
  MCP_UPDATE,
  SESSION_ANSWER_ASK,
  SESSION_ANSWER_PERMISSION,
  SESSION_CANCEL,
  SESSION_CLOSE,
  SESSION_CREATE,
  SESSION_FORK,
  SESSION_LIST,
  SESSION_OP,
  SESSION_PICK_DIRECTORY,
  SESSION_PROMPT,
  SESSION_RESUME,
  SESSION_SUBSCRIBE,
  SESSION_UNSUBSCRIBE,
  SETTINGS_LIST,
  SETTINGS_OPEN,
  SETTINGS_OPEN_FILE,
  SETTINGS_RESET,
  SETTINGS_REVEAL,
  SETTINGS_SET,
  SIDECAR_GET_STATUS,
  SIDECAR_RESTART,
  SIDECAR_STATUS,
  SKILLS_LIST,
  SKILLS_SET_ENABLED,
} from "../shared/channels";
import { flag, mcpSecretRef, mcpServerInput } from "./extensions-input";
import { externalUrl } from "./external-url";
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
  ipcMain.handle(
    SESSION_ANSWER_PERMISSION,
    async (_event, sessionId: unknown, requestId: unknown, optionId: unknown) => {
      await sidecar.request("session.answerPermission", {
        sessionId: text(sessionId, "sessionId"),
        requestId: text(requestId, "requestId"),
        optionId: text(optionId, "optionId"),
      });
    },
  );
  ipcMain.handle(
    SESSION_ANSWER_ASK,
    async (_event, sessionId: unknown, requestId: unknown, action: unknown, content: unknown) => {
      if (action !== "accept" && action !== "decline") throw new Error("action is not valid");
      if (content !== undefined && !isAskContent(content)) throw new Error("content is not valid");
      await sidecar.request("session.answerAsk", {
        sessionId: text(sessionId, "sessionId"),
        requestId: text(requestId, "requestId"),
        action,
        ...(content === undefined ? {} : { content }),
      });
    },
  );
  ipcMain.handle(SESSION_LIST, async () => (await sidecar.request("session.list")).sessions);
  ipcMain.handle(SESSION_RESUME, async (_event, sessionId: unknown) => {
    const opened = await sidecar.request("session.resume", {
      sessionId: text(sessionId, "sessionId"),
    });
    return opened.sessionId;
  });
  ipcMain.handle(SESSION_FORK, async (_event, sessionId: unknown) => {
    const forked = await sidecar.request("session.fork", {
      sessionId: text(sessionId, "sessionId"),
    });
    return forked.sessionId;
  });
  ipcMain.handle(SESSION_CLOSE, async (_event, sessionId: unknown) => {
    await sidecar.request("session.close", { sessionId: text(sessionId, "sessionId") });
  });
}

/**
 * The renderer picks the scope and names a session; main checks the shape before it reaches the
 * sidecar. The project directory is never sent by the renderer: the sidecar takes it from the
 * session (and refuses the home directory there).
 */
function settingsTarget(value: unknown): SettingsTarget {
  if (typeof value !== "object" || value === null) throw new Error("target must be an object");
  const scope: unknown = "scope" in value ? value.scope : undefined;
  if (scope !== "global" && scope !== "project") throw new Error("scope must be global or project");
  const sessionId: unknown = "sessionId" in value ? value.sessionId : undefined;
  if (sessionId === undefined) {
    if (scope === "project") throw new Error("the project scope needs a session");
    return { scope };
  }
  return { scope, sessionId: text(sessionId, "sessionId") };
}

function registerSettingsRelay(sidecar: SidecarSupervisor): void {
  ipcMain.handle(SETTINGS_LIST, (_event, target: unknown) =>
    sidecar.request("settings.list", settingsTarget(target)),
  );
  ipcMain.handle(SETTINGS_SET, (_event, target: unknown, id: unknown, value: unknown) =>
    sidecar.request("settings.set", { ...settingsTarget(target), id: text(id, "id"), value }),
  );
  ipcMain.handle(SETTINGS_RESET, (_event, target: unknown, id: unknown) =>
    sidecar.request("settings.reset", { ...settingsTarget(target), id: text(id, "id") }),
  );
  // No argument: the file is the global config.yml the sidecar reports, never a path from the window.
  ipcMain.handle(SETTINGS_OPEN_FILE, async () => {
    const { files } = await sidecar.request("settings.list", { scope: "global" });
    if ((await shell.openPath(files.global)) !== "") shell.showItemInFolder(files.global);
  });
  ipcMain.handle(SETTINGS_REVEAL, async (_event, target: unknown, id: unknown) => {
    const revealed = await sidecar.request("settings.reveal", {
      ...settingsTarget(target),
      id: text(id, "id"),
    });
    return revealed.value;
  });
}

function registerExtensionsRelay(sidecar: SidecarSupervisor): void {
  ipcMain.handle(MCP_LIST, (_event, target: unknown) =>
    sidecar.request("mcp.list", settingsTarget(target)),
  );
  ipcMain.handle(MCP_ADD, (_event, target: unknown, server: unknown) =>
    sidecar.request("mcp.add", { ...settingsTarget(target), server: mcpServerInput(server) }),
  );
  ipcMain.handle(MCP_UPDATE, (_event, target: unknown, server: unknown) =>
    sidecar.request("mcp.update", { ...settingsTarget(target), server: mcpServerInput(server) }),
  );
  ipcMain.handle(MCP_REMOVE, (_event, target: unknown, name: unknown) =>
    sidecar.request("mcp.remove", { ...settingsTarget(target), name: text(name, "name") }),
  );
  ipcMain.handle(MCP_SET_ENABLED, (_event, target: unknown, name: unknown, enabled: unknown) =>
    sidecar.request("mcp.setEnabled", {
      ...settingsTarget(target),
      name: text(name, "name"),
      enabled: flag(enabled, "enabled"),
    }),
  );
  ipcMain.handle(MCP_REVEAL, async (_event, target: unknown, name: unknown, secret: unknown) => {
    const revealed = await sidecar.request("mcp.reveal", {
      ...settingsTarget(target),
      name: text(name, "name"),
      secret: mcpSecretRef(secret),
    });
    return revealed.value;
  });
  ipcMain.handle(SKILLS_LIST, (_event, sessionId: unknown) =>
    sidecar.request(
      "skills.list",
      sessionId === undefined ? {} : { sessionId: text(sessionId, "sessionId") },
    ),
  );
  ipcMain.handle(
    SKILLS_SET_ENABLED,
    (_event, name: unknown, enabled: unknown, sessionId: unknown) =>
      sidecar.request("skills.setEnabled", {
        name: text(name, "name"),
        enabled: flag(enabled, "enabled"),
        ...(sessionId === undefined ? {} : { sessionId: text(sessionId, "sessionId") }),
      }),
  );
}

function createWindow(): void {
  const win = new BrowserWindow({
    ...platform.windowChrome,
    width: 1440,
    height: 900,
    // Below this the three columns of the design no longer fit.
    minWidth: 960,
    minHeight: 600,
    // Same value as `--color-bg-base` in packages/ui/src/tokens.css, so the window never flashes
    // white before the renderer paints. Main cannot read CSS: change both together.
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
  platform.installMenu({
    openSettings: () => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(SETTINGS_OPEN);
    },
  });
  const sidecar = new SidecarSupervisor({ command: sidecarCommand() });
  supervisor = sidecar;
  registerSettingsRelay(sidecar);
  registerExtensionsRelay(sidecar);
  sidecar.onStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(SIDECAR_STATUS, status);
  });
  ipcMain.handle(APP_OPEN_LINK, async (_event, url: unknown) => {
    const checked = externalUrl(url);
    if (checked === null) return false;
    await shell.openExternal(checked);
    return true;
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
