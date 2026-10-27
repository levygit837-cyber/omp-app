import type { ContextFill, TodoPhase } from "@omp-app/protocol";
import { useStore } from "zustand";
import { replicas } from "../session-hooks";
import type { SessionsState } from "../session-store";

const select = <T>(selector: (state: SessionsState) => T): T => useStore(replicas.store, selector);

/** Null until omp can measure it. The reference changes only on a `context.set`. */
export const useContextFill = (sessionId: string): ContextFill | null =>
  select((s) => s.sessions[sessionId]?.context ?? null);
export const useSessionCost = (sessionId: string): number =>
  select((s) => s.sessions[sessionId]?.usage.cost ?? 0);
const NO_TODO: readonly TodoPhase[] = [];
export const useTodo = (sessionId: string): readonly TodoPhase[] =>
  select((s) => s.sessions[sessionId]?.todo ?? NO_TODO);
/** One per `user` item. A number, so a streamed delta never re-renders the reader. */
export const useTurnCount = (sessionId: string): number =>
  select((s) => {
    let turns = 0;
    for (const item of s.sessions[sessionId]?.timeline ?? []) if (item.kind === "user") turns++;
    return turns;
  });
