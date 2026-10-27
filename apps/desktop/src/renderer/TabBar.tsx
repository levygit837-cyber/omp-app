import { ChatIcon, cx, IconButton, SidebarLeftIcon, StateMark, StatusPill } from "@omp-app/ui";
import { sessionMark } from "./format";
import { useSessionTitle, useStatus } from "./session-hooks";

function ChatTab({ sessionId }: { sessionId: string }) {
  const status = useStatus(sessionId);
  const title = useSessionTitle(sessionId);
  return (
    <div
      aria-current="true"
      className="app-no-drag flex h-(--layout-bar-height) max-w-full items-center gap-(--space-8) border-b border-accent px-(--space-12) text-size-sm"
    >
      <StateMark state={sessionMark(status)} />
      <ChatIcon className="text-icon-neutral" />
      <span className="min-w-0 truncate">{title}</span>
    </div>
  );
}

/**
 * 44 px bar over the center column. With the sidebar closed it also carries the traffic-light
 * room and the sidebar button, at the same x as when the sidebar is open.
 */
export function TabBar({
  sessionId,
  sidebarOpen,
  engineStopped,
  readOnly,
  onToggleSidebar,
}: {
  sessionId: string | null;
  sidebarOpen: boolean;
  engineStopped: boolean;
  readOnly: boolean;
  onToggleSidebar: () => void;
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
            className="app-no-drag relative"
            aria-label="Show sidebar"
            aria-expanded={false}
            onClick={onToggleSidebar}
          >
            <SidebarLeftIcon />
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
        {sessionId && <ChatTab sessionId={sessionId} />}
      </div>
      <span className="flex-1" />
      {readOnly && (
        <div className="flex items-center">
          <StatusPill>Read-only</StatusPill>
        </div>
      )}
    </div>
  );
}
