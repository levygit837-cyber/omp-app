import {
  ACTION_BUSY_MESSAGE,
  CONFIRM_REQUIRED_MESSAGE,
  type PauseState,
  type SessionOp,
  type SessionViewModel,
} from "@omp-app/protocol";

/** What the fake sidecar needs of a session for Clear context, Delete session and pause. */
export interface ActionFakeSession {
  readonly vm: SessionViewModel;
}

/**
 * The persisted subagent sessions a delete takes along. `FAKE_DELETE_SUBAGENTS=<n>` picks the
 * number, so the smoke run can show both sentences of the Delete window.
 */
export const fakeSubagents = (): number => Number(process.env.FAKE_DELETE_SUBAGENTS ?? 0);

let paused: PauseState = { paused: false };

export const fakePauseState = (): PauseState => paused;

/** Like the real sidecar: pausing needs the answer, resuming does not. */
export function setFakePaused(
  emit: (op: SessionOp) => void,
  want: boolean,
  confirmed: boolean,
): PauseState {
  if (want && !confirmed) throw new Error(`${CONFIRM_REQUIRED_MESSAGE}: pause`);
  const changed = paused.paused !== want;
  paused = want ? (changed ? { paused: true, since: Date.now() } : paused) : { paused: false };
  const now = Date.now();
  emit({
    type: "item.add",
    item: {
      kind: "command",
      id: `pause-${now}`,
      text: want ? "/pause" : "/resume",
      state: "done",
      output: !changed
        ? want
          ? "Every agent was already paused."
          : "No agent was paused."
        : want
          ? "Every open session and its subagents stop at their next step. Nothing was cancelled. Run “Resume all agents” from the command palette to let them go on. If omp restarts while paused, the sessions start unpaused."
          : "Every open session goes on from where it stopped.",
      startedAt: now,
      endedAt: now,
    },
  });
  return paused;
}

/** Clear context: refused mid-turn, confirmed by the caller; the timeline gets a boundary line. */
export function clearFake(
  session: ActionFakeSession & { turn?: unknown },
  emit: (op: SessionOp) => void,
  confirmed: boolean,
): { dropped: number } {
  if (!confirmed) throw new Error(`${CONFIRM_REQUIRED_MESSAGE}: clear`);
  if (session.turn) throw new Error(ACTION_BUSY_MESSAGE);
  const dropped = session.vm.timeline.filter(
    (item) => item.kind === "user" || item.kind === "assistant",
  ).length;
  emit({
    type: "item.add",
    item: { kind: "boundary", id: `boundary-${Date.now()}`, at: Date.now() },
  });
  return { dropped };
}
