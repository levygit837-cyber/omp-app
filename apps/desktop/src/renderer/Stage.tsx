import { Button, FolderIcon, Notice, StateMark } from "@omp-app/ui";
import { useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { type EngineTrack, useElapsed } from "./engine";
import { describeEngineFailure } from "./errors";
import { clock } from "./format";
import { Shortcut } from "./Shortcut";

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
      <p className="text-size-md text-text-secondary">{describeEngineFailure(status.error)}</p>
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
          Restart omp <Shortcut className="text-on-accent-hint">⌘R</Shortcut>
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
        <Button variant="primary" onClick={onOpen} disabled={disabled} aria-keyshortcuts="Meta+O">
          Open folder…
        </Button>
      </div>
    </div>
  );
}

function FirstUse({
  onOpen,
  onOpenFolder,
  recent,
  disabled,
  hint,
}: {
  onOpen: () => void;
  onOpenFolder: (cwd: string) => void;
  recent: readonly string[];
  disabled: boolean;
  hint?: string;
}) {
  return (
    <div className="flex w-(--layout-empty-column) max-w-full flex-col gap-(--space-14)">
      <h1 className="text-size-title font-medium">Open a folder to start</h1>
      <p className="text-size-body text-text-secondary">
        omp works inside a project folder: it reads, edits and runs code there. Sessions you already
        have in ~/.omp show up in the sidebar on their own.
      </p>
      <div className="pt-(--space-6)">
        <Button
          variant="primary"
          onClick={onOpen}
          disabled={disabled}
          aria-keyshortcuts="Meta+O"
          data-testid="open-folder"
        >
          <FolderIcon />
          Open folder…
        </Button>
      </div>
      {hint && <p className="text-size-sm text-text-dim">{hint}</p>}
      {recent.length > 0 && (
        <section
          aria-label="Recent folders"
          className="flex flex-col gap-(--space-4) pt-(--space-14)"
        >
          <h2 className="pb-(--space-6) font-mono text-size-2xs tracking-caps text-text-dim">
            OR PICK A RECENT FOLDER
          </h2>
          <ul className="flex flex-col">
            {recent.map((cwd) => (
              <li key={cwd}>
                <button
                  type="button"
                  data-testid="recent-folder"
                  disabled={disabled}
                  onClick={() => onOpenFolder(cwd)}
                  className="flex w-full items-center gap-(--space-10) rounded-sm px-(--space-8) py-(--space-6) text-left font-mono text-size-sm text-text-secondary hover:bg-bg-hover disabled:opacity-(--opacity-disabled)"
                >
                  <FolderIcon className="text-icon-neutral" />
                  <span className="min-w-0 truncate">{cwd}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export interface StageProps {
  sidecar: SidecarStatus;
  track: EngineTrack;
  lost: boolean;
  /** The open sessions are being brought back: the empty state would flash and be wrong. */
  restoring: boolean;
  error: string | null;
  /** Folders of the most recently used sessions on disk, newest first. */
  recent: readonly string[];
  readOnlyDismissed: boolean;
  onDismissReadOnly: () => void;
  onOpen: () => void;
  onOpenFolder: (cwd: string) => void;
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
      {track.back && !lost && (
        <p role="status" className="flex items-center gap-(--space-8) text-size-md">
          <StateMark state="idle" decorative />
          omp engine is back
        </p>
      )}
      {lost && <LostBoundary onOpen={onOpen} disabled={!ready || readOnly} />}
      {readOnly && !props.readOnlyDismissed && (
        <ReadOnlyNotice status={sidecar} onDismiss={props.onDismissReadOnly} />
      )}
      {!lost && !props.restoring && !(readOnly && !props.readOnlyDismissed) && (
        <FirstUse
          onOpen={onOpen}
          onOpenFolder={props.onOpenFolder}
          recent={props.recent}
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
