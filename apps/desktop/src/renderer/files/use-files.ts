import type { Item } from "@omp-app/protocol";
import { useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { replicas, useStatus } from "../session-hooks";
import { debounce, type RefreshInputs, shouldRefresh, touchEpoch } from "./files-model";
import { createFilesStore, type PageState } from "./files-store";

/** The window's Files state, fed by the bridge. */
export const filesStore = createFilesStore(window.omp.files);

replicas.onMoved((from, to) => filesStore.moved(from, to));
// A session that left the replicas was closed: forget its page. Deferred one microtask so a
// `session.moved` (which removes the old id before it announces the new one) moves the page first.
replicas.store.subscribe((state) =>
  queueMicrotask(() => {
    for (const id of Object.keys(filesStore.store.getState().pages)) {
      if (!(id in state.sessions)) filesStore.dispose(id);
    }
  }),
);

/** The Files page of a session; undefined until the first look at it. */
export const usePage = (sessionId: string): PageState | undefined =>
  useStore(filesStore.store, (s) => s.pages[sessionId]);

const NO_ITEMS: readonly Item[] = [];

/** Wait this long after the last trigger, so a burst of edits is one `git status`. */
const REFRESH_MS = 250;

/**
 * Keeps a session's git state current while its pane is mounted: once at the start, when a
 * file-touching tool call ends, when a turn ends, and when the window gets focus again. There is
 * no watcher: the agent's tools and the person's editor are the only things that change the disk
 * in a way this page needs to follow, and the third covers the editor.
 */
export function useFilesRefresh(sessionId: string): void {
  const known = useStore(replicas.store, (s) => s.sessions[sessionId] !== undefined);
  const epoch = useStore(replicas.store, (s) =>
    touchEpoch(s.sessions[sessionId]?.timeline ?? NO_ITEMS),
  );
  const status = useStatus(sessionId);
  const last = useRef<RefreshInputs | null>(null);
  const scheduled = useMemo(
    () => debounce(() => filesStore.refresh(sessionId), REFRESH_MS),
    [sessionId],
  );

  useEffect(() => {
    if (!known) return;
    const next = { epoch, status };
    if (last.current === null) filesStore.refresh(sessionId);
    else if (shouldRefresh(last.current, next)) scheduled.trigger();
    last.current = next;
  }, [known, epoch, status, sessionId, scheduled]);

  useEffect(() => {
    const onFocus = () => scheduled.trigger();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      scheduled.cancel();
    };
  }, [scheduled]);
}
