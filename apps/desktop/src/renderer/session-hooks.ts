import type {
  CommandItem,
  Item,
  JobInfo,
  PendingRequest,
  PlanState,
  QueueState,
  SessionStatus,
  SessionWarning,
  SubagentInfo,
} from "@omp-app/protocol";
import { useMemo } from "react";
import { useStore } from "zustand";
import { sessionTitle } from "./format";
import { createSessionReplicas, type SessionsState } from "./session-store";

/** The window's replicas, fed by the bridge. */
export const replicas = createSessionReplicas(window.omp.session, (callback) =>
  requestAnimationFrame(() => callback()),
);
window.omp.session.onOp(replicas.receive);

const select = <T>(selector: (state: SessionsState) => T): T => useStore(replicas.store, selector);

/**
 * Selectors stay narrow on purpose: a streaming delta replaces one item, so a component that
 * reads only a status, a count or one item by index re-renders only when that value changes.
 */
export const useStatus = (sessionId: string): SessionStatus | undefined =>
  select((s) => s.sessions[sessionId]?.status);
export const useItemCount = (sessionId: string): number =>
  select((s) => s.sessions[sessionId]?.timeline.length ?? 0);
export const useItem = (sessionId: string, index: number): Item | undefined =>
  select((s) => s.sessions[sessionId]?.timeline[index]);
export const useCwd = (sessionId: string): string | undefined =>
  select((s) => s.sessions[sessionId]?.cwd);
export const useSessionError = (sessionId: string): string | undefined =>
  select((s) => s.sessions[sessionId]?.error);
/** The newest command line of the session, once it ended; undefined while it still runs. */
export const useEndedCommand = (sessionId: string): CommandItem | undefined =>
  select((s) => {
    const timeline = s.sessions[sessionId]?.timeline ?? [];
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item?.kind === "command") return item.state === "running" ? undefined : item;
    }
    return undefined;
  });
export const useSyncError = (): string | null => select((s) => s.error);
export const useWarnings = (sessionId: string): readonly SessionWarning[] | undefined =>
  select((s) => s.sessions[sessionId]?.warnings);
export const usePending = (sessionId: string): readonly PendingRequest[] | undefined =>
  select((s) => s.sessions[sessionId]?.pending);
export const usePlan = (sessionId: string): PlanState | undefined =>
  select((s) => s.sessions[sessionId]?.plan);
const NO_SUBAGENTS: readonly SubagentInfo[] = [];
const NO_JOBS: readonly JobInfo[] = [];
export const useSubagents = (sessionId: string): readonly SubagentInfo[] =>
  select((s) => s.sessions[sessionId]?.subagents ?? NO_SUBAGENTS);
export const useJobs = (sessionId: string): readonly JobInfo[] =>
  select((s) => s.sessions[sessionId]?.jobs ?? NO_JOBS);
export const useItemKind = (sessionId: string, index: number): Item["kind"] | undefined =>
  select((s) => s.sessions[sessionId]?.timeline[index]?.kind);
export const useModel = (sessionId: string | null): string | null | undefined =>
  select((s) => (sessionId ? s.sessions[sessionId]?.model : undefined));
export const useThinking = (sessionId: string): string | null | undefined =>
  select((s) => s.sessions[sessionId]?.thinking);
export const useQueue = (sessionId: string): QueueState | undefined =>
  select((s) => s.sessions[sessionId]?.queue);
/** The first prompt stands in for a title until sessions carry one. A string, so it is stable. */
export const useSessionTitle = (sessionId: string): string =>
  select((s) => {
    const first = s.sessions[sessionId]?.timeline.find((item) => item.kind === "user");
    return sessionTitle(first?.text);
  });

/**
 * Folder of every listed session that has a replica. Selected as one string, which is stable
 * while no folder changes, so streaming deltas do not re-render the sidebar.
 */
export function useOpenCwds(ids: readonly string[]): ReadonlyMap<string, string> {
  const key = select((s) => ids.map((id) => `${id}\t${s.sessions[id]?.cwd ?? ""}`).join("\n"));
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const line of key.split("\n")) {
      const [id, cwd] = line.split("\t");
      if (id && cwd) map.set(id, cwd);
    }
    return map;
  }, [key]);
}

/** Read once, when a turn ends: subscribing would re-render on every streamed chunk. */
export function lastAssistantText(sessionId: string): string | undefined {
  const timeline = replicas.store.getState().sessions[sessionId]?.timeline ?? [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item?.kind === "assistant") return item.text;
  }
  return undefined;
}
