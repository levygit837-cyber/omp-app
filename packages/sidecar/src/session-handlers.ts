import { type StoredSession, UNKNOWN_SESSION_MESSAGE } from "@omp-app/protocol";
import type { RequestAnswers } from "./request-registry";
import type { Handlers } from "./server";
import type { SessionStore } from "./session-store";

/** What the handlers need from the omp host. Narrow, so tests can stand in for omp. */
export interface SessionControl {
  list(): Promise<StoredSession[]>;
  createSession(cwd: string): Promise<string>;
  resumeSession(sessionId: string): Promise<string>;
  forkSession(sessionId: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
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
  "session.list",
  "session.resume",
  "session.fork",
  "session.close",
] as const;

/** Handlers for the `session.*` methods. Control goes through ACP; state comes from the store. */
export function sessionHandlers(
  control: SessionControl,
  store: SessionStore,
  requests: Pick<RequestAnswers, "answerPermission" | "answerAsk" | "dismissSession">,
): Pick<Required<Handlers>, (typeof SESSION_CAPABILITIES)[number]> {
  // A session that omp moved to a new file answers to its new id; a caller still holding the old
  // one (a prompt in flight, a remembered open set) is sent to the successor.
  const known = (sessionId: string): string => {
    const id = store.current(sessionId);
    if (!store.has(id)) throw new Error(`${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`);
    return id;
  };
  // Lifecycle calls run one at a time, so "is it open?" and what follows from the answer are one
  // step: `close` and `resume` of one session can never interleave into "resumed, then gone".
  let lifecycle: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(run: () => Promise<T>): Promise<T> => {
    const next = lifecycle.then(run);
    lifecycle = next.catch(() => {});
    return next;
  };
  return {
    "session.create": ({ cwd }) =>
      inOrder(async () => ({ sessionId: await control.createSession(cwd) })),

    "session.list": async () => ({ sessions: await control.list() }),

    // Already open: the same session again (under its current id), with whatever it has run
    // since. Opening it twice would put a second `AgentSession` on one file.
    "session.resume": ({ sessionId }) =>
      inOrder(async () => {
        const open = store.current(sessionId);
        return { sessionId: store.has(open) ? open : await control.resumeSession(sessionId) };
      }),

    "session.fork": ({ sessionId }) =>
      inOrder(async () => ({ sessionId: await control.forkSession(store.current(sessionId)) })),

    "session.close": ({ sessionId }) =>
      inOrder(async () => {
        const open = store.current(sessionId);
        // Idempotent: closing what is not open is already done.
        if (!store.has(open)) return null;
        await control.closeSession(open);
        store.remove(open);
        return null;
      }),

    "session.prompt": async ({ sessionId, text }) => {
      // The turn can run for minutes. The caller learns of progress through ops, so the request
      // returns once the prompt is accepted; a failed turn becomes a `failed` status.
      control.prompt(known(sessionId), text).catch((error: unknown) => {
        // The session may have been closed while the turn ran; nobody is left to tell.
        const id = store.current(sessionId);
        if (!store.has(id)) return;
        store.fail(id, error instanceof Error ? error.message : String(error));
      });
      return null;
    },

    "session.cancel": async ({ sessionId }) => {
      const id = known(sessionId);
      // omp keeps the wire request of a permission open when the turn is cancelled (it only
      // sends `$/cancel_request` on a steer), so drop it here or the band would outlive the turn.
      requests.dismissSession(id);
      await control.cancel(id);
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
      store.unsubscribe(store.current(sessionId), client);
      return null;
    },
  };
}
