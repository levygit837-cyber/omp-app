/**
 * The slash commands omp can run without a terminal, as the command palette lists them.
 * Only builtins with a non-TUI handler appear (`SlashCommandSpec.handle`,
 * slash-commands/types.ts:190 [V]): a name without one would go to the model as plain text.
 */
import { isRecord } from "./guards";

/** An argument word omp completes for a command (`/mcp add`, `/fast on`). */
export interface SlashSubcommand {
  readonly name: string;
  readonly description?: string;
  /** Argument shape after the subcommand, e.g. `<name> [--scope project|user]`. */
  readonly usage?: string;
}

export interface SlashCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  /** Shape of the argument (`[model]`); absent when the command takes none. */
  readonly hint?: string;
  readonly subcommands: readonly SlashSubcommand[];
  /** Asked before any line of this command runs; see `confirmationOf`. */
  readonly confirm?: Confirmation;
  /** Asked only when the first argument is one of these words (`/usage reset`, `/session delete`). */
  readonly confirmVerbs?: readonly VerbConfirmation[];
}

/**
 * What a line does beyond the session, in one sentence, asked before it runs: it sends
 * something off the machine, writes outside the session, starts a server, moves the session,
 * changes configuration or discards state. Such a line never runs from a single keystroke, and
 * the sidecar refuses it without `confirmed` (`CONFIRM_REQUIRED_MESSAGE`).
 */
export interface Confirmation {
  readonly because: string;
  /** The effect is lost for good (a deleted file, a spent credit): the answer is a red button. */
  readonly destructive?: true;
}

export interface VerbConfirmation extends Confirmation {
  /** Lower case, as omp reads the first word after the command name (`parseSubcommand`). */
  readonly verbs: readonly string[];
}

/**
 * The confirmation a line needs, or null. `args` is what follows the command name; the first
 * word picks a verb entry, which wins over the command-wide one. One function for the sidecar
 * (which enforces) and the palette (which asks), so they cannot disagree.
 */
export function confirmationOf(
  command: Pick<SlashCommand, "confirm" | "confirmVerbs">,
  args: string,
): Confirmation | null {
  const verb = args.trim().split(/\s/, 1)[0]?.toLowerCase() ?? "";
  return command.confirmVerbs?.find((c) => c.verbs.includes(verb)) ?? command.confirm ?? null;
}

/**
 * Prefix of the error for a line that is not a builtin omp can run without a terminal. Shared
 * because Electron's IPC keeps only the message text, so the renderer has to match on it.
 */
export const UNKNOWN_COMMAND_MESSAGE = "unknown command";

/** Prefix of the error for a line that needs a confirmation and was sent without `confirmed`. */
export const CONFIRM_REQUIRED_MESSAGE = "confirmation required";

export interface SessionCommandsResult {
  readonly commands: readonly SlashCommand[];
}

const optString = (v: unknown): boolean => v === undefined || typeof v === "string";

function isSubcommand(v: unknown): v is SlashSubcommand {
  return (
    isRecord(v) && typeof v.name === "string" && optString(v.description) && optString(v.usage)
  );
}

function isConfirmation(v: unknown): v is Confirmation {
  return (
    isRecord(v) &&
    typeof v.because === "string" &&
    (v.destructive === undefined || v.destructive === true)
  );
}

function isVerbConfirmation(v: unknown): v is VerbConfirmation {
  return (
    isRecord(v) &&
    isConfirmation(v) &&
    Array.isArray(v.verbs) &&
    v.verbs.every((w) => typeof w === "string")
  );
}

function isSlashCommand(v: unknown): v is SlashCommand {
  return (
    isRecord(v) &&
    typeof v.name === "string" &&
    Array.isArray(v.aliases) &&
    v.aliases.every((a) => typeof a === "string") &&
    typeof v.description === "string" &&
    optString(v.hint) &&
    Array.isArray(v.subcommands) &&
    v.subcommands.every(isSubcommand) &&
    (v.confirm === undefined || isConfirmation(v.confirm)) &&
    (v.confirmVerbs === undefined ||
      (Array.isArray(v.confirmVerbs) && v.confirmVerbs.every(isVerbConfirmation)))
  );
}

export function isSessionCommandsResult(v: unknown): v is SessionCommandsResult {
  return isRecord(v) && Array.isArray(v.commands) && v.commands.every(isSlashCommand);
}
