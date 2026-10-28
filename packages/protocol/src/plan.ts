/**
 * Plan mode as the window sees it. omp keeps the real state on the `AgentSession`
 * (`getPlanModeState`, agent-session.ts:7181 [V]); the sidecar mirrors it into the view model so
 * every replica, and a window that reloads, shows the same thing.
 */
import { isRecord } from "./guards";

export interface PlanState {
  readonly enabled: boolean;
  /**
   * The plan path omp holds in its plan-mode state (`local://PLAN.md` when plan mode was just
   * turned on). While a proposal waits for approval omp has not yet moved this to the file the
   * agent wrote (acp-agent.ts:2299 [V]), so the name to show comes from `session.readPlan`.
   * Null while plan mode is off.
   */
  readonly planFile: string | null;
}

/**
 * Why `session.setPlanMode` refuses while a turn runs. Plan mode changes what the agent may do,
 * and omp has no guard of its own (`setSessionMode`, acp-agent.ts:946-955 [V]), so the sidecar
 * keeps the rule. The window maps this text to a sentence.
 */
export const PLAN_BUSY_MESSAGE = "plan mode changes between turns";

/** Why the sidecar would not read the plan file. */
export type PlanRefusal =
  /** The path omp reports is not a `local://` URL of the session. */
  | "not_local"
  /** The file resolves outside the session's local root (a `..` or a symlink). */
  | "outside_session"
  | "too_large"
  | "not_a_file";

/** What `session.readPlan` found. A refusal and a missing file are answers, not errors. */
export type PlanReadResult =
  | {
      readonly state: "ok";
      readonly file: string;
      readonly content: string;
      /**
       * The file was last written before plan mode was turned on this time: omp re-enters plan
       * mode on the plan it already had (the re-entry prompt), so this is not a new proposal.
       * False when the sidecar did not see plan mode being turned on (nothing to compare with).
       */
      readonly earlier: boolean;
    }
  /** Plan mode is off, or the agent has not written the plan yet. */
  | { readonly state: "missing" }
  | { readonly state: "refused"; readonly reason: PlanRefusal };

const REFUSALS: ReadonlySet<unknown> = new Set<PlanRefusal>([
  "not_local",
  "outside_session",
  "too_large",
  "not_a_file",
]);

export function isPlanState(v: unknown): v is PlanState {
  return (
    isRecord(v) &&
    typeof v.enabled === "boolean" &&
    (v.planFile === null || typeof v.planFile === "string")
  );
}

export function isPlanReadResult(v: unknown): v is PlanReadResult {
  if (!isRecord(v)) return false;
  if (v.state === "ok") {
    return (
      typeof v.file === "string" && typeof v.content === "string" && typeof v.earlier === "boolean"
    );
  }
  if (v.state === "missing") return true;
  return v.state === "refused" && REFUSALS.has(v.reason);
}
