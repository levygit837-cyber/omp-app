import { Notice } from "@omp-app/ui";
import { useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { Announcer } from "./Announcer";
import { Composer } from "./Composer";
import type { EnginePhase } from "./composer-state";
import { EngineSlot } from "./EngineSlot";
import type { EngineTrack } from "./engine";
import { useSessionError, useSyncError, useWarnings } from "./session-hooks";
import { useShownStatus } from "./shown-status";
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
  const problem = sessionError ?? syncError;

  return (
    <>
      <p data-testid="session-status" data-status={status} className="sr-only">
        Status: {status ?? "unknown"}
      </p>
      <Announcer sessionId={sessionId} />
      <Timeline sessionId={sessionId} resume={sent} />
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
    </>
  );
}
