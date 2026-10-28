import type { MenuAnchor } from "@omp-app/ui";
import { createStore } from "zustand/vanilla";

export type KillKind = "subagent" | "job";

export interface KillTarget {
  readonly sessionId: string;
  readonly kind: KillKind;
  readonly id: string;
  readonly name: string;
  readonly anchor: MenuAnchor;
  /** Gets focus back when the card closes, so the keyboard does not fall to the page. */
  readonly opener: HTMLElement | null;
}

export interface KillState {
  readonly target: KillTarget | null;
  /** Why the last kill failed, as a sentence, and the session it failed in. */
  readonly error: { readonly sessionId: string; readonly message: string } | null;
}

export const killStore = createStore<KillState>(() => ({ target: null, error: null }));

/** Opens the confirmation for killing a subagent or a job. One card at a time, app-wide. */
export function askKill(target: KillTarget): void {
  killStore.setState({ target, error: null });
}

/** Closes the card and hands the keyboard back to what opened it. */
export function closeKill(): void {
  const opener = killStore.getState().target?.opener;
  killStore.setState({ target: null });
  opener?.focus();
}

export function failKill(sessionId: string, message: string): void {
  killStore.setState({ error: { sessionId, message } });
}

export function dismissKillError(): void {
  killStore.setState({ error: null });
}

/** A failure belongs to the session it happened in: showing it over another one would mislead. */
export function focusKillOn(sessionId: string | null): void {
  const { error } = killStore.getState();
  if (error && error.sessionId !== sessionId) killStore.setState({ error: null });
}
