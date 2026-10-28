import { Notice } from "@omp-app/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { Composer } from "./Composer";
import type { EnginePhase } from "./composer-state";
import { EngineSlot } from "./EngineSlot";
import type { EngineTrack } from "./engine";
import { useFollowRequests } from "./follow-request";
import { PlanView } from "./PlanView";
import { type PlanCenter, PlanCenterContext } from "./plan-center";
import { type CenterView, nextCenterView, pendingProposal } from "./plan-view";
import { COMPOSER_ID } from "./requests-view";
import { usePlan, useSessionError, useSyncError, useWarnings } from "./session-hooks";
import { useShownStatus, useWaiting } from "./shown-status";
import { Timeline } from "./Timeline";
import { WaitingBand } from "./WaitingBand";

/** Non-blocking problems the session carries on despite. Warning severity: it still works. */
function Warnings({ sessionId }: { sessionId: string }) {
  const warnings = useWarnings(sessionId);
  if (!warnings || warnings.length === 0) return null;
  return (
    <ul
      data-testid="session-warnings"
      aria-label="Session warnings"
      className="flex flex-col gap-(--space-event)"
    >
      {warnings.map((w, index) => (
        // Append-only list, so the index is a stable identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
        <li key={index} data-testid="session-warning">
          {w.source === "mcp" ? (
            <Notice
              severity="warning"
              title={
                <>
                  MCP server <span className="font-mono">{w.server}</span>
                </>
              }
              detail="didn’t start cleanly"
            >
              {w.message}
            </Notice>
          ) : (
            <Notice severity="warning" title={w.title}>
              {w.message}
            </Notice>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The open session: timeline, what the session says about itself, engine slot, input bar. */
export function SessionPane({
  sessionId,
  sidecar,
  track,
  engine,
  onRestart,
}: {
  sessionId: string;
  sidecar: SidecarStatus;
  track: EngineTrack;
  engine: EnginePhase;
  onRestart: () => void;
}) {
  const status = useShownStatus(sessionId);
  const sessionError = useSessionError(sessionId);
  const syncError = useSyncError();
  // Bumped when a prompt is sent, so the timeline follows the answer even after a scroll up.
  const [sent, setSent] = useState(0);
  // Output of a command run from the palette also brings the timeline to the newest line.
  const asked = useFollowRequests(sessionId);
  const problem = sessionError ?? syncError;

  // The plan view replaces the timeline in the chat column; the band and the input bar stay.
  const planEnabled = usePlan(sessionId)?.enabled ?? false;
  const proposalId = pendingProposal(planEnabled, useWaiting(sessionId))?.id;
  const [view, setView] = useState<CenterView>("chat");
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    const next = nextCenterView({
      current: view,
      planEnabled,
      proposalId,
      shownProposalId: shown.current,
    });
    shown.current = next.shownProposalId;
    if (next.view !== view) setView(next.view);
  }, [view, planEnabled, proposalId]);
  const center = useMemo<PlanCenter>(
    () => ({
      view,
      open: () => setView("plan"),
      close: () => setView("chat"),
    }),
    [view],
  );
  const back = useCallback(() => {
    setView("chat");
    // The Back control leaves with the view; keep focus in the pane rather than on the page.
    queueMicrotask(() => document.getElementById(COMPOSER_ID)?.focus());
  }, []);

  return (
    <PlanCenterContext.Provider value={center}>
      <p data-testid="session-status" data-status={status} className="sr-only">
        Status: {status ?? "unknown"}
      </p>
      {/* The timeline stays mounted under the plan view: `invisible` keeps its geometry (the
          virtualizer would move the scroll position if it were `display: none`) and `inert`
          keeps it out of the focus order, the same technique as Settings in App.tsx. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className={`flex min-h-0 flex-1 flex-col${view === "plan" ? " invisible" : ""}`}
          inert={view === "plan"}
        >
          <Timeline sessionId={sessionId} resume={sent + asked} />
        </div>
        {view === "plan" && <PlanView sessionId={sessionId} onBack={back} />}
      </div>
      <div className="flex justify-center px-(--space-48) empty:hidden">
        <div className="flex w-(--layout-chat-column) max-w-full flex-col gap-(--space-event) pt-(--space-event) empty:hidden">
          <Warnings sessionId={sessionId} />
          {problem && (
            <Notice severity="error" title="This session failed" data-testid="session-error">
              {problem}
            </Notice>
          )}
        </div>
      </div>
      <div className="flex justify-center px-(--space-48) empty:hidden">
        <div className="w-(--layout-chat-column) max-w-full pt-(--space-event) empty:hidden">
          <WaitingBand sessionId={sessionId} />
        </div>
      </div>
      <EngineSlot
        sessionId={sessionId}
        sidecar={sidecar}
        track={track}
        streaming={status === "streaming"}
        onRestart={onRestart}
      />
      <div className="flex justify-center px-(--space-48) pb-(--space-12)">
        <Composer
          sessionId={sessionId}
          sidecar={sidecar}
          engine={engine}
          onSent={() => setSent((n) => n + 1)}
        />
      </div>
    </PlanCenterContext.Provider>
  );
}
