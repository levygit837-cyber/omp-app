import { contextBridge } from "electron";
import type { OmpBridge } from "../shared/bridge";

const bridge: OmpBridge = {
  versions: {
    electron: process.versions.electron ?? "unknown",
    chrome: process.versions.chrome ?? "unknown",
  },
};

contextBridge.exposeInMainWorld("omp", bridge);
