import {
  FolderIcon,
  IconButton,
  NewSessionIcon,
  SidebarLeftCollapseIcon,
  StateMark,
} from "@omp-app/ui";
import type { Ref } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { projectName } from "./format";
import { useCwd, useSessionTitle } from "./session-hooks";
import { useSessionMark } from "./shown-status";

/** Left edge of the title bar: room for the native traffic lights, then the two buttons. */
export function SidebarTop({
  toggleRef,
  onToggle,
  onNewSession,
  newDisabled,
}: {
  toggleRef: Ref<HTMLButtonElement>;
  onToggle: () => void;
  onNewSession: () => void;
  newDisabled: boolean;
}) {
  return (
    <div className="app-drag flex h-(--layout-bar-height) shrink-0 items-center pr-(--space-10) pl-(--layout-traffic-lights)">
      <IconButton
        ref={toggleRef}
        className="app-no-drag"
        aria-label="Hide sidebar"
        aria-expanded={true}
        onClick={onToggle}
      >
        <SidebarLeftCollapseIcon />
      </IconButton>
      <span className="flex-1" />
      <IconButton
        className="app-no-drag"
        aria-label="New session"
        title="New session"
        onClick={onNewSession}
        disabled={newDisabled}
        data-testid="pick-directory"
      >
        <NewSessionIcon />
      </IconButton>
    </div>
  );
}

function SessionRow({ sessionId }: { sessionId: string }) {
  const mark = useSessionMark(sessionId);
  const title = useSessionTitle(sessionId);
  return (
    <li
      aria-current="true"
      className="flex items-center gap-(--space-8) rounded-sm bg-bg-selected py-(--space-6) pr-(--space-8) pl-(--space-30) text-size-md"
    >
      <StateMark state={mark} />
      <span className="min-w-0 truncate">{title}</span>
    </li>
  );
}

function Project({ sessionId }: { sessionId: string }) {
  const cwd = useCwd(sessionId);
  if (!cwd) return null;
  return (
    <ul className="flex flex-col gap-(--space-2)" aria-label="Sessions">
      <li
        className="flex items-center gap-(--space-8) px-(--space-8) py-(--space-6) text-size-md"
        title={cwd}
      >
        <FolderIcon className="text-icon-neutral" />
        <span className="min-w-0 truncate">{projectName(cwd)}</span>
        {/* The row shows the folder's name; the full path is for assistive technology. */}
        <span className="sr-only" data-testid="session-cwd">
          {cwd}
        </span>
      </li>
      <SessionRow sessionId={sessionId} />
    </ul>
  );
}

/** Engine line and bridge versions: real data, quiet, at the foot of the sidebar. */
function Footer({ sidecar, versions }: { sidecar: SidecarStatus; versions: string }) {
  const state = sidecar.state;
  return (
    <div className="flex flex-col gap-(--space-4) px-(--space-16) py-(--space-12) font-mono text-size-xs text-text-dim">
      <p
        data-testid="sidecar-status"
        data-state={state}
        aria-live="polite"
        className="flex items-center gap-(--space-8)"
      >
        <StateMark
          state={state === "failed" ? "error" : state === "starting" ? "running" : "idle"}
          decorative
        />
        {state === "ready" && `omp ${sidecar.ompVersion} · sidecar ${sidecar.sidecarVersion}`}
        {state === "starting" && "omp is starting…"}
        {state === "failed" && "omp is stopped"}
      </p>
      <p data-testid="bridge-versions">{versions}</p>
    </div>
  );
}

export function SidebarBody({
  sessionId,
  sidecar,
  versions,
}: {
  sessionId: string | null;
  sidecar: SidecarStatus;
  versions: string;
}) {
  return (
    <>
      <nav
        aria-label="Projects"
        className="min-h-0 flex-1 overflow-y-auto px-(--space-8) py-(--space-4)"
      >
        <p className="px-(--space-8) pt-(--space-14) pb-(--space-6) font-mono text-size-2xs tracking-caps text-text-dim">
          PROJECTS
        </p>
        {sessionId && <Project sessionId={sessionId} />}
        {!sessionId && sidecar.state !== "ready" && (
          <p className="px-(--space-8) pt-(--space-4) text-size-sm text-text-dim">
            Projects load from omp. They come back when it’s running.
          </p>
        )}
      </nav>
      <Footer sidecar={sidecar} versions={versions} />
    </>
  );
}
