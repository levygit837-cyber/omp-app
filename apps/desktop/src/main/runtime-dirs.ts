import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `omp-app-<pid of main>-<random>`: the pid is what tells a stale dir from a live one. */
const NAME = /^omp-app-(\d+)-/;

/** Creates the per-launch dir that holds the sidecar socket. */
export function createRuntimeDir(base: string = tmpdir(), pid: number = process.pid): string {
  return mkdtempSync(join(base, `omp-app-${pid}-`));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SweepOptions {
  readonly base?: string;
  /** Only dirs owned by this uid are touched. */
  readonly uid?: number;
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * Removes runtime dirs left behind by an app instance that died without cleaning up
 * (crash, `kill -9`) and whose sidecar did not clean up either. Skips dirs of live
 * processes (including another running app), dirs owned by other users, and anything
 * that is not a real directory. Returns the removed paths.
 */
export function sweepStaleRuntimeDirs(options: SweepOptions = {}): string[] {
  const base = options.base ?? tmpdir();
  const uid = options.uid ?? process.getuid?.();
  const alive = options.isAlive ?? processExists;
  const removed: string[] = [];
  for (const name of readdirSync(base)) {
    const match = NAME.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || alive(pid)) continue;
    const path = join(base, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.uid !== uid) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Raced with the sidecar removing it, or not ours to remove: leave it.
    }
  }
  return removed;
}
