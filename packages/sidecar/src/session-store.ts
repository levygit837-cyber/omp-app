import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type {
  ContextFill,
  DecisionItem,
  PendingRequest,
  SessionOp,
  SessionOpEvent,
  SessionSnapshot,
  SessionViewModel,
  SessionWarning,
} from "@omp-app/protocol";
import { applyOp, UNKNOWN_SESSION_MESSAGE } from "@omp-app/protocol";
import { type Reduced, reduceEvent, reduceModel } from "./reducer";

export type OpSink = (event: SessionOpEvent) => void;

interface Entry {
  viewModel: SessionViewModel;
  /** Ops applied since the session was created. The next op gets `seq + 1`. */
  seq: number;
  /** One sink per subscriber key (a connection). Insertion order is delivery order. */
  readonly sinks: Map<unknown, OpSink>;
}

/**
 * The sidecar's replica source of truth: one view model per session, the `seq` counter that
 * orders its ops, and the subscribers that receive them. No I/O of its own: sinks are callbacks.
 */
export class SessionStore {
  readonly #sessions = new Map<string, Entry>();
  readonly #now: () => number;

  /** `now` stamps the events omp does not time itself (tool calls, thinking, retries); tests inject a fake. */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  /** Ids a session left behind when omp moved it, mapped to the id it lives under now. */
  readonly #moved = new Map<string, string>();

  /** Registers a session. Ops that happen later are numbered from 1. */
  create(viewModel: SessionViewModel): void {
    if (this.#sessions.has(viewModel.id))
      throw new Error(`session already exists: ${viewModel.id}`);
    this.#sessions.set(viewModel.id, { viewModel, seq: 0, sinks: new Map() });
  }

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  /** Feeds one `AgentSessionEvent` through the reducer and publishes the resulting ops. */
  dispatch(sessionId: string, event: AgentSessionEvent): void {
    const entry = this.#entry(sessionId);
    this.#commit(sessionId, entry, reduceEvent(entry.viewModel, event, this.#now()));
  }

  /** `model_changed` has no payload; the caller reads the session's current model. */
  setModel(sessionId: string, model: string | null): void {
    const entry = this.#entry(sessionId);
    this.#commit(sessionId, entry, reduceModel(entry.viewModel, model));
  }

  /** Marks the session failed for a reason that did not come through its event stream. */
  fail(sessionId: string, error: string): void {
    const entry = this.#entry(sessionId);
    const op: SessionOp = { type: "status.set", status: "failed", error };
    this.#commit(sessionId, entry, {
      viewModel: applyOp(entry.viewModel, op),
      ops: [op],
    });
  }

  /** Records a non-blocking problem; the session keeps running. */
  warn(sessionId: string, warning: SessionWarning): void {
    const entry = this.#entry(sessionId);
    const op: SessionOp = { type: "warning.add", warning };
    this.#commit(sessionId, entry, { viewModel: applyOp(entry.viewModel, op), ops: [op] });
  }

  /** Records how full the context is, as the caller measured it. No op when nothing changed. */
  setContext(sessionId: string, context: ContextFill | null): void {
    const entry = this.#entry(sessionId);
    const now = entry.viewModel.context;
    if (JSON.stringify(now) === JSON.stringify(context)) return;
    const op: SessionOp = { type: "context.set", context };
    this.#commit(sessionId, entry, { viewModel: applyOp(entry.viewModel, op), ops: [op] });
  }

  /** Puts a request a person has to answer into the view model, so every replica shows it. */
  addRequest(sessionId: string, request: PendingRequest): void {
    this.#apply(sessionId, { type: "request.add", request });
  }

  /**
   * Removes a pending request. With `decision` it leaves the one-line event in the timeline;
   * without, it vanishes (the turn ended or was superseded). Nothing happens if it is gone.
   */
  settleRequest(
    sessionId: string,
    requestId: string,
    decision?: Omit<DecisionItem, "kind" | "id">,
  ): void {
    const entry = this.#entry(sessionId);
    if (!entry.viewModel.pending.some((r) => r.id === requestId)) return;
    const item = decision && {
      kind: "decision" as const,
      id: `i${entry.viewModel.timeline.length}`,
      ...decision,
    };
    this.#apply(sessionId, {
      type: "request.settle",
      requestId,
      ...(item ? { item } : {}),
    });
  }

  snapshot(sessionId: string): SessionSnapshot {
    const entry = this.#entry(sessionId);
    return { snapshot: entry.viewModel, seq: entry.seq };
  }

  /**
   * Starts (or, for the same `key`, replaces) delivery of the session's ops to `sink`.
   * The snapshot and the registration happen in one synchronous step, so the first op the sink
   * sees is exactly `snapshot.seq + 1`.
   */
  subscribe(sessionId: string, key: unknown, sink: OpSink): SessionSnapshot {
    const entry = this.#entry(sessionId);
    entry.sinks.set(key, sink);
    return { snapshot: entry.viewModel, seq: entry.seq };
  }

  unsubscribe(sessionId: string, key: unknown): void {
    this.#sessions.get(sessionId)?.sinks.delete(key);
  }

  /**
   * The session keeps going under another id (omp moved it to a new file because another process
   * owns the old one). Subscribers get a `session.moved` op under the OLD id, numbered like any
   * other op, and then stay subscribed: every later op arrives under `newId` with `seq` carrying
   * on. The old id is unknown from here on.
   */
  rekey(oldId: string, newId: string): void {
    if (oldId === newId) return;
    if (this.#sessions.has(newId)) throw new Error(`session already exists: ${newId}`);
    const entry = this.#entry(oldId);
    const op: SessionOp = { type: "session.moved", id: newId };
    this.#commit(oldId, entry, { viewModel: applyOp(entry.viewModel, op), ops: [op] });
    this.#sessions.delete(oldId);
    this.#sessions.set(newId, entry);
    this.#moved.set(oldId, newId);
  }

  /** The id a session answers to now: itself, or where it moved to (following repeated moves). */
  current(sessionId: string): string {
    let id = sessionId;
    for (let next = this.#moved.get(id); next !== undefined; next = this.#moved.get(id)) id = next;
    return id;
  }

  /** Forgets a closed session and its subscribers. Later requests for it are `unknown session`. */
  remove(sessionId: string): void {
    this.#sessions.delete(sessionId);
    for (const [old, now] of this.#moved) if (now === sessionId) this.#moved.delete(old);
  }

  /** Drops every subscription of `key`, e.g. when its connection closes. */
  unsubscribeAll(key: unknown): void {
    for (const entry of this.#sessions.values()) entry.sinks.delete(key);
  }

  #apply(sessionId: string, op: SessionOp): void {
    const entry = this.#entry(sessionId);
    this.#commit(sessionId, entry, { viewModel: applyOp(entry.viewModel, op), ops: [op] });
  }

  #entry(sessionId: string): Entry {
    const entry = this.#sessions.get(sessionId);
    if (!entry) throw new Error(`${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`);
    return entry;
  }

  #commit(sessionId: string, entry: Entry, reduced: Reduced): void {
    entry.viewModel = reduced.viewModel;
    for (const op of reduced.ops) {
      const event: SessionOpEvent = { sessionId, seq: ++entry.seq, op };
      for (const sink of entry.sinks.values()) {
        try {
          sink(event);
        } catch (error) {
          console.error(
            `[sidecar] op sink failed: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }
  }
}
