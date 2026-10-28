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

export async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitOutcome> {
  const { signal, timeoutMs = DEFAULT_GIT_TIMEOUT_MS, maxBytes = DEFAULT_GIT_MAX_BYTES } = options;
  if (signal?.aborted) return { kind: "aborted" };
  let proc: Bun.Subprocess<Buffer<ArrayBuffer> | "ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(["git", ...HARDENING, ...args], {
      cwd,
      env: gitEnv(),
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
