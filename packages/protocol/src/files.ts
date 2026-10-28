/**
 * The Files page: git state, the project tree and read-only file views of the session's folder.
 * Every method here only reads. The caller names no folder: the sidecar takes the root from the
 * session it already owns. The one thing a caller names is a path RELATIVE to that root (a node
 * it saw in a listing); the sidecar validates it, resolves it with `realpath` and refuses
 * anything that is not exactly the file inside the project (`..`, absolute, a symbolic link on
 * the way).
 */
import { isRecord } from "./guards";
import type { DiffRow } from "./timeline";

/** Entries one `files.tree` call returns for a single folder. */
export const MAX_TREE_ENTRIES = 2_000;
/** Changed files one `files.status` call lists. Past it `truncated` is true. */
export const MAX_CHANGES = 5_000;
/** Largest file `files.read` returns, in bytes. A bigger one answers `too_large`. */
export const MAX_FILE_BYTES = 512 * 1024;
/** Rows of one `files.diff`; the counts still cover the whole change. */
export const MAX_DIFF_ROWS = 5_000;
/** Longest relative path a caller may send, in UTF-16 code units. */
export const MAX_FILE_PATH_CHARS = 4_096;

/**
 * Prefix of the error for a request the sidecar could not serve (git is missing, crashed or
 * answered something unreadable). The window maps it to a sentence; the raw git text never
 * leaves the sidecar.
 */
export const FILES_UNAVAILABLE_MESSAGE = "files unavailable";
/** Prefix of the error for a path the caller sent that is not a relative path inside the project. */
export const FILES_BAD_PATH_MESSAGE = "invalid path";
/** Sent to a status request that a newer one for the same session replaced. The window drops it. */
export const FILES_SUPERSEDED_MESSAGE = "files request superseded";

/**
 * One letter per changed file, the way `git status` writes them: modified, added, deleted,
 * renamed, copied, type changed, unmerged (a conflict) and untracked.
 */
export type ChangeStatus = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?";

const CHANGE_STATUSES: Record<ChangeStatus, true> = {
  M: true,
  A: true,
  D: true,
  R: true,
  C: true,
  T: true,
  U: true,
  "?": true,
};

function isChangeStatus(v: unknown): v is ChangeStatus {
  return typeof v === "string" && Object.hasOwn(CHANGE_STATUSES, v);
}

export interface FileChange {
  /** Relative to the session folder, `/`-separated. */
  readonly path: string;
  /** Where a renamed or copied file came from, relative to the session folder. */
  readonly from?: string;
  readonly status: ChangeStatus;
  /** Lines added and removed against HEAD; null for a binary file or one too big to count. */
  readonly added: number | null;
  readonly removed: number | null;
  readonly binary?: true;
}

export interface GitBranch {
  /** Null while HEAD is detached. */
  readonly name: string | null;
  /** Short commit id of HEAD; null on a branch with no commit yet. */
  readonly head: string | null;
  /** The remote-tracking branch (`origin/main`), or null when the branch has none. */
  readonly upstream: string | null;
  /** Commits the branch has that its upstream lacks. 0 without an upstream. */
  readonly ahead: number;
  /** Commits the upstream has that the branch lacks. 0 without an upstream. */
  readonly behind: number;
}

/** Files by kind of change, over everything git reported (conflicts count as modified). */
export interface ChangeTotals {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
}

export type FilesStatusResult =
  | {
      readonly state: "ok";
      readonly branch: GitBranch;
      readonly changes: readonly FileChange[];
      readonly totals: ChangeTotals;
      /** Git reported more than {@link MAX_CHANGES} files; `changes` and `totals` hold a prefix. */
      readonly truncated: boolean;
    }
  /** The folder is not inside a git work tree (or git refuses to open it). */
  | { readonly state: "not_repo" }
  /** The session's folder no longer exists. */
  | { readonly state: "missing" }
  /** Git did not answer in time and was stopped. */
  | { readonly state: "timeout" };

export interface TreeEntry {
  readonly name: string;
  readonly kind: "file" | "dir";
}

/** Why the sidecar would not serve a path. */
export type FileRefusal = "missing" | "outside_project" | "not_a_file" | "invalid_path";

const REFUSALS: Record<FileRefusal, true> = {
  missing: true,
  outside_project: true,
  not_a_file: true,
  invalid_path: true,
};

function isRefusal(v: unknown): v is FileRefusal {
  return typeof v === "string" && Object.hasOwn(REFUSALS, v);
}

export type FilesTreeResult =
  | {
      readonly state: "ok";
      /** Folders first, then files, each by name. Symbolic links and `.git` are never listed. */
      readonly entries: readonly TreeEntry[];
      /** The folder holds more than the sidecar lists. */
      readonly truncated: boolean;
    }
  /** The folder (or the whole project) is gone. */
  | { readonly state: "missing" }
  | { readonly state: "refused"; readonly reason: FileRefusal }
  | { readonly state: "timeout" };

export type FilesReadResult =
  | {
      readonly state: "ok";
      readonly path: string;
      readonly content: string;
      readonly bytes: number;
    }
  /** A NUL byte, or bytes that are not valid UTF-8. */
  | { readonly state: "binary"; readonly bytes: number }
  | { readonly state: "too_large"; readonly bytes: number; readonly limit: number }
  | { readonly state: "refused"; readonly reason: FileRefusal };

export type FilesDiffResult =
  | {
      readonly state: "ok";
      readonly path: string;
      readonly from?: string;
      readonly status: ChangeStatus;
      readonly rows: readonly DiffRow[];
      /** Over the whole change, including rows left out of `rows`. */
      readonly added: number;
      readonly removed: number;
      /** Rows past {@link MAX_DIFF_ROWS} were left out. */
      readonly truncated: boolean;
    }
  | { readonly state: "binary"; readonly status: ChangeStatus }
  | { readonly state: "too_large"; readonly status: ChangeStatus }
  /** The file matches HEAD (or the folder is not a repository): there is no diff. */
  | { readonly state: "unchanged" }
  | { readonly state: "refused"; readonly reason: FileRefusal }
  | { readonly state: "timeout" };

const isString = (v: unknown): v is string => typeof v === "string";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isNullableCount = (v: unknown): boolean => v === null || isCount(v);
const isNullableString = (v: unknown): boolean => v === null || isString(v);

function isFileChange(v: unknown): v is FileChange {
  return (
    isRecord(v) &&
    isString(v.path) &&
    (v.from === undefined || isString(v.from)) &&
    isChangeStatus(v.status) &&
    isNullableCount(v.added) &&
    isNullableCount(v.removed) &&
    (v.binary === undefined || v.binary === true)
  );
}

function isBranch(v: unknown): v is GitBranch {
  return (
    isRecord(v) &&
    isNullableString(v.name) &&
    isNullableString(v.head) &&
    isNullableString(v.upstream) &&
    isCount(v.ahead) &&
    isCount(v.behind)
  );
}

function isTotals(v: unknown): v is ChangeTotals {
  return isRecord(v) && isCount(v.added) && isCount(v.modified) && isCount(v.deleted);
}

export function isFilesStatusResult(v: unknown): v is FilesStatusResult {
  if (!isRecord(v)) return false;
  if (v.state === "ok") {
    return (
      isBranch(v.branch) &&
      Array.isArray(v.changes) &&
      v.changes.every(isFileChange) &&
      isTotals(v.totals) &&
      typeof v.truncated === "boolean"
    );
  }
  return v.state === "not_repo" || v.state === "missing" || v.state === "timeout";
}

function isTreeEntry(v: unknown): v is TreeEntry {
  return isRecord(v) && isString(v.name) && (v.kind === "file" || v.kind === "dir");
}

export function isFilesTreeResult(v: unknown): v is FilesTreeResult {
  if (!isRecord(v)) return false;
  if (v.state === "ok") {
    return (
      Array.isArray(v.entries) && v.entries.every(isTreeEntry) && typeof v.truncated === "boolean"
    );
  }
  if (v.state === "refused") return isRefusal(v.reason);
  return v.state === "missing" || v.state === "timeout";
}

export function isFilesReadResult(v: unknown): v is FilesReadResult {
  if (!isRecord(v)) return false;
  switch (v.state) {
    case "ok":
      return isString(v.path) && isString(v.content) && isCount(v.bytes);
    case "binary":
      return isCount(v.bytes);
    case "too_large":
      return isCount(v.bytes) && isCount(v.limit);
    case "refused":
      return isRefusal(v.reason);
    default:
      return false;
  }
}

function isDiffRowShape(v: unknown): boolean {
  return (
    isRecord(v) &&
    (v.kind === "add" || v.kind === "remove" || v.kind === "context" || v.kind === "skip") &&
    (v.oldLine === undefined || isCount(v.oldLine)) &&
    (v.newLine === undefined || isCount(v.newLine)) &&
    isString(v.text)
  );
}

export function isFilesDiffResult(v: unknown): v is FilesDiffResult {
  if (!isRecord(v)) return false;
  switch (v.state) {
    case "ok":
      return (
        isString(v.path) &&
        (v.from === undefined || isString(v.from)) &&
        isChangeStatus(v.status) &&
        Array.isArray(v.rows) &&
        v.rows.every(isDiffRowShape) &&
        isCount(v.added) &&
        isCount(v.removed) &&
        typeof v.truncated === "boolean"
      );
    case "binary":
    case "too_large":
      return isChangeStatus(v.status);
    case "unchanged":
    case "timeout":
      return true;
    case "refused":
      return isRefusal(v.reason);
    default:
      return false;
  }
}
