import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type {
  CommandItem,
  ContextFill,
  DecisionItem,
  JobInfo,
  PendingRequest,
  PlanState,
  QueueState,
  SessionOp,
  SessionOpEvent,
  SessionSnapshot,
  SessionStatus,
  SessionViewModel,
  SessionWarning,
  SubagentInfo,
  TodoPhase,
} from "@omp-app/protocol";
import { applyOp, UNKNOWN_SESSION_MESSAGE } from "@omp-app/protocol";
import { type Reduced, reduceEvent, reduceModel, reduceThinking } from "./reducer";

export type OpSink = (event: SessionOpEvent) => void;

/** What the session holds after omp cleared its context, as omp reports it. */
export interface ClearedState {
  /** When the boundary was written to the session file, epoch milliseconds. */
  readonly at: number;
  readonly context: ContextFill | null;
  readonly queue: QueueState;
  readonly todo: readonly TodoPhase[];
}

interface Entry {
  viewModel: SessionViewModel;
  /** Ops applied since the session was created. The next op gets `seq + 1`. */
  seq: number;
  /** One sink per subscriber key (a connection). Insertion order is delivery order. */
  readonly sinks: Map<unknown, OpSink>;
  /**
   * A read-only view of work the sidecar observes (a subagent's timeline), not a session omp
   * drives: it can be subscribed to, and nothing else is accepted for it.
   */
  readonly view: boolean;
  /** Run when the entry is removed, whatever id it lives under by then. */
  readonly onRemove: Set<() => void>;
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
    this.#sessions.set(viewModel.id, {
      viewModel,
      seq: 0,
      sinks: new Map(),
      view: false,
      onRemove: new Set(),
    });
  }

  /** Registers a read-only view (see `Entry.view`). Ops that happen later are numbered from 1. */
  createView(viewModel: SessionViewModel): void {
    if (this.#sessions.has(viewModel.id))
      throw new Error(`session already exists: ${viewModel.id}`);
    this.#sessions.set(viewModel.id, {
      viewModel,
      seq: 0,
      sinks: new Map(),
      view: true,
      onRemove: new Set(),
    });
  }

  /** Whether the id is a read-only view. Such an id is not a session for anything that drives one. */
  isView(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.view === true;
  }

  /** Runs `fn` when the entry is removed, so what hangs off a session goes with it. */
  onRemove(sessionId: string, fn: () => void): void {
    this.#entry(sessionId).onRemove.add(fn);
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

  /** A model switch re-applies the thinking level without always saying so in an event. */
  setThinking(sessionId: string, thinking: string | null): void {
    const entry = this.#entry(sessionId);
    this.#commit(sessionId, entry, reduceThinking(entry.viewModel, thinking));
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

  /** Sets the status of a view whose events do not end on their own (a subagent that was killed). */
  setStatus(sessionId: string, status: SessionStatus): void {
    const entry = this.#entry(sessionId);
    if (entry.viewModel.status === status) return;
    this.#apply(sessionId, { type: "status.set", status });
  }

  /** Adds or updates a subagent of the session. No op when nothing about it changed. */
  setSubagent(sessionId: string, subagent: SubagentInfo): void {
    const entry = this.#entry(sessionId);
    const before = entry.viewModel.subagents.find((s) => s.id === subagent.id);
    if (before && JSON.stringify(before) === JSON.stringify(subagent)) return;
    this.#apply(sessionId, { type: "subagent.set", subagent });
  }

  /** Replaces the session's job list. No op when it is the same list. */
  setJobs(sessionId: string, jobs: readonly JobInfo[]): void {
    const entry = this.#entry(sessionId);
    if (JSON.stringify(entry.viewModel.jobs) === JSON.stringify(jobs)) return;
    this.#apply(sessionId, { type: "jobs.set", jobs });
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

  /** Records omp's plan mode state. No op when nothing changed. */
  setPlan(sessionId: string, plan: PlanState): void {
    const entry = this.#entry(sessionId);
    const now = entry.viewModel.plan;
    if (now.enabled === plan.enabled && now.planFile === plan.planFile) return;
    this.#apply(sessionId, { type: "plan.set", plan });
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

  /**
   * The agent's context was cleared: the timeline stays and gains the "Context cleared" line, and
   * what omp reset (queued messages) or measured again (context fill) is taken from omp. Each
   * piece publishes nothing when it did not change.
   */
  markCleared(sessionId: string, cleared: ClearedState): void {
    const entry = this.#entry(sessionId);
    this.#apply(sessionId, {
      type: "item.add",
      item: { kind: "boundary", id: `i${entry.viewModel.timeline.length}`, at: cleared.at },
    });
    const queue = this.#entry(sessionId).viewModel.queue;
    if (JSON.stringify(queue) !== JSON.stringify(cleared.queue)) {
      this.#apply(sessionId, { type: "queue.set", queue: cleared.queue });
    }
    if (JSON.stringify(this.#entry(sessionId).viewModel.todo) !== JSON.stringify(cleared.todo)) {
      this.#apply(sessionId, { type: "todo.set", todo: cleared.todo });
    }
    this.setContext(sessionId, cleared.context);
  }

  /** Appends a running `command` item for a line the person ran; returns its id. */
  startCommand(sessionId: string, text: string): string {
    const entry = this.#entry(sessionId);
    const id = `i${entry.viewModel.timeline.length}`;
    this.#apply(sessionId, {
      type: "item.add",
      item: { kind: "command", id, text, state: "running", output: "", startedAt: this.#now() },
    });
    return id;
  }

  /** Changes a command item (its output so far, or how it ended). The finished item, if any. */
  patchCommand(
    sessionId: string,
    itemId: string,
    patch: Partial<Omit<CommandItem, "kind" | "id">>,
  ): CommandItem | undefined {
    this.#apply(sessionId, { type: "item.patch", itemId, patch });
    const item = this.#entry(sessionId).viewModel.timeline.find((i) => i.id === itemId);
    return item?.kind === "command" ? item : undefined;
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
    const entry = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    for (const run of entry?.onRemove ?? []) {
      try {
        run();
      } catch (error) {
        console.error(
          `[sidecar] cleanup failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
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
