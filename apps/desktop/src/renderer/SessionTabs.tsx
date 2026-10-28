import type { JobInfo, SubagentInfo } from "@omp-app/protocol";
import { ChatIcon, cx, FileIcon, JobIcon, StateMark, SubagentIcon } from "@omp-app/ui";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import {
  jobMark,
  jobName,
  type Mark,
  moveTab,
  subagentMark,
  subagentName,
  type TabRef,
  tabDomId,
  tabKey,
} from "./delegation-view";
import { nameOf } from "./files/files-model";
import { useSessionTitle } from "./session-hooks";
import { useSessionMark } from "./shown-status";
import { findTabElement } from "./tab-lookup";
import type { SessionTabs as Tabs } from "./use-tabs";

/** What a tab of each kind looks like. A new kind is one more case here and in `delegation-view`. */
function describe(
  ref: TabRef,
  main: { mark: Mark; title: string },
  subagents: readonly SubagentInfo[],
  jobs: readonly JobInfo[],
): {
  /** Null for a tab with no run state of its own (a file). */
  mark: Mark | null;
  icon: ReactNode;
  label: string;
  title?: string;
  closable: boolean;
} | null {
  switch (ref.kind) {
    case "main":
      return {
        mark: main.mark,
        icon: <ChatIcon className="text-icon-neutral" />,
        label: main.title,
        closable: false,
      };
    case "subagent": {
      const sub = subagents.find((s) => s.id === ref.id);
      return sub
        ? {
            mark: subagentMark(sub.status),
            icon: <SubagentIcon className="text-icon-neutral" />,
            label: subagentName(sub),
            closable: true,
          }
        : null;
    }
    case "job": {
      const job = jobs.find((j) => j.id === ref.id);
      return job
        ? {
            mark: jobMark(job.status),
            icon: <JobIcon className="text-icon-neutral" />,
            label: jobName(job),
            closable: true,
          }
        : null;
    }
    case "file":
      return {
        mark: null,
        icon: <FileIcon className="text-icon-neutral" />,
        label: nameOf(ref.path),
        title: ref.path,
        closable: true,
      };
    default:
      return ref satisfies never;
  }
}

/** The tab button of `key` among the children of the tablist, found without a CSS selector. */
function tabIn(list: HTMLElement | null, key: string): HTMLElement | undefined {
  // Tabs can sit one level down (a file tab is wrapped with its close control).
  const buttons = Array.from(list?.querySelectorAll<HTMLElement>("[role=tab]") ?? []);
  return findTabElement(buttons, key);
}

/**
 * The tabs of the focused session (Pen `ZBxmu`): its chat, its subagents and its background jobs.
 * One tab stop for the whole list (roving tabindex); arrows, Home and End move between tabs,
 * Delete or Backspace closes one. Closing a tab only hides it: the subagent keeps running and
 * keeps its row in the sidebar.
 */
export function SessionTabs({ sessionId, tabs }: { sessionId: string; tabs: Tabs }) {
  const mark = useSessionMark(sessionId);
  const title = useSessionTitle(sessionId);
  const list = useRef<HTMLDivElement>(null);
  const keys = tabs.tabs.map(tabKey);
  const activeKey = tabKey(tabs.active);

  // More tabs than fit: the strip scrolls, and the tab in use is never left out of view. Focus by
  // arrow keys scrolls on its own; this covers a selection made elsewhere (a sidebar row, the
  // docked summary).
  useEffect(() => {
    tabIn(list.current, activeKey)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeKey]);

  const main = { mark: { mark, label: mark === "running" ? "Running" : "Idle" }, title };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target.closest("[role=tab]") : null;
    const current = target?.getAttribute("data-tab-key");
    if (!current) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      const ref = tabs.tabs.find((t) => tabKey(t) === current);
      if (!ref || ref.kind === "main") return;
      event.preventDefault();
      // Focus goes to the neighbour that stays, so the keyboard does not fall to the page.
      const at = keys.indexOf(current);
      const next = keys[at + 1] ?? keys[at - 1];
      tabs.close(ref);
      requestAnimationFrame(() =>
        (next === undefined ? undefined : tabIn(list.current, next))?.focus(),
      );
      return;
    }
    const to = moveTab(keys, current, event.key);
    if (to === null) return;
    event.preventDefault();
    const ref = tabs.tabs.find((t) => tabKey(t) === to);
    if (ref) tabs.select(ref);
    tabIn(list.current, to)?.focus();
  };

  return (
    <div
      ref={list}
      role="tablist"
      aria-label="Views of this session"
      onKeyDown={onKeyDown}
      // A mouse wheel only moves vertically: let it move the strip too. The scrollbar stays
      // hidden because the 44 px bar has no room for one; wheel, trackpad, keys and clicks reach every tab.
      onWheel={(event) => {
        if (event.deltaX === 0 && list.current) list.current.scrollLeft += event.deltaY;
      }}
      className="flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none]"
    >
      {tabs.tabs.map((ref) => {
        const view = describe(ref, main, tabs.subagents, tabs.jobs);
        if (!view) return null;
        const key = tabKey(ref);
        const selected = key === activeKey;
        const isFile = ref.kind === "file";
        const tab = (
          <button
            type="button"
            key={key}
            role="tab"
            id={tabDomId(ref)}
            data-testid="session-tab"
            data-tab-key={key}
            aria-selected={selected}
            aria-controls="session-tabpanel"
            aria-label={`${view.label}, ${view.mark?.label ?? "read-only file"}`}
            title={view.title}
            tabIndex={selected ? 0 : -1}
            onClick={() => tabs.select(ref)}
            className={cx(
              "app-no-drag flex h-(--layout-bar-height) max-w-(--layout-tab-max) shrink-0 items-center focus-visible:-outline-offset-(--size-focus-ring) gap-(--space-8) border-b px-(--space-12) text-size-sm hover:bg-bg-hover",
              isFile && "pr-(--space-30)",
              selected
                ? "border-accent text-text-primary"
                : "border-transparent text-text-secondary",
            )}
          >
            {view.mark && <StateMark state={view.mark.mark} decorative />}
            {view.icon}
            <span
              className={cx(
                "min-w-0 truncate",
                (ref.kind === "job" || isFile) && "font-mono text-size-xs",
              )}
            >
              {view.label}
            </span>
          </button>
        );
        if (!isFile) return tab;
        // A tab is a button, and a button cannot hold another, so the close control sits beside
        // it. It is out of the tab order: Delete or Backspace on the tab closes it from the keyboard.
        return (
          <div key={key} role="presentation" className="group relative flex shrink-0 items-stretch">
            {tab}
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Close ${view.label}`}
              onClick={() => tabs.close(ref)}
              className="app-no-drag absolute top-1/2 right-(--space-8) flex size-(--size-icon-ui) -translate-y-1/2 items-center justify-center rounded-sm text-text-dim opacity-0 hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
