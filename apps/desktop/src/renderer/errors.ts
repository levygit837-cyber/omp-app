import { STALE_REQUEST_MESSAGE } from "@omp-app/protocol";

/** Electron prefixes errors thrown by an IPC handler with this; it means nothing to the user. */
const IPC_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;

/**
 * Messages the sidecar and the main process raise for an answer that is not valid. The window
 * only sends valid ones, so these are not reachable from it; they still never reach the screen.
 */
const REFUSED_ANSWER =
  /^(?:not an offered option|unknown answer field|answer to \S+ must be|\S+ (?:needs an answer|must be (?:text|true or false)|is not one of the offered choices|has a value that was not offered)|action is not valid|content is not valid)/;

/**
 * Messages the sidecar and omp raise for things a user can run into, as the sentence to show.
 * The patterns match omp's wording (acp-agent.ts:1775 and neighbours) and the sidecar's own.
 */
const KNOWN: readonly (readonly [RegExp, (match: RegExpMatchArray) => string])[] = [
  [
    /^folder no longer exists: (.+)$/s,
    (m) => `The session’s folder no longer exists (${m[1]}), so it can’t be opened here.`,
  ],
  [/^session not found: /, () => "That session is no longer on disk."],
  [/^unknown session/, () => "That session isn’t open in omp any more."],
  [
    /Could not restore model (\S+)/,
    (m) => `omp couldn’t restore the model this session used (${m[1]}). Check its credentials.`,
  ],
  [
    /fork is unavailable while a prompt is in progress/,
    () => "This session is running a turn. Fork it when the turn ends.",
  ],
  [
    /cannot be forked before it is persisted/,
    () => "This session has no turns yet, so there is nothing to fork.",
  ],
  [
    /database is newer than this app supports/,
    () => "omp-app is read-only: your omp data is newer than this version supports.",
  ],
];

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
  for (const [pattern, sentence] of KNOWN) {
    const match = text.match(pattern);
    if (match) return sentence(match);
  }
  return text.length > 0 ? text : "Something went wrong.";
}
