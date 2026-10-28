import { useState } from "react";
import { describeError } from "./errors";
import { LOCKED_ID } from "./ModelControls";
import { usePlanCenter } from "./plan-center";
import { planToggleView } from "./plan-view";
import { useModel, usePlan } from "./session-hooks";
import { useShownStatus } from "./shown-status";

const LABEL = "font-mono text-size-xs whitespace-nowrap";
const QUIET =
  "rounded-sm px-(--space-4) text-text-dim hover:text-text-primary aria-disabled:opacity-(--opacity-disabled) aria-disabled:hover:text-text-dim";

/**
 * Plan mode in the input bar: a quiet mono label next to the model, in the same voice. The word
 * `on`/`off` carries the state; the plan view is opened from here while plan mode is on.
 */
export function PlanToggle({
  sessionId,
  engineReady,
  readOnly,
}: {
  sessionId: string;
  engineReady: boolean;
  readOnly: boolean;
}) {
  const plan = usePlan(sessionId);
  const streaming = useShownStatus(sessionId) === "streaming";
  const center = usePlanCenter();
  const [error, setError] = useState<string | null>(null);
  // Not drawn until the replica has the session: a control without data is not rendered.
  const known = useModel(sessionId) !== undefined && plan !== undefined;
  const view = planToggleView({
    enabled: plan?.enabled ?? false,
    streaming,
    engineReady,
    readOnly,
  });
  if (!known || !view.shown) return null;

  const flip = () => {
    if (view.locked) return;
    setError(null);
    window.omp.session
      .setPlanMode(sessionId, !view.pressed)
      .catch((e: unknown) => setError(describeError(e)));
  };

  return (
    <>
      <button
        type="button"
        data-testid="plan-toggle"
        aria-pressed={view.pressed}
        aria-disabled={view.locked || undefined}
        aria-describedby={view.reasonInBar ? LOCKED_ID : undefined}
        title={view.reason ?? undefined}
        onClick={flip}
        className={`${LABEL} ${QUIET} flex items-baseline gap-(--space-6)`}
      >
        plan
        {/* The state is `aria-pressed` for assistive tech; the word is for the eye. */}
        <span aria-hidden="true" className={view.pressed ? "text-text-primary" : undefined}>
          {view.pressed ? "on" : "off"}
        </span>
      </button>
      {view.pressed && (
        <button
          type="button"
          data-testid="plan-open"
          aria-pressed={center.view === "plan"}
          onClick={center.view === "plan" ? center.close : center.open}
          className={`${LABEL} ${QUIET}`}
        >
          {center.view === "plan" ? "back to chat" : "view plan"}
        </button>
      )}
      {error && (
        <p role="alert" className="text-size-sm text-state-error">
          {error}
        </p>
      )}
    </>
  );
}
