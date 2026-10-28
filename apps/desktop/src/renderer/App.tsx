import { cx } from "@omp-app/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { ActionErrorNotice } from "./ActionError";
import { Announcer } from "./Announcer";
import { ExtensionsScreen } from "./ExtensionsScreen";
import { enginePhase, useEngine } from "./engine";
import { PaletteHost } from "./palette/PaletteHost";
import { usePalette } from "./palette/use-palette";
import { buildRows, recentFolders } from "./projects";
import { RightPanel, RightPanelToggle } from "./right-panel/RightPanel";
import { useRightPanel } from "./right-panel/use-right-panel";
import { SessionPane } from "./SessionPane";
import { SettingsScreen } from "./SettingsScreen";
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
  const palette = usePalette();
  const [readOnlyDismissed, setReadOnlyDismissed] = useState(false);
  const sessionId = controller.focused;
  const openCwds = useOpenCwds(controller.open);
  const ready = sidecar.state === "ready";
  const readOnly = ready && sidecar.mode === "read_only";
  const canOpen = ready && !readOnly;
  const open = () => void controller.start();

  // The session view is home: leaving Settings returns to the session that was open, and a
  // session that starts or is selected while Settings is up takes the screen back.
  const [view, setView] = useState<"session" | "settings" | "extensions">("session");
  const extensionsButton = useRef<HTMLButtonElement>(null);
  const extensionsShowButton = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<"settings" | "extensions">("settings");
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsShowButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const closeSettings = () => {
    returnFocus.current = true;
    returnTo.current = "settings";
    setView("session");
  };
  const closeExtensions = () => {
    returnFocus.current = true;
    returnTo.current = "extensions";
    setView("session");
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the trigger is the session id
  useEffect(() => setView("session"), [sessionId]);
  useEffect(() => window.omp.settings.onOpenRequested(() => setView("settings")), []);
  useEffect(() => {
    if (view !== "session" || !returnFocus.current) return;
    returnFocus.current = false;
    (sidebarOpen
      ? returnTo.current === "extensions"
        ? extensionsButton
        : settingsButton
      : showButton
    ).current?.focus();
  }, [view, sidebarOpen]);

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
      {/* The palette sits above everything, outside the inert subtree: it can open over Settings. */}
      {palette.open && (
        <PaletteHost
          sessionId={sessionId}
          stored={controller.stored}
          openIds={controller.open}
          openCwds={openCwds}
          engine={engine}
          readOnly={readOnly}
          canOpen={canOpen}
          sidebarOpen={sidebarOpen}
          rightOpen={right.open}
          settingsShortcut={palette.mac ? "⌘," : null}
          onClose={palette.hide}
          onSelectSession={(id) => {
            setView("session");
            void controller.select(id);
          }}
          onNewSession={open}
          onOpenSettings={() => setView("settings")}
          onToggleLeft={() => toggleSidebar(!sidebarOpen)}
          onToggleRight={() => right.toggle(!right.open)}
          onShowSession={() => setView("session")}
        />
      )}
      <div className="flex h-full bg-bg-base text-size-md text-text-primary" inert={palette.open}>
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
              settingsOpen={view === "settings"}
              settingsRef={settingsButton}
              onOpenSettings={() => setView("settings")}
              extensionsOpen={view === "extensions"}
              extensionsRef={extensionsButton}
              onOpenExtensions={() => setView("extensions")}
              onSelect={(id) => {
                // Picking the focused row changes no session id, so the effect above would not fire.
                setView("session");
                void controller.select(id);
              }}
              onFork={(id) => void controller.fork(id)}
              onClose={(id) => void controller.close(id)}
            />
          </aside>
        )}
        {/* The one live region of the focused session sits outside the inert subtree below, so a
            request or a finished turn is still announced while Settings is on top. The docked
            "Waiting for you" tab lives in that subtree and is invisible then; the design has no
            second place for it, so the sidebar row's approval mark is the only visible signal. */}
        {sessionId && <Announcer key={sessionId} sessionId={sessionId} />}
        {/* The session and its right panel stay mounted and laid out under Settings. Unmounting
            would drop the composer draft; `display: none` would zero the timeline's size, and the
            virtualizer would move the scroll position while re-measuring. `invisible` keeps the
            geometry, `inert` keeps it out of the focus order and the a11y tree, and the
            Settings screen overlays the whole area right of the sidebar. */}
        <div className="relative flex min-w-0 flex-1">
          <div
            className={cx("flex min-w-0 flex-1", view !== "session" && "invisible")}
            inert={view !== "session"}
          >
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
                  error={syncError}
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
          {view === "extensions" && (
            <main
              className="absolute inset-0 z-10 flex flex-col bg-bg-base"
              aria-label="MCP and skills"
            >
              <ExtensionsScreen
                sidecar={sidecar}
                sessionId={sessionId}
                sidebarOpen={sidebarOpen}
                toggleRef={extensionsShowButton}
                onToggleSidebar={() => toggleSidebar(true)}
                onClose={closeExtensions}
              />
            </main>
          )}
          {view === "settings" && (
            <main className="absolute inset-0 z-10 flex flex-col bg-bg-base" aria-label="Settings">
              <SettingsScreen
                sidecar={sidecar}
                sessionId={sessionId}
                sidebarOpen={sidebarOpen}
                toggleRef={settingsShowButton}
                onToggleSidebar={() => toggleSidebar(true)}
                onClose={closeSettings}
              />
            </main>
          )}
        </div>
      </div>
    </EngineContext.Provider>
  );
}
