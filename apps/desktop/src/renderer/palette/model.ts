import {
  confirmationOf,
  type SlashCommand,
  type SlashSubcommand,
  type StoredSession,
} from "@omp-app/protocol";
import type { EnginePhase } from "../composer-state";
import { NEW_SESSION_TITLE } from "../format";
import { buildRows, projectLabels } from "../projects";
import { type Range, rank } from "./search";

/**
 * What the command palette shows and what Enter does, as plain data (Pen `NUFjM`). The component
 * draws it and owns focus; every decision that can be wrong lives here, where it is tested.
 */

// -- The query ----------------------------------------------------------------------------------

/** `all` searches everything; a leading `/` limits it to omp commands, `>` to app actions. */
export type Mode = "all" | "commands" | "actions";

export const MODE_PREFIX: Readonly<Record<Mode, string>> = { all: "", commands: "/", actions: ">" };

export function parseQuery(raw: string): { mode: Mode; text: string } {
  if (raw.startsWith("/")) return { mode: "commands", text: raw.slice(1) };
  if (raw.startsWith(">")) return { mode: "actions", text: raw.slice(1) };
  return { mode: "all", text: raw };
}

/** Text typed after `/`: the command word, and what follows it once a space was typed. */
export function splitCommand(text: string): { word: string; args: string | null } {
  const space = text.search(/\s/);
  if (space === -1) return { word: text, args: null };
  return { word: text.slice(0, space), args: text.slice(space).replace(/^\s+/, "") };
}

// -- What can be found --------------------------------------------------------------------------

export interface SessionRef {
  readonly id: string;
  readonly title: string;
  /** Folder label, as the sidebar shows it. */
  readonly project: string;
  readonly focused: boolean;
}

export type ActionId =
  | "new-session"
  | "open-settings"
  | "toggle-left"
  | "toggle-right"
  | "fork-session"
  | "clear-context"
  | "delete-session"
  | "toggle-pause";

export interface ActionRef {
  readonly id: ActionId;
  readonly label: string;
  /** Acts on the focused session: listed under "This session", not under "App actions". */
  readonly scope?: "session";
  /** Asks first, saying what it does; the host words the question (`onPrepare`). */
  readonly asks?: true;
  /** A real shortcut that already does this, drawn at the right of the row. */
  readonly shortcut?: string;
}

/** Why the focused session cannot take a command, or null when it can. First reason wins. */
export function commandsBlocked(input: {
  readonly sessionId: string | null;
  readonly readOnly: boolean;
  readonly engine: EnginePhase;
}): "no-session" | "read-only" | "engine" | null {
  if (input.sessionId === null) return "no-session";
  if (input.readOnly) return "read-only";
  return input.engine === "ready" ? null : "engine";
}

/** Where the omp commands stand: asked for, answered, refused, or not askable. */
export type CommandsState =
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | { readonly state: "unavailable"; readonly why: "no-session" | "read-only" | "engine" }
  | { readonly state: "ready"; readonly commands: readonly SlashCommand[] };

export interface PaletteInput {
  readonly sessions: readonly SessionRef[];
  readonly actions: readonly ActionRef[];
  readonly commands: CommandsState;
  /** The focused session can take a prompt right now; enables "Send … to the agent". */
  readonly canPrompt: boolean;
  /** Title of the focused session, for the suggestion row. */
  readonly focusedTitle: string | null;
}

export type Entry =
  | { readonly kind: "session"; readonly session: SessionRef }
  | { readonly kind: "action"; readonly action: ActionRef }
  | { readonly kind: "command"; readonly command: SlashCommand }
  /** The command as typed, with its arguments: the row that runs it. */
  | { readonly kind: "run"; readonly command: SlashCommand; readonly args: string }
  | { readonly kind: "sub"; readonly command: SlashCommand; readonly sub: SlashSubcommand }
  | { readonly kind: "prompt"; readonly text: string; readonly sessionTitle: string };

export interface Row {
  readonly key: string;
  readonly entry: Entry;
  /** Where the query hit the row's main label. */
  readonly ranges: readonly Range[];
}

export type GroupId = "sessions" | "session" | "actions" | "commands" | "suggestion";

export interface Group {
  readonly id: GroupId;
  /** Shown in small caps; the frame's group headers. */
  readonly label: string;
  readonly rows: readonly Row[];
  /** Rows that matched but were cut for length. */
  readonly more: number;
}

/** Why the omp commands are not listed, when the person is looking for them. */
export type CommandsNote = "loading" | "failed" | "no-session" | "read-only" | "engine";

export type View =
  | { readonly kind: "list"; readonly groups: readonly Group[]; readonly note: CommandsNote | null }
  | { readonly kind: "empty"; readonly query: string; readonly groups: readonly Group[] };

/** Rows per group while nothing is typed; the rest is a search away. */
export const IDLE_LIMIT = { sessions: 6, session: 3, actions: 4, commands: 6 } as const;
/** Rows per group while searching. */
export const SEARCH_LIMIT = 30;

// -- Building the view --------------------------------------------------------------------------

const LABELS: Record<GroupId, string> = {
  sessions: "Sessions",
  session: "This session",
  actions: "App actions",
  commands: "omp commands",
  suggestion: "Suggestion",
};

const isRequired = (command: SlashCommand): boolean => command.hint?.startsWith("<") === true;

function limited(
  id: GroupId,
  ranked: readonly { item: Entry; ranges: readonly Range[] }[],
  limit: number,
  keyOf: (entry: Entry) => string,
): Group | null {
  if (ranked.length === 0) return null;
  const rows = ranked.slice(0, limit).map(({ item, ranges }) => ({
    key: keyOf(item),
    entry: item,
    ranges,
  }));
  return { id, label: LABELS[id], rows, more: ranked.length - rows.length };
}

const keyOf = (entry: Entry): string => {
  switch (entry.kind) {
    case "session":
      return `session:${entry.session.id}`;
    case "action":
      return `action:${entry.action.id}`;
    case "command":
      return `command:${entry.command.name}`;
    case "run":
      return `run:${entry.command.name}`;
    case "sub":
      return `sub:${entry.command.name}:${entry.sub.name}`;
    case "prompt":
      return "prompt";
  }
};

function noteFor(input: PaletteInput, mode: Mode): CommandsNote | null {
  const c = input.commands;
  if (c.state === "ready") return null;
  if (c.state === "unavailable") return mode === "commands" ? c.why : null;
  return c.state;
}

/** The command a word names exactly, by name or alias. */
export function commandNamed(
  commands: readonly SlashCommand[],
  word: string,
): SlashCommand | undefined {
  const w = word.toLowerCase();
  return commands.find((c) => c.name === w || c.aliases.includes(w));
}

/**
 * The query once a command is named and a space typed (`/switch son`): the palette stops
 * searching and takes the rest as the command's arguments. `word` is what was typed, which may be
 * an alias. Null while still searching for the command.
 */
export function argumentStage(
  raw: string,
  commands: readonly SlashCommand[],
): { readonly command: SlashCommand; readonly word: string; readonly args: string } | null {
  const { mode, text } = parseQuery(raw);
  if (mode !== "commands") return null;
  const { word, args } = splitCommand(text);
  const command = args === null ? undefined : commandNamed(commands, word);
  return command && args !== null ? { command, word, args } : null;
}

/** The rows after `/name `: the line that runs the command, and the words omp completes. */
function argumentGroup(command: SlashCommand, args: string): Group {
  const entries: Entry[] = [{ kind: "run", command, args: args.trimEnd() }];
  const words = args.trimEnd() === "" ? [] : args.trimEnd().split(/\s+/);
  // Subcommands complete only the first word; after that omp parses the rest.
  if (words.length <= 1 && !/\s$/.test(args)) {
    const typed = words[0] ?? "";
    const subs = rank(command.subcommands, typed, (s) => ({
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
    }));
    for (const { item } of subs) {
      if (item.name !== typed) entries.push({ kind: "sub", command, sub: item });
    }
  }
  return {
    id: "commands",
    label: LABELS.commands,
    rows: entries.map((entry) => ({ key: keyOf(entry), entry, ranges: [] })),
    more: 0,
  };
}

/** The palette's content for a raw query (prefix included). */
export function buildView(raw: string, input: PaletteInput): View {
  const { mode, text } = parseQuery(raw);
  const query = text.trim();
  const searching = query !== "";
  const cap = (idle: number): number => (searching ? SEARCH_LIMIT : idle);
  const note = noteFor(input, mode);
  const commands = input.commands.state === "ready" ? input.commands.commands : [];

  // `/name ` plus anything: the person is writing the arguments of one command.
  const stage = argumentStage(raw, commands);
  if (stage) return { kind: "list", groups: [argumentGroup(stage.command, stage.args)], note };

  const groups: { group: Group; top: number }[] = [];
  if (mode !== "commands" && mode !== "actions") {
    const ranked = rank(
      input.sessions.map((session): Entry => ({ kind: "session", session })),
      query,
      (e) =>
        e.kind === "session" ? { name: e.session.title, alt: [e.session.project] } : { name: "" },
    );
    const group = limited("sessions", ranked, cap(IDLE_LIMIT.sessions), keyOf);
    if (group) groups.push({ group, top: ranked[0]?.score ?? 0 });
  }
  if (mode !== "commands") {
    // The actions on the focused session sit in their own group, so "Delete session" is never
    // mistaken for something the app does to itself.
    for (const [id, scope] of [
      ["session", "session"],
      ["actions", undefined],
    ] as const) {
      const ranked = rank(
        input.actions
          .filter((action) => action.scope === scope)
          .map((action): Entry => ({ kind: "action", action })),
        query,
        (e) => (e.kind === "action" ? { name: e.action.label } : { name: "" }),
      );
      const group = limited(id, ranked, cap(IDLE_LIMIT[id]), keyOf);
      if (group) groups.push({ group, top: ranked[0]?.score ?? 0 });
    }
  }
  if (mode !== "actions") {
    const ranked = rank(
      commands.map((command): Entry => ({ kind: "command", command })),
      mode === "commands" ? splitCommand(text).word : query,
      (e) =>
        e.kind === "command"
          ? {
              name: e.command.name,
              alt: e.command.aliases,
              description: e.command.description,
            }
          : { name: "" },
    );
    // `/` asks for the whole list, so it is not cut to the few the mixed view shows.
    const group = limited(
      "commands",
      ranked,
      mode === "commands" ? ranked.length : cap(IDLE_LIMIT.commands),
      keyOf,
    );
    if (group) groups.push({ group, top: ranked[0]?.score ?? 0 });
  }

  // Best match first; with nothing typed every score is 0 and the order stays as built.
  groups.sort((a, b) => b.top - a.top);
  const ordered = groups.map((g) => g.group);

  if (ordered.length === 0) {
    const suggestion =
      mode === "all" && searching && input.canPrompt && input.focusedTitle !== null
        ? ([
            {
              id: "suggestion" as const,
              label: LABELS.suggestion,
              rows: [
                {
                  key: "prompt",
                  entry: {
                    kind: "prompt" as const,
                    text: query,
                    sessionTitle: input.focusedTitle,
                  },
                  ranges: [] as readonly Range[],
                },
              ],
              more: 0,
            },
          ] satisfies Group[])
        : [];
    // While the commands are on their way, or when the person asked for them, say that instead
    // of "no results": the answer may just not have arrived.
    const waitingOnCommands = note === "loading" || (mode === "commands" && note !== null);
    if (!waitingOnCommands && (note === null || searching)) {
      return { kind: "empty", query, groups: suggestion };
    }
  }
  return { kind: "list", groups: ordered, note };
}

// -- Selection ----------------------------------------------------------------------------------

export function rowsOf(view: View): readonly Row[] {
  return view.groups.flatMap((g) => g.rows);
}

/** Arrow keys wrap around, as in a menu. */
export function moveSelection(index: number, count: number, delta: number): number {
  if (count === 0) return 0;
  return (((index + delta) % count) + count) % count;
}

// -- What Enter does ----------------------------------------------------------------------------

export type Outcome =
  | { readonly do: "select-session"; readonly id: string }
  | { readonly do: "action"; readonly id: ActionId; readonly confirmed?: true }
  /** The action asks first: the host words the question, then the palette shows it. */
  | { readonly do: "ask"; readonly id: ActionId }
  | { readonly do: "prompt"; readonly text: string }
  | { readonly do: "run"; readonly line: string; readonly confirmed?: true }
  /** The command reaches beyond the session: ask first, saying what it does. */
  | {
      readonly do: "confirm";
      readonly line: string;
      readonly because: string;
      /** The effect is lost for good: the answer is the red button. */
      readonly destructive: boolean;
    }
  /** The command needs an argument: put its name in the field and let the person finish it. */
  | { readonly do: "complete"; readonly raw: string }
  | { readonly do: "none" };

/** `args` is what follows the name; the same `confirmationOf` the sidecar enforces decides. */
function runOrConfirm(command: SlashCommand, args: string): Outcome {
  const line = args === "" ? `/${command.name}` : `/${command.name} ${args}`;
  const confirmation = confirmationOf(command, args);
  return confirmation === null
    ? { do: "run", line }
    : {
        do: "confirm",
        line,
        because: confirmation.because,
        destructive: confirmation.destructive === true,
      };
}

export function activate(entry: Entry): Outcome {
  switch (entry.kind) {
    case "session":
      return { do: "select-session", id: entry.session.id };
    case "action":
      return entry.action.asks
        ? { do: "ask", id: entry.action.id }
        : { do: "action", id: entry.action.id };
    case "prompt":
      return { do: "prompt", text: entry.text };
    case "command":
      return isRequired(entry.command)
        ? { do: "complete", raw: `/${entry.command.name} ` }
        : runOrConfirm(entry.command, "");
    case "run": {
      // A required argument that is still empty has nothing to run yet.
      if (isRequired(entry.command) && entry.args === "") return { do: "none" };
      return runOrConfirm(entry.command, entry.args);
    }
    case "sub":
      return entry.sub.usage
        ? { do: "complete", raw: `/${entry.command.name} ${entry.sub.name} ` }
        : runOrConfirm(entry.command, entry.sub.name);
  }
}

/** Tab completes the selected command or subcommand into the field instead of running it. */
export function completion(entry: Entry): string | null {
  switch (entry.kind) {
    case "command":
      return `/${entry.command.name} `;
    case "sub":
      return `/${entry.command.name} ${entry.sub.name} `;
    default:
      return null;
  }
}

// -- Sessions -----------------------------------------------------------------------------------

/**
 * The sessions the palette can switch to: the open ones first (a new session is not on disk
 * yet), then the ones on disk newest first, as the sidebar lists them. `titles` carries the
 * title of an open session from its replica.
 */
export function sessionRefs(
  stored: readonly StoredSession[] | null,
  open: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, string>,
  focused: string | null,
): SessionRef[] {
  const rows = buildRows(stored ?? [], open);
  const labels = projectLabels(rows.map((r) => r.cwd));
  const refs = rows.map((row) => ({
    id: row.id,
    title: row.title ?? titles.get(row.id) ?? NEW_SESSION_TITLE,
    project: labels.get(row.cwd) ?? row.cwd,
    focused: row.id === focused,
  }));
  // The session already in front is the least useful answer to "switch session".
  return [...refs.filter((r) => !r.focused), ...refs.filter((r) => r.focused)];
}

// -- Words for people ---------------------------------------------------------------------------

/** What a screen reader hears when the list changes: how many rows, or that there are none. */
export function describeResults(view: View): string {
  const count = rowsOf(view).length;
  if (view.kind === "empty") {
    return `No results for ${view.query}${count > 0 ? ". One suggestion" : ""}`;
  }
  if (count === 0) return "No results";
  return count === 1 ? "1 result" : `${count} results`;
}

/** The note shown when the omp commands are not listed, as a sentence. */
export const NOTE_TEXT: Readonly<Record<CommandsNote, string>> = {
  loading: "Loading omp commands…",
  failed: "Couldn’t load the omp commands.",
  "no-session": "Open a session to run omp commands.",
  "read-only": "omp commands are off while omp-app is read-only.",
  engine: "omp isn’t running. Restart it to run commands.",
};

/**
 * Which button of the confirm step takes the focus. A confirm that discards state starts on
 * Cancel: Enter (a double tap, a key repeat) then backs out, and Run takes a Tab or a click.
 */
export function confirmFocus(confirm: { readonly destructive: boolean }): "run" | "cancel" {
  return confirm.destructive ? "cancel" : "run";
}
