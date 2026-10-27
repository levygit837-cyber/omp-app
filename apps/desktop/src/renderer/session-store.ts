import {
  applyOp,
  type SessionOp,
  type SessionOpEvent,
  type SessionViewModel,
  UNKNOWN_SESSION_MESSAGE,
} from "@omp-app/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { OmpBridge } from "../shared/bridge";

/** Calls `callback` once, on the next frame. In the window this is `requestAnimationFrame`. */
export type FrameScheduler = (callback: () => void) => void;

export interface SessionsState {
  /** One replica per open session, keyed by session id. Items keep their identity across ops. */
  readonly sessions: Readonly<Record<string, SessionViewModel>>;
  /** Last failure of a background re-subscribe, or null. */
  readonly error: string | null;
}

export type SessionApi = Pick<OmpBridge["session"], "subscribe" | "unsubscribe">;

export interface SessionReplicas {
  readonly store: StoreApi<SessionsState>;
  /**
   * Subscribes to a session and replaces any local state with its snapshot. Safe to call again
   * (window reload, reconnect): the snapshot wins. Resolves, once the replica is in the store,
   * with the id it is under: the one asked for, or its successor when the session had moved.
   * Rejects with {@link SessionLostError} when the sidecar does not know the session (it was
   * restarted since); the replica is then gone from the store.
   */
  open(sessionId: string): Promise<string>;
  /**
   * Calls `listener(from, to)` when a session moved to a new id: omp keeps saving it to a new
   * file because another process owns the old one. The replica is already under `to`.
   */
  onMoved(listener: (from: string, to: string) => void): () => void;
  /** Drops the replica and stops the op stream for the session. */
  close(sessionId: string): Promise<void>;
  /**
   * Forgets every pending request of every replica. A request lives in the sidecar process that
   * made it, so when that process is gone nobody can answer it; the next snapshot of a session
   * brings back whatever is really waiting.
   */
  clearPending(): void;
  /** Feed every `session.op` event here, in arrival order. */
  receive(event: SessionOpEvent): void;
}

/** Bookkeeping that never reaches components: it changes more often than they need to render. */
interface Tracking {
  /** Highest seq accepted so far, whether already applied or still buffered. */
  seq: number;
  /** Text deltas accepted but not yet applied; flushed once per frame. */
  pending: SessionOp[];
  /** Non-null while a (re)subscribe is in flight: events are held until the snapshot lands. */
  held: SessionOpEvent[] | null;
  inflight: Promise<void> | null;
}

/** The sidecar does not know this session: it was restarted, and sessions do not survive that. */
export class SessionLostError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session lost: ${sessionId}`);
    this.name = "SessionLostError";
    this.sessionId = sessionId;
  }
}

/**
 * The sidecar answers `${UNKNOWN_SESSION_MESSAGE}: <id>`. Electron wraps a rejected IPC call as
 * "Error invoking remote method '<channel>': Error: <message>", and only the text survives, so
 * the message is matched rather than an error code.
 */
function isUnknownSession(error: unknown): boolean {
  return error instanceof Error && error.message.includes(UNKNOWN_SESSION_MESSAGE);
}

/**
 * The renderer's copy of every open session, rebuilt from the sidecar's snapshot plus the ordered
 * stream of ops. Ordering rules:
 *
 * - an op with `seq <= last` is a duplicate and is dropped;
 * - an op that skips a seq means a lost op: the replica re-subscribes and the snapshot replaces
 *   it, so a gap can never leave the timeline silently wrong;
 * - text deltas are coalesced and applied once per frame; any other op first applies the buffered
 *   text, so ops still land in the order they were sent.
 */
export function createSessionReplicas(api: SessionApi, schedule: FrameScheduler): SessionReplicas {
  const store = createStore<SessionsState>(() => ({ sessions: {}, error: null }));
  const tracking = new Map<string, Tracking>();
  const dirty = new Set<string>();
  const moveListeners = new Set<(from: string, to: string) => void>();
  let frameRequested = false;

  const setSession = (sessionId: string, vm: SessionViewModel) =>
    store.setState((state) => ({ sessions: { ...state.sessions, [sessionId]: vm } }));

  /** Forgets a session locally: its replica, buffered text and sequence tracking. */
  function drop(sessionId: string): void {
    tracking.delete(sessionId);
    dirty.delete(sessionId);
    store.setState((state) => {
      const { [sessionId]: _dropped, ...rest } = state.sessions;
      return { sessions: rest };
    });
  }

  /** The session lives under another id from now on: its replica and tracking follow. */
  function moveTo(from: string, to: string): void {
    const t = tracking.get(from);
    if (!t || from === to) return;
    tracking.delete(from);
    tracking.set(to, t);
    if (dirty.delete(from)) dirty.add(to);
    store.setState((state) => {
      const { [from]: vm, ...rest } = state.sessions;
      return vm ? { sessions: { ...rest, [to]: vm } } : state;
    });
    for (const listener of moveListeners) listener(from, to);
  }

  function apply(sessionId: string, ops: readonly SessionOp[]): void {
    const current = store.getState().sessions[sessionId];
    if (!current || ops.length === 0) return;
    setSession(sessionId, ops.reduce(applyOp, current));
  }

  function flush(sessionId: string): void {
    const t = tracking.get(sessionId);
    dirty.delete(sessionId);
    if (!t || t.pending.length === 0) return;
    const ops = t.pending;
    t.pending = [];
    apply(sessionId, ops);
  }

  function requestFrame(): void {
    if (frameRequested) return;
    frameRequested = true;
    schedule(() => {
      frameRequested = false;
      for (const sessionId of [...dirty]) flush(sessionId);
    });
  }

  function queueText(t: Tracking, sessionId: string, op: SessionOp): void {
    const last = t.pending.at(-1);
    if (
      last?.type === "item.appendText" &&
      op.type === "item.appendText" &&
      last.itemId === op.itemId
    ) {
      t.pending[t.pending.length - 1] = { ...last, text: last.text + op.text };
    } else {
      t.pending.push(op);
    }
    dirty.add(sessionId);
    requestFrame();
  }

  function resync(sessionId: string, t: Tracking, held: SessionOpEvent[]): Promise<void> {
    if (t.inflight) return t.inflight;
    t.held = held;
    t.pending = [];
    dirty.delete(sessionId);
    const inflight = api.subscribe(sessionId).then(
      (snapshot) => {
        if (tracking.get(sessionId) !== t) return; // closed meanwhile
        t.inflight = null;
        const heldEvents = t.held ?? [];
        t.held = null;
        t.seq = snapshot.seq;
        setSession(sessionId, snapshot.snapshot);
        // Asked for an id the session left behind: the sidecar answers with the current one.
        moveTo(sessionId, snapshot.snapshot.id);
        for (const event of heldEvents.sort((a, b) => a.seq - b.seq)) receive(event);
      },
      (error: unknown) => {
        if (tracking.get(sessionId) !== t) throw error; // closed meanwhile: not ours to clean up
        t.inflight = null;
        t.held = null;
        if (isUnknownSession(error)) {
          drop(sessionId);
          throw new SessionLostError(sessionId);
        }
        // A session that never got a snapshot has nothing to keep tracking.
        if (!store.getState().sessions[sessionId]) tracking.delete(sessionId);
        throw error;
      },
    );
    t.inflight = inflight;
    return inflight;
  }

  function receive(event: SessionOpEvent): void {
    const t = tracking.get(event.sessionId);
    if (!t) return;
    if (t.held) {
      t.held.push(event);
      return;
    }
    if (event.seq <= t.seq) return;
    if (event.seq !== t.seq + 1) {
      resync(event.sessionId, t, [event]).catch((error: unknown) => {
        if (error instanceof SessionLostError) return; // the replica is gone; the window shows it
        store.setState({ error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    t.seq = event.seq;
    if (event.op.type === "item.appendText") {
      queueText(t, event.sessionId, event.op);
      return;
    }
    flush(event.sessionId);
    apply(event.sessionId, [event.op]);
    if (event.op.type === "session.moved") moveTo(event.sessionId, event.op.id);
  }

  function open(sessionId: string): Promise<string> {
    let t = tracking.get(sessionId);
    if (!t) {
      t = { seq: 0, pending: [], held: null, inflight: null };
      tracking.set(sessionId, t);
    }
    return resync(sessionId, t, t.held ?? []).then(() => {
      // Under the id it moved to, if it did.
      for (const [id, tracked] of tracking) if (tracked === t) return id;
      return sessionId;
    });
  }

  return {
    store,
    open,
    onMoved(listener) {
      moveListeners.add(listener);
      return () => moveListeners.delete(listener);
    },
    async close(sessionId) {
      drop(sessionId);
      await api.unsubscribe(sessionId);
    },
    clearPending() {
      store.setState((state) => ({
        sessions: Object.fromEntries(
          Object.entries(state.sessions).map(([id, vm]) => [
            id,
            vm.pending.length === 0 ? vm : { ...vm, pending: [] },
          ]),
        ),
      }));
    },
    receive,
  };
}
