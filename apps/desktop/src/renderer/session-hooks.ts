import type { Item, SessionStatus, SessionWarning } from "@omp-app/protocol";
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
export const useSyncError = (): string | null => select((s) => s.error);
export const useWarnings = (sessionId: string): readonly SessionWarning[] | undefined =>
  select((s) => s.sessions[sessionId]?.warnings);
export const useItemKind = (sessionId: string, index: number): Item["kind"] | undefined =>
  select((s) => s.sessions[sessionId]?.timeline[index]?.kind);
export const useModel = (sessionId: string | null): string | null | undefined =>
  select((s) => (sessionId ? s.sessions[sessionId]?.model : undefined));
/** The first prompt stands in for a title until sessions carry one. A string, so it is stable. */
export const useSessionTitle = (sessionId: string): string =>
  select((s) => {
    const first = s.sessions[sessionId]?.timeline.find((item) => item.kind === "user");
    return sessionTitle(first?.text);
  });
