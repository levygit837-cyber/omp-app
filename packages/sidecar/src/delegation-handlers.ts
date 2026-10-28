import { UNKNOWN_SESSION_MESSAGE } from "@omp-app/protocol";
import type { DelegationRegistry } from "./delegation";
import type { Handlers } from "./server";
import type { SessionStore } from "./session-store";

export const DELEGATION_CAPABILITIES = ["subagent.cancel", "job.cancel"] as const;

/**
 * Killing delegated work is its own request. `session.cancel` (Esc) never reaches it: the
 * parent's turn stops and its detached subagents and jobs carry on (ADR 0001). A `blocking`
 * agent runs inline under the parent's signal and ends with it (`task/index.ts:888-889` [V]).
 */
export function delegationHandlers(
  registry: Pick<DelegationRegistry, "of">,
  store: SessionStore,
): Pick<Required<Handlers>, (typeof DELEGATION_CAPABILITIES)[number]> {
  const of = (sessionId: string) => {
    const id = store.current(sessionId);
    const delegation = store.has(id) && !store.isView(id) ? registry.of(id) : undefined;
    if (!delegation) throw new Error(`${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`);
    return delegation;
  };
  return {
    "subagent.cancel": async ({ sessionId, subagentId }) => ({
      cancelled: await of(sessionId).cancelSubagent(subagentId),
    }),
    "job.cancel": async ({ sessionId, jobId }) => ({
      cancelled: of(sessionId).cancelJob(jobId),
    }),
  };
}
