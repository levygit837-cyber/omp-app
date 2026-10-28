import {
  type ChangeStatus,
  type ChangeTotals,
  type DiffRow,
  type GitBranch,
  MAX_DIFF_ROWS,
} from "@omp-app/protocol";

/** One path git reported, relative to the repository root. */
export interface StatusEntry {
  readonly path: string;
  readonly from?: string;
  readonly status: ChangeStatus;
}

export interface ParsedStatus {
  readonly branch: GitBranch;
  readonly entries: readonly StatusEntry[];
}

/** The text after the `skip`th space of `line` (porcelain v2 puts the path last, spaces and all). */
function afterFields(line: string, skip: number): string {
  let at = 0;
  for (let i = 0; i < skip; i++) {
    at = line.indexOf(" ", at);
    if (at === -1) return "";
    at += 1;
  }
  return line.slice(at);
}

/**
 * One letter for a path changed against HEAD, from the two columns of `XY` (index, work tree).
 * What a person sees is the change since the last commit, so a file added to the index and then
 * edited is still `A`, and one deleted in either column is `D`.
 */
export function statusLetter(xy: string): ChangeStatus {
  const x = xy[0] ?? ".";
  const y = xy[1] ?? ".";
  if (x === "D" || y === "D") return "D";
  if (x === "A" || (x === "." && y === "A")) return "A";
  if (x === "R" || y === "R") return "R";
  if (x === "C" || y === "C") return "C";
  if (x === "T" || y === "T") return "T";
  return "M";
}

/**
 * Parses `git status --porcelain=v2 -z --branch --untracked-files=all`. Entries are NUL
 * separated and never quoted, so any file name is read back as it is. A rename carries its
 * source as the next NUL field. Ignored paths (`!`) and anything unknown are skipped.
 *
 * The last field is always dropped: it is the empty tail of complete output, or an entry cut
 * in the middle of a name when the output hit its cap.
 */
export function parseStatus(text: string): ParsedStatus {
  let name: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: StatusEntry[] = [];
  const fields = text.split("\0");
  // Complete output ends with a NUL, so its last field is empty. Cut output ends inside an
  // entry, so its last field may be a partial name. Either way the last field is dropped.
  fields.pop();
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    if (field.startsWith("# branch.oid ")) {
      const oid = field.slice("# branch.oid ".length);
      head = oid === "(initial)" ? null : oid.slice(0, 7);
    } else if (field.startsWith("# branch.head ")) {
      const value = field.slice("# branch.head ".length);
      name = value === "(detached)" ? null : value;
    } else if (field.startsWith("# branch.upstream ")) {
      upstream = field.slice("# branch.upstream ".length);
    } else if (field.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(field.slice("# branch.ab ".length));
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (field.startsWith("1 ")) {
      const path = afterFields(field, 8);
      if (path) entries.push({ path, status: statusLetter(field.slice(2, 4)) });
    } else if (field.startsWith("2 ")) {
      const path = afterFields(field, 9);
      const from = fields[++i];
      if (path && from !== undefined) {
        entries.push({ path, from, status: statusLetter(field.slice(2, 4)) });
      }
    } else if (field.startsWith("u ")) {
      const path = afterFields(field, 10);
      if (path) entries.push({ path, status: "U" });
    } else if (field.startsWith("? ")) {
      entries.push({ path: field.slice(2), status: "?" });
    }
  }
  return { branch: { name, head, upstream, ahead, behind }, entries };
}

/** Counts of `A`, `M` and `D` over the entries; a conflict, rename or type change is a modification. */
export function totalsOf(entries: readonly { readonly status: ChangeStatus }[]): ChangeTotals {
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const { status } of entries) {
    if (status === "A" || status === "?") added++;
    else if (status === "D") deleted++;
    else modified++;
  }
  return { added, modified, deleted };
}

export interface NumstatEntry {
  readonly added: number | null;
  readonly removed: number | null;
  readonly binary: boolean;
}

/**
 * Parses `git diff --numstat -z`: `added TAB removed TAB path NUL`, and for a rename
 * `added TAB removed TAB NUL old NUL new NUL`. A binary file counts `-`. Keyed by the NEW path.
 */
export function parseNumstat(text: string): Map<string, NumstatEntry> {
  const result = new Map<string, NumstatEntry>();
  const fields = text.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(field);
    if (!match) continue;
    const binary = match[1] === "-";
    let path = match[3] as string;
    if (path === "") {
      // A rename or copy: the next two fields are the old and the new path.
      i += 2;
      path = fields[i] ?? "";
    }
    if (path === "") continue;
    result.set(path, {
      added: binary ? null : Number(match[1]),
      removed: binary ? null : Number(match[2]),
      binary,
    });
  }
  return result;
}

export type ParsedDiff =
  | { readonly kind: "binary" }
  | {
      readonly kind: "rows";
      readonly rows: readonly DiffRow[];
      readonly added: number;
      readonly removed: number;
      readonly truncated: boolean;
    };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Turns the output of `git diff` for ONE file into rows. Header lines (`diff --git`, `index`,
 * `---`, `+++`, rename and mode lines) end at the first `@@`; a diff with no hunk and a
 * `Binary files … differ` or `GIT binary patch` line is binary. Between two hunks, and before a
 * first hunk that does not start at line 1, a `skip` row stands for the lines left out. Rows stop
 * at {@link MAX_DIFF_ROWS}; the counts still cover the whole change.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let sawHunk = false;
  let binary = false;
  let nextOldAfterHunk = 1;
  let dropped = false;
  const push = (row: DiffRow): void => {
    if (rows.length < MAX_DIFF_ROWS) rows.push(row);
    else dropped = true;
  };
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      // A zero count means the hunk sits AFTER the numbered line.
      oldLine = oldCount === 0 ? oldStart + 1 : oldStart;
      newLine = Number(hunk[3]) + (hunk[4] === "0" ? 1 : 0);
      if (oldLine > nextOldAfterHunk || (!sawHunk && oldLine > 1)) push({ kind: "skip", text: "" });
      sawHunk = true;
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) binary = true;
      continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const mark = line[0];
    const body = line.slice(1);
    if (mark === "+") {
      added++;
      push({ kind: "add", newLine, text: body });
      newLine++;
    } else if (mark === "-") {
      removed++;
      push({ kind: "remove", oldLine, text: body });
      oldLine++;
    } else if (mark === " ") {
      push({ kind: "context", oldLine, newLine, text: body });
      oldLine++;
      newLine++;
    } else {
      // Not a hunk line: the next file's header (never expected for one path) ends the hunks.
      inHunk = false;
      continue;
    }
    nextOldAfterHunk = oldLine;
  }
  if (!sawHunk && binary) return { kind: "binary" };
  return { kind: "rows", rows, added, removed, truncated: dropped };
}

/** An untracked or newly added file as an all-added diff. */
export function allAdded(text: string): ParsedDiff {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const rows: DiffRow[] = [];
  for (const [index, line] of lines.entries()) {
    if (rows.length >= MAX_DIFF_ROWS) break;
    rows.push({
      kind: "add",
      newLine: index + 1,
      text: line.endsWith("\r") ? line.slice(0, -1) : line,
    });
  }
  return {
    kind: "rows",
    rows,
    added: lines.length,
    removed: 0,
    truncated: lines.length > rows.length,
  };
}
