import { lstat, readdir } from "node:fs/promises";
import {
  type ChangeStatus,
  FILES_BAD_PATH_MESSAGE,
  FILES_SUPERSEDED_MESSAGE,
  FILES_UNAVAILABLE_MESSAGE,
  type FilesDiffResult,
  type FilesReadResult,
  type FilesStatusResult,
  type FilesTreeResult,
  MAX_FILE_BYTES,
  MAX_TREE_ENTRIES,
  type TreeEntry,
  UNKNOWN_SESSION_MESSAGE,
} from "@omp-app/protocol";
import {
  diffBase,
  GitAborted,
  listTracked,
  probeRepo,
  readDiff,
  readNumstat,
  readStatus,
  toChanges,
} from "./files-git";
import { cleanRelative, openRegular, realRootOf, resolveInside } from "./files-path";
import { allAdded, type NumstatEntry, parseUnifiedDiff, totalsOf } from "./git-parse";
import type { Handlers } from "./server";
import type { SessionStore } from "./session-store";

export const FILES_CAPABILITIES = [
  "files.status",
  "files.tree",
  "files.read",
  "files.diff",
] as const;

/** What the handlers need from the omp host. */
export interface FilesControl {
  cwdOf(sessionId: string): string;
}

/** Untracked files whose line counts are read for the changes list; the rest show no counts. */
const MAX_COUNTED_UNTRACKED = 200;
const MAX_COUNTED_BYTES = 256 * 1024;
/** The largest `git diff` kept for one file. */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Text of a file's bytes, or null when they are not valid UTF-8 text (a NUL byte counts as binary). */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

type ReadBytes =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "too_large"; readonly bytes: number }
  | { readonly kind: "refused"; readonly reason: "missing" | "outside_project" | "not_a_file" };

/** Up to `limit` bytes of a regular file inside the project, read through the descriptor that was checked. */
async function readBounded(
  realRoot: string,
  segments: readonly string[],
  limit: number,
): Promise<ReadBytes> {
  const opened = await openRegular(realRoot, segments);
  if (!opened.ok) {
    return {
      kind: "refused",
      reason: opened.reason === "invalid_path" ? "not_a_file" : opened.reason,
    };
  }
  try {
    if (opened.size > limit) return { kind: "too_large", bytes: opened.size };
    const buffer = Buffer.allocUnsafe(limit + 1);
    let filled = 0;
    while (filled <= limit) {
      const { bytesRead } = await opened.handle.read(buffer, filled, limit + 1 - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > limit) return { kind: "too_large", bytes: filled };
    return { kind: "ok", bytes: buffer.subarray(0, filled) };
  } catch {
    return { kind: "refused", reason: "not_a_file" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

function countLines(text: string): number {
  if (text === "") return 0;
  let n = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) n++;
  return text.endsWith("\n") ? n : n + 1;
}

/** Line counts of untracked files, read from disk (git has no diff for them). */
async function countUntracked(
  realRoot: string,
  paths: readonly string[],
): Promise<Map<string, NumstatEntry>> {
  const counts = new Map<string, NumstatEntry>();
  for (const path of paths.slice(0, MAX_COUNTED_UNTRACKED)) {
    const segments = cleanRelative(path, false);
    if (!Array.isArray(segments)) continue;
    const read = await readBounded(realRoot, segments, MAX_COUNTED_BYTES);
    if (read.kind !== "ok") continue;
    const text = decodeText(read.bytes);
    counts.set(
      path,
      text === null
        ? { added: null, removed: null, binary: true }
        : { added: countLines(text), removed: 0, binary: false },
    );
  }
  return counts;
}

/** The entries of one folder from the listing of git's files below it. */
function entriesFromPaths(dir: string, paths: readonly string[]): TreeEntry[] {
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(dir)) continue;
    const rest = path.slice(dir.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.add(rest);
    else dirs.add(rest.slice(0, slash));
  }
  const byName = (a: TreeEntry, b: TreeEntry) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return [
    ...[...dirs].map((name): TreeEntry => ({ name, kind: "dir" })).sort(byName),
    ...[...files]
      .filter((name) => !dirs.has(name))
      .map((name): TreeEntry => ({ name, kind: "file" }))
      .sort(byName),
  ];
}

/** One folder as it is on disk (a symbolic link and `.git` never appear). */
async function entriesFromDisk(absolute: string): Promise<TreeEntry[]> {
  const found = await readdir(absolute, { withFileTypes: true });
  const dirs: TreeEntry[] = [];
  const files: TreeEntry[] = [];
  for (const entry of found) {
    if (entry.name === ".git") continue;
    if (entry.isDirectory()) dirs.push({ name: entry.name, kind: "dir" });
    else if (entry.isFile()) files.push({ name: entry.name, kind: "file" });
  }
  const byName = (a: TreeEntry, b: TreeEntry) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return [...dirs.sort(byName), ...files.sort(byName)];
}

/** Keeps what is still a regular file or a real folder on disk (a tracked file may be deleted or a link). */
async function existing(absolute: string, entries: readonly TreeEntry[]): Promise<TreeEntry[]> {
  const kept: TreeEntry[] = [];
  for (const entry of entries) {
    const info = await lstat(`${absolute}/${entry.name}`).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) kept.push({ name: entry.name, kind: "dir" });
    else if (info.isFile()) kept.push({ name: entry.name, kind: "file" });
  }
  return kept;
}

/** Handlers for the `files.*` methods. Everything here reads; see `methodWrites`. */
export function filesHandlers(
  control: FilesControl,
  store: SessionStore,
): Pick<Required<Handlers>, (typeof FILES_CAPABILITIES)[number]> {
  // Every git child and read of a session runs under a signal that its close fires.
  const live = new Map<string, Set<AbortController>>();
  const hooked = new Set<string>();
  const statusRuns = new Map<string, AbortController>();

  const known = (sessionId: string): string => {
    const id = store.current(sessionId);
    if (!store.has(id) || store.isView(id))
      throw new Error(`${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`);
    return id;
  };

  async function run<T>(
    sessionId: string,
    supersede: boolean,
    work: (id: string, root: string | null, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const id = known(sessionId);
    const controller = new AbortController();
    let set = live.get(id);
    if (!set) {
      set = new Set();
      live.set(id, set);
    }
    set.add(controller);
    if (!hooked.has(id)) {
      hooked.add(id);
      store.onRemove(id, () => {
        for (const c of live.get(id) ?? []) c.abort();
        live.delete(id);
        statusRuns.delete(id);
        hooked.delete(id);
      });
    }
    if (supersede) {
      statusRuns.get(id)?.abort();
      statusRuns.set(id, controller);
    }
    try {
      return await work(id, await realRootOf(control.cwdOf(id)), controller.signal);
    } catch (error) {
      if (error instanceof GitAborted) {
        throw new Error(
          store.has(store.current(id))
            ? FILES_SUPERSEDED_MESSAGE
            : `${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`,
        );
      }
      throw error;
    } finally {
      set.delete(controller);
      if (statusRuns.get(id) === controller) statusRuns.delete(id);
    }
  }

  const segmentsOf = (path: unknown, allowRoot: boolean): string[] => {
    const segments = cleanRelative(path, allowRoot);
    if (!Array.isArray(segments)) throw new Error(FILES_BAD_PATH_MESSAGE);
    return segments;
  };

  return {
    "files.status": ({ sessionId }) =>
      run(sessionId, true, async (_id, root, signal): Promise<FilesStatusResult> => {
        if (root === null) return { state: "missing" };
        const probe = await probeRepo(root, signal);
        if (probe.kind === "not_repo") return { state: "not_repo" };
        if (probe.kind === "timeout") return { state: "timeout" };
        const status = await readStatus(root, probe.prefix, signal);
        if (status.kind === "timeout") return { state: "timeout" };
        const { branch, entries, cut } = status.status;
        const base = await diffBase(root, branch, signal);
        const counts = base === null ? null : await readNumstat(root, base, signal);
        const untracked = await countUntracked(
          root,
          entries.filter((e) => e.status === "?").map((e) => e.path),
        );
        const { changes, truncated } = toChanges(entries, probe.prefix, counts, untracked);
        return {
          state: "ok",
          branch,
          changes,
          totals: totalsOf(entries),
          truncated: truncated || cut,
        };
      }),

    "files.tree": async ({ sessionId, path }) => {
      const segments = segmentsOf(path, true);
      return run(sessionId, false, async (_id, root, signal): Promise<FilesTreeResult> => {
        if (root === null) return { state: "missing" };
        const resolved = await resolveInside(root, segments);
        if (!resolved.ok) {
          return resolved.reason === "missing"
            ? { state: "missing" }
            : { state: "refused", reason: resolved.reason };
        }
        const info = await lstat(resolved.absolute).catch(() => null);
        if (!info?.isDirectory()) return { state: "refused", reason: "not_a_file" };
        const dir = segments.length === 0 ? "" : `${segments.join("/")}/`;
        const probe = await probeRepo(root, signal);
        if (probe.kind === "timeout") return { state: "timeout" };
        let entries: TreeEntry[];
        if (probe.kind === "repo") {
          const listing = await listTracked(root, dir, signal);
          entries =
            listing.kind === "ok"
              ? entriesFromPaths(dir, listing.paths)
              : await entriesFromDisk(resolved.absolute).catch(() => []);
        } else {
          entries = await entriesFromDisk(resolved.absolute).catch(() => []);
        }
        const truncated = entries.length > MAX_TREE_ENTRIES;
        const kept = await existing(resolved.absolute, entries.slice(0, MAX_TREE_ENTRIES));
        return { state: "ok", entries: kept, truncated };
      });
    },

    "files.read": async ({ sessionId, path }) => {
      const segments = segmentsOf(path, false);
      return run(sessionId, false, async (_id, root): Promise<FilesReadResult> => {
        if (root === null) return { state: "refused", reason: "missing" };
        const read = await readBounded(root, segments, MAX_FILE_BYTES);
        if (read.kind === "refused") return { state: "refused", reason: read.reason };
        if (read.kind === "too_large") {
          return { state: "too_large", bytes: read.bytes, limit: MAX_FILE_BYTES };
        }
        const content = decodeText(read.bytes);
        if (content === null) return { state: "binary", bytes: read.bytes.length };
        return { state: "ok", path: segments.join("/"), content, bytes: read.bytes.length };
      });
    },

    "files.diff": async ({ sessionId, path }) => {
      const segments = segmentsOf(path, false);
      return run(sessionId, false, async (_id, root, signal): Promise<FilesDiffResult> => {
        if (root === null) return { state: "refused", reason: "missing" };
        const probe = await probeRepo(root, signal);
        if (probe.kind === "not_repo") return { state: "unchanged" };
        if (probe.kind === "timeout") return { state: "timeout" };
        const relative = segments.join("/");
        const status = await readStatus(root, probe.prefix, signal);
        if (status.kind === "timeout") return { state: "timeout" };
        const entry = status.status.entries.find((e) => e.path === relative);
        if (!entry) return { state: "unchanged" };
        const letter: ChangeStatus = entry.status;
        if (letter === "?") {
          const read = await readBounded(root, segments, MAX_DIFF_BYTES);
          if (read.kind === "refused") return { state: "refused", reason: read.reason };
          if (read.kind === "too_large") return { state: "too_large", status: letter };
          const text = decodeText(read.bytes);
          if (text === null) return { state: "binary", status: letter };
          const parsed = allAdded(text);
          if (parsed.kind !== "rows") return { state: "binary", status: letter };
          return { state: "ok", path: relative, status: letter, ...parsed };
        }
        const base = await diffBase(root, status.status.branch, signal);
        if (base === null) throw new Error(FILES_UNAVAILABLE_MESSAGE);
        const specs = entry.from === undefined ? [relative] : [entry.from, relative];
        const out = await readDiff(root, base, specs, signal, MAX_DIFF_BYTES);
        if (out.kind === "timeout") return { state: "timeout" };
        if (out.kind === "over_cap") return { state: "too_large", status: letter };
        if (out.kind !== "ok") throw new Error(FILES_UNAVAILABLE_MESSAGE);
        const parsed = parseUnifiedDiff(out.stdout.toString("utf8"));
        if (parsed.kind === "binary") return { state: "binary", status: letter };
        return {
          state: "ok",
          path: relative,
          ...(entry.from === undefined ? {} : { from: entry.from }),
          status: letter,
          rows: parsed.rows,
          added: parsed.added,
          removed: parsed.removed,
          truncated: parsed.truncated,
        };
      });
    },
  };
}
