import { Button, FolderIcon, Notice, StateMark } from "@omp-app/ui";
import { useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { type EngineTrack, useElapsed } from "./engine";
import { clock } from "./format";

/** Centred column of the empty and engine states: no session to show, so no timeline. */
function Column({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-(--space-48)">
      <div className="flex w-(--layout-chat-column) max-w-full flex-col gap-(--space-10)">
        {children}
      </div>
    </div>
  );
}

function Shortcut({ children }: { children: string }) {
  return <kbd className="font-mono text-size-2xs text-on-accent-hint">{children}</kbd>;
}

function EngineStarting({ track }: { track: EngineTrack }) {
  const elapsed = useElapsed(track.since);
  return (
    <div className="flex flex-col gap-(--space-event-inner)" aria-live="polite">
      <p className="flex items-center gap-(--space-icon-phrase) text-size-body">
        <StateMark state="running" decorative />
        {track.restarting ? "Restarting omp engine…" : "Starting omp engine…"}
      </p>
      <p className="font-mono text-size-xs text-text-dim">{clock(elapsed)}</p>
    </div>
  );
}

function EngineFailed({
  track,
  status,
  onRestart,
}: {
  track: EngineTrack;
  status: Extract<SidecarStatus, { state: "failed" }>;
  onRestart: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const log = status.logTail.slice(-5);
  const copy = () => {
    void navigator.clipboard.writeText(log.join("\n")).then(() => setCopied(true));
  };
  return (
    <div
      role="alert"
      data-testid="sidecar-failed"
      className="flex w-(--layout-card) max-w-full flex-col gap-(--space-12)"
    >
      <h1 className="flex items-center gap-(--space-10) text-size-lg font-medium">
        <StateMark state="error" decorative />
        {track.wasReady ? "omp engine stopped" : "omp engine stopped while starting"}
      </h1>
      <p className="text-size-md text-text-secondary">{status.error}</p>
      <div className="flex flex-col gap-(--space-4) py-(--space-6) pl-(--space-output-indent)">
        <p className="font-mono text-size-2xs tracking-caps text-text-dim uppercase">
          Last {log.length === 1 ? "line" : `${log.length} lines`} of output
        </p>
        {log.length === 0 && <p className="font-mono text-size-xs text-text-dim">(no output)</p>}
        {log.map((line, index) => (
          <p
            // The tail is a fixed snapshot of the last lines, so the index is its identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed snapshot
            key={index}
            className={`font-mono text-size-xs break-words ${index >= log.length - 2 ? "text-text-primary" : "text-text-dim"}`}
          >
            {line}
          </p>
        ))}
      </div>
      <div className="flex gap-(--space-8) pl-(--space-output-indent)">
        <Button variant="primary" onClick={onRestart} data-testid="restart-engine">
          Restart omp <Shortcut>⌘R</Shortcut>
        </Button>
        <Button onClick={copy} disabled={log.length === 0}>
          {copied ? "Copied" : "Copy log"}
        </Button>
      </div>
    </div>
  );
}

/** "Read-only" explained in the flow: what stopped, why, and that nothing else changes. */
export function ReadOnlyNotice({
  status,
  onDismiss,
}: {
  status: Extract<SidecarStatus, { state: "ready" }>;
  onDismiss: () => void;
}) {
  const { schema } = status;
  return (
    <section
      role="alert"
      data-testid="read-only-notice"
      aria-label="Read-only mode"
      className="flex flex-col gap-(--space-10) border-t border-state-approval-rule pb-(--space-24)"
    >
      <h1 className="flex items-center gap-(--space-10) pt-(--space-6) text-size-body font-medium">
        <StateMark state="approval" decorative />
        Read-only: ~/.omp is newer than this app’s omp
      </h1>
      <p className="text-size-md text-text-secondary">
        {schema
          ? `Another omp wrote agent.db with schema ${schema.onDisk}; omp-app ships omp ${status.ompVersion}, which reads schema ${schema.expected}. `
          : ""}
        To keep your sessions safe, nothing here writes to ~/.omp until you update the app.
      </p>
      <div className="flex flex-col gap-(--space-4) pt-(--space-4)">
        <p className="font-mono text-size-2xs tracking-caps text-text-dim uppercase">Paused</p>
        <p className="text-size-sm text-text-secondary">New sessions · new prompts</p>
      </div>
      {schema && (
        <p className="font-mono text-size-xs text-text-dim">
          agent.db schema {schema.onDisk} · omp {status.ompVersion} expects {schema.expected} ·
          sidecar {status.sidecarVersion}
        </p>
      )}
      <div className="pt-(--space-4)">
        <Button onClick={onDismiss}>Got it</Button>
      </div>
    </section>
  );
}

/** The session is gone for good because the engine restarted; the sidebar and tabs stay. */
function LostBoundary({ onOpen, disabled }: { onOpen: () => void; disabled: boolean }) {
  return (
    <div role="alert" data-testid="session-lost" className="flex flex-col gap-(--space-24)">
      <div className="flex items-center gap-(--space-12)">
        <hr className="h-px flex-1 border-0 bg-state-error-border" />
        <p className="flex items-center gap-(--space-8) text-size-body">
          <StateMark state="error" decorative />
          omp engine restarted · this session didn’t come back
        </p>
        <hr className="h-px flex-1 border-0 bg-state-error-border" />
      </div>
      <div>
        <Button variant="primary" onClick={onOpen} disabled={disabled}>
          Open folder… <Shortcut>⌘O</Shortcut>
        </Button>
      </div>
    </div>
  );
}

function FirstUse({
  onOpen,
  disabled,
  hint,
}: {
  onOpen: () => void;
  disabled: boolean;
  hint?: string;
}) {
  return (
    <div className="flex w-(--layout-empty-column) max-w-full flex-col gap-(--space-14)">
      <h1 className="text-size-title font-medium">Open a folder to start</h1>
      <p className="text-size-body text-text-secondary">
        omp works inside a project folder: it reads, edits and runs code there.
      </p>
      <div className="pt-(--space-6)">
        <Button variant="primary" onClick={onOpen} disabled={disabled} data-testid="open-folder">
          <FolderIcon />
          Open folder… <Shortcut>⌘O</Shortcut>
        </Button>
      </div>
      {hint && <p className="text-size-sm text-text-dim">{hint}</p>}
    </div>
  );
}

export interface StageProps {
  sidecar: SidecarStatus;
  track: EngineTrack;
  lost: boolean;
  error: string | null;
  readOnlyDismissed: boolean;
  onDismissReadOnly: () => void;
  onOpen: () => void;
  onRestart: () => void;
}

/** What the middle of the window shows while no session is open, by priority: engine first. */
export function Stage(props: StageProps) {
  const { sidecar, track, lost, error, onOpen, onRestart } = props;
  const readOnly = sidecar.state === "ready" && sidecar.mode === "read_only";
  const ready = sidecar.state === "ready";

  if (sidecar.state === "failed") {
    return (
      <Column>
        <EngineFailed track={track} status={sidecar} onRestart={onRestart} />
      </Column>
    );
  }
  if (sidecar.state === "starting") {
    return (
      <Column>
        <EngineStarting track={track} />
      </Column>
    );
  }
  return (
    <Column>
      {track.back && (
        <p role="status" className="flex items-center gap-(--space-8) text-size-md">
          <StateMark state="idle" decorative />
          omp engine is back
        </p>
      )}
      {lost && <LostBoundary onOpen={onOpen} disabled={!ready || readOnly} />}
      {readOnly && !props.readOnlyDismissed && (
        <ReadOnlyNotice status={sidecar} onDismiss={props.onDismissReadOnly} />
      )}
      {!lost && !(readOnly && !props.readOnlyDismissed) && (
        <FirstUse
          onOpen={onOpen}
          disabled={!ready || readOnly}
          hint={readOnly ? "New sessions are paused while omp-app is read-only." : undefined}
        />
      )}
      {error && (
        <Notice severity="error" title="Couldn’t start a session" data-testid="session-error">
          {error}
        </Notice>
      )}
    </Column>
  );
}
