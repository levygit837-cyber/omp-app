import type { QueueState, SessionStatus } from "@omp-app/protocol";
import type { EnginePhase } from "./composer-state";
import { modelLabel } from "./format";

/** Longest piece of a reply read out when it finishes. */
export const ANNOUNCE_MAX = 120;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length > ANNOUNCE_MAX ? `${points.slice(0, ANNOUNCE_MAX - 1).join("")}…` : flat;
}

export interface AnnounceInput {
  /** The status shown before this change, and the one shown now (see `shownStatus`). */
  readonly previous: SessionStatus | undefined;
  readonly status: SessionStatus | undefined;
  readonly engine: EnginePhase;
  /** Text of the last assistant message, read when a turn ends. */
  readonly lastReply: string | undefined;
}

/**
 * What a screen reader hears, and only at a transition: a turn starts, or it ends. Text arriving
 * while it runs is never announced, and neither is scrolling through the timeline.
 */
export function announce({ previous, status, engine, lastReply }: AnnounceInput): string | null {
  const wasRunning = previous === "streaming";
  const isRunning = status === "streaming";
  if (isRunning && !wasRunning) return "Assistant is responding";
  if (!wasRunning || isRunning) return null;
  if (engine !== "ready") return "omp stopped while the assistant was responding";
  if (status === "failed") return "The session failed";
  const reply = lastReply ? clip(lastReply) : "";
  return reply ? `Assistant finished: ${reply}` : "Assistant finished";
}

/**
 * What a screen reader hears when the queue of waiting messages changes: a message entering says
 * which kind, a message leaving says how many are left. The queue alone cannot tell a delivery
 * from a removal, so the wording is the same for both.
 */
export function announceQueue(
  previous: QueueState | undefined,
  next: QueueState | undefined,
): string | null {
  if (!previous || !next) return null;
  const before = previous.steering.length + previous.followUp.length;
  const after = next.steering.length + next.followUp.length;
  if (after > before) {
    return next.steering.length > previous.steering.length ? "Steer queued" : "Follow-up queued";
  }
  if (after < before) return after === 0 ? "Queue empty" : `${after} queued`;
  return null;
}

/** Model or thinking level changed under the person's hands. Null while either side is unknown. */
export function announceControls(
  previous: {
    readonly model: string | null | undefined;
    readonly thinking: string | null | undefined;
  },
  next: { readonly model: string | null | undefined; readonly thinking: string | null | undefined },
): string | null {
  if (next.model && previous.model && next.model !== previous.model) {
    return `Model: ${modelLabel(next.model)}`;
  }
  if (next.thinking && previous.thinking && next.thinking !== previous.thinking) {
    return `Thinking: ${next.thinking}`;
  }
  return null;
}
