import { cx, IconButton, SidebarLeftExpandIcon, StateMark, StatusPill } from "@omp-app/ui";
import type { ReactNode, Ref } from "react";
import { SessionTabs } from "./SessionTabs";
import type { SessionTabs as Tabs } from "./use-tabs";

/**
 * 44 px bar over the center column. With the sidebar closed it also carries the traffic-light
 * room and the sidebar button, at the same x as when the sidebar is open.
 */
export function TabBar({
  sessionId,
  tabs,
  sidebarOpen,
  engineStopped,
  readOnly,
  toggleRef,
  onToggleSidebar,
  rightToggle,
}: {
  sessionId: string | null;
  tabs: Tabs;
  sidebarOpen: boolean;
  engineStopped: boolean;
  readOnly: boolean;
  toggleRef: Ref<HTMLButtonElement>;
  onToggleSidebar: () => void;
  /** The right panel's "show" button, present only while that panel is closed. */
  rightToggle?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "app-drag flex h-(--layout-bar-height) shrink-0 items-stretch gap-(--space-2) border-b border-border-hairline pr-(--space-16)",
        // Closed, the bar starts at the window edge so the button sits where the open sidebar's does.
        sidebarOpen && "pl-(--space-16)",
      )}
    >
      {!sidebarOpen && (
        <div className="flex items-center pl-(--layout-traffic-lights)">
          <IconButton
            ref={toggleRef}
            className="app-no-drag relative"
            aria-label="Show sidebar"
            aria-expanded={false}
            onClick={onToggleSidebar}
          >
            <SidebarLeftExpandIcon />
            {engineStopped && (
              <StateMark
                state="error"
                label="omp engine stopped"
                className="absolute top-0 right-0"
              />
            )}
          </IconButton>
        </div>
      )}
      <div className="flex min-w-0 items-stretch">
        {sessionId && <SessionTabs sessionId={sessionId} tabs={tabs} />}
      </div>
      <span className="flex-1" />
      {readOnly && (
        <div className="flex items-center">
          <StatusPill>Read-only</StatusPill>
        </div>
      )}
      {rightToggle}
    </div>
  );
}
