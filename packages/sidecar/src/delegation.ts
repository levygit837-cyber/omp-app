import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
  TASK_SUBAGENT_EVENT_CHANNEL,
  TASK_SUBAGENT_LIFECYCLE_CHANNEL,
  TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import {
  type JobInfo,
  STOP_FAILED_MESSAGE,
  type SubagentInfo,
  type SubagentStatus,
  subagentLive,
} from "@omp-app/protocol";
import { loadPersistedSubagents, type PersistedSubagent } from "./persisted-subagents";
import { emptyViewModel } from "./reducer";
import type { SessionStore } from "./session-store";
import { isRecord } from "./tool-output";

/** What the tracker needs from omp's `EventBus`. */
export interface EventBusLike {
  on(channel: string, listener: (data: unknown) => void): () => void;
}

/** A live subagent as omp's registry reports it. */
export interface LiveSubagent {
  readonly kind: string;
  readonly status: string;
  readonly parentId?: string;
  readonly sessionFile: string | null;
  readonly hasSession: boolean;
}

/**
 * The part of omp that kills a subagent. Injected so the ownership rules can be tested without a
 * live omp; `ompSubagents` is the real one.
 */
export interface SubagentControl {
  find(subagentId: string): LiveSubagent | undefined;
  /** Releases the subagent with a tombstone and aborts its run. False when omp had already released it. */
  kill(subagentId: string): Promise<boolean>;
}

/** The slice of omp's `AgentRef` that `ompSubagents` reads. */
interface OmpRef {
  readonly kind: string;
  readonly status: string;
  readonly parentId?: string | undefined;
  readonly sessionFile: string | null;
  readonly session: { abort(options: { reason: string }): Promise<void> } | null;
}

/** The omp globals `ompSubagents` drives; injectable so the order of calls can be tested. */
export interface OmpSubagentDeps<R extends OmpRef> {
  /** Read on every call: omp rebinds its global manager when the registry is reset. */
  readonly registry: () => { get(id: string): R | undefined };
  readonly lifecycle: () => {
    release(id: string, expected: R, options: { tombstone: true }): Promise<boolean>;
  };
  readonly abortReason: string;
}

/** Real omp: `AgentRegistry` to find it, `handleRpcCancelSubagent`'s two calls to stop it. */
export function createOmpSubagents<R extends OmpRef>(omp: OmpSubagentDeps<R>): SubagentControl {
  return {
    find(subagentId) {
      const ref = omp.registry().get(subagentId);
      if (!ref) return undefined;
      return {
        kind: ref.kind,
        status: ref.status,
        ...(ref.parentId !== undefined ? { parentId: ref.parentId } : {}),
        sessionFile: ref.sessionFile,
        hasSession: ref.session !== null,
      };
    },
    async kill(subagentId) {
      const ref = omp.registry().get(subagentId);
      // Captured before `release`: it detaches the session synchronously (`agent-lifecycle.ts:567` [V]),
      // so `ref.session` is already null by the time the abort below is started.
      const live = ref?.session;
      if (!ref || !live) return false;
      // Release first: it publishes the tombstone before its first await, so the executor cannot
      // accept the run's result while the abort settles (`handleRpcCancelSubagent`, rpc-mode.ts:783 [V]).
      const [released, aborted] = await Promise.allSettled([
        omp.lifecycle().release(subagentId, ref, { tombstone: true }),
        live.abort({ reason: omp.abortReason }),
      ]);
      const failure = released.status === "rejected" ? released : aborted;
      if (failure.status === "rejected") throw failure.reason;
      return released.status === "fulfilled" && released.value;
    },
  };
}

export const ompSubagents: SubagentControl = createOmpSubagents<AgentRef>({
  registry: () => AgentRegistry.global(),
  lifecycle: () => AgentLifecycleManager.global(),
  abortReason: USER_INTERRUPT_LABEL,
});

/** What `attachSession` needs to follow the delegated work of a session. */
export interface DelegationHooks {
  /** The session's `subagentEventBus` (`sdk.ts:1774` [V]); omp exposes no getter, the host keeps it. */
  readonly bus: EventBusLike;
  readonly registry: DelegationRegistry;
  /** Epoch ms clock for start and end times; tests inject a fake. */
  readonly now?: () => number;
  /** How subagents are found and killed; defaults to the real omp. */
  readonly subagents?: SubagentControl;
  /** Reads the subagents a session file left on disk; defaults to `loadPersistedSubagents`. */
  readonly load?: (sessionFile: string) => Promise<readonly PersistedSubagent[]>;
}

/** One session's subagents and jobs. */
export interface Delegation {
  /**
   * Stops a running subagent of this session. False when it is unknown, not this session's, or
   * already over. `session.cancel` never calls this: Esc leaves detached work running (ADR 0001);
   * a `blocking` agent is inline and ends with the parent's abort (`task/index.ts:888-889` [V]).
   */
  cancelSubagent(subagentId: string): Promise<boolean>;
  /** Cancels a running background job this session owns. False when there is none by that id. */
  cancelJob(jobId: string): boolean;
}

/** How often the job list is read: omp announces no job changes, only a completion sink. */
export const JOB_POLL_MS = 1000;
/** Settled jobs kept in the list besides the running ones. */
const RECENT_JOBS = 10;
const TEXT_MAX = 200;

const clip = (text: string): string => {
  const line = text.split("\n").findLast((l) => l.trim() !== "") ?? "";
  return line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX - 1)}…` : line;
};

const LIFECYCLE: Record<string, SubagentStatus> = {
  started: "running",
  completed: "completed",
  failed: "failed",
  aborted: "aborted",
};

interface Known {
  info: SubagentInfo;
  sessionFile?: string;
  /** Stopped by `cancelSubagent`: omp tombstoned it, so no later frame may bring it back. */
  killed?: boolean;
}

const toJob = (job: AsyncJob): JobInfo => ({
  id: job.id,
  type: job.type,
  status: job.status,
  label: clip(job.label),
  startTime: job.startTime,
  ...(job.endTime !== undefined ? { endTime: job.endTime } : {}),
  ...(job.progressText ? { progressText: clip(job.progressText) } : {}),
});

/**
 * Follows the work one session delegated.
 *
 * Subagents: the three `task:subagent:*` channels of the session's bus (payloads
 * `task/types.ts`, `executor.ts:1620,1725,2978,3339` [V]). Lifecycle decides the status,
 * progress carries the token count, and every `event` frame goes through the reducer into the
 * subagent's own view model (`SessionStore.createView`), the same one a main session uses.
 *
 * Jobs: `AsyncJobManager` is read on a timer, only the session's own (`ownerId`), because omp
 * refuses to cancel anyone else's (`agent-session.ts#ownedAsyncJob` [V]). A `task` job is left
 * out: it is the subagent, listed as one.
 *
 * `sessionId` reads the session's current id (omp can move it); view ids do not depend on it.
 * Everything is released when the session leaves the store.
 */
export function trackDelegation(
  store: SessionStore,
  session: AgentSession,
  hooks: DelegationHooks,
  sessionId: () => string,
): Delegation {
  const agentId = session.getAgentId();
  const now = hooks.now ?? Date.now;
  const control = hooks.subagents ?? ompSubagents;
  const subs = new Map<string, Known>();
  let jobs: JobInfo[] = [];

  const publish = (known: Known): void => {
    const id = sessionId();
    if (store.has(id)) store.setSubagent(id, known.info);
  };

  /** Finds or creates the subagent; creating registers its view model. */
  // Agent ids are unique only within one parent session, so the view id carries the parent's.
  const viewIdOf = (id: string): string => `view:${agentId ?? sessionId()}:${id}`;

  const ensure = (id: string, agent: string, description?: string): Known => {
    const existing = subs.get(id);
    if (existing) return existing;
    const viewId = viewIdOf(id);
    const known: Known = {
      info: {
        id,
        viewId,
        agent,
        description: description ?? null,
        status: "running",
        startedAt: now(),
        tokens: 0,
      },
    };
    subs.set(id, known);
    store.createView(
      emptyViewModel({ id: viewId, cwd: session.sessionManager.getCwd(), model: null }),
    );
    publish(known);
    return known;
  };

  /** Nested subagents link to the one that spawned them; the session's own are top level. */
  const resolveParent = (known: Known): void => {
    if (known.info.parentId !== undefined) return;
    const parent = control.find(known.info.id)?.parentId;
    if (parent !== undefined && parent !== agentId) {
      known.info = { ...known.info, parentId: parent };
    }
  };

  const settle = (known: Known, status: SubagentStatus): void => {
    // The first final status stands: a late frame must not reopen a subagent that was killed.
    if (!subagentLive(known.info.status)) return;
    known.info = { ...known.info, status, endedAt: now() };
    // A killed or finished subagent's own events may not say so (abort ends no run), and a failed
    // one is shown as failed.
    if (status === "failed") store.setStatus(known.info.viewId, "failed");
    else if (store.isView(known.info.viewId)) store.setStatus(known.info.viewId, "idle");
    pollJobs();
  };

  const offs: (() => void)[] = [
    hooks.bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (data) => {
      if (!isRecord(data) || typeof data.id !== "string" || typeof data.agent !== "string") return;
      const status = LIFECYCLE[String(data.status)];
      if (!status) return;
      const known = ensure(
        data.id,
        data.agent,
        typeof data.description === "string" ? data.description : undefined,
      );
      if (typeof data.sessionFile === "string") known.sessionFile = data.sessionFile;
      // `started` carries no description; the settling frame does (fixture subagent.jsonl [V]).
      if (typeof data.description === "string" && known.info.description === null) {
        known.info = { ...known.info, description: data.description };
      }
      resolveParent(known);
      if (status === "running") {
        // omp announces `started` again for a follow-up turn of a subagent it kept alive
        // (`executor.ts:3783` [V]): that is a new run, not a late frame. Only a kill is final.
        if (!subagentLive(known.info.status) && !known.killed) {
          const { endedAt: _ended, ...rest } = known.info;
          known.info = { ...rest, status: "running", startedAt: now() };
        }
        publish(known);
      } else {
        settle(known, status);
        publish(known);
      }
    }),
    hooks.bus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (data) => {
      if (!isRecord(data) || !isRecord(data.progress)) return;
      const { id, agent, tokens } = data.progress;
      if (typeof id !== "string" || typeof agent !== "string") return;
      const known = ensure(id, agent);
      if (typeof data.sessionFile === "string") known.sessionFile = data.sessionFile;
      resolveParent(known);
      if (typeof tokens === "number" && tokens !== known.info.tokens) {
        known.info = { ...known.info, tokens };
      }
      publish(known);
    }),
    hooks.bus.on(TASK_SUBAGENT_EVENT_CHANNEL, (data) => {
      if (!isRecord(data) || typeof data.id !== "string" || !isRecord(data.event)) return;
      const known = subs.get(data.id);
      // The lifecycle frame always comes first; a frame without one belongs to nobody we know.
      if (!known) return;
      store.dispatch(known.info.viewId, data.event as unknown as AgentSessionEvent);
    }),
  ];

  const pollJobs = (): void => {
    const id = sessionId();
    const manager = session.asyncJobManager;
    if (!manager || !store.has(id)) return;
    const filter = { ownerId: agentId };
    const running = manager.getRunningJobs(filter);
    const recent = manager.getRecentJobs(RECENT_JOBS, filter);
    jobs = [...running, ...recent].filter((j) => j.type !== "task").map(toJob);
    store.setJobs(id, jobs);
  };
  const timer = setInterval(pollJobs, JOB_POLL_MS);

  let disposed = false;

  /**
   * Where a resumed subagent's description comes from. Two sources:
   * 1. The parent's `task` tool row (`SubagentRow.description`, built by `tool-output.ts#subagents`
   *    from the persisted tool result's `details.progress[].description`). That is the one-sentence
   *    label omp generates for the live HUD (`executor.ts:1650-1661` [V]), the same text the live
   *    path shows. omp only fills it when the label lands before the result is persisted; otherwise
   *    `subagents()` falls back to the assignment text (`p.task`), as in fixtures/subagent.jsonl [V].
   * 2. The loader's summary of `session_init.task` (`persisted-subagents.ts#describeTask`); the
   *    subagent's own file never stores the label.
   * The row wins when it is a real label; it loses when it is only the (clipped) task text, since
   * the loader's `# Target` summary reads better than a clipped dump of the whole assignment.
   * No row, or an empty one: the summary.
   */
  const fromRow = (row: string | undefined, task: string | null): string | undefined => {
    if (!row) return undefined;
    const prefix = row.endsWith("…") ? row.slice(0, -1) : row;
    return task?.startsWith(prefix) ? undefined : row;
  };

  const taskDescriptions = (): Map<string, string> => {
    const out = new Map<string, string>();
    const id = sessionId();
    if (!store.has(id)) return out;
    for (const item of store.snapshot(id).snapshot.timeline) {
      if (item.kind !== "tool" || item.tool !== "task") continue;
      for (const call of item.calls) {
        if (call.output?.kind !== "subagents") continue;
        for (const row of call.output.agents) {
          if (row.description !== "") out.set(row.id, row.description);
        }
      }
    }
    return out;
  };

  /**
   * Shows the subagents a resumed session ran before, from the transcripts omp left on disk. Runs
   * once, after attach. Ids already known (live frames that arrived while the load ran) win: a
   * persisted entry never replaces one, and the loader never reports `running`, so it
   * cannot make a live subagent look finished. A parent closed meanwhile gets no view.
   */
  const hydrate = async (): Promise<void> => {
    // Optional call: a session that was never persisted has no file, and test stand-ins omit it.
    const file = session.sessionManager.getSessionFile?.();
    if (!file) return;
    try {
      const persisted = await (hooks.load ?? loadPersistedSubagents)(file);
      if (disposed || !store.has(sessionId())) return;
      const described = taskDescriptions();
      for (const p of persisted) {
        if (subs.has(p.id)) continue;
        const viewId = viewIdOf(p.id);
        if (store.has(viewId)) continue;
        const known: Known = {
          info: {
            id: p.id,
            viewId,
            agent: p.agent,
            description: fromRow(described.get(p.id), p.task) ?? p.description,
            status: p.status,
            startedAt: p.startedAt,
            ...(p.endedAt !== undefined ? { endedAt: p.endedAt } : {}),
            tokens: p.tokens,
            ...(p.parentId !== undefined ? { parentId: p.parentId } : {}),
          },
        };
        subs.set(p.id, known);
        store.createView({
          ...emptyViewModel({ id: viewId, cwd: session.sessionManager.getCwd(), model: p.model }),
          status: p.status === "failed" ? "failed" : "idle",
          timeline: [...p.timeline],
        });
        publish(known);
      }
    } catch (error) {
      console.error("[sidecar] reading the persisted subagents failed:", error);
    }
  };

  const dispose = (): void => {
    disposed = true;
    clearInterval(timer);
    for (const off of offs) off();
    // The views leave with the parent: nobody can ask for them once it is closed.
    for (const known of subs.values()) store.remove(known.info.viewId);
    subs.clear();
  };
  store.onRemove(sessionId(), dispose);
  void hydrate();

  return {
    async cancelSubagent(subagentId) {
      const known = subs.get(subagentId);
      if (!known || !subagentLive(known.info.status)) return false;
      // Same checks as omp's RPC `cancel_subagent` (`rpc-subagents.ts:299` [V]): the agent id alone
      // is not unique, so the live ref must be a running subagent of ours with the transcript we saw.
      const ref = control.find(subagentId);
      if (ref?.kind !== "sub" || ref.status !== "running" || !ref.hasSession) return false;
      if (known.sessionFile !== undefined && ref.sessionFile !== known.sessionFile) return false;
      if (ref.parentId !== agentId && !(ref.parentId && subs.has(ref.parentId))) return false;
      try {
        if (!(await control.kill(subagentId))) return false;
      } catch (error) {
        // omp detaches and disposes the subagent even when the tombstone write or the abort
        // fails (`rpc-subagents.ts` doc of `handleRpcCancelSubagent` [V]), so look at what is
        // left: gone means the kill happened and only its bookkeeping failed; still running
        // means it did not, and the node must say so.
        console.error(`subagent.cancel ${subagentId} failed:`, error);
        const left = control.find(subagentId);
        if (left?.status === "running" && left.hasSession) throw new Error(STOP_FAILED_MESSAGE);
      }
      known.killed = true;
      settle(known, "aborted");
      publish(known);
      return true;
    },

    cancelJob(jobId) {
      if (!jobs.some((j) => j.id === jobId && j.status === "running")) return false;
      const cancelled = session.cancelAsyncJob(jobId);
      pollJobs();
      return cancelled;
    },
  };
}

/** Which `Delegation` belongs to which session, by the id the store knows the session under now. */
export class DelegationRegistry {
  readonly #entries = new Set<{ id: () => string; delegation: Delegation }>();

  add(id: () => string, delegation: Delegation, store: SessionStore): void {
    const entry = { id, delegation };
    this.#entries.add(entry);
    store.onRemove(id(), () => this.#entries.delete(entry));
  }

  of(sessionId: string): Delegation | undefined {
    for (const entry of this.#entries) if (entry.id() === sessionId) return entry.delegation;
    return undefined;
  }
}
