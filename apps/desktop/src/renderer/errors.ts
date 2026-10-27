/** Electron prefixes errors thrown by an IPC handler with this; it means nothing to the user. */
const IPC_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;

/** The sentence a user sees for an error from the bridge, never the raw IPC text. */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw
    .replace(IPC_PREFIX, "")
    .replace(/^Error: /, "")
    .trim();
  if (/sidecar is not ready/i.test(text)) return "omp isn’t running. Restart it, then try again.";
  return text.length > 0 ? text : "Something went wrong.";
}
