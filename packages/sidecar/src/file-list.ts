import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { MAX_FILE_MATCHES, MAX_FILE_QUERY_CHARS } from "@omp-app/protocol";

/** Entries read before the walk gives up, so a huge tree answers in bounded time. */
const MAX_VISITED = 20_000;
const MAX_DEPTH = 8;
/** Folders that hold generated or foreign files; a person rarely means to mention one. */
const SKIPPED = new Set(["node_modules", ".git"]);

/** Fixed argv: the repository is untrusted input, so nothing here comes from the user or the repo. */
const GIT_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "ls-files",
  "-co",
  "--exclude-standard",
  "-z",
];
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** What `listFiles` found. `truncated` is true when the search stopped early and may have missed matches. */
export interface FileListing {
  /** Paths relative to the root, best match first; folders end in `/`. */
  files: string[];
  truncated: boolean;
}

interface Scored {
  path: string;
  score: number;
}

const byScore = (a: Scored, b: Scored): number => b.score - a.score || a.path.localeCompare(b.path);

/**
 * How well `query` matches `path`, or null. Characters of the query must appear in order
 * (case-insensitive); a match in the file name, at a word start, or in one run scores higher,
 * and a shorter path beats a longer one. Pure.
 */
export function scoreMatch(path: string, query: string): number | null {
  if (query === "") return -path.length;
  const text = path.toLowerCase();
  const needle = query.toLowerCase();
  const nameStart = path.endsWith("/")
    ? path.lastIndexOf("/", path.length - 2) + 1
    : path.lastIndexOf("/") + 1;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    const at = text.indexOf(char, from);
    if (at === -1) return null;
    if (at === previous + 1) score += 3;
    if (at === 0 || "/-_. ".includes(text[at - 1] ?? "")) score += 2;
    if (at >= nameStart) score += 1;
    previous = at;
    from = at + 1;
  }
  if (text.slice(nameStart).includes(needle)) score += 10;
  return score * 100 - path.length;
}

type GitOutcome = { kind: "ok"; paths: string[] } | { kind: "over_cap" } | { kind: "failed" };

/** Tracked and untracked-but-not-ignored paths under `root`, from `git ls-files`. */
async function gitPaths(root: string): Promise<GitOutcome> {
  const env: Record<string, string> = { GIT_OPTIONAL_LOCKS: "0" };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(["git", ...GIT_ARGS], {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return { kind: "failed" };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, GIT_TIMEOUT_MS);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of proc.stdout) {
      size += chunk.length;
      if (size > GIT_MAX_OUTPUT_BYTES) {
        proc.kill("SIGKILL");
        return { kind: "over_cap" };
      }
      chunks.push(chunk);
    }
    if ((await proc.exited) !== 0 || timedOut) return { kind: "failed" };
    const text = Buffer.concat(chunks).toString("utf8");
    return { kind: "ok", paths: text.split("\0").filter((path) => path.length > 0) };
  } catch {
    return { kind: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Candidates for `needle` from git's file list: every file plus the folders that contain
 * them, under the same filters as the walk (dot names, SKIPPED folders, depth).
 */
function scoreGitPaths(paths: readonly string[], needle: string, wantsHidden: boolean): Scored[] {
  const seen = new Set<string>();
  const found: Scored[] = [];
  const consider = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const score = scoreMatch(path, needle);
    if (score !== null) found.push({ path, score });
  };
  for (const file of paths) {
    const segments = file.split("/");
    let prefix = "";
    for (const [index, name] of segments.entries()) {
      // The walk lists entries at most MAX_DEPTH segments deep.
      if (index >= MAX_DEPTH || name === "" || (name.startsWith(".") && !wantsHidden)) break;
      if (index === segments.length - 1) {
        consider(prefix + name);
        break;
      }
      if (SKIPPED.has(name)) break;
      prefix += `${name}/`;
      consider(prefix);
    }
  }
  return found;
}

/**
 * The first `MAX_FILE_MATCHES` candidates, in order, that are still a regular file or folder
 * on disk with no symbolic link on the way. `git ls-files` lists tracked symlinks and files
 * deleted from the working tree; only the candidates actually returned are inspected.
 */
async function existingRegular(root: string, sorted: readonly Scored[]): Promise<string[]> {
  const realDirs = new Map<string, boolean>([["", true]]);
  const isRealDir = async (relative: string): Promise<boolean> => {
    const known = realDirs.get(relative);
    if (known !== undefined) return known;
    const cut = relative.lastIndexOf("/");
    const parentOk = await isRealDir(cut === -1 ? "" : relative.slice(0, cut));
    const info = parentOk ? await lstat(join(root, relative)).catch(() => null) : null;
    const ok = info?.isDirectory() ?? false;
    realDirs.set(relative, ok);
    return ok;
  };
  const files: string[] = [];
  for (const { path } of sorted) {
    if (files.length >= MAX_FILE_MATCHES) break;
    const isDirectory = path.endsWith("/");
    const relative = isDirectory ? path.slice(0, -1) : path;
    const cut = relative.lastIndexOf("/");
    if (!(await isRealDir(cut === -1 ? "" : relative.slice(0, cut)))) continue;
    const info = await lstat(join(root, relative)).catch(() => null);
    if (isDirectory ? info?.isDirectory() : info?.isFile()) files.push(path);
  }
  return files;
}

/** Bounded breadth-first walk; `truncated` when it ran out of its `MAX_VISITED` budget. */
async function walkFiles(root: string, needle: string, wantsHidden: boolean): Promise<FileListing> {
  const found: Scored[] = [];
  let visited = 0;
  let truncated = false;
  let level: { dir: string; relative: string }[] = [{ dir: root, relative: "" }];
  walk: for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
    const next: typeof level = [];
    for (const { dir, relative } of level) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (++visited > MAX_VISITED) {
          truncated = true;
          break walk;
        }
        if (entry.name.startsWith(".") && !wantsHidden) continue;
        const isDirectory = entry.isDirectory();
        // A `Dirent` reports a symbolic link as neither a file nor a directory, so this is the
        // line that keeps links (and whatever they point at) out of the listing and the walk.
        if (!isDirectory && !entry.isFile()) continue;
        if (isDirectory && SKIPPED.has(entry.name)) continue;
        const path = `${relative}${entry.name}${isDirectory ? "/" : ""}`;
        const score = scoreMatch(path, needle);
        if (score !== null) found.push({ path, score });
        if (isDirectory) next.push({ dir: join(dir, entry.name), relative: path });
      }
    }
    level = next;
  }
  found.sort(byScore);
  return { files: found.slice(0, MAX_FILE_MATCHES).map((match) => match.path), truncated };
}

/**
 * Files and folders under `root` that match `query`, as paths relative to it (folders end in
 * `/`), best first. Read-only and confined: a symbolic link is never listed, so nothing outside
 * `root` can appear whatever the folder contains. Dot files show only when the query starts
 * with a dot; `node_modules` and `.git` are skipped.
 *
 * Inside a git repository the list comes from `git ls-files -co --exclude-standard`, so
 * ignored files stay out and a huge tree is no obstacle. Otherwise (no git, not a repository,
 * timeout, more than 64 MiB of output) a walk bounded in depth and entries read answers, and
 * `truncated` says whether it ran out of budget (always true when git's output was too big).
 */
export async function listFiles(root: string, query: string): Promise<FileListing> {
  const needle = query.slice(0, MAX_FILE_QUERY_CHARS);
  const wantsHidden = needle.startsWith(".") || needle.includes("/.");
  const git = await gitPaths(root);
  if (git.kind === "ok") {
    const sorted = scoreGitPaths(git.paths, needle, wantsHidden).sort(byScore);
    return { files: await existingRegular(root, sorted), truncated: false };
  }
  const walked = await walkFiles(root, needle, wantsHidden);
  return git.kind === "over_cap" ? { ...walked, truncated: true } : walked;
}
