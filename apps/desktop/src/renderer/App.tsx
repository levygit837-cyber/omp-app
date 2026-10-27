import { useEffect, useRef, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { enginePhase, useEngine } from "./engine";
import { SessionPane } from "./SessionPane";
import { SidebarBody, SidebarTop } from "./Sidebar";
import { Stage } from "./Stage";
import { useSessionController } from "./session-controller";
import { useSyncError } from "./session-hooks";
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
  const [readOnlyDismissed, setReadOnlyDismissed] = useState(false);
  const { sessionId } = controller;
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

  const stageError = controller.error ?? (sessionId ? null : syncError);

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
              sessionId={sessionId}
              sidecar={sidecar}
              versions={`electron ${electron} · chrome ${chrome}`}
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
          />
          {sessionId ? (
            <SessionPane
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
              error={stageError}
              readOnlyDismissed={readOnlyDismissed}
              onDismissReadOnly={() => setReadOnlyDismissed(true)}
              onOpen={open}
              onRestart={restart}
            />
          )}
        </main>
      </div>
    </EngineContext.Provider>
  );
}
