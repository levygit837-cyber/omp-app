import { createContext, useContext } from "react";
import type { EnginePhase } from "./composer-state";
import { shownStatus } from "./engine";
import { useStatus } from "./session-hooks";

/** Where the engine is, for every component that shows what a session is doing. */
export const EngineContext = createContext<EnginePhase>("starting");

/** The session's status as it is shown: a turn does not run on a dead engine. */
export function useShownStatus(sessionId: string) {
  return shownStatus(useStatus(sessionId), useContext(EngineContext));
}
