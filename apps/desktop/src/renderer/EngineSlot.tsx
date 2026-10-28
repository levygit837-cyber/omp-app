import { subagentLive } from "@omp-app/protocol";
import { Button, StateMark } from "@omp-app/ui";
import type { ReactNode } from "react";
import type { SidecarStatus } from "../shared/bridge";
import {
  type DelegationSummary,
  isBusy,
  jobName,
  subagentsPhrase,
  summarize,
} from "./delegation-view";
import { type EngineTrack, TIMER_SHOW_AFTER_MS, useElapsed, useRunStart } from "./engine";
import { clock } from "./format";
import { Shortcut } from "./Shortcut";
import { useJobs, useSubagents } from "./session-hooks";
import { useWaiting } from "./shown-status";
import { showTab } from "./use-tabs";
import { focusBand } from "./WaitingBand";

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
 * What runs beside the chat, as the design writes it: `1 of 2 subagents · bun dev`. Each part is a
 * button that opens the thing it counts, because a count with nowhere to go is a dead control.
 */
function Delegated({
  sessionId,
  summary,
  firstSubagent,
}: {
  sessionId: string;
  summary: DelegationSummary;
  firstSubagent: string | undefined;
}) {
  const phrase = subagentsPhrase(summary);
  const open = "rounded-sm text-text-secondary hover:text-text-primary";
  return (
    <>
      {phrase && firstSubagent && (
        <button
          type="button"
          data-testid="delegation-subagents"
          className={open}
          onClick={() => showTab(sessionId, { kind: "subagent", id: firstSubagent })}
        >
          {phrase}
        </button>
      )}
      {summary.jobsRunning.map((job) => (
        <button
          key={job.id}
          type="button"
          data-testid="delegation-job"
          className={`${open} max-w-(--layout-tab-max) truncate font-mono text-size-xs`}
          onClick={() => showTab(sessionId, { kind: "job", id: job.id })}
        >
          {jobName(job)}
        </button>
      ))}
    </>
  );
}

/**
 * The docked tab above the input bar. One slot, one occupant: the engine outranks the turn, so
 * a stopped or restarting engine hides the run indicator.
 */
export function EngineSlot({
  sessionId,
  sidecar,
  track,
  streaming,
  onRestart,
}: {
  sessionId: string;
  sidecar: SidecarStatus;
  track: EngineTrack;
  streaming: boolean;
  onRestart: () => void;
}) {
  const engineElapsed = useElapsed(sidecar.state === "ready" ? null : track.since);
  const runSince = useRunStart(streaming && sidecar.state === "ready");
  const runElapsed = useElapsed(runSince);
  const waiting = useWaiting(sessionId)[0];
  const waitElapsed = useElapsed(waiting?.raisedAt ?? null);
  const subagents = useSubagents(sessionId);
  const jobs = useJobs(sessionId);
  const summary = summarize({ subagents, jobs });
  const firstSubagent = subagents.find((s) => subagentLive(s.status))?.id;
  const delegated = isBusy(summary) ? (
    <Delegated sessionId={sessionId} summary={summary} firstSubagent={firstSubagent} />
  ) : null;
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
  } else if (waiting) {
    // The approval itself lives in the band; the tab only says the agent waits and leads there.
    content = (
      <Tab label="Waiting for you">
        <StateMark state="approval" decorative />
        <button
          type="button"
          data-testid="waiting-tab"
          onClick={focusBand}
          className="flex items-center gap-(--space-8) rounded-sm"
        >
          <span>Waiting for you</span>
          <span className="font-mono text-size-xs text-text-secondary">· {clock(waitElapsed)}</span>
        </button>
      </Tab>
    );
  } else if (streaming) {
    content = (
      <Tab label="Running">
        <StateMark state="running" decorative />
        {runElapsed >= TIMER_SHOW_AFTER_MS && (
          <span className="font-mono text-size-xs text-text-secondary">{clock(runElapsed)}</span>
        )}
        {delegated}
      </Tab>
    );
  } else if (delegated) {
    // The turn is over but delegated work is not: Esc stopped the chat, not what it started.
    content = (
      <Tab label="Running in the background">
        <StateMark state="running" decorative />
        {delegated}
      </Tab>
    );
  }

  return (
    <div className="flex h-(--layout-indicator-height) items-end justify-center px-(--space-48)">
      <div className="flex w-(--layout-composer) max-w-full px-(--space-14)">{content}</div>
    </div>
  );
}
