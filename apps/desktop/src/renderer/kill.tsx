import { ConfirmCard, type MenuAnchor, Notice } from "@omp-app/ui";
import { useEffect } from "react";
import { useStore } from "zustand";
import { describeError } from "./errors";
import {
  closeKill,
  dismissKillError,
  failKill,
  focusKillOn,
  type KillKind,
  type KillTarget,
  killStore,
} from "./kill-state";

export { askKill } from "./kill-state";

async function confirm(target: KillTarget): Promise<void> {
  closeKill();
  try {
    // False means it had already ended by itself: the tree already says so, nothing to add.
    await (target.kind === "subagent"
      ? window.omp.session.cancelSubagent(target.sessionId, target.id)
      : window.omp.session.cancelJob(target.sessionId, target.id));
  } catch (error) {
    failKill(target.sessionId, describeError(error));
  }
}

const QUESTION: Record<KillKind, string> = { subagent: "Stop", job: "Stop" };
const CONSEQUENCE: Record<KillKind, string> = {
  subagent: "Ends its run now. What it already did stays, and its parent keeps going.",
  job: "Ends the process now. Its output so far stays.",
};

/** The confirmation card and the failure notice of a kill. Rendered once, by the window. */
export function KillHost({ focused }: { focused: string | null }) {
  const { target, error } = useStore(killStore);
  useEffect(() => focusKillOn(focused), [focused]);
  return (
    <>
      {error && (
        <div className="flex items-start justify-between gap-(--space-12) border-b border-border-hairline px-(--space-24) py-(--space-12)">
          <Notice severity="error" title="Couldn’t stop it" data-testid="kill-error">
            {error.message}
          </Notice>
          <button
            type="button"
            className="rounded-sm px-(--space-4) text-size-sm text-text-secondary hover:text-text-primary"
            onClick={dismissKillError}
          >
            Dismiss
          </button>
        </div>
      )}
      {target && (
        <ConfirmCard
          question={`${QUESTION[target.kind]} “${target.name}”?`}
          consequence={CONSEQUENCE[target.kind]}
          confirmLabel="Stop"
          anchor={target.anchor}
          opener={target.opener}
          onConfirm={() => void confirm(target)}
          onCancel={closeKill}
        />
      )}
    </>
  );
}

/** The anchor that puts a card just under an element. */
export function belowOf(el: HTMLElement): MenuAnchor {
  const box = el.getBoundingClientRect();
  return { x: box.left, y: box.bottom, above: box.top };
}
