import { basename } from "node:path";

/** The prefix of the temp project folder each live run makes. */
export const LIVE_PROJECT_PREFIX = "omp-app-live-project-";

/**
 * Whether `sessionDir` is the session directory omp made for `cwd`, the temp project of one live
 * run. omp names that directory after the path, in a form that depends on where the path is: the
 * temp root gives `-tmp-<rest>`, a path outside the temp root and home gives `--<path>--`
 * (session-paths.ts getDefaultSessionDirName [V]). Both forms end in the folder name (the second
 * before its closing `--`), which carries a random suffix: that holds for this run only, and
 * never for a real project's sessions.
 */
export function ownsLiveSessionDir(sessionDir: string, cwd: string): boolean {
  const project = basename(cwd);
  const name = basename(sessionDir);
  return (
    project.startsWith(LIVE_PROJECT_PREFIX) &&
    (name.endsWith(project) || name.endsWith(`${project}--`))
  );
}

/**
 * Stops the sidecar and only then removes the folders it writes into. The sidecar saves its
 * session file while it shuts down, so a removal that does not wait for its exit can run first
 * and leave a session directory behind. The wait is bounded: a sidecar that never exits must not
 * keep the run (or a Ctrl-C) hanging, and the folders are removed anyway.
 */
export async function stopThenClean(steps: {
  readonly stop: () => void;
  readonly exited: Promise<unknown>;
  readonly clean: () => void;
  readonly waitMs: number;
}): Promise<"exited" | "timed_out"> {
  steps.stop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), steps.waitMs);
  });
  try {
    return await Promise.race([steps.exited.then(() => "exited" as const), timeout]);
  } finally {
    clearTimeout(timer);
    steps.clean();
  }
}
