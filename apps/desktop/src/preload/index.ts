import { contextBridge } from "electron";

/** Surface exposed to the renderer as `window.omp`. Empty until the protocol lands. */
export type OmpBridge = Record<string, never>;

const bridge: OmpBridge = {};

contextBridge.exposeInMainWorld("omp", bridge);
