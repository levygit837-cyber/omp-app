import { constants } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { type FileRefusal, MAX_FILE_PATH_CHARS } from "@omp-app/protocol";

/**
 * A path from the window, as segments, or the reason it is not one. The window only ever sends a
 * path it saw in a listing, so anything odd is refused rather than repaired: `..` and `.`
 * segments, an absolute path, an empty segment (`a//b`, a trailing `/`), a NUL byte, a path
 * over the cap, and any segment named `.git` (the repository's own files are never served).
 * The empty string is the project root, which only `allowRoot` callers (the tree) accept.
 */
export function cleanRelative(path: unknown, allowRoot: boolean): string[] | FileRefusal {
  if (typeof path !== "string" || path.length > MAX_FILE_PATH_CHARS || path.includes("\0")) {
    return "invalid_path";
  }
  if (path === "") return allowRoot ? [] : "invalid_path";
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment === ".git") {
      return "invalid_path";
    }
  }
  return segments;
}

export type Resolved =
  | { readonly ok: true; readonly absolute: string }
  | { readonly ok: false; readonly reason: FileRefusal };

/**
 * `segments` under `realRoot` (already a `realpath`), when the path exists and no symbolic link
 * lies anywhere on it: the real path of the result must equal the lexical one. A link that points
 * inside the project is refused too; the listings never offer one, so nothing legitimate is lost,
 * and "no link on the way" is a rule that needs no reasoning about where a link leads.
 */
export async function resolveInside(
  realRoot: string,
  segments: readonly string[],
): Promise<Resolved> {
  const lexical = segments.length === 0 ? realRoot : join(realRoot, ...segments);
  let real: string;
  try {
    real = await realpath(lexical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "outside_project",
    };
  }
  if (real !== lexical) return { ok: false, reason: "outside_project" };
  return { ok: true, absolute: lexical };
}

/** The real path of the session folder, or null when it is gone (or is not a folder). */
export async function realRootOf(cwd: string): Promise<string | null> {
  try {
    const real = await realpath(cwd);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export type OpenedFile =
  | { readonly ok: true; readonly handle: FileHandle; readonly size: number }
  | { readonly ok: false; readonly reason: FileRefusal };

/**
 * Opens a regular file inside the project for reading. `O_NOFOLLOW` makes the open itself refuse
 * a link at the last segment (no window between a check and the open); `O_NONBLOCK` keeps a named
 * pipe from hanging the open. After the open the descriptor is checked against the path again:
 * it must be a regular file, and the path must still resolve to the same file with no link on
 * the way, so a folder swapped for a link in between is caught. The remaining window is the
 * time between this check and the read, and the read only ever goes through the descriptor.
 */
export async function openRegular(
  realRoot: string,
  segments: readonly string[],
): Promise<OpenedFile> {
  const before = await resolveInside(realRoot, segments);
  if (!before.ok) return before;
  let handle: FileHandle;
  try {
    handle = await open(
      before.absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === "ENOENT" ? "missing" : code === "ELOOP" ? "outside_project" : "not_a_file",
    };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return { ok: false, reason: "not_a_file" };
    }
    const after = await resolveInside(realRoot, segments);
    const same = after.ok && (await stat(after.absolute).catch(() => null))?.ino === info.ino;
    if (!after.ok || !same) {
      await handle.close();
      return { ok: false, reason: after.ok ? "outside_project" : after.reason };
    }
    return { ok: true, handle, size: info.size };
  } catch {
    await handle.close().catch(() => {});
    return { ok: false, reason: "not_a_file" };
  }
}
