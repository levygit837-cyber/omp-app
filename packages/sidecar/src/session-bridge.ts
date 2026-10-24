import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { emptyViewModel } from "./reducer";
import type { SessionStore } from "./session-store";

const modelOf = (session: AgentSession): string | null =>
  session.model ? `${session.model.provider}/${session.model.id}` : null;

/**
 * Registers a new session with the store and feeds it every event `AgentSession` emits.
 * This is the single source of the timeline.
 */
export function attachSession(store: SessionStore, session: AgentSession): void {
  const id = session.sessionId;
  store.create(
    emptyViewModel({ id, cwd: session.sessionManager.getCwd(), model: modelOf(session) }),
  );
  session.subscribe((event) => {
    try {
      if (event.type === "model_changed") store.setModel(id, modelOf(session));
      else store.dispatch(id, event);
    } catch (error) {
      // A reducer bug must not take the agent run down with it.
      console.error(
        `[sidecar] reducer failed on ${event.type}: ${error instanceof Error ? error.stack : error}`,
      );
    }
  });
}
