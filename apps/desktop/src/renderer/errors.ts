import { STALE_REQUEST_MESSAGE } from "@omp-app/protocol";

/** Electron prefixes errors thrown by an IPC handler with this; it means nothing to the user. */
const IPC_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;

/**
 * Messages the sidecar and the main process raise for an answer that is not valid. The window
 * only sends valid ones, so these are not reachable from it; they still never reach the screen.
 */
const REFUSED_ANSWER =
  /^(?:not an offered option|unknown answer field|answer to \S+ must be|\S+ (?:needs an answer|must be (?:text|true or false)|is not one of the offered choices|has a value that was not offered)|action is not valid|content is not valid)/;

/** The sentence a user sees for an error from the bridge, never the raw IPC text. */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw
    .replace(IPC_PREFIX, "")
    .replace(/^Error: /, "")
    .trim();
  if (text.startsWith(STALE_REQUEST_MESSAGE)) return "That question is no longer waiting.";
  if (REFUSED_ANSWER.test(text)) return "That answer was not accepted. Check it and try again.";
  if (/sidecar is not ready/i.test(text)) return "omp isn’t running. Restart it, then try again.";
  return text.length > 0 ? text : "Something went wrong.";
}
