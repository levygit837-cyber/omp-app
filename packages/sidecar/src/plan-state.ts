import type { PlanState } from "@omp-app/protocol";

/** What the plan code needs of an `AgentSession`. Narrow, so tests can stand in for omp. */
export interface PlanSession {
  readonly sessionId: string;
  /** `AgentSession.isStreaming`: the flag #14's `idle()` guard reads (omp-host.ts). */
  readonly isStreaming: boolean;
  /** `AgentSession.getPlanModeState` (agent-session.ts:7181 [V]). */
  getPlanModeState(): { readonly enabled: boolean; readonly planFilePath: string } | undefined;
  readonly sessionManager: {
    getArtifactsDir(): string | null;
    getSessionId(): string;
  };
}

/** The plan state omp holds right now, in the shape the view model carries. */
export function planOf(session: Pick<PlanSession, "getPlanModeState">): PlanState {
  const state = session.getPlanModeState();
  return state?.enabled
    ? { enabled: true, planFile: state.planFilePath }
    : { enabled: false, planFile: null };
}
