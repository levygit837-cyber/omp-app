import type { FileChange, GitBranch } from "@omp-app/protocol";
import { FILES_UNAVAILABLE_MESSAGE, MAX_CHANGES } from "@omp-app/protocol";
import { type NumstatEntry, parseNumstat, parseStatus, type StatusEntry } from "./git-parse";
import { type GitOutcome, runGit } from "./git-run";

const STATUS_MAX_BYTES = 16 * 1024 * 1024;
const LISTING_MAX_BYTES = 64 * 1024 * 1024;
const LISTING_TIMEOUT_MS = 10_000;

export type RepoProbe =
  | { readonly kind: "repo"; readonly prefix: string }
  | { readonly kind: "not_repo" }
  | { readonly kind: "timeout" };

/** Why a git call produced nothing; `aborted` means the session went away. */
export class GitAborted extends Error {
  constructor() {
    super("aborted");
  }
}

/** An outcome that is none of ok, over_cap, timeout: git is missing or crashed. */
function unavailable(): Error {
  return new Error(FILES_UNAVAILABLE_MESSAGE);
}

/**
 * Is `root` inside a git work tree, and under which folder of it? `prefix` is the path of `root`
 * below the repository root (`""` at the root, `"packages/app/"` below it). Every path git prints
 * for a status or a diff is relative to the repository root, so the prefix is what turns them
 * into paths relative to the session folder.
 */
export async function probeRepo(root: string, signal: AbortSignal): Promise<RepoProbe> {
  const out = await runGit(root, ["rev-parse", "--is-inside-work-tree", "--show-prefix"], {
    signal,
    timeoutMs: 5_000,
    maxBytes: 64 * 1024,
  });
  switch (out.kind) {
    case "aborted":
      throw new GitAborted();
    case "timeout":
      return { kind: "timeout" };
    case "failed":
      if (out.code === 128) return { kind: "not_repo" };
      throw unavailable();
    case "over_cap":
      throw unavailable();
    case "ok": {
      const [inside, prefix = ""] = out.stdout.toString("utf8").split("\n");
      if (inside !== "true") return { kind: "not_repo" };
      return { kind: "repo", prefix };
    }
  }
}

function stripPrefix(path: string, prefix: string): string | null {
  if (prefix === "") return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

export interface GitStatus {
  readonly branch: GitBranch;
  readonly entries: readonly StatusEntry[];
  /** Git's output ran into the byte cap: `entries` is a prefix of the truth. */
  readonly cut: boolean;
}

export type StatusOutcome =
  | { readonly kind: "ok"; readonly status: GitStatus }
  | { readonly kind: "timeout" };

/** `git status` for the session folder, or for one path of it, with paths relative to the folder. */
export async function readStatus(
  root: string,
  prefix: string,
  signal: AbortSignal,
  pathspec?: readonly string[],
): Promise<StatusOutcome> {
  const out = await runGit(
    root,
    [
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--",
      ...(pathspec ?? []),
    ],
    { signal, maxBytes: STATUS_MAX_BYTES, timeoutMs: 15_000 },
  );
  if (out.kind === "aborted") throw new GitAborted();
  if (out.kind === "timeout") return { kind: "timeout" };
  if (out.kind === "failed") throw unavailable();
  const parsed = parseStatus(out.stdout.toString("utf8"));
  const entries: StatusEntry[] = [];
  for (const entry of parsed.entries) {
    const path = stripPrefix(entry.path, prefix);
    if (path === null || path === "") continue;
    const from = entry.from === undefined ? null : stripPrefix(entry.from, prefix);
    entries.push(
      from === null ? { path, status: entry.status } : { path, from, status: entry.status },
    );
  }
  return { kind: "ok", status: { branch: parsed.branch, entries, cut: out.kind === "over_cap" } };
}

/** The empty tree of this repository (its hash depends on the object format). */
async function emptyTree(root: string, signal: AbortSignal): Promise<string | null> {
  const out = await runGit(root, ["hash-object", "-t", "tree", "--stdin"], {
    signal,
    input: "",
    maxBytes: 256,
    timeoutMs: 5_000,
  });
  if (out.kind === "aborted") throw new GitAborted();
  return out.kind === "ok" ? out.stdout.toString("utf8").trim() : null;
}

/** What changes are compared against: HEAD, or the empty tree on a branch with no commit yet. */
export async function diffBase(
  root: string,
  branch: GitBranch,
  signal: AbortSignal,
): Promise<string | null> {
  return branch.head === null ? emptyTree(root, signal) : "HEAD";
}

/**
 * `diff-index`, never `diff`: the porcelain `git diff` refreshes stat data in the index and
 * writes it back even with `--no-optional-locks` (measured: the index file changes when a file's
 * mtime is stale), while the plumbing command only reads. `--ignore-submodules=all` and
 * `--no-ext-diff --no-textconv` keep the repository's config from naming a program.
 */
const DIFF_FLAGS = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--ignore-submodules=all",
  "-M",
];

/** Line counts of every tracked change against `base`, keyed by path relative to the repository root. */
export async function readNumstat(
  root: string,
  base: string,
  signal: AbortSignal,
): Promise<Map<string, NumstatEntry> | null> {
  const out = await runGit(root, ["diff-index", ...DIFF_FLAGS, "--numstat", "-z", base, "--"], {
    signal,
    maxBytes: STATUS_MAX_BYTES,
    timeoutMs: 15_000,
  });
  if (out.kind === "aborted") throw new GitAborted();
  if (out.kind !== "ok") return null;
  return parseNumstat(out.stdout.toString("utf8"));
}

/** `git diff` of the named paths against `base`. */
export async function readDiff(
  root: string,
  base: string,
  paths: readonly string[],
  signal: AbortSignal,
  maxBytes: number,
): Promise<GitOutcome> {
  const out = await runGit(root, ["diff-index", ...DIFF_FLAGS, "-p", "-U3", base, "--", ...paths], {
    signal,
    maxBytes,
    timeoutMs: 15_000,
  });
  if (out.kind === "aborted") throw new GitAborted();
  return out;
}

export type ListingOutcome =
  | { readonly kind: "ok"; readonly paths: readonly string[] }
  /** Git could not answer (not a repository, too much output, too slow): list the folder as it is. */
  | { readonly kind: "unavailable" };

/** Tracked and untracked-not-ignored files below `dir` (`""` or ending in `/`), relative to the session folder. */
export async function listTracked(
  root: string,
  dir: string,
  signal: AbortSignal,
): Promise<ListingOutcome> {
  const out = await runGit(
    root,
    ["ls-files", "-co", "--exclude-standard", "-z", "--", ...(dir === "" ? [] : [dir])],
    { signal, maxBytes: LISTING_MAX_BYTES, timeoutMs: LISTING_TIMEOUT_MS },
  );
  if (out.kind === "aborted") throw new GitAborted();
  if (out.kind !== "ok") return { kind: "unavailable" };
  return {
    kind: "ok",
    paths: out.stdout
      .toString("utf8")
      .split("\0")
      .filter((p) => p !== ""),
  };
}

/** Joins status entries with their line counts into the protocol's change rows. */
export function toChanges(
  entries: readonly StatusEntry[],
  prefix: string,
  counts: ReadonlyMap<string, NumstatEntry> | null,
  untracked: ReadonlyMap<string, NumstatEntry>,
): { changes: FileChange[]; truncated: boolean } {
  const changes: FileChange[] = [];
  for (const entry of entries) {
    const count =
      entry.status === "?" ? untracked.get(entry.path) : counts?.get(prefix + entry.path);
    changes.push({
      path: entry.path,
      ...(entry.from === undefined ? {} : { from: entry.from }),
      status: entry.status,
      added: count?.added ?? null,
      removed: count?.removed ?? null,
      ...(count?.binary ? { binary: true as const } : {}),
    });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { changes: changes.slice(0, MAX_CHANGES), truncated: changes.length > MAX_CHANGES };
}
