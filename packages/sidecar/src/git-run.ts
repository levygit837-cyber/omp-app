import { Buffer } from "node:buffer";

/**
 * Every git the sidecar starts goes through here. The repository is untrusted input (its config,
 * hooks and attributes can name programs), and the folder is a person's work, so git must read it
 * and never write it, never run what the repository names and never wait for a person.
 *
 * - `--no-optional-locks` and `GIT_OPTIONAL_LOCKS=0`: `status` does not refresh the index.
 * - `core.fsmonitor=false`: the repository's `core.fsmonitor` is a program git would start.
 * - `core.hooksPath=/dev/null`: no hook of the repository (or of a submodule) runs.
 * - `core.pager=cat`, `--no-pager`, `GIT_PAGER=cat`: nothing waits on a pager.
 * - `protocol.ext.allow=never`: no `ext::` transport (it runs a command).
 * - `--literal-pathspecs`: a file named `*` or `:(top)x` is that file, not a pattern.
 * - Filter drivers: `filter.<name>.clean` runs whenever git hashes a file whose stat data differs
 *   from the index, which is every file of a fresh clone and every file an agent just edited, and
 *   `status`, `diff-index` and `ls-files` all do that. `.gitattributes`, `.git/info/attributes`
 *   and `core.attributesFile` all name drivers and none can be turned off as a whole, so every
 *   driver the repository's own config defines is replaced by name (see `filterOverrides`).
 * - A fixed argv and no shell: no argument is ever parsed by a shell.
 * - `-c` options travel to the git processes git itself starts (submodules).
 *
 * Callers add `--no-ext-diff --no-textconv` to `diff`, which would otherwise run the programs
 * of the `diff.*` config.
 */
const HARDENING = [
  "--no-optional-locks",
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
  "-c",
  "protocol.ext.allow=never",
];

/** The settings of a repository-defined filter driver that stop it from running or failing. */
const FILTER_NEUTRAL = ["clean", "smudge", "process"] as const;

export const DEFAULT_GIT_TIMEOUT_MS = 8_000;
export const DEFAULT_GIT_MAX_BYTES = 8 * 1024 * 1024;

/** What a git child came to. `over_cap` still carries the first bytes, cut at the limit. */
export type GitOutcome =
  | { readonly kind: "ok"; readonly stdout: Buffer }
  | { readonly kind: "over_cap"; readonly stdout: Buffer }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }
  /** A non-zero exit (`code`), or git could not be started (`code` null). */
  | { readonly kind: "failed"; readonly code: number | null };

export interface GitOptions {
  /** Kills the child when it fires; the outcome is `aborted`. */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Output kept before the child is killed. */
  readonly maxBytes?: number;
  /** Written to the child's stdin; without it stdin is closed. */
  readonly input?: string;
}

/** The environment of a git child: only what git needs to find itself and the user's config. */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  return env;
}

/**
 * Every filter driver the repository itself defines (its local and worktree config, includes
 * followed) as environment config that blanks `clean`, `smudge` and `process` and sets
 * `required=false` (a required filter that cannot run aborts git). Environment config outranks
 * the repository's, travels in the environment rather than the argv so a name can never be taken
 * for an option, and reaches the git children git starts. Drivers of the person's own global
 * config are theirs and stay. `null` when a name cannot be passed safely or the config cannot be
 * listed: the caller must then not run git at all.
 */
export function filterOverrides(listing: Buffer): Record<string, string> | null {
  const fields = listing.toString("utf8").split("\0");
  const names = new Set<string>();
  // `--show-scope --name-only -z` prints `scope NUL name NUL` pairs.
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i];
    const key = fields[i + 1] ?? "";
    if (scope !== "local" && scope !== "worktree") continue;
    if (!key.startsWith("filter.")) continue;
    const variable = key.lastIndexOf(".");
    if (variable <= "filter.".length) continue;
    const name = key.slice("filter.".length, variable);
    if (name.includes("\n")) return null;
    names.add(name);
  }
  const env: Record<string, string> = {};
  let count = 0;
  const set = (key: string, value: string) => {
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count}`] = value;
    count++;
  };
  for (const name of names) {
    for (const variable of FILTER_NEUTRAL) set(`filter.${name}.${variable}`, "");
    set(`filter.${name}.required`, "false");
  }
  if (count > 0) env.GIT_CONFIG_COUNT = String(count);
  return env;
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitOutcome> {
  const { signal } = options;
  if (signal?.aborted) return { kind: "aborted" };
  const listing = await spawnGit(
    cwd,
    ["config", "--list", "-z", "--name-only", "--show-scope"],
    { ...options, maxBytes: DEFAULT_GIT_MAX_BYTES, input: undefined },
    {},
  );
  if (listing.kind !== "ok")
    return listing.kind === "over_cap" ? { kind: "failed", code: null } : listing;
  const overrides = filterOverrides(listing.stdout);
  if (overrides === null) return { kind: "failed", code: null };
  return spawnGit(cwd, args, options, overrides);
}

async function spawnGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions,
  overrides: Readonly<Record<string, string>>,
): Promise<GitOutcome> {
  const { signal, timeoutMs = DEFAULT_GIT_TIMEOUT_MS, maxBytes = DEFAULT_GIT_MAX_BYTES } = options;
  let proc: Bun.Subprocess<Buffer<ArrayBuffer> | "ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(["git", ...HARDENING, ...args], {
      cwd,
      env: { ...gitEnv(), ...overrides },
      stdin: options.input === undefined ? "ignore" : Buffer.from(options.input),
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return { kind: "failed", code: null };
  }
  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    proc.kill("SIGKILL");
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of proc.stdout) {
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        proc.kill("SIGKILL");
        return { kind: "over_cap", stdout: Buffer.concat(chunks) };
      }
      size += chunk.length;
      chunks.push(chunk);
    }
    const code = await proc.exited;
    if (aborted) return { kind: "aborted" };
    if (timedOut) return { kind: "timeout" };
    if (code !== 0) return { kind: "failed", code };
    return { kind: "ok", stdout: Buffer.concat(chunks) };
  } catch {
    if (aborted) return { kind: "aborted" };
    return timedOut ? { kind: "timeout" } : { kind: "failed", code: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
