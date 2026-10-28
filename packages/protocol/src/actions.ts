/**
 * The session actions omp has only as terminal builtins (`/clear`, `/session delete`, `/pause`)
 * and that the sidecar calls through the SDK instead: what each asks before it runs, what each
 * returns, and the sentences for the refusals. One module for the sidecar (which enforces
 * `confirmed`) and the renderer (which asks), so the question the person answers is the one the
 * handler required.
 */
import { isRecord } from "./guards";

/** The turn is running: omp refuses to drop its context, and a file in use is not deleted. */
export const ACTION_BUSY_MESSAGE = "action refused: a turn is running";

/** A builtin (`/compact`, `/handoff`) is still running; clearing under it would race its result. */
export const ACTION_COMMAND_MESSAGE = "action refused: a command is running";

/** A foreground shell command is running; its output would land after the new boundary. */
export const ACTION_SHELL_MESSAGE = "action refused: a shell command is running";

/** Another omp process (typically the CLI) owns the session file; deleting it would pull it away. */
export const FILE_OWNED_MESSAGE = "action refused: another omp process owns the session file";

export type SessionAction = "clear" | "delete";

/** What the person is asked before an action runs, in the words of the confirmation window. */
export interface ActionConfirmation {
  /** The bold line: `Delete “title”?`. */
  readonly question: string;
  /** What the action does beyond the obvious, in plain sentences. */
  readonly because: string;
  /** The label of the button that does it. */
  readonly confirm: string;
  /** The effect cannot be undone: the button is red and the focus starts on Cancel. */
  readonly destructive: boolean;
}

/** What the sentence depends on. `title` arrives already shortened for a line. */
export interface ActionFacts {
  readonly title: string;
  /** Persisted subagent sessions that go with the session (`session.deletePreview`). */
  readonly subagents?: number;
  /** The session waits for an approval or an answer; deleting it rejects the request. */
  readonly waiting?: boolean;
}

/**
 * The confirmation of Clear context and Delete session (Pen `TWRW2` and `K8sot8`).
 *
 * Clear differs from the frame in two places, both because omp's code says otherwise:
 * "checkpoints are kept" is false (`resetSessionContext` drops the checkpoint runtime state,
 * `agent-session.ts:6323` [V]), so the sentence does not promise them; and subagents and
 * background jobs still running are cancelled (`#cancelOwnAsyncJobs`, `agent-session.ts:6302,3204`
 * [V]).
 */
export function sessionActionConfirmation(
  action: SessionAction,
  facts: ActionFacts,
): ActionConfirmation {
  if (action === "clear") {
    return {
      question: `Clear context of “${facts.title}”?`,
      because:
        "The agent forgets the conversation; the timeline stays visible above a “Context cleared” line and in the session file. Your files are not touched. Subagents and background jobs still running are stopped.",
      confirm: "Clear",
      destructive: true,
    };
  }
  const subagents = facts.subagents ?? 0;
  const scope =
    subagents > 0
      ? `the session and its ${subagents} subagent ${subagents === 1 ? "session" : "sessions"}`
      : "the session file";
  // Pen `J5CJ7`: a session that waits on an approval is deleted anyway; the request is rejected.
  const waiting = facts.waiting === true;
  return {
    question: `Delete “${facts.title}”?`,
    because: waiting
      ? `Removes ${scope} from ~/.omp, so the CLI loses it too. It is waiting for your approval; deleting rejects the request. This cannot be undone.`
      : `Removes ${scope} from ~/.omp. The CLI loses it too. This cannot be undone.`,
    confirm: "Delete",
    destructive: true,
  };
}

/** The palette command that freezes and releases every agent; its label follows the state. */
export function pauseLabel(paused: boolean): string {
  return paused ? "Resume all agents" : "Pause all agents";
}

/**
 * Asked before pausing. Resuming asks nothing: it is the way out, and it only lets work go on.
 * The gate belongs to the whole sidecar (`agentPauseGate`, `pause.ts:42,54` [V]), so the sentence
 * says every open session, not the one the command was run from.
 */
export function pauseConfirmation(): ActionConfirmation {
  return {
    question: "Pause all agents?",
    because:
      "Freezes every open session, subagents included, at its next step until you resume. Nothing is stopped or lost. If omp restarts while paused, the sessions start unpaused.",
    confirm: "Pause",
    destructive: false,
  };
}

export interface ClearContextResult {
  /** Messages the agent no longer sees (omp's `droppedCount`). */
  readonly dropped: number;
}

export interface DeletePreview {
  /** Persisted subagent sessions that `session.delete` removes with the session. */
  readonly subagents: number;
}

export interface DeleteResult {
  /** Subagent sessions removed with the session. */
  readonly subagents: number;
}

export interface PauseState {
  readonly paused: boolean;
  /** Epoch ms when the pause began; absent while running. */
  readonly since?: number;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export function isClearContextResult(v: unknown): v is ClearContextResult {
  return isRecord(v) && isCount(v.dropped);
}

export function isDeletePreview(v: unknown): v is DeletePreview {
  return isRecord(v) && isCount(v.subagents);
}

export const isDeleteResult: (v: unknown) => v is DeleteResult = isDeletePreview;

export function isPauseState(v: unknown): v is PauseState {
  return (
    isRecord(v) &&
    typeof v.paused === "boolean" &&
    (v.since === undefined || (typeof v.since === "number" && Number.isFinite(v.since)))
  );
}
