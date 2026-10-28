import { useSyncExternalStore } from "react";

/**
 * Asks a session's timeline to follow its newest line again, from outside the session pane: a
 * command run from the palette answers there, and the person just asked for it even if they had
 * scrolled up. The pane adds the count to the token it already passes the timeline.
 */
const counts = new Map<string, number>();
const listeners = new Set<() => void>();

export function requestFollow(sessionId: string): void {
  counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
  for (const listener of listeners) listener();
}

export function useFollowRequests(sessionId: string): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => counts.get(sessionId) ?? 0,
  );
}
