import { Button, Notice } from "@omp-app/ui";
import type { ActionError } from "./session-actions";

/**
 * Why the last action (new, resume, fork, close) failed. It sits above whatever the center column
 * shows, so the failure is seen with a session focused as well as without one. Never modal.
 */
export function ActionErrorNotice({
  error,
  onDismiss,
}: {
  error: ActionError;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="action-error"
      className="flex items-start justify-between gap-(--space-12) border-b border-border-hairline px-(--space-24) py-(--space-12)"
    >
      <Notice severity="error" title={error.title}>
        {error.message}
      </Notice>
      <Button variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
