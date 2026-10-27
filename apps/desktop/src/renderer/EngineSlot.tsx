import { Button, StateMark } from "@omp-app/ui";
import type { ReactNode } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { type EngineTrack, TIMER_SHOW_AFTER_MS, useElapsed, useRunStart } from "./engine";
import { clock } from "./format";
import { Shortcut } from "./Shortcut";

function Tab({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex items-center gap-(--space-8) rounded-t-md border border-b-0 border-border-hairline bg-bg-elevated py-(--space-8) pr-(--space-12) pl-(--space-12) text-size-md"
    >
      {children}
    </div>
  );
}

/**
 * The docked tab above the input bar. One slot, one occupant: the engine outranks the turn, so
 * a stopped or restarting engine hides the run indicator.
 */
export function EngineSlot({
  sidecar,
  track,
  streaming,
  onRestart,
}: {
  sidecar: SidecarStatus;
  track: EngineTrack;
  streaming: boolean;
  onRestart: () => void;
}) {
  const engineElapsed = useElapsed(sidecar.state === "ready" ? null : track.since);
  const runSince = useRunStart(streaming && sidecar.state === "ready");
  const runElapsed = useElapsed(runSince);
  let content: ReactNode = null;

  if (sidecar.state === "failed") {
    content = (
      <Tab>
        <StateMark state="error" decorative />
        <span>omp engine stopped</span>
        <span className="flex gap-(--space-4)">
          <Button onClick={onRestart}>
            Restart <Shortcut className="text-text-dim">⌘R</Shortcut>
          </Button>
        </span>
      </Tab>
    );
  } else if (sidecar.state === "starting") {
    content = (
      <Tab>
        <StateMark state="running" decorative />
        <span>{track.restarting ? "Restarting omp engine…" : "Starting omp engine…"}</span>
        <span className="font-mono text-size-xs text-text-secondary">{clock(engineElapsed)}</span>
      </Tab>
    );
  } else if (track.back) {
    content = (
      <Tab>
        <StateMark state="idle" decorative />
        <span>omp engine is back</span>
      </Tab>
    );
  } else if (streaming) {
    content = (
      <Tab label="Running">
        <StateMark state="running" decorative />
        {runElapsed >= TIMER_SHOW_AFTER_MS && (
          <span className="font-mono text-size-xs text-text-secondary">{clock(runElapsed)}</span>
        )}
      </Tab>
    );
  }

  return (
    <div className="flex h-(--layout-indicator-height) items-end justify-center px-(--space-48)">
      <div className="flex w-(--layout-composer) max-w-full px-(--space-14)">{content}</div>
    </div>
  );
}
