import { UNKNOWN_SESSION_MESSAGE } from "@omp-app/protocol";
import type { RequestAnswers } from "./request-registry";
import type { Handlers } from "./server";
import type { SessionStore } from "./session-store";

/** What the handlers need from the omp host. Narrow, so tests can stand in for omp. */
export interface SessionControl {
  createSession(cwd: string): Promise<string>;
  prompt(sessionId: string, text: string): Promise<string>;
  cancel(sessionId: string): Promise<void>;
}

export const SESSION_CAPABILITIES = [
  "session.create",
  "session.prompt",
  "session.cancel",
  "session.subscribe",
  "session.unsubscribe",
  "session.answerPermission",
  "session.answerAsk",
] as const;

/** Handlers for the `session.*` methods. Control goes through ACP; state comes from the store. */
export function sessionHandlers(
  control: SessionControl,
  store: SessionStore,
  requests: Pick<RequestAnswers, "answerPermission" | "answerAsk" | "dismissSession">,
): Pick<Required<Handlers>, (typeof SESSION_CAPABILITIES)[number]> {
  const known = (sessionId: string): string => {
    if (!store.has(sessionId)) throw new Error(`${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`);
    return sessionId;
  };
  return {
    "session.create": async ({ cwd }) => ({ sessionId: await control.createSession(cwd) }),

    "session.prompt": async ({ sessionId, text }) => {
      known(sessionId);
      // The turn can run for minutes. The caller learns of progress through ops, so the request
      // returns once the prompt is accepted; a failed turn becomes a `failed` status.
      control.prompt(sessionId, text).catch((error: unknown) => {
        store.fail(sessionId, error instanceof Error ? error.message : String(error));
      });
      return null;
    },

    "session.cancel": async ({ sessionId }) => {
      // omp keeps the wire request of a permission open when the turn is cancelled (it only
      // sends `$/cancel_request` on a steer), so drop it here or the band would outlive the turn.
      requests.dismissSession(known(sessionId));
      await control.cancel(sessionId);
      return null;
    },

    "session.answerPermission": async ({ sessionId, requestId, optionId }) => {
      requests.answerPermission(known(sessionId), requestId, optionId);
      return null;
    },

    "session.answerAsk": async ({ sessionId, requestId, action, content }) => {
      requests.answerAsk(known(sessionId), requestId, action, content);
      return null;
    },

    "session.subscribe": async ({ sessionId }, client) =>
      store.subscribe(known(sessionId), client, (event) => client.emit("session.op", event)),

    "session.unsubscribe": async ({ sessionId }, client) => {
      store.unsubscribe(sessionId, client);
      return null;
    },
  };
}
