import type { SessionOpEvent } from "@omp-app/protocol";
import { contextBridge, ipcRenderer } from "electron";
import type { OmpBridge, SidecarStatus } from "../shared/bridge";
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
  SESSION_FILES,
  SESSION_FORK,
  SESSION_LIST,
  SESSION_MODELS,
  SESSION_OP,
  SESSION_PICK_DIRECTORY,
  SESSION_PROMPT,
  SESSION_REMOVE_QUEUED,
  SESSION_RESUME,
  SESSION_SET_MODEL,
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
} from "../shared/channels";

const bridge: OmpBridge = {
  versions: {
    electron: process.versions.electron ?? "unknown",
    chrome: process.versions.chrome ?? "unknown",
  },
  app: {
    openLink: (url) => ipcRenderer.invoke(APP_OPEN_LINK, url),
  },
  sidecar: {
    getStatus: () => ipcRenderer.invoke(SIDECAR_GET_STATUS),
    onStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: SidecarStatus) =>
        listener(status);
      ipcRenderer.on(SIDECAR_STATUS, handler);
      return () => {
        ipcRenderer.removeListener(SIDECAR_STATUS, handler);
      };
    },
    restart: () => ipcRenderer.invoke(SIDECAR_RESTART),
  },
  session: {
    pickDirectory: () => ipcRenderer.invoke(SESSION_PICK_DIRECTORY),
    create: (cwd) => ipcRenderer.invoke(SESSION_CREATE, cwd),
    subscribe: (sessionId) => ipcRenderer.invoke(SESSION_SUBSCRIBE, sessionId),
    unsubscribe: (sessionId) => ipcRenderer.invoke(SESSION_UNSUBSCRIBE, sessionId),
    prompt: (sessionId, text, options) =>
      ipcRenderer.invoke(SESSION_PROMPT, sessionId, text, options),
    models: (sessionId) => ipcRenderer.invoke(SESSION_MODELS, sessionId),
    setModel: (sessionId, model) => ipcRenderer.invoke(SESSION_SET_MODEL, sessionId, model),
    setThinking: (sessionId, level) => ipcRenderer.invoke(SESSION_SET_THINKING, sessionId, level),
    removeQueued: (sessionId, queue, text) =>
      ipcRenderer.invoke(SESSION_REMOVE_QUEUED, sessionId, queue, text),
    files: (sessionId, query) => ipcRenderer.invoke(SESSION_FILES, sessionId, query),
    cancel: (sessionId) => ipcRenderer.invoke(SESSION_CANCEL, sessionId),
    answerPermission: (sessionId, requestId, optionId) =>
      ipcRenderer.invoke(SESSION_ANSWER_PERMISSION, sessionId, requestId, optionId),
    answerAsk: (sessionId, requestId, action, content) =>
      ipcRenderer.invoke(SESSION_ANSWER_ASK, sessionId, requestId, action, content),
    list: () => ipcRenderer.invoke(SESSION_LIST),
    resume: (sessionId) => ipcRenderer.invoke(SESSION_RESUME, sessionId),
    fork: (sessionId) => ipcRenderer.invoke(SESSION_FORK, sessionId),
    close: (sessionId) => ipcRenderer.invoke(SESSION_CLOSE, sessionId),
    onOp: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, op: SessionOpEvent) => listener(op);
      ipcRenderer.on(SESSION_OP, handler);
      return () => {
        ipcRenderer.removeListener(SESSION_OP, handler);
      };
    },
  },
  settings: {
    list: (target) => ipcRenderer.invoke(SETTINGS_LIST, target),
    set: (target, id, value) => ipcRenderer.invoke(SETTINGS_SET, target, id, value),
    reset: (target, id) => ipcRenderer.invoke(SETTINGS_RESET, target, id),
    reveal: (target, id) => ipcRenderer.invoke(SETTINGS_REVEAL, target, id),
    openConfigFile: () => ipcRenderer.invoke(SETTINGS_OPEN_FILE),
    onOpenRequested: (listener) => {
      const handler = () => listener();
      ipcRenderer.on(SETTINGS_OPEN, handler);
      return () => {
        ipcRenderer.removeListener(SETTINGS_OPEN, handler);
      };
    },
  },
  mcp: {
    list: (target) => ipcRenderer.invoke(MCP_LIST, target),
    add: (target, server) => ipcRenderer.invoke(MCP_ADD, target, server),
    update: (target, server) => ipcRenderer.invoke(MCP_UPDATE, target, server),
    remove: (target, name) => ipcRenderer.invoke(MCP_REMOVE, target, name),
    setEnabled: (target, name, enabled) =>
      ipcRenderer.invoke(MCP_SET_ENABLED, target, name, enabled),
    reveal: (target, name, secret) => ipcRenderer.invoke(MCP_REVEAL, target, name, secret),
  },
  skills: {
    list: (sessionId) => ipcRenderer.invoke(SKILLS_LIST, sessionId),
    setEnabled: (name, enabled, sessionId) =>
      ipcRenderer.invoke(SKILLS_SET_ENABLED, name, enabled, sessionId),
  },
};

contextBridge.exposeInMainWorld("omp", bridge);
