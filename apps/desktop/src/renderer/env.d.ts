import type { OmpBridge } from "../shared/bridge";

declare global {
  interface Window {
    omp: OmpBridge;
  }
}
