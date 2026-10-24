import { contextBridge, ipcRenderer } from "electron";
import type { OmpBridge, SidecarStatus } from "../shared/bridge";
import { SIDECAR_GET_STATUS, SIDECAR_RESTART, SIDECAR_STATUS } from "../shared/channels";

const bridge: OmpBridge = {
  versions: {
    electron: process.versions.electron ?? "unknown",
    chrome: process.versions.chrome ?? "unknown",
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
};

contextBridge.exposeInMainWorld("omp", bridge);
