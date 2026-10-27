import { useEffect, useMemo, useRef, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { ActionErrorNotice } from "./ActionError";
import { enginePhase, useEngine } from "./engine";
import { buildRows, recentFolders } from "./projects";
import { RightPanel, RightPanelToggle } from "./right-panel/RightPanel";
import { useRightPanel } from "./right-panel/use-right-panel";
import { SessionPane } from "./SessionPane";
import { SidebarBody, SidebarTop } from "./Sidebar";
import { Stage } from "./Stage";
import { useSessionController } from "./session-controller";
import { useOpenCwds, useSyncError } from "./session-hooks";
import { EngineContext } from "./shown-status";
import { TabBar } from "./TabBar";

function useSidecarStatus(): SidecarStatus {
  const [status, setStatus] = useState<SidecarStatus>({ state: "starting" });
  useEffect(() => {
    // Subscribe before reading, so a change between the two cannot be lost.
    const unsubscribe = window.omp.sidecar.onStatus(setStatus);
    void window.omp.sidecar.getStatus().then(setStatus);
    return unsubscribe;
  }, []);
  return status;
}

const restart = () => void window.omp.sidecar.restart();

/** How many recent folders the empty state offers (Pen UweVm, frame A). */
const RECENT_FOLDERS = 3;

export function App() {
  const { electron, chrome } = window.omp.versions;
  const sidecar = useSidecarStatus();
  const track = useEngine(sidecar);
  const engine = enginePhase(track);
  const controller = useSessionController(sidecar);
  const syncError = useSyncError();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // The toggle that was pressed unmounts with its sidebar state, so focus moves to the one that
  // replaces it; otherwise it falls to <body> and the next Tab starts over.
  const hideButton = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const handoff = useRef(false);
  const toggleSidebar = (open: boolean) => {
    handoff.current = true;
    setSidebarOpen(open);
  };
  useEffect(() => {
    if (!handoff.current) return;
    handoff.current = false;
    (sidebarOpen ? hideButton : showButton).current?.focus();
  }, [sidebarOpen]);
  const right = useRightPanel();
  const [readOnlyDismissed, setReadOnlyDismissed] = useState(false);
  const sessionId = controller.focused;
  const openCwds = useOpenCwds(controller.open);
  const ready = sidecar.state === "ready";
  const readOnly = ready && sidecar.mode === "read_only";
  const canOpen = ready && !readOnly;
  const open = () => void controller.start();

  // ⌘R restarts the engine when it is stopped; ⌘O opens a folder. The menu leaves both free.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.shiftKey || event.altKey) return;
      if (event.key === "r" && sidecar.state === "failed") {
        event.preventDefault();
        restart();
      } else if (event.key === "o" && canOpen) {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const recent = useMemo(
    () => recentFolders(buildRows(controller.stored ?? [], new Map()), RECENT_FOLDERS),
    [controller.stored],
  );

  return (
    <EngineContext.Provider value={engine}>
      <div className="flex h-full bg-bg-base text-size-md text-text-primary">
        {sidebarOpen && (
          <aside
            aria-label="Sidebar"
            className="flex w-(--layout-sidebar-left) shrink-0 flex-col border-r border-border-hairline bg-bg-sidebar"
          >
            <SidebarTop
              toggleRef={hideButton}
              onToggle={() => toggleSidebar(false)}
              onNewSession={open}
              newDisabled={!canOpen}
            />
            <SidebarBody
              stored={controller.stored}
              listError={controller.listError}
              open={controller.open}
              openCwds={openCwds}
              focused={sessionId}
              readOnly={readOnly}
              sidecar={sidecar}
              versions={`electron ${electron} · chrome ${chrome}`}
              onSelect={(id) => void controller.select(id)}
              onFork={(id) => void controller.fork(id)}
              onClose={(id) => void controller.close(id)}
            />
          </aside>
        )}
        <main className="flex min-w-0 flex-1 flex-col" aria-label="Session">
          <TabBar
            sessionId={sessionId}
            sidebarOpen={sidebarOpen}
            engineStopped={sidecar.state === "failed"}
            readOnly={readOnly}
            toggleRef={showButton}
            onToggleSidebar={() => toggleSidebar(true)}
            rightToggle={
              sessionId && !right.open ? (
                <RightPanelToggle
                  toggleRef={right.showButton}
                  onToggle={() => right.toggle(true)}
                />
              ) : null
            }
          />
          {controller.error && (
            <ActionErrorNotice error={controller.error} onDismiss={controller.dismissError} />
          )}
          {sessionId ? (
            <SessionPane
              key={sessionId}
              sessionId={sessionId}
              sidecar={sidecar}
              track={track}
              engine={engine}
              onRestart={restart}
            />
          ) : (
            <Stage
              sidecar={sidecar}
              track={track}
              lost={controller.lost}
              restoring={controller.restoring}
              error={sessionId ? null : syncError}
              recent={recent}
              readOnlyDismissed={readOnlyDismissed}
              onDismissReadOnly={() => setReadOnlyDismissed(true)}
              onOpen={open}
              onOpenFolder={(cwd) => void controller.startIn(cwd)}
              onRestart={restart}
            />
          )}
        </main>
        {sessionId && right.open && (
          <RightPanel
            sessionId={sessionId}
            toggleRef={right.hideButton}
            onToggle={() => right.toggle(false)}
          />
        )}
      </div>
    </EngineContext.Provider>
  );
}
