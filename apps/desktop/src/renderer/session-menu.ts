import type { SessionStatus } from "@omp-app/protocol";

/** What the menu of a session row depends on. */
export interface SessionMenuInput {
  /** The window holds the session open; Clear and Delete act on a session the sidecar holds. */
  readonly open: boolean;
  readonly readOnly: boolean;
  readonly status: SessionStatus | undefined;
  /** The turn waits for the person (an approval or a question), not for the model. */
  readonly waiting: boolean;
  /** The session has a file: before its first turn there is nothing to clear or delete. */
  readonly onDisk: boolean;
}

/** An entry that is not there, can run, or is there but cannot run yet, and says why. */
export type MenuEntry =
  | { readonly state: "hidden" }
  | { readonly state: "enabled" }
  | { readonly state: "blocked"; readonly reason: string };

export interface SessionMenuState {
  readonly clear: MenuEntry;
  readonly delete: MenuEntry;
}

const HIDDEN: MenuEntry = { state: "hidden" };
const ENABLED: MenuEntry = { state: "enabled" };

export const CLEAR_BLOCKED = "A turn is running. Press Esc to stop it, then clear the context.";
export const DELETE_BLOCKED = "A turn is running. Press Esc to stop it, then delete the session.";

/**
 * Clear context and Delete session (Pen `QTqk0`). Both write, so a read-only app does not offer
 * them; both need a session the sidecar holds and that has a file. A running turn blocks both,
 * except that a turn waiting on the person can still be deleted (the request is rejected, Pen
 * `J5CJ7`); clearing under it would leave the question without a conversation.
 */
export function sessionMenuState(input: SessionMenuInput): SessionMenuState {
  if (!input.open || input.readOnly || !input.onDisk) return { clear: HIDDEN, delete: HIDDEN };
  const streaming = input.status === "streaming";
  return {
    clear: streaming ? { state: "blocked", reason: CLEAR_BLOCKED } : ENABLED,
    delete: streaming && !input.waiting ? { state: "blocked", reason: DELETE_BLOCKED } : ENABLED,
  };
}
