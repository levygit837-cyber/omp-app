import type { StoredSession } from "@omp-app/protocol";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  cx,
  FolderIcon,
  IconButton,
  Menu,
  type MenuAnchor,
  MenuItem,
  MoreIcon,
  NewSessionIcon,
  SidebarLeftCollapseIcon,
  StateMark,
} from "@omp-app/ui";
import { type Ref, useEffect, useMemo, useRef, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { relativeTime } from "./format";
import { buildRows, groupProjects, projectLabels, type SessionRowData } from "./projects";
import { useSessionTitle } from "./session-hooks";
import { useSessionMark, useShownStatus } from "./shown-status";

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

/** Ticks once a minute so "5m" becomes "6m" without a refresh. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export interface SessionActions {
  /** Focus an open session, or open a stored one. */
  onSelect: (sessionId: string) => void;
  onFork: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
}

interface RowProps extends SessionActions {
  row: SessionRowData;
  open: boolean;
  focused: boolean;
  /** Opening or forking writes; a read-only app can only show what it already holds. */
  readOnly: boolean;
  now: number;
}

/** The menu of a session: only what omp can really do from here. */
function SessionMenu({
  anchor,
  canFork,
  canClose,
  closeBlocked,
  onFork,
  onClose,
  onDismiss,
}: {
  anchor: MenuAnchor;
  canFork: boolean;
  canClose: boolean;
  /** Closing stops a running turn, so a session that is streaming cannot be closed from here. */
  closeBlocked: boolean;
  onFork: () => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  return (
    <Menu label="Session actions" anchor={anchor} onDismiss={onDismiss}>
      {canFork && (
        <MenuItem
          onClick={() => {
            onDismiss();
            onFork();
          }}
        >
          Fork
        </MenuItem>
      )}
      {canClose && (
        <MenuItem
          disabled={closeBlocked}
          title={closeBlocked ? "A turn is running. Press Esc to stop it, then close." : undefined}
          onClick={() => {
            onDismiss();
            onClose();
          }}
        >
          Close
        </MenuItem>
      )}
    </Menu>
  );
}

function SessionRow({ row, open, focused, readOnly, now, onSelect, onFork, onClose }: RowProps) {
  const status = useShownStatus(row.id);
  const mark = useSessionMark(row.id);
  const replicaTitle = useSessionTitle(row.id);
  const title = row.title ?? replicaTitle;
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  // A session that is not on disk yet has nothing to copy, and omp refuses to copy one that is
  // running a turn. One that is not open has nothing to close.
  const canFork = row.modified !== null && !readOnly && status !== "streaming";
  const canClose = open;
  const hasMenu = canFork || canClose;
  const locked = readOnly && !open;

  const dismiss = () => {
    setAnchor(null);
    more.current?.focus();
  };
  return (
    <li
      className="group relative"
      onContextMenu={(event) => {
        if (!hasMenu) return;
        event.preventDefault();
        setAnchor({ x: event.clientX, y: event.clientY, above: event.clientY });
      }}
    >
      <button
        type="button"
        data-testid="session-row"
        data-session-id={row.id}
        aria-current={focused ? "true" : undefined}
        aria-disabled={locked || undefined}
        title={locked ? "Opening sessions is paused while omp-app is read-only." : undefined}
        onClick={() => {
          if (!locked) onSelect(row.id);
        }}
        className={cx(
          "flex w-full items-center gap-(--space-8) rounded-sm py-(--space-6) pr-(--space-8) pl-(--space-30) text-left text-size-md hover:bg-bg-hover",
          focused && "bg-bg-selected",
          locked ? "text-text-dim" : focused ? "text-text-primary" : "text-text-secondary",
        )}
      >
        <StateMark state={mark} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {row.modified !== null && (
          <span className="shrink-0 font-mono text-size-2xs text-text-dim group-focus-within:opacity-0 group-hover:opacity-0">
            {relativeTime(row.modified, now)}
          </span>
        )}
      </button>
      {hasMenu && (
        <IconButton
          ref={more}
          aria-label={`Actions for ${title}`}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          className="absolute top-1/2 right-(--space-4) -translate-y-1/2 opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setAnchor({ x: box.left, y: box.bottom, above: box.top });
          }}
        >
          <MoreIcon />
        </IconButton>
      )}
      {anchor && (
        <SessionMenu
          anchor={anchor}
          canFork={canFork}
          canClose={canClose}
          closeBlocked={status === "streaming"}
          onFork={() => onFork(row.id)}
          onClose={() => onClose(row.id)}
          onDismiss={dismiss}
        />
      )}
    </li>
  );
}

function Project({
  cwd,
  rows,
  label,
  collapsed,
  onToggle,
  focusedId,
  ...rest
}: {
  cwd: string;
  /** The folder's name, with parent folders added where two folders share a name. */
  label: string;
  rows: readonly SessionRowData[];
  collapsed: boolean;
  onToggle: () => void;
  focusedId: string | null;
  open: ReadonlySet<string>;
  readOnly: boolean;
  now: number;
} & SessionActions) {
  const { open, readOnly, now, onSelect, onFork, onClose } = rest;
  const holdsFocused = rows.some((row) => row.id === focusedId);
  return (
    <li>
      <button
        type="button"
        aria-expanded={!collapsed}
        title={cwd}
        onClick={onToggle}
        className="flex w-full items-center gap-(--space-8) rounded-sm px-(--space-8) py-(--space-6) text-left text-size-md hover:bg-bg-hover"
      >
        {collapsed ? (
          <ChevronRightIcon className="text-icon-neutral" />
        ) : (
          <ChevronDownIcon className="text-icon-neutral" />
        )}
        <FolderIcon className="text-icon-neutral" />
        <span className="min-w-0 truncate">{label}</span>
        {/* The row shows the folder's name; the full path is for assistive technology. */}
        {holdsFocused && (
          <span className="sr-only" data-testid="session-cwd">
            {cwd}
          </span>
        )}
      </button>
      {!collapsed && (
        <ul className="flex flex-col gap-(--space-2)" aria-label={`Sessions in ${label}`}>
          {rows.map((row) => (
            <SessionRow
              key={row.id}
              row={row}
              open={open.has(row.id)}
              focused={row.id === focusedId}
              readOnly={readOnly}
              now={now}
              onSelect={onSelect}
              onFork={onFork}
              onClose={onClose}
            />
          ))}
        </ul>
      )}
    </li>
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
  stored,
  listError,
  open,
  openCwds,
  focused,
  readOnly,
  sidecar,
  versions,
  ...actions
}: {
  stored: readonly StoredSession[] | null;
  listError: string | null;
  open: readonly string[];
  /** Folder of every open session, from its replica. */
  openCwds: ReadonlyMap<string, string>;
  focused: string | null;
  readOnly: boolean;
  sidecar: SidecarStatus;
  versions: string;
} & SessionActions) {
  const now = useNow();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const openSet = useMemo(() => new Set(open), [open]);
  const groups = useMemo(
    () =>
      groupProjects(
        buildRows(stored ?? [], new Map([...openCwds].filter(([id]) => openSet.has(id)))),
      ),
    [stored, openCwds, openSet],
  );
  const labels = useMemo(() => projectLabels(groups.map((group) => group.cwd)), [groups]);
  const toggle = (cwd: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(cwd)) next.add(cwd);
      return next;
    });
  const ready = sidecar.state === "ready";

  return (
    <>
      <nav
        aria-label="Projects"
        className="min-h-0 flex-1 overflow-y-auto px-(--space-8) py-(--space-4)"
      >
        <p className="px-(--space-8) pt-(--space-14) pb-(--space-6) font-mono text-size-2xs tracking-caps text-text-dim">
          PROJECTS
        </p>
        {groups.length > 0 && (
          <ul className="flex flex-col gap-(--space-2)">
            {groups.map((group) => (
              <Project
                key={group.cwd}
                cwd={group.cwd}
                label={labels.get(group.cwd) ?? group.cwd}
                rows={group.sessions}
                collapsed={collapsed.has(group.cwd)}
                onToggle={() => toggle(group.cwd)}
                focusedId={focused}
                open={openSet}
                readOnly={readOnly}
                now={now}
                {...actions}
              />
            ))}
          </ul>
        )}
        {groups.length === 0 && !ready && (
          <p className="px-(--space-8) pt-(--space-4) text-size-sm text-text-dim">
            Projects load from omp. They come back when it’s running.
          </p>
        )}
        {ready && listError && (
          <p
            role="alert"
            className="px-(--space-8) pt-(--space-4) text-size-sm text-text-secondary"
          >
            Couldn’t list your sessions. {listError}
          </p>
        )}
        {groups.length === 0 && ready && !listError && stored !== null && (
          <p className="px-(--space-8) pt-(--space-4) text-size-sm text-text-dim">
            No projects yet.
          </p>
        )}
      </nav>
      <Footer sidecar={sidecar} versions={versions} />
    </>
  );
}
