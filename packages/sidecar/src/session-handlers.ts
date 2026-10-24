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
] as const;

/** Handlers for the `session.*` methods. Control goes through ACP; state comes from the store. */
export function sessionHandlers(
  control: SessionControl,
  store: SessionStore,
): Pick<Required<Handlers>, (typeof SESSION_CAPABILITIES)[number]> {
  const known = (sessionId: string): string => {
    if (!store.has(sessionId)) throw new Error(`unknown session: ${sessionId}`);
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
      await control.cancel(known(sessionId));
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
