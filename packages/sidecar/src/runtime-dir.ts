import { rmSync } from "node:fs";
import { basename, dirname } from "node:path";

/** Name main gives the per-launch dir that holds the socket: `omp-app-<main pid>-<random>`. */
const RUNTIME_DIR = /^omp-app-\d+-/;

/**
 * Removes the per-launch runtime dir that holds the socket. If main dies without cleaning up
 * (crash, `kill -9`), the sidecar is the last one alive to do it. A socket placed in any other
 * directory only loses the socket file: that parent is not ours to delete.
 */
export function removeRuntimeDir(socketPath: string): void {
  const dir = dirname(socketPath);
  if (RUNTIME_DIR.test(basename(dir))) rmSync(dir, { recursive: true, force: true });
  else rmSync(socketPath, { force: true });
}
