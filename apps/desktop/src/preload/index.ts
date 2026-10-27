import type { SessionOpEvent } from "@omp-app/protocol";
import { contextBridge, ipcRenderer } from "electron";
import type { OmpBridge, SidecarStatus } from "../shared/bridge";
import {
  APP_OPEN_LINK,
  SESSION_ANSWER_ASK,
  SESSION_ANSWER_PERMISSION,
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
    prompt: (sessionId, text) => ipcRenderer.invoke(SESSION_PROMPT, sessionId, text),
    cancel: (sessionId) => ipcRenderer.invoke(SESSION_CANCEL, sessionId),
    answerPermission: (sessionId, requestId, optionId) =>
      ipcRenderer.invoke(SESSION_ANSWER_PERMISSION, sessionId, requestId, optionId),
    answerAsk: (sessionId, requestId, action, content) =>
      ipcRenderer.invoke(SESSION_ANSWER_ASK, sessionId, requestId, action, content),
    onOp: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, op: SessionOpEvent) => listener(op);
      ipcRenderer.on(SESSION_OP, handler);
      return () => {
        ipcRenderer.removeListener(SESSION_OP, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld("omp", bridge);
