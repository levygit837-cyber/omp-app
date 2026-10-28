import type {
  ChangeStatus,
  FileChange,
  FilesDiffResult,
  FilesReadResult,
  GitBranch,
  Item,
  TreeEntry,
} from "@omp-app/protocol";

/** The word for each status letter: the letter alone is not a name, and color never carries it. */
export const STATUS_WORDS: Readonly<Record<ChangeStatus, string>> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type changed",
  U: "conflicted",
  "?": "untracked",
};

// -- Paths ---------------------------------------------------------------------------------------

/** `src/a/b.ts` → `src/a`; a top-level file has the empty root as its folder. */
export function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export const joinPath = (dir: string, name: string): string =>
  dir === "" ? name : `${dir}/${name}`;

/** The extension a language lookup can use, or null (`Makefile`, `.gitignore`, `a.`). */
export function extensionOf(path: string): string | null {
  const name = nameOf(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? null : name.slice(dot + 1).toLowerCase();
}

// -- Markers -------------------------------------------------------------------------------------

export interface Markers {
  /** Status letter of each changed file, by its path in the working tree. */
  readonly files: Readonly<Record<string, ChangeStatus>>;
  /** Every folder that has a change somewhere below it. */
  readonly dirs: Readonly<Record<string, true>>;
}

export const NO_MARKERS: Markers = { files: {}, dirs: {} };

export function markersOf(changes: readonly FileChange[]): Markers {
  const files: Record<string, ChangeStatus> = {};
  const dirs: Record<string, true> = {};
  for (const change of changes) {
    files[change.path] = change.status;
    for (let dir = dirOf(change.path); dir !== ""; dir = dirOf(dir)) {
      if (dirs[dir]) break;
      dirs[dir] = true;
    }
  }
  return { files, dirs };
}

/** The change for `path` in a status listing, if the file is changed. */
export const changeFor = (changes: readonly FileChange[], path: string): FileChange | undefined =>
  changes.find((change) => change.path === path);

/** Statuses that occur, in a fixed order, for the legend under the tree. */
export function legendOf(changes: readonly FileChange[]): ChangeStatus[] {
  const order: readonly ChangeStatus[] = ["M", "A", "D", "R", "C", "T", "U", "?"];
  const present = new Set(changes.map((change) => change.status));
  return order.filter((status) => present.has(status));
}

// -- Branch --------------------------------------------------------------------------------------

/** What to call the checked-out ref: the branch, else the short commit of a detached HEAD. */
export function branchName(branch: GitBranch): string | null {
  return branch.name ?? (branch.head === null ? null : branch.head.slice(0, 7));
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The sentence under the branch name: how far it is from its upstream. */
export function branchNote(branch: GitBranch): string {
  if (branch.name === null) return "Detached HEAD";
  if (branch.upstream === null) return "No upstream branch";
  const parts: string[] = [];
  if (branch.ahead > 0) parts.push(`${plural(branch.ahead, "commit")} ahead of`);
  if (branch.behind > 0) {
    parts.push(branch.ahead > 0 ? "and" : "");
    parts.push(`${plural(branch.behind, "commit")} behind`);
  }
  if (parts.length === 0) return `Up to date with ${branch.upstream}`;
  return `${parts.filter(Boolean).join(" ")} ${branch.upstream}`.replace(
    "ahead of and",
    "ahead and",
  );
}

export interface BranchChip {
  readonly name: string;
  /** `+2 ~1 -3`: new, modified and deleted files; absent counts are left out. */
  readonly counts: string;
  /** The same in words, for assistive technology and the tooltip. */
  readonly label: string;
}

/** Null when there is nothing to name (no commit yet and no branch). */
export function branchChip(
  branch: GitBranch,
  totals: { readonly added: number; readonly modified: number; readonly deleted: number },
): BranchChip | null {
  const name = branchName(branch);
  if (name === null) return null;
  const counts = [
    totals.added > 0 ? `+${totals.added}` : "",
    totals.modified > 0 ? `~${totals.modified}` : "",
    totals.deleted > 0 ? `-${totals.deleted}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const words = [
    totals.added > 0 ? `${totals.added} added` : "",
    totals.modified > 0 ? `${totals.modified} modified` : "",
    totals.deleted > 0 ? `${totals.deleted} deleted` : "",
  ].filter(Boolean);
  const kind = branch.name === null ? "Detached at" : "Branch";
  return {
    name,
    counts,
    label: `${kind} ${name}, ${words.length === 0 ? "no changes" : words.join(", ")}`,
  };
}

// -- Tree ----------------------------------------------------------------------------------------

/** What the window knows about one folder of the tree. */
export type DirNode =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly entries: readonly TreeEntry[]; readonly truncated: boolean }
  | { readonly state: "failed"; readonly message: string };

export interface EntryRow {
  readonly kind: "entry";
  readonly path: string;
  readonly name: string;
  readonly entry: "file" | "dir";
  readonly depth: number;
  readonly expanded: boolean;
  /** Status letter of a changed file. */
  readonly status: ChangeStatus | null;
  /** A folder with a change below it. */
  readonly dot: boolean;
  /** 1-based position among its siblings, for `aria-posinset`. */
  readonly index: number;
  readonly siblings: number;
}

export interface NoteRow {
  readonly kind: "note";
  /** Unique inside the list, for React. */
  readonly key: string;
  readonly depth: number;
  readonly text: string;
  readonly tone: "plain" | "error";
}

export type TreeRow = EntryRow | NoteRow;

/**
 * The rows the tree shows, top to bottom: the root folder's entries, and under each expanded
 * folder its own. A folder that is not loaded yet, is empty, failed or was cut short gets a note
 * row instead of silence.
 */
export function flattenTree(
  dirs: Readonly<Record<string, DirNode | undefined>>,
  expanded: ReadonlySet<string>,
  markers: Markers,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    const node = dirs[dir];
    if (node === undefined || node.state === "loading") {
      rows.push({ kind: "note", key: `loading:${dir}`, depth, text: "Loading…", tone: "plain" });
      return;
    }
    if (node.state === "failed") {
      rows.push({ kind: "note", key: `failed:${dir}`, depth, text: node.message, tone: "error" });
      return;
    }
    if (node.entries.length === 0) {
      rows.push({ kind: "note", key: `empty:${dir}`, depth, text: "Empty folder", tone: "plain" });
      return;
    }
    node.entries.forEach((entry, at) => {
      const path = joinPath(dir, entry.name);
      const open = entry.kind === "dir" && expanded.has(path);
      rows.push({
        kind: "entry",
        path,
        name: entry.name,
        entry: entry.kind,
        depth,
        expanded: open,
        status: entry.kind === "file" ? (markers.files[path] ?? null) : null,
        dot: entry.kind === "dir" && markers.dirs[path] === true,
        index: at + 1,
        siblings: node.entries.length,
      });
      if (open) walk(path, depth + 1);
    });
    if (node.truncated) {
      rows.push({
        kind: "note",
        key: `truncated:${dir}`,
        depth,
        text: "Only the first entries are listed. Search to find the rest.",
        tone: "plain",
      });
    }
  };
  walk("", 0);
  return rows;
}

export type TreeMove =
  | { readonly kind: "focus"; readonly path: string }
  | { readonly kind: "expand"; readonly path: string }
  | { readonly kind: "collapse"; readonly path: string }
  | { readonly kind: "open"; readonly path: string };

/**
 * The effect of a key on the tree (the WAI-ARIA treeview pattern): Up/Down/Home/End move focus,
 * Right opens a folder or enters it, Left closes it or goes to its parent, Enter and Space open a
 * file or toggle a folder. Null for any other key.
 */
export function navigateTree(
  rows: readonly TreeRow[],
  current: string,
  key: string,
): TreeMove | null {
  const entries = rows.filter((row): row is EntryRow => row.kind === "entry");
  const at = entries.findIndex((row) => row.path === current);
  const row = entries[at];
  if (!row) return null;
  const focus = (target: EntryRow | undefined): TreeMove | null =>
    target ? { kind: "focus", path: target.path } : null;
  switch (key) {
    case "ArrowDown":
      return focus(entries[at + 1]);
    case "ArrowUp":
      return focus(entries[at - 1]);
    case "Home":
      return focus(entries[0]);
    case "End":
      return focus(entries.at(-1));
    case "ArrowRight": {
      if (row.entry !== "dir") return null;
      if (!row.expanded) return { kind: "expand", path: row.path };
      const child = entries[at + 1];
      return child && child.depth > row.depth ? focus(child) : null;
    }
    case "ArrowLeft": {
      if (row.entry === "dir" && row.expanded) return { kind: "collapse", path: row.path };
      for (let i = at - 1; i >= 0; i--) {
        const parent = entries[i];
        if (parent && parent.depth < row.depth) return focus(parent);
      }
      return null;
    }
    case "Enter":
    case " ":
      if (row.entry === "file") return { kind: "open", path: row.path };
      return { kind: row.expanded ? "collapse" : "expand", path: row.path };
    default:
      return null;
  }
}

// -- Refresh -------------------------------------------------------------------------------------

/** Tools that can change a file. A finished call of one of them means the page may be stale. */
const FILE_TOUCHING: Readonly<Record<string, true>> = {
  edit: true,
  write: true,
  ast_edit: true,
  bash: true,
  eval: true,
  task: true,
};

/**
 * How many calls of a file-touching tool have ended. It only grows, so a change in the number
 * means "something may have touched the disk since I last looked". A running call does not count:
 * the file is not final yet.
 */
export function touchEpoch(timeline: readonly Item[]): number {
  let ended = 0;
  for (const item of timeline) {
    if (item.kind !== "tool" || FILE_TOUCHING[item.tool] !== true) continue;
    for (const call of item.calls) if (call.status !== "running") ended++;
  }
  return ended;
}

export interface Debouncer {
  /** Runs `fn` once `ms` after the last call. */
  trigger(): void;
  cancel(): void;
}

/** A timer source. `set` returns the function that cancels what it scheduled. */
export interface Timers {
  set(callback: () => void, ms: number): () => void;
}

export const REAL_TIMERS: Timers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
};

export function debounce(fn: () => void, ms: number, timers: Timers = REAL_TIMERS): Debouncer {
  let cancelPending: (() => void) | null = null;
  const cancel = () => {
    cancelPending?.();
    cancelPending = null;
  };
  return {
    trigger() {
      cancel();
      cancelPending = timers.set(() => {
        cancelPending = null;
        fn();
      }, ms);
    },
    cancel,
  };
}

/** What the window looks at to decide a refresh. */
export interface RefreshInputs {
  readonly epoch: number;
  readonly status: string | undefined;
}

/**
 * Whether the page may be stale between two looks: a file-touching call ended, or the turn ended
 * (it left `streaming`). Starting a turn changes nothing on disk, so it does not count.
 */
export function shouldRefresh(prev: RefreshInputs, next: RefreshInputs): boolean {
  return next.epoch !== prev.epoch || (prev.status === "streaming" && next.status !== "streaming");
}

// -- Display -------------------------------------------------------------------------------------

/** Changes drawn in the list; the rest stay marked in the tree. */
export const MAX_SHOWN_CHANGES = 200;

/** `1.5 KB`, `2.0 MB`: binary units, one decimal from a kilobyte up. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Names with no extension that still have a grammar. */
const WHOLE_NAMES: Readonly<Record<string, string>> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  makefile: "makefile",
  GNUmakefile: "makefile",
};

/** The language hint for `CodeBlock`: a whole-name match, else the extension; null is plain text. */
export function languageOf(path: string): string | null {
  return WHOLE_NAMES[nameOf(path)] ?? extensionOf(path);
}

/** Folders above `path`, outermost first: `a/b/c.ts` → `a`, `a/b`. */
export function ancestorsOf(path: string): string[] {
  const folders: string[] = [];
  for (let dir = dirOf(path); dir !== ""; dir = dirOf(dir)) folders.unshift(dir);
  return folders;
}

/**
 * What Esc does in the search field: with text, it clears the field and stops there; empty, it
 * leaves the key alone, so it reaches whatever Esc means elsewhere (stopping a turn).
 */
export function searchEscape(query: string): "clear" | "pass" {
  return query === "" ? "pass" : "clear";
}

/** A folder result of the file search ends in `/`; the tree's paths never do. */
export function searchTarget(result: string): { path: string; kind: "file" | "dir" } {
  return result.endsWith("/")
    ? { path: result.slice(0, -1), kind: "dir" }
    : { path: result, kind: "file" };
}

// -- File view -----------------------------------------------------------------------------------

/** The sentence for a file that cannot be shown as text. Null when the content is there. */
export function readNotice(result: FilesReadResult): string | null {
  switch (result.state) {
    case "ok":
      return null;
    case "binary":
      return `This file is binary (${formatBytes(result.bytes)}), so it is not shown.`;
    case "too_large":
      return `This file is ${formatBytes(result.bytes)}, over the ${formatBytes(result.limit)} shown here.`;
    case "refused":
      switch (result.reason) {
        case "missing":
          return "This file no longer exists.";
        case "outside_project":
          return "This file is outside the project, so it is not shown.";
        case "not_a_file":
          return "This is not a regular file.";
        case "invalid_path":
          return "That path is not valid.";
        default:
          return result.reason satisfies never;
      }
    default:
      return result satisfies never;
  }
}

/** The sentence for a diff that cannot be drawn. Null when there are rows. */
export function diffNotice(result: FilesDiffResult): string | null {
  switch (result.state) {
    case "ok":
      return result.rows.length === 0
        ? "Nothing to show: only the file mode or its name changed."
        : null;
    case "binary":
      return "This file is binary, so there is no line diff.";
    case "too_large":
      return "This diff is too large to show.";
    case "unchanged":
      return "This file has no changes against HEAD.";
    case "refused":
      return "This file can’t be compared from here.";
    case "timeout":
      return "Git took too long to answer. Try again in a moment.";
    default:
      return result satisfies never;
  }
}
