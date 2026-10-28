import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { PlanReadResult } from "@omp-app/protocol";
import type { PlanSession } from "./plan-state";

/** A plan is a page of markdown. omp itself shows a `local://` text file only up to this size
 *  [V] internal-urls/local-protocol.ts (`LOCAL_TEXT_RESOURCE_MAX_BYTES`, 1 MiB). */
export const PLAN_MAX_BYTES = 1024 * 1024;

/** `local://name` and the `local:/name` spelling a resumed state can carry. */
const LOCAL_URL = /^local:\/{1,2}(.+)$/;
/** The files omp's own plan lookup lists in the local root [V] plan-mode/plan-files.ts:listPlanFiles. */
const PLAN_NAME = /plan\.md$/i;

/** A file name under the root, or why the path omp reported cannot be one. */
function relativeOf(
  planFilePath: string,
): { rel: string } | Extract<PlanReadResult, { state: "refused" }> {
  const match = LOCAL_URL.exec(planFilePath);
  if (!match?.[1]) return { state: "refused", reason: "not_local" };
  const rel = match[1];
  const escapes =
    rel.startsWith("/") ||
    rel.includes("\\") ||
    rel.includes("\0") ||
    rel.split("/").includes("..");
  return escapes ? { state: "refused", reason: "outside_session" } : { rel };
}

const isEnoent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ||
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOTDIR";

/** Plan files in the root, newest first: omp's own fallback when the agent's file name is not known. */
async function scan(realRoot: string): Promise<string[]> {
  const entries = await readdir(realRoot, { withFileTypes: true }).catch(() => []);
  const plans = await Promise.all(
    entries
      // A symlink is not `isFile()` here, so a link dropped in the root is never listed.
      .filter((entry) => entry.isFile() && PLAN_NAME.test(entry.name))
      .map(async (entry) => ({
        name: entry.name,
        mtime: (await stat(join(realRoot, entry.name)).catch(() => null))?.mtimeMs ?? 0,
      })),
  );
  return plans.sort((a, b) => b.mtime - a.mtime).map((p) => p.name);
}

/** The file at `rel` under the root, or null when it does not exist. */
async function readIn(
  realRoot: string,
  rel: string,
  maxBytes: number,
  enabledAtMs: number | undefined,
): Promise<PlanReadResult | null> {
  const target = join(realRoot, rel);
  let real: string;
  try {
    real = await realpath(target);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  // The real path, so a symlink (the file or a directory on the way) cannot lead out of the root.
  if (!real.startsWith(`${realRoot}${sep}`)) return { state: "refused", reason: "outside_session" };
  const info = await stat(real);
  if (!info.isFile()) return { state: "refused", reason: "not_a_file" };
  const handle = await open(real, "r");
  try {
    // One byte more than the limit tells a file at the limit from one over it, without ever
    // reading more than that, whatever the size on disk.
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return { state: "refused", reason: "too_large" };
    return {
      state: "ok",
      file: `local://${rel}`,
      content: buffer.toString("utf8", 0, bytesRead),
      earlier: enabledAtMs !== undefined && info.mtimeMs < enabledAtMs,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Reads the plan of a session from its `local://` root. `planFilePath` is the path omp holds in
 * its plan-mode state. The agent writes its plan to `local://<slug>-plan.md` and only tells omp
 * the slug [V] prompts/system/plan-mode-active.md:7, so omp finds the file by listing the root
 * newest first [V] plan-mode/approved-plan.ts:resolveApprovedPlan. This does the same, with the
 * state path first when it is not among the listed files.
 */
export async function readPlanFrom(options: {
  localRoot: string;
  planFilePath: string | null;
  maxBytes?: number;
  /** When plan mode was turned on; a plan last written before that is reported as `earlier`. */
  enabledAtMs?: number;
}): Promise<PlanReadResult> {
  const maxBytes = options.maxBytes ?? PLAN_MAX_BYTES;
  if (options.planFilePath === null) return { state: "missing" };
  const named = relativeOf(options.planFilePath);
  if ("state" in named) return named;
  let realRoot: string;
  try {
    realRoot = await realpath(options.localRoot);
  } catch (error) {
    if (isEnoent(error)) return { state: "missing" };
    throw error;
  }
  const listed = await scan(realRoot);
  const order = listed.includes(named.rel) ? listed : [named.rel, ...listed];
  for (const rel of order) {
    const found = await readIn(realRoot, rel, maxBytes, options.enabledAtMs);
    if (found) return found;
  }
  return { state: "missing" };
}

/** The plan of a live session, from the plan path omp reports for it right now. */
export function readPlanOf(
  session: PlanSession,
  planFilePath: string | null,
  enabledAtMs?: number,
) {
  const localRoot = resolveLocalRoot({
    getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
    getSessionId: () => session.sessionManager.getSessionId(),
  });
  return readPlanFrom({
    localRoot,
    planFilePath,
    ...(enabledAtMs === undefined ? {} : { enabledAtMs }),
  });
}
