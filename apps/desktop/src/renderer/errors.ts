import {
  ACTION_BUSY_MESSAGE,
  ACTION_COMMAND_MESSAGE,
  ACTION_SHELL_MESSAGE,
  CONFIRM_REQUIRED_MESSAGE,
  FILE_OWNED_MESSAGE,
  PLAN_BUSY_MESSAGE,
  SESSION_BUSY_MESSAGE,
  STALE_REQUEST_MESSAGE,
  UNKNOWN_COMMAND_MESSAGE,
} from "@omp-app/protocol";

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
  [
    new RegExp(`^${UNKNOWN_COMMAND_MESSAGE}: (\\S+)`),
    (m) => `omp has no command called ${m[1]} that runs here.`,
  ],
  [
    new RegExp(`^${CONFIRM_REQUIRED_MESSAGE}: (.+)`),
    (m) => `${m[1]} needs a confirmation first. Nothing was run.`,
  ],
  [/^session not found: /, () => "That session is no longer on disk."],
  [/^unknown session/, () => "That session isn’t open in omp any more."],
  // acp-agent.ts:2219-2227 [V]: plan mode is only offered while the `plan.enabled` setting is on.
  [
    /^Unsupported ACP mode: plan/,
    () => "Plan mode is turned off in omp’s settings (Tasks › Plan Mode).",
  ],
  // The sidecar refuses a plan switch while a turn runs; the toggle is disabled then, so this is
  // the answer to a click that raced the status change.
  [new RegExp(`^${PLAN_BUSY_MESSAGE}$`), () => "Plan mode changes between turns."],
  [
    new RegExp(`^${ACTION_BUSY_MESSAGE}$`),
    () => "The agent is working. Stop it with Esc, or wait for the turn to end.",
  ],
  [
    new RegExp(`^${ACTION_SHELL_MESSAGE}$`),
    () => "A shell command is still running in this session. Wait for it, then try again.",
  ],
  [
    new RegExp(`^${ACTION_COMMAND_MESSAGE}$`),
    () => "A command is still running in this session. Wait for it to end, then try again.",
  ],
  [
    new RegExp(`^${FILE_OWNED_MESSAGE}$`),
    () => "Another omp process (the CLI, probably) has this session open. Close it there first.",
  ],
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
    new RegExp(`^${SESSION_BUSY_MESSAGE}`),
    () => "The agent is working. Change the model or the thinking level when the turn ends.",
  ],
  [/^No API key for (\S+)/, (m) => `omp has no credentials for ${m[1]}. Add them, then try again.`],
  [/^unknown model/, () => "That model isn’t available to this session any more."],
  [/^unknown thinking level/, () => "That model doesn’t accept that thinking level."],
  [/^image refused: too_large/, () => "That image is too large to send. Try a smaller one."],
  [/^image refused: type/, () => "Only PNG, JPEG, GIF and WebP images can be attached."],
  [/^image refused: count/, () => "A message can carry only a few images."],
  [/^image refused: /, () => "That image couldn’t be read. Try another one."],
  [
    /^Extension command "\/[^"]*" cannot be queued/,
    () => "That command can only run when the agent is idle. Send it again when the turn ends.",
  ],
  [/^invalid (?:prompt|model|thinking level|queue entry|query)/, () => "That couldn’t be sent."],
  [
    /could not stop subagent/,
    () => "omp couldn’t stop that subagent. It is still running; try again.",
  ],
  [
    /database is newer than this app supports/,
    () => "omp-app is read-only: your omp data is newer than this version supports.",
  ],
];

/**
 * Why the engine stopped, as the sentence to show. The one failure the window can name is a
 * frame past the protocol limit (`FrameTooLongError`); anything else is the supervisor's own
 * text (exit code, lost connection) and passes through.
 */
export function describeEngineFailure(raw: string): string {
  if (/^frame line exceeds \d+ characters/.test(raw)) {
    return "omp sent a message that was too large for this app to read, so the connection was closed. Restart omp to continue.";
  }
  return raw;
}

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

/**
 * omp's objections to an `mcp.json` entry or to a name (`validateServerConfig` and
 * `validateServerName`, omp 18.12.6 `mcp/config.ts:340-367`, `mcp/config-writer.ts:88-101` [V]),
 * as the sentence to show. Text that matches none of them is one of the sidecar's own sentences
 * and passes through.
 */
const CONFIG_PROBLEMS: readonly (readonly [RegExp, string | ((m: RegExpMatchArray) => string)])[] =
  [
    [
      /Server "[^"]*": both "command" and "url" are set[^.]*?not both/g,
      "This server sets both a command and a URL. Keep one.",
    ],
    [
      /Server "[^"]*": stdio server requires "command" field/g,
      "This stdio server needs a command.",
    ],
    [
      /Server "[^"]*": (http|sse) server requires "url" field/g,
      (m) => `This ${m[1]} server needs a URL.`,
    ],
    [
      /Server "[^"]*": unknown server type "([^"]*)"/g,
      (m) => `“${m[1]}” isn’t a transport omp knows. Use stdio, http or sse.`,
    ],
    [/Server name cannot be empty/g, "Give the server a name."],
    [
      /Server name is too long \(max (\d+) characters\)/g,
      (m) => `That name is longer than ${m[1]} characters.`,
    ],
    [
      /Server name can only contain letters, numbers, dash, underscore, dot, colon, and single spaces/g,
      "A name can use letters, numbers, dash, underscore, dot, colon and single spaces.",
    ],
  ];

export function describeConfigProblem(text: string): string {
  let out = text;
  for (const [pattern, sentence] of CONFIG_PROBLEMS) {
    out = out.replace(pattern, (...args) => {
      if (typeof sentence === "string") return sentence;
      const groups = args.slice(0, -2).map((a) => (typeof a === "string" ? a : ""));
      return sentence(groups as unknown as RegExpMatchArray);
    });
  }
  return out;
}

/** Why an MCP server did not connect, as a sentence. The raw text from the process is not shown. */
const CONNECT_FAILURES: readonly (readonly [RegExp, string])[] = [
  [/ENOENT/, "The command wasn’t found. Check that it is installed and on your PATH."],
  [/EACCES|permission denied/i, "The command isn’t allowed to run. Check its permissions."],
  [
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|getaddrinfo/i,
    "omp couldn’t reach the server. Check the URL and your connection.",
  ],
  [
    /\b(?:401|403)\b|unauthori[sz]ed|forbidden/i,
    "The server refused the credentials. Check the token or headers.",
  ],
  [/time(?:d)?[ -]?out/i, "The server didn’t answer in time."],
  [
    /connection closed|exited|EPIPE/i,
    "The server stopped right after it started. Run its command in a terminal to see why.",
  ],
];

export function describeMcpFailure(text: string): string {
  for (const [pattern, sentence] of CONNECT_FAILURES) if (pattern.test(text)) return sentence;
  return "omp couldn’t start this server.";
}

/**
 * Text the sidecar sends for a refusal or a problem it found: its own sentences, or omp's
 * validation text. Both become a sentence, and the IPC wrapper never shows.
 */
export function describeSidecarText(text: string): string {
  return describeConfigProblem(describeError(text));
}
