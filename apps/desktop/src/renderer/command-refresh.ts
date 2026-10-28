import type { SessionsState } from "./session-store";

/**
 * Whether a command line ended between two states of the replicas. A builtin can change what the
 * sidebar lists (`/rename` sets the title on the session file), and the listing is the only
 * source of titles, so the window reads it again when a command finishes.
 */
export function commandEnded(before: SessionsState, after: SessionsState): boolean {
  for (const [id, was] of Object.entries(before.sessions)) {
    const now = after.sessions[id];
    if (!now) continue;
    for (const item of was.timeline) {
      if (item.kind !== "command" || item.state !== "running") continue;
      const same = now.timeline.find((i) => i.id === item.id);
      if (same?.kind === "command" && same.state !== "running") return true;
    }
  }
  return false;
}
