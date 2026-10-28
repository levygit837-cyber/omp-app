import { join } from "node:path";
import {
  FILES_BAD_PATH_MESSAGE,
  IMAGE_REFUSED_MESSAGE,
  isAskContent,
  isPromptImage,
  isSessionOpEvent,
  MAX_FILE_PATH_CHARS,
  MAX_FILE_QUERY_CHARS,
  type PromptImage,
  refuseImages,
  type SettingsTarget,
} from "@omp-app/protocol";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import {
  AGENTS_PAUSE_STATE,
  AGENTS_SET_PAUSED,
  APP_OPEN_LINK,
  FILES_DIFF,
  FILES_READ,
  FILES_STATUS,
  FILES_TREE,
  JOB_CANCEL,
  MCP_ADD,
  MCP_LIST,
  MCP_REMOVE,
  MCP_REVEAL,
  MCP_SET_ENABLED,
  MCP_UPDATE,
  PALETTE_OPEN,
  SESSION_ANSWER_ASK,
  SESSION_ANSWER_PERMISSION,
  SESSION_CANCEL,
  SESSION_CLEAR_CONTEXT,
  SESSION_CLOSE,
  SESSION_COMMANDS,
  SESSION_CREATE,
  SESSION_DELETE,
  SESSION_DELETE_PREVIEW,
  SESSION_FILES,
  SESSION_FORK,
  SESSION_LIST,
  SESSION_MODELS,
  SESSION_OP,
  SESSION_PICK_DIRECTORY,
  SESSION_PROMPT,
  SESSION_READ_PLAN,
  SESSION_REMOVE_QUEUED,
  SESSION_RESUME,
  SESSION_RUN_COMMAND,
  SESSION_SET_MODEL,
  SESSION_SET_PLAN_MODE,
  SESSION_SET_THINKING,
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
  SUBAGENT_CANCEL,
} from "../shared/channels";
import { flag, mcpSecretRef, mcpServerInput } from "./extensions-input";
import { externalUrl } from "./external-url";
import { ipcId } from "./ipc-id";
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

/**
 * What a prompt may carry, checked here because the renderer is untrusted. Text may be empty
 * only when images go with it. Images are re-checked for count, type, shape and size.
 */
function promptOptions(
  value: unknown,
  prompt: unknown,
): { delivery?: "steer" | "followUp"; images?: PromptImage[] } {
  const options = value === undefined || value === null ? {} : value;
  if (typeof options !== "object") throw new Error("options must be an object");
  const delivery: unknown = "delivery" in options ? options.delivery : undefined;
  if (delivery !== undefined && delivery !== "steer" && delivery !== "followUp") {
    throw new Error("delivery is not valid");
  }
  const images: unknown = "images" in options ? options.images : undefined;
  if (images !== undefined && !(Array.isArray(images) && images.every(isPromptImage))) {
    throw new Error("images are not valid");
  }
  const refusal = images === undefined ? null : refuseImages(images);
  if (refusal) throw new Error(`${IMAGE_REFUSED_MESSAGE}: ${refusal}`);
  if (typeof prompt !== "string") throw new Error("text must be a string");
  if (prompt.length === 0 && (images === undefined || images.length === 0)) {
    throw new Error("text must be a string");
  }
  return {
    ...(delivery === undefined ? {} : { delivery }),
    ...(images === undefined ? {} : { images }),
  };
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
  ipcMain.handle(
    SESSION_PROMPT,
    async (_event, sessionId: unknown, prompt: unknown, options: unknown) => {
      const extras = promptOptions(options, prompt);
      await sidecar.request("session.prompt", {
        sessionId: text(sessionId, "sessionId"),
        text: prompt as string,
        ...extras,
      });
    },
  );
  ipcMain.handle(
    SESSION_MODELS,
    async (_event, sessionId: unknown) =>
      (await sidecar.request("session.models", { sessionId: text(sessionId, "sessionId") })).models,
  );
  ipcMain.handle(SESSION_SET_MODEL, async (_event, sessionId: unknown, model: unknown) => {
    await sidecar.request("session.setModel", {
      sessionId: text(sessionId, "sessionId"),
      model: text(model, "model"),
    });
  });
  ipcMain.handle(SESSION_SET_THINKING, async (_event, sessionId: unknown, level: unknown) => {
    await sidecar.request("session.setThinking", {
      sessionId: text(sessionId, "sessionId"),
      level: text(level, "level"),
    });
  });
  ipcMain.handle(
    SESSION_REMOVE_QUEUED,
    async (_event, sessionId: unknown, queue: unknown, entry: unknown) => {
      if (queue !== "steering" && queue !== "followUp") throw new Error("queue is not valid");
      const result = await sidecar.request("session.removeQueued", {
        sessionId: text(sessionId, "sessionId"),
        queue,
        text: text(entry, "text"),
      });
      return result.removed;
    },
  );
  ipcMain.handle(SESSION_FILES, async (_event, sessionId: unknown, query: unknown) => {
    if (typeof query !== "string" || query.length > MAX_FILE_QUERY_CHARS) {
      throw new Error("query is not valid");
    }
    const result = await sidecar.request("session.files", {
      sessionId: text(sessionId, "sessionId"),
      query,
    });
    return { files: result.files, truncated: result.truncated === true };
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
  ipcMain.handle(SESSION_SET_PLAN_MODE, async (_event, sessionId: unknown, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
    await sidecar.request("session.setPlanMode", {
      sessionId: text(sessionId, "sessionId"),
      enabled,
    });
  });
  // No path crosses this call: the sidecar reads the plan path from omp's own state.
  ipcMain.handle(SESSION_READ_PLAN, (_event, sessionId: unknown) =>
    sidecar.request("session.readPlan", { sessionId: text(sessionId, "sessionId") }),
  );
  ipcMain.handle(SUBAGENT_CANCEL, async (_event, sessionId: unknown, subagentId: unknown) => {
    const result = await sidecar.request("subagent.cancel", {
      sessionId: ipcId(sessionId, "sessionId"),
      subagentId: ipcId(subagentId, "subagentId"),
    });
    return result.cancelled;
  });
  ipcMain.handle(JOB_CANCEL, async (_event, sessionId: unknown, jobId: unknown) => {
    const result = await sidecar.request("job.cancel", {
      sessionId: ipcId(sessionId, "sessionId"),
      jobId: ipcId(jobId, "jobId"),
    });
    return result.cancelled;
  });
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
  // The sidecar enforces `confirmed`; main only passes a literal `true` through.
  ipcMain.handle(SESSION_CLEAR_CONTEXT, (_event, sessionId: unknown, confirmed: unknown) =>
    sidecar.request("session.clearContext", {
      sessionId: text(sessionId, "sessionId"),
      ...(confirmed === true ? { confirmed } : {}),
    }),
  );
  ipcMain.handle(SESSION_DELETE_PREVIEW, (_event, sessionId: unknown) =>
    sidecar.request("session.deletePreview", { sessionId: text(sessionId, "sessionId") }),
  );
  ipcMain.handle(SESSION_DELETE, (_event, sessionId: unknown, confirmed: unknown) =>
    sidecar.request("session.delete", {
      sessionId: text(sessionId, "sessionId"),
      ...(confirmed === true ? { confirmed } : {}),
    }),
  );
  ipcMain.handle(AGENTS_PAUSE_STATE, () => sidecar.request("agents.pauseState"));
  ipcMain.handle(
    AGENTS_SET_PAUSED,
    (_event, sessionId: unknown, paused: unknown, confirmed: unknown) => {
      if (typeof paused !== "boolean") throw new Error("paused must be true or false");
      return sidecar.request("agents.setPaused", {
        sessionId: text(sessionId, "sessionId"),
        paused,
        ...(confirmed === true ? { confirmed } : {}),
      });
    },
  );
  ipcMain.handle(
    SESSION_COMMANDS,
    async (_event, sessionId: unknown) =>
      (await sidecar.request("session.commands", { sessionId: text(sessionId, "sessionId") }))
        .commands,
  );
  ipcMain.handle(
    SESSION_RUN_COMMAND,
    async (_event, sessionId: unknown, line: unknown, confirmed: unknown) => {
      const lineText = text(line, "text");
      // The sidecar decides what is a builtin; this only keeps a stray string from being a line.
      if (!lineText.startsWith("/")) throw new Error("text must start with a slash");
      await sidecar.request("session.runCommand", {
        sessionId: text(sessionId, "sessionId"),
        text: lineText,
        // Only a literal `true` is an answer; the sidecar checks whether one was needed.
        ...(confirmed === true ? { confirmed } : {}),
      });
    },
  );
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
  // The Files page. The window names a session and a path RELATIVE to that session's folder; the
  // sidecar resolves it against the folder it owns and refuses anything that leaves it.
  const relativePath = (value: unknown): string => {
    if (typeof value !== "string" || value.length > MAX_FILE_PATH_CHARS) {
      throw new Error(FILES_BAD_PATH_MESSAGE);
    }
    return value;
  };
  ipcMain.handle(FILES_STATUS, (_event, sessionId: unknown) =>
    sidecar.request("files.status", { sessionId: ipcId(sessionId, "sessionId") }),
  );
  ipcMain.handle(FILES_TREE, (_event, sessionId: unknown, path: unknown) =>
    sidecar.request("files.tree", {
      sessionId: ipcId(sessionId, "sessionId"),
      path: relativePath(path),
    }),
  );
  ipcMain.handle(FILES_READ, (_event, sessionId: unknown, path: unknown) =>
    sidecar.request("files.read", {
      sessionId: ipcId(sessionId, "sessionId"),
      path: relativePath(path),
    }),
  );
  ipcMain.handle(FILES_DIFF, (_event, sessionId: unknown, path: unknown) =>
    sidecar.request("files.diff", {
      sessionId: ipcId(sessionId, "sessionId"),
      path: relativePath(path),
    }),
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
    openPalette: () => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(PALETTE_OPEN);
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
