import type { PendingRequest } from "@omp-app/protocol";
import type { MarkState } from "@omp-app/ui";
import { createContext, useContext } from "react";
import type { EnginePhase } from "./composer-state";
import { shownStatus } from "./engine";
import { sessionMark } from "./format";
import { usePending, useStatus } from "./session-hooks";

/** Where the engine is, for every component that shows what a session is doing. */
export const EngineContext = createContext<EnginePhase>("starting");

/** The session's status as it is shown: a turn does not run on a dead engine. */
export function useShownStatus(sessionId: string) {
  return shownStatus(useStatus(sessionId), useContext(EngineContext));
}

/**
 * What the person has to answer in this session, oldest first. A dead engine cannot receive an
 * answer, so nothing is waiting then: the band, the tab and the marks go away with it.
 */
export function useWaiting(sessionId: string): readonly PendingRequest[] {
  const pending = usePending(sessionId);
  const engine = useContext(EngineContext);
  return engine === "ready" && pending ? pending : NONE;
}

const NONE: readonly PendingRequest[] = [];

/** The mark a session carries in the sidebar and its tab. */
export function useSessionMark(sessionId: string): MarkState {
  return sessionMark(useShownStatus(sessionId), useWaiting(sessionId).length > 0);
}
