import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionWarning } from "@omp-app/protocol";
import { readStoredCommands } from "./command-entries";
import { readContextFill } from "./context-fill";
import { emptyViewModel } from "./reducer";
import type { RequestAnswers } from "./request-registry";
import type { SessionStore } from "./session-store";
import { buildTranscript, describeOmitted } from "./transcript";
import { thinkingOf } from "./user-message";

const thinkingOfSession = (session: AgentSession): string | null =>
  thinkingOf(session.thinkingLevel, session.configuredThinkingLevel());

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

const MOVED: Record<"open-elsewhere" | "replaced" | "contested", string> = {
  "open-elsewhere":
    "Another omp process has this session open, so omp keeps saving your turns to a copy. The original stays as that process left it.",
  replaced: "The session file changed on disk, so omp keeps saving to a copy and leaves it alone.",
  contested:
    "Another writer kept changing the session file, so omp keeps saving to a copy and stops racing it.",
};

/**
 * Registers an opened session with the store and feeds it every event `AgentSession` emits.
 * This is the single source of the live timeline. The reducer and the context reading are guarded
 * separately: a throw in the reducer still leaves the context meter current. A stored session arrives with its history:
 * the timeline starts as the transcript of what is on disk (`transcript.ts`), and the live
 * events continue it.
 */
export function attachSession(
  store: SessionStore,
  session: AgentSession,
  requests: Pick<RequestAnswers, "agentEvent">,
): void {
  // The id the store knows the session by: the manager's, which omp changes when it moves the
  // session to a new file (see the persistence notice below). `session.sessionId` is the provider
  // session id and also changes on `/fresh`, which moves nothing.
  let id = session.sessionManager.getSessionId();
  const transcript = buildTranscript(
    session.buildTranscriptSessionContext().messages,
    readStoredCommands(session.sessionManager.getBranch()),
  );
  const warnings: SessionWarning[] = [];
  const omittedText = describeOmitted(transcript.omitted);
  if (omittedText) {
    warnings.push({
      source: "session",
      title: "Earlier entries are not shown",
      message: `${omittedText} are not shown here yet. They are still in the session file and still count as context.`,
    });
  }
  // Another live omp process owns this session's file (typically the CLI has it open), or the
  // file changed under us: omp keeps saving to a new sibling file with a NEW session id
  // (session-manager.ts:839-851, 1263-1286 [V]). The store follows, and subscribers are told
  // with a `session.moved` op, so the replica, the open set and the sidebar row move with it.
  // omp replays notices from before we subscribed, synchronously: those only add a warning,
  // since the session is registered under its current id from the start.
  let created = false;
  session.sessionManager.onPersistenceNotice((notice) => {
    const warning: SessionWarning = {
      source: "session",
      title: "This session moved to a new file",
      message: MOVED[notice.reason],
    };
    if (!created) {
      warnings.push(warning);
      return;
    }
    const previous = id;
    id = session.sessionManager.getSessionId();
    if (id !== previous) store.rekey(previous, id);
    store.warn(id, warning);
  });
  store.create({
    ...emptyViewModel({
      id,
      cwd: session.sessionManager.getCwd(),
      model: modelOf(session) ?? transcript.model,
      thinking: thinkingOfSession(session),
    }),
    timeline: transcript.items,
    warnings,
  });
  created = true;
  session.subscribe((event) => {
    guarded(`reducer on ${event.type}`, () => {
      if (event.type === "model_changed") {
        store.setModel(id, modelOf(session));
        // A switch re-applies the thinking level (`model-controls.ts:#reapplyThinkingLevel`
        // [V]) and may clamp it to what the new model accepts, with or without an event.
        store.setThinking(id, thinkingOfSession(session));
      } else store.dispatch(id, event);
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
