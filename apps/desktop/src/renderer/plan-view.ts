/**
 * What the plan toggle and the plan view say and allow, as pure functions (the repo has no DOM
 * tests). The state itself lives in omp (`getPlanModeState`, agent-session.ts:7181 [V]) and
 * reaches the window as `SessionViewModel.plan`.
 */
import type { AskRequest, PendingRequest, PlanReadResult, PlanRefusal } from "@omp-app/protocol";
import { CANCEL_NOTE } from "./requests-view";

/** The two choices omp's approval question offers (acp-agent.ts:104-105 [V]). */
export const APPROVE_CHOICE = "Approve and execute";
export const REFINE_CHOICE = "Refine plan";

/**
 * The approval question of a proposal: one select with exactly omp's two choices. omp sends it
 * through the same elicitation as any `ask`, so the shape is the only way to tell it apart.
 */
export function isPlanApproval(request: PendingRequest): request is AskRequest {
  if (request.kind !== "ask" || request.fields.length !== 1) return false;
  const [field] = request.fields;
  const values = field?.choices?.map((choice) => choice.value);
  return (
    field?.type === "select" &&
    values?.length === 2 &&
    values[0] === APPROVE_CHOICE &&
    values[1] === REFINE_CHOICE
  );
}

/** The proposal waiting for the person, if any. Only meaningful while plan mode is on. */
export function pendingProposal(
  planEnabled: boolean,
  waiting: readonly PendingRequest[],
): AskRequest | undefined {
  if (!planEnabled) return undefined;
  return waiting.find(isPlanApproval);
}

/**
 * What cancelling a question costs. For the `ask` tool omp reads it as the person stopping the
 * agent (tools/ask.ts:784-787 [V]); for the plan approval it reads it as `Refine plan`: plan mode
 * stays on and the agent is told to propose again (acp-agent.ts:2400-2404 [V], live: plan-cancel).
 */
export const PLAN_CANCEL_NOTE = "cancel counts as refine plan";

export function cancelNoteFor(request: AskRequest): string {
  return isPlanApproval(request) ? PLAN_CANCEL_NOTE : CANCEL_NOTE;
}

export interface PlanToggleInputs {
  readonly enabled: boolean;
  readonly streaming: boolean;
  readonly engineReady: boolean;
  readonly readOnly: boolean;
}

export interface PlanToggleView {
  /** The control exists at all. A read-only sidecar cannot turn it on, so there is nothing to show. */
  readonly shown: boolean;
  readonly pressed: boolean;
  /**
   * The switch does nothing now. The control stays in the tab order (`aria-disabled`, not
   * `disabled`), like the model and thinking triggers, so a keyboard user lands on it and hears why.
   */
  readonly locked: boolean;
  /** Why it is locked, as a tooltip; null when it is not, or when the bar says it in text. */
  readonly reason: string | null;
  /**
   * The bar already shows the reason as text while a turn runs (`LOCKED_WHILE_RUNNING`), and the
   * control points `aria-describedby` at it instead of repeating it in a tooltip.
   */
  readonly reasonInBar: boolean;
}

/**
 * Plan mode changes what the agent may do, so it is switched between turns: a switch in the
 * middle of a run would change the tools under it. The proposal itself happens inside a run and
 * is answered in the band, so nothing needs the switch then.
 */
export function planToggleView({
  enabled,
  streaming,
  engineReady,
  readOnly,
}: PlanToggleInputs): PlanToggleView {
  const base = { pressed: enabled, reasonInBar: false };
  if (readOnly) return { ...base, shown: false, locked: true, reason: null };
  if (!engineReady) {
    return { ...base, shown: true, locked: true, reason: "omp isn’t running" };
  }
  if (streaming) return { ...base, shown: true, locked: true, reason: null, reasonInBar: true };
  return { ...base, shown: true, locked: false, reason: null };
}

/** What `session.readPlan` is doing, as the view holds it. */
export type PlanReading =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly text: string }
  | { readonly status: "done"; readonly result: PlanReadResult };

export type PlanPage =
  | { readonly kind: "loading" }
  | { readonly kind: "empty"; readonly text: string }
  | { readonly kind: "problem"; readonly text: string }
  | {
      readonly kind: "plan";
      readonly file: string;
      readonly content: string;
      /** Written before plan mode was turned on this time (omp re-entered it). */
      readonly earlier: boolean;
    };

const REFUSALS: Record<PlanRefusal, string> = {
  not_local: "omp reports a plan file that isn’t in the session’s plan folder, so it isn’t shown.",
  outside_session: "The plan file points outside the session’s plan folder, so it isn’t shown.",
  too_large: "The plan file is too large to show here.",
  not_a_file: "The plan path isn’t a file.",
};

/** The body of the plan view. A plan that is not there yet is a state, not an error. */
export function planPage(reading: PlanReading): PlanPage {
  if (reading.status === "loading") return { kind: "loading" };
  if (reading.status === "failed") return { kind: "problem", text: reading.text };
  const { result } = reading;
  switch (result.state) {
    case "ok":
      return { kind: "plan", file: result.file, content: result.content, earlier: result.earlier };
    case "missing":
      return {
        kind: "empty",
        text: "No plan yet. In plan mode the agent reads the project, writes the plan and proposes it here.",
      };
    case "refused":
      return { kind: "problem", text: REFUSALS[result.reason] };
    default:
      return result satisfies never;
  }
}

/** The file name to show for `local://rename-config-plan.md`. */
export function planFileName(file: string): string {
  return file.replace(/^local:\/{1,2}/, "");
}

/** The line that points from the plan view to the band, which stays where the answer is given. */
export const PROPOSAL_HINT =
  "Answer in the band below: Approve and execute leaves plan mode and starts the work; Refine plan keeps plan mode.";

/**
 * Whether a key press leaves the plan view. Esc does, except where it already means something
 * else: while the band waits for an answer it is the band's cancel, while a turn runs it is the
 * input bar's stop (`keyStopsTurn`), and under an `inert` subtree (Settings on top) it is not
 * the person's at all. The Back control works in every case.
 */
export function keyLeavesPlan(key: string, underInert: boolean, escClaimed: boolean): boolean {
  return key === "Escape" && !underInert && !escClaimed;
}

/**
 * Where the center column shows the plan. It opens by itself when a proposal first arrives (the
 * band only carries the first 12 lines) and closes by itself when plan mode ends, since the
 * work that follows an approval is in the chat.
 */
export type CenterView = "chat" | "plan";

export function nextCenterView(input: {
  readonly current: CenterView;
  readonly planEnabled: boolean;
  readonly proposalId: string | undefined;
  readonly shownProposalId: string | undefined;
}): { view: CenterView; shownProposalId: string | undefined } {
  const { current, planEnabled, proposalId, shownProposalId } = input;
  if (!planEnabled) return { view: "chat", shownProposalId: undefined };
  if (proposalId !== undefined && proposalId !== shownProposalId) {
    return { view: "plan", shownProposalId: proposalId };
  }
  return { view: current, shownProposalId: proposalId ?? shownProposalId };
}
