import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { readContextFill } from "./context-fill";
import { emptyViewModel } from "./reducer";
import type { RequestAnswers } from "./request-registry";
import type { SessionStore } from "./session-store";

const modelOf = (session: AgentSession): string | null =>
  session.model ? `${session.model.provider}/${session.model.id}` : null;

/** The context size changes when a reply lands, the history is compacted or the model changes. */
const CONTEXT_EVENTS: ReadonlySet<string> = new Set([
  "message_end",
  "agent_end",
  "auto_compaction_end",
  "model_changed",
]);

/** A bug in one step must not take the agent run down, nor skip the steps after it. */
function guarded(type: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    console.error(
      `[sidecar] ${type} failed: ${error instanceof Error ? error.stack : String(error)}`,
    );
  }
}

/**
 * Registers a new session with the store and feeds it every event `AgentSession` emits.
 * This is the single source of the timeline. The reducer and the context reading are guarded
 * separately: a throw in the reducer still leaves the context meter current.
 */
export function attachSession(
  store: SessionStore,
  session: AgentSession,
  requests: Pick<RequestAnswers, "agentEvent">,
): void {
  const id = session.sessionId;
  store.create(
    emptyViewModel({ id, cwd: session.sessionManager.getCwd(), model: modelOf(session) }),
  );
  session.subscribe((event) => {
    guarded(`reducer on ${event.type}`, () => {
      if (event.type === "model_changed") store.setModel(id, modelOf(session));
      else store.dispatch(id, event);
    });
    // After the dispatch, so a request that ends with its turn leaves after the turn's ops.
    guarded(`request withdrawal on ${event.type}`, () => requests.agentEvent(id, event));
    if (CONTEXT_EVENTS.has(event.type)) {
      guarded(`context reading on ${event.type}`, () =>
        store.setContext(id, readContextFill(session)),
      );
    }
  });
}
