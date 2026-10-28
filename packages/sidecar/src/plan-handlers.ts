import { PLAN_BUSY_MESSAGE, UNKNOWN_SESSION_MESSAGE } from "@omp-app/protocol";
import { readPlanOf } from "./plan-reader";
import { type PlanSession, planOf } from "./plan-state";
import type { RequestAnswers } from "./request-registry";
import type { Handlers } from "./server";
import type { SessionStore } from "./session-store";

export const PLAN_CAPABILITIES = ["session.setPlanMode", "session.readPlan"] as const;

/** What the plan handlers need from the omp host. */
export interface PlanControl {
  /**
   * Switches omp's ACP mode (`session/set_mode`, id `plan` or `default`). That is the one path
   * that also installs the proposal handler, without which a plan in plan mode has no approval
   * [V] modes/acp/acp-agent.ts:2236-2257 (the comment cites issue #1869).
   */
  setPlanMode(sessionId: string, enabled: boolean): Promise<void>;
}

/**
 * The live `AgentSession` of every open session, to read its plan state and its plan root. Looked
 * up by the session's own id, which follows omp when it moves the session to a new file.
 */
export class PlanSessions {
  readonly #open = new Set<PlanSession>();
  readonly #isOpen: (sessionId: string) => boolean;

  constructor(isOpen: (sessionId: string) => boolean) {
    this.#isOpen = isOpen;
  }

  /**
   * One live session per id. Closing and resuming a session gives the same id to a new
   * `AgentSession`, and the store has the id again before this runs, so the closed one cannot be
   * told apart by `isOpen`: the newest registration of an id replaces the older one.
   */
  add(session: PlanSession): void {
    for (const other of this.#open) {
      if (other !== session && other.sessionId === session.sessionId) this.#open.delete(other);
    }
    this.#prune();
    this.#open.add(session);
  }

  find(sessionId: string): PlanSession | undefined {
    this.#prune();
    for (const session of this.#open) if (session.sessionId === sessionId) return session;
    return undefined;
  }

  /** A closed session leaves the store; drop it here too so its memory is not held. */
  #prune(): void {
    for (const session of this.#open)
      if (!this.#isOpen(session.sessionId)) this.#open.delete(session);
  }
}

/** Handlers for the plan methods. The state itself reaches replicas through `store.setPlan`. */
export function planHandlers(
  control: PlanControl,
  store: SessionStore,
  sessions: PlanSessions,
  requests: Pick<RequestAnswers, "dismissSession">,
): Pick<Required<Handlers>, (typeof PLAN_CAPABILITIES)[number]> {
  const known = (sessionId: string): { id: string; session: PlanSession } => {
    const id = store.current(sessionId);
    const session = store.has(id) ? sessions.find(id) : undefined;
    if (!session) throw new Error(`${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`);
    return { id, session };
  };
  // When plan mode was turned on, to tell a plan written since from one omp re-entered.
  const enabledAt = new WeakMap<PlanSession, number>();
  // One switch at a time per session, so "already in that state?" and the switch are one step:
  // two enables at once would flag the second as a re-entry (acp-agent.ts:2245 [V]).
  const chains = new Map<string, Promise<unknown>>();
  const inOrder = <T>(sessionId: string, run: () => Promise<T>): Promise<T> => {
    const key = store.current(sessionId);
    const next = (chains.get(key) ?? Promise.resolve()).then(run);
    const tail = next.catch(() => {});
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return next;
  };
  return {
    "session.setPlanMode": ({ sessionId, enabled }) =>
      inOrder(sessionId, async () => {
        const { id, session } = known(sessionId);
        if (planOf(session).enabled === enabled) return null;
        // omp has no guard of its own (acp-agent.ts:946-955 [V]). Same flag as the model and
        // thinking controls (`idle()` in omp-host.ts), plus the store, which is what the window sees.
        if (session.isStreaming || store.snapshot(id).snapshot.status === "streaming") {
          throw new Error(PLAN_BUSY_MESSAGE);
        }
        const waiting = store.snapshot(id).snapshot.pending.length > 0;
        if (enabled) enabledAt.set(session, Date.now());
        // A proposal still waiting: omp does not abort the question when the mode is switched,
        // and answering `Refine plan` afterwards writes plan mode back on, without a proposal
        // handler (acp-agent.ts:2236-2257, :2338-2342 [V]; reproduced with the real omp [P]).
        // So the question is withdrawn first (omp reads that as a refine), and the switch is
        // sent twice: the refine step of the withdrawn proposal runs after the first one, and
        // the second reaches omp behind it on the same ordered channel.
        else if (waiting) requests.dismissSession(id);
        await control.setPlanMode(id, enabled);
        if (waiting && !enabled) await control.setPlanMode(id, false);
        if (!enabled) enabledAt.delete(session);
        // `AgentSession` emits no event for a mode change, so the store is told here.
        store.setPlan(store.current(session.sessionId), planOf(session));
        return null;
      }),

    "session.readPlan": async ({ sessionId }) => {
      const { session } = known(sessionId);
      return readPlanOf(session, planOf(session).planFile, enabledAt.get(session));
    },
  };
}
