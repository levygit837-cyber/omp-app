import {
  cx,
  FolderIcon,
  IconButton,
  OverviewIcon,
  SidebarRightCollapseIcon,
  SidebarRightExpandIcon,
  StateMark,
} from "@omp-app/ui";
import { type KeyboardEvent, type Ref, useRef } from "react";
import { moveTab } from "../delegation-view";
import { FilesPage } from "../files/FilesPage";
import { projectName } from "../format";
import { useCwd, useSessionTitle } from "../session-hooks";
import { contextMeter, formatCost, summarizeTodo, type TodoRow } from "./facts";
import { useContextFill, useSessionCost, useTodo, useTurnCount } from "./session-facts";
import { SECTION_LABEL } from "./styles";
import type { PanelPage } from "./use-right-panel";

const PAGES: readonly {
  readonly id: PanelPage;
  readonly name: string;
  readonly icon: typeof FolderIcon;
}[] = [
  { id: "general", name: "Geral", icon: OverviewIcon },
  { id: "files", name: "Arquivos", icon: FolderIcon },
];

/** Dom id of a page's tab and of its panel, so each names the other. */
const tabId = (page: PanelPage) => `right-tab-${page}`;
const PANEL_ID = "right-panel-page";

/**
 * Page switcher (Pen `oKImu`): the selected page shows its icon and name, the others only the
 * icon. One tab stop, arrows move between pages, Home and End jump.
 */
function PageSwitcher({ page, onPage }: { page: PanelPage; onPage: (page: PanelPage) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const to = moveTab(
      PAGES.map((p) => p.id),
      page,
      event.key,
    );
    if (to === null) return;
    event.preventDefault();
    onPage(to as PanelPage);
    requestAnimationFrame(() => document.getElementById(tabId(to as PanelPage))?.focus());
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label="Details pages"
      onKeyDown={onKeyDown}
      className="flex items-center gap-(--space-2)"
    >
      {PAGES.map(({ id, name, icon: Icon }) => {
        const selected = id === page;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={tabId(id)}
            aria-selected={selected}
            aria-controls={PANEL_ID}
            aria-label={name}
            title={name}
            tabIndex={selected ? 0 : -1}
            onClick={() => onPage(id)}
            className={cx(
              "app-no-drag inline-flex h-(--size-control) items-center gap-(--space-6) rounded-sm px-(--space-6) text-size-sm hover:bg-bg-hover focus-visible:outline-(length:--size-focus-ring) focus-visible:outline-focus-ring",
              selected ? "bg-bg-selected text-text-primary" : "text-icon-neutral",
            )}
          >
            <Icon />
            {selected && <span className="font-medium">{name}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Right edge of the title bar when the panel is open: same x as the toggle when it is closed. */
function PanelTop({
  page,
  onPage,
  toggleRef,
  onToggle,
}: {
  page: PanelPage;
  onPage: (page: PanelPage) => void;
  toggleRef: Ref<HTMLButtonElement>;
  onToggle: () => void;
}) {
  return (
    <div className="app-drag flex h-(--layout-bar-height) shrink-0 items-center border-b border-border-hairline pr-(--space-16) pl-(--space-14)">
      <PageSwitcher page={page} onPage={onPage} />
      <span className="flex-1" />
      <IconButton
        ref={toggleRef}
        className="app-no-drag"
        aria-label="Hide details"
        aria-expanded={true}
        onClick={onToggle}
      >
        <SidebarRightCollapseIcon />
      </IconButton>
    </div>
  );
}

/** Shown in the tab bar while the panel is closed, at the position of the open panel's toggle. */
export function RightPanelToggle({
  toggleRef,
  onToggle,
}: {
  toggleRef: Ref<HTMLButtonElement>;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center">
      <IconButton
        ref={toggleRef}
        className="app-no-drag"
        aria-label="Show details"
        aria-expanded={false}
        onClick={onToggle}
      >
        <SidebarRightExpandIcon />
      </IconButton>
    </div>
  );
}

function Heading({ sessionId }: { sessionId: string }) {
  const title = useSessionTitle(sessionId);
  const cwd = useCwd(sessionId);
  const turns = useTurnCount(sessionId);
  return (
    <header className="flex flex-col gap-(--space-6)">
      <h3 className="text-size-lg font-medium break-words text-text-primary">{title}</h3>
      <p className="font-mono text-size-xs break-words text-text-dim">
        {cwd && <span title={cwd}>{projectName(cwd)}</span>}
        {cwd && turns > 0 && " · "}
        {turns > 0 && `${turns} ${turns === 1 ? "turn" : "turns"}`}
      </p>
    </header>
  );
}

function Context({ sessionId }: { sessionId: string }) {
  const context = useContextFill(sessionId);
  const cost = formatCost(useSessionCost(sessionId));
  if (!context && !cost) return null;
  const meter = context ? contextMeter(context) : null;
  return (
    <section
      aria-labelledby="right-panel-context"
      data-testid="context-meter"
      className="flex flex-col gap-(--space-8)"
    >
      <div className="flex items-baseline justify-between gap-(--space-8)">
        <h3 id="right-panel-context" className={SECTION_LABEL}>
          Context
        </h3>
        {meter && (
          <span className="font-mono text-size-xs text-text-secondary">
            {meter.used} / {meter.window}
          </span>
        )}
      </div>
      {context && meter && (
        // biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot take the design's bar and threshold tick
        <div
          role="meter"
          aria-labelledby="right-panel-context"
          aria-valuemin={0}
          aria-valuemax={context.window}
          aria-valuenow={Math.min(context.tokens, context.window)}
          aria-valuetext={`${meter.used} of ${meter.window} tokens`}
          className="relative h-(--space-4) overflow-hidden rounded-xs bg-border-default"
        >
          <div className="h-full bg-text-secondary" style={{ width: `${meter.fillPercent}%` }} />
          {meter.compactPercent !== null && (
            <div
              aria-hidden="true"
              className="absolute inset-y-0 w-(--space-2) bg-text-dim"
              style={{ left: `${meter.compactPercent}%` }}
            />
          )}
        </div>
      )}
      {(meter?.compactAt || cost) && (
        <p className="text-size-sm text-text-dim">
          {meter?.compactAt && `Compacts at ${meter.compactAt}.`}
          {meter?.compactAt && cost && " "}
          {cost && `${cost} spent in this session.`}
        </p>
      )}
    </section>
  );
}

/**
 * Success is silent, so a finished task has no mark: dim, struck through. The shapes are the
 * same ones the rest of the window uses: arc = running, ring = not started, triangle = blocked.
 * An abandoned task is dim and struck through too, but says so to assistive technology.
 */
function Task({ task }: { task: TodoRow }) {
  const { status, content } = task;
  const finished = status === "completed" || status === "abandoned";
  return (
    <li className="flex items-start gap-(--space-icon-phrase) py-(--space-2) text-size-md">
      <span className="flex h-(--size-tool-row) items-center">
        {status === "in_progress" && <StateMark state="running" label="In progress" />}
        {status === "pending" && <StateMark state="idle" label="Pending" />}
        {status === "blocked" && <StateMark state="approval" label="Blocked" />}
        {finished && <span aria-hidden="true" className="size-(--size-mark)" />}
      </span>
      <span
        className={cx(
          "min-w-0 break-words leading-(--size-tool-row)",
          finished ? "text-text-dim line-through" : "text-text-primary",
        )}
      >
        {finished && (
          <span className="sr-only">{status === "completed" ? "Completed: " : "Abandoned: "}</span>
        )}
        {content}
      </span>
    </li>
  );
}

function Todo({ sessionId }: { sessionId: string }) {
  const { groups, done, total } = summarizeTodo(useTodo(sessionId));
  if (total === 0) return null;
  return (
    <section
      aria-labelledby="right-panel-todo"
      data-testid="todo-list"
      className="flex flex-col gap-(--space-8)"
    >
      <div className="flex items-baseline justify-between gap-(--space-8)">
        <h3 id="right-panel-todo" className={SECTION_LABEL}>
          Todo
        </h3>
        <span className="font-mono text-size-xs text-text-secondary">
          {done} / {total}
        </span>
      </div>
      {groups.map((group) => (
        <div key={group.name} className="flex flex-col">
          {groups.length > 1 && (
            <h4 className="pb-(--space-2) text-size-xs text-text-dim">{group.name}</h4>
          )}
          <ul className="flex flex-col">
            {group.tasks.map((task, index) => (
              // Tasks have no id and the list is replaced whole, so the position is the identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <Task key={index} task={task} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** The right sidebar: "Geral" (the session at a glance) and "Arquivos" (the project, read-only). */
export function RightPanel({
  sessionId,
  page,
  onPage,
  openPath,
  toggleRef,
  onToggle,
}: {
  sessionId: string | null;
  page: PanelPage;
  onPage: (page: PanelPage) => void;
  /** The file shown in the center column, marked in the lists. */
  openPath: string | null;
  toggleRef: Ref<HTMLButtonElement>;
  onToggle: () => void;
}) {
  return (
    <aside
      aria-label="Details"
      data-testid="right-panel"
      className="flex w-(--layout-sidebar-right) shrink-0 flex-col border-l border-border-hairline bg-bg-base"
    >
      <PanelTop page={page} onPage={onPage} toggleRef={toggleRef} onToggle={onToggle} />
      {sessionId && (
        <div
          id={PANEL_ID}
          role="tabpanel"
          aria-labelledby={tabId(page)}
          className="flex min-h-0 flex-1 flex-col gap-(--space-24) overflow-y-auto px-(--space-20) py-(--space-20)"
        >
          {page === "general" ? (
            <>
              <Heading sessionId={sessionId} />
              <Context sessionId={sessionId} />
              <Todo sessionId={sessionId} />
            </>
          ) : (
            <FilesPage sessionId={sessionId} openPath={openPath} />
          )}
        </div>
      )}
    </aside>
  );
}
