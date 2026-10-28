import type { JobInfo, SubagentInfo } from "@omp-app/protocol";
import { useCallback, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { resolveTab, type TabRef, tabsOf } from "./delegation-view";
import { replicas, useJobs, useSubagents } from "./session-hooks";
import { dismissTab, NO_TABS, rekeyTabs, selectTab, type TabState } from "./tab-state";

const tabStore = createStore<TabState>(() => NO_TABS);
replicas.onMoved((from, to) => tabStore.setState((state) => rekeyTabs(state, from, to)));

const NO_KEYS: readonly string[] = [];
const NO_FILES: readonly string[] = [];

export interface SessionTabs {
  readonly tabs: readonly TabRef[];
  /** The tab on screen: the one picked while it still exists, else the chat. */
  readonly active: TabRef;
  readonly subagents: readonly SubagentInfo[];
  readonly jobs: readonly JobInfo[];
  select(ref: TabRef): void;
  close(ref: TabRef): void;
}

/** Selects a tab of a session from outside its tab bar (the sidebar's subagent rows). */
export const showTab = (sessionId: string, ref: TabRef): void =>
  tabStore.setState((state) => selectTab(state, sessionId, ref));

/** The tabs of a session: its chat, its subagents, its background jobs and its open files. */
export function useSessionTabs(focused: string | null): SessionTabs {
  const sessionId = focused ?? "";
  const subagents = useSubagents(sessionId);
  const jobs = useJobs(sessionId);
  const wanted = useStore(tabStore, (s) => s.selected[sessionId]);
  const closed = useStore(tabStore, (s) => s.dismissed[sessionId]) ?? NO_KEYS;
  const files = useStore(tabStore, (s) => s.files[sessionId]) ?? NO_FILES;
  const tabs = useMemo(
    () => tabsOf({ subagents, jobs }, new Set(closed), files),
    [subagents, jobs, closed, files],
  );
  const active = useMemo(() => resolveTab(tabs, wanted), [tabs, wanted]);
  const select = useCallback((ref: TabRef) => showTab(sessionId, ref), [sessionId]);
  const close = useCallback(
    (ref: TabRef) => tabStore.setState((state) => dismissTab(state, sessionId, ref)),
    [sessionId],
  );
  return { tabs, active, subagents, jobs, select, close };
}
