import type { StoredSession } from "@omp-app/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { commandEnded } from "./command-refresh";
import { describeError } from "./errors";
import { NONE, parse, type Reopened, rekey, reopen, serialize } from "./open-sessions";
import {
  type ActionApi,
  type ActionError,
  actionError,
  type Held,
  type Patch,
  perform,
} from "./session-actions";
import { replicas } from "./session-hooks";

/** Survives a window reload (same tab), so a reload brings the open sessions back. */
const STORAGE_KEY = "omp-app.openSessions";

export const message = describeError;

const INITIAL: Held = { sessions: NONE, lost: false, error: null };

export interface SessionController {
  /** Sessions the window holds open, in the order they were opened. */
  readonly open: readonly string[];
  /** The session the center column shows, or null. */
  readonly focused: string | null;
  /** The session that was focused could not be brought back (it is gone from disk too). */
  readonly lost: boolean;
  /** True while the open sessions are being brought back; actions wait for it. */
  readonly restoring: boolean;
  /** Why the last action (new, resume, fork, close) failed, shown wherever the user is. */
  readonly error: ActionError | null;
  /** Sessions on disk, newest first, or null until the first listing arrives. */
  readonly stored: readonly StoredSession[] | null;
  /** Why the listing failed, or null. */
  readonly listError: string | null;
  /** Pick a directory and start a session in it. */
  start(): Promise<void>;
  /** Start a session in a folder already known (a recent project). */
  startIn(cwd: string): Promise<void>;
  /** Focus an open session, or open a stored one with its full history. */
  select(sessionId: string): Promise<void>;
  /** Copy a session, as it is on disk, into a new one and focus the copy. */
  fork(sessionId: string): Promise<void>;
  /** Remove a session from the open set. Its file stays on disk. */
  close(sessionId: string): Promise<void>;
  /** Drops the agent's memory of a session; its timeline stays. Already confirmed by the person. */
  clearContext(sessionId: string): Promise<void>;
  /** Deletes a session and its files, and closes it. Already confirmed by the person. */
  remove(sessionId: string): Promise<void>;
  /** What deleting would take with the session (its subagent sessions), or null when it failed. */
  previewDelete(sessionId: string): Promise<number | null>;
  /** Hides the last action error. */
  dismissError(): void;
}

/** The sidecar and the replicas, as the actions see them. */
const api: ActionApi = {
  create: (cwd) => window.omp.session.create(cwd),
  resume: (sessionId) => window.omp.session.resume(sessionId),
  fork: (sessionId) => window.omp.session.fork(sessionId),
  close: (sessionId) => window.omp.session.close(sessionId),
  // The window asks the person before it gets here; the sidecar enforces the answer.
  clearContext: async (sessionId) => {
    await window.omp.session.clearContext(sessionId, true);
  },
  delete: async (sessionId) => {
    await window.omp.session.delete(sessionId, true);
  },
  attach: (sessionId) => replicas.open(sessionId),
  detach: (sessionId) => replicas.close(sessionId),
};

/**
 * The set of open sessions and the focused one. Every open session stays subscribed, so its mark
 * in the sidebar is live while another one is on screen.
 */
export function useSessionController(sidecar: SidecarStatus): SessionController {
  const [held, setHeld] = useState<Held>(INITIAL);
  const [restoring, setRestoring] = useState(true);
  const [stored, setStored] = useState<readonly StoredSession[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const ready = sidecar.state === "ready";

  const current = useRef(held);
  current.current = held;
  // Nothing is written back before the remembered set was read, or a reload would erase it.
  const hydrated = useRef(false);
  const restore = useRef<Promise<Reopened> | null>(null);
  const pending = useRef(new Set<string>());
  const listing = useRef(0);

  useEffect(() => {
    if (hydrated.current) sessionStorage.setItem(STORAGE_KEY, serialize(held.sessions));
  }, [held.sessions]);

  const refresh = useCallback(async () => {
    const mine = ++listing.current;
    try {
      const list = await window.omp.session.list();
      if (mine !== listing.current) return;
      setStored(list);
      setListError(null);
    } catch (e) {
      if (mine === listing.current) setListError(message(e));
    }
  }, []);

  // omp moved a session to a new file (another process owns the old one): the open set, the
  // focus and the row follow it to its new id, and the listing is read again.
  useEffect(
    () =>
      replicas.onMoved((from, to) => {
        setHeld((state) => ({ ...state, sessions: rekey(state.sessions, from, to) }));
        void refresh();
      }),
    [refresh],
  );

  // After a reload, or when the sidecar comes back from a restart: attach again to what the
  // sidecar still holds and read the rest from disk. A restart costs a running turn, not history.
  useEffect(() => {
    if (!ready) {
      // The sidecar that held the requests is gone: nobody can answer them, and they must not
      // come back as a waiting band when a new sidecar reaches `ready`.
      replicas.clearPending();
      return;
    }
    let live = true;
    setRestoring(true);
    const remembered = hydrated.current
      ? current.current.sessions
      : parse(sessionStorage.getItem(STORAGE_KEY));
    // One restore at a time: StrictMode runs this effect twice, and two resumes of one file race.
    restore.current ??= reopen(
      { open: replicas.open, resume: window.omp.session.resume },
      remembered,
    ).finally(() => {
      restore.current = null;
    });
    restore.current.then(
      (result) => {
        if (!live) return;
        hydrated.current = true;
        setHeld((state) => ({ ...state, sessions: result.state, lost: result.focusedLost }));
        setRestoring(false);
      },
      (e: unknown) => {
        if (!live) return;
        hydrated.current = true;
        setHeld((state) => ({ ...state, error: actionError("resume", e) }));
        setRestoring(false);
      },
    );
    void refresh();
    return () => {
      live = false;
    };
  }, [ready, refresh]);

  // The listing is the source of titles and times: read it again when a turn ends, and when the
  // window regains focus (a CLI run may have added or changed sessions meanwhile).
  useEffect(() => {
    const unsubscribe = replicas.store.subscribe((state, previous) => {
      if (commandEnded(previous, state)) {
        void refresh();
        return;
      }
      for (const [id, before] of Object.entries(previous.sessions)) {
        if (before.status === "streaming" && state.sessions[id]?.status !== "streaming") {
          void refresh();
          return;
        }
      }
    });
    const onFocus = () => {
      if (ready) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [ready, refresh]);

  /** One action per key at a time (a double click must not resume twice); the outcome is applied. */
  const act = useCallback(
    async (key: string, run: () => Promise<Patch>) => {
      if (pending.current.has(key)) return;
      pending.current.add(key);
      setHeld((state) => (state.error ? { ...state, error: null } : state));
      try {
        setHeld(await run());
      } finally {
        pending.current.delete(key);
        void refresh();
      }
    },
    [refresh],
  );

  const startIn = (cwd: string) =>
    act(`new:${cwd}`, () => perform(api, current.current.sessions, { action: "new", cwd }));

  const start = async () => {
    try {
      const dir = await window.omp.session.pickDirectory();
      if (dir) await startIn(dir);
    } catch (e) {
      setHeld((state) => ({ ...state, error: actionError("new", e) }));
    }
  };

  const run = (action: "resume" | "fork" | "close" | "clear" | "delete", sessionId: string) =>
    act(`${action}:${sessionId}`, () =>
      perform(api, current.current.sessions, { action, sessionId }),
    );

  return {
    open: held.sessions.open,
    focused: held.sessions.focused,
    lost: held.lost,
    restoring,
    error: held.error,
    stored,
    listError,
    start,
    startIn,
    select: (sessionId) => run("resume", sessionId),
    fork: (sessionId) => run("fork", sessionId),
    close: (sessionId) => run("close", sessionId),
    clearContext: (sessionId) => run("clear", sessionId),
    remove: (sessionId) => run("delete", sessionId),
    previewDelete: async (sessionId) => {
      try {
        return (await window.omp.session.deletePreview(sessionId)).subagents;
      } catch (e) {
        setHeld((state) => ({ ...state, error: actionError("delete", e) }));
        return null;
      }
    },
    dismissError: () => setHeld((state) => ({ ...state, error: null })),
  };
}
