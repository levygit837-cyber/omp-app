import type { SessionStatus } from "@omp-app/protocol";
import type { EnginePhase } from "./composer-state";

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
