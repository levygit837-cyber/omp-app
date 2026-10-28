import {
  CONFIRM_REQUIRED_MESSAGE,
  type Delivery,
  IMAGE_REFUSED_MESSAGE,
  isPromptImage,
  MAX_FILE_QUERY_CHARS,
  type ModelOption,
  type PromptImage,
  type QueueName,
  refuseImages,
  type SessionCommandsResult,
  type StoredSession,
  UNKNOWN_COMMAND_MESSAGE,
  UNKNOWN_SESSION_MESSAGE,
} from "@omp-app/protocol";
import {
  confirmationFor,
  gatedPromptLine,
  isRunnableCommand,
  needsConfirmationSentence,
} from "./command-catalog";
import { type CommandControl, CommandRunner } from "./command-runner";
import { listFiles } from "./file-list";
import type { RequestAnswers } from "./request-registry";
import type { Handlers } from "./server";
import type { SessionStore } from "./session-store";

/** What the handlers need from the omp host. Narrow, so tests can stand in for omp. */
export interface SessionControl extends CommandControl {
  list(): Promise<StoredSession[]>;
  createSession(cwd: string): Promise<string>;
  resumeSession(sessionId: string): Promise<string>;
  forkSession(sessionId: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
  prompt(sessionId: string, text: string, images?: readonly PromptImage[]): Promise<string>;
  join(
    sessionId: string,
    text: string,
    images: readonly PromptImage[],
    delivery: Delivery,
  ): Promise<boolean>;
  models(sessionId: string): ModelOption[];
  setModel(sessionId: string, model: string): Promise<void>;
  setThinking(sessionId: string, level: string): void;
  removeQueued(sessionId: string, queue: QueueName, text: string): boolean;
  cwdOf(sessionId: string): string;
  cancel(sessionId: string): Promise<void>;
  /** The builtins omp runs without a terminal. Independent of the session. */
  commands(): SessionCommandsResult["commands"];
}

export const SESSION_CAPABILITIES = [
  "session.create",
  "session.prompt",
  "session.models",
  "session.setModel",
  "session.setThinking",
  "session.removeQueued",
  "session.files",
  "session.cancel",
  "session.subscribe",
  "session.unsubscribe",
  "session.answerPermission",
  "session.answerAsk",
  "session.list",
  "session.resume",
  "session.fork",
  "session.close",
  "session.commands",
  "session.runCommand",
] as const;

/** Handlers for the `session.*` methods. Control goes through ACP; state comes from the store. */
export function sessionHandlers(
  control: SessionControl,
  store: SessionStore,
  requests: Pick<RequestAnswers, "answerPermission" | "answerAsk" | "dismissSession">,
): Pick<Required<Handlers>, (typeof SESSION_CAPABILITIES)[number]> {
  // A session that omp moved to a new file answers to its new id; a caller still holding the old
  // one (a prompt in flight, a remembered open set) is sent to the successor.
  // A subagent's view is read-only: it can be subscribed to (`watched`), and nothing drives it.
  const watched = (sessionId: string): string => {
    const id = store.current(sessionId);
    if (!store.has(id)) throw new Error(`${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`);
    return id;
  };
  const known = (sessionId: string): string => {
    const id = watched(sessionId);
    if (store.isView(id)) throw new Error(`${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`);
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
  const commands = new CommandRunner({
    store,
    control,
    // The same path as a typed prompt, for what a builtin hands back (`/force`, `/ratchet`).
    refusal: (text) => {
      const line = gatedPromptLine(text);
      return line === null ? null : needsConfirmationSentence(line);
    },
    prompt: (sessionId, text) => {
      control.prompt(sessionId, text).catch((error: unknown) => {
        const id = store.current(sessionId);
        if (store.has(id)) store.fail(id, error instanceof Error ? error.message : String(error));
      });
    },
  });
  return {
    "session.create": ({ cwd }) =>
      inOrder(async () => ({ sessionId: await control.createSession(cwd) })),

    "session.list": async () => ({ sessions: await control.list() }),

    // Already open: the same session again (under its current id), with whatever it has run
    // since. Opening it twice would put a second `AgentSession` on one file.
    "session.resume": ({ sessionId }) =>
      inOrder(async () => {
        const open = store.current(sessionId);
        if (store.isView(open)) throw new Error(`${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`);
        return { sessionId: store.has(open) ? open : await control.resumeSession(sessionId) };
      }),

    "session.fork": ({ sessionId }) =>
      inOrder(async () => {
        const open = store.current(sessionId);
        if (store.isView(open)) throw new Error(`${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`);
        return { sessionId: await control.forkSession(open) };
      }),

    "session.close": ({ sessionId }) =>
      inOrder(async () => {
        const open = store.current(sessionId);
        // Idempotent: closing what is not open is already done.
        if (!store.has(open)) return null;
        if (store.isView(open)) throw new Error(`${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`);
        await control.closeSession(open);
        store.remove(open);
        return null;
      }),

    "session.prompt": async ({ sessionId, text, images = [], delivery = "steer" }) => {
      // Refused here so the composer shows a sentence; `OmpHost.prompt` holds the same line for
      // every other caller.
      const gated = gatedPromptLine(text);
      if (gated !== null) throw new Error(`${CONFIRM_REQUIRED_MESSAGE}: ${gated}`);
      // The request comes from a renderer: check the shape here, not at the call sites.
      if (
        !Array.isArray(images) ||
        !images.every(isPromptImage) ||
        (delivery !== "steer" && delivery !== "followUp")
      ) {
        throw new Error("invalid prompt");
      }
      const refusal = refuseImages(images);
      if (refusal) throw new Error(`${IMAGE_REFUSED_MESSAGE}: ${refusal}`);
      const id = known(sessionId);
      // While the agent works the prompt joins the turn. When omp declines it (the turn is being
      // cancelled, or nobody the app started is running) it starts a turn like an idle prompt.
      if (store.snapshot(id).snapshot.status === "streaming") {
        if (await control.join(id, text, images, delivery)) return null;
      }
      // The turn can run for minutes. The caller learns of progress through ops, so the request
      // returns once the prompt is accepted; a failed turn becomes a `failed` status.
      control.prompt(id, text, images).catch((error: unknown) => {
        // The session may have been closed while the turn ran; nobody is left to tell.
        const id = store.current(sessionId);
        if (!store.has(id)) return;
        store.fail(id, error instanceof Error ? error.message : String(error));
      });
      return null;
    },

    "session.models": async ({ sessionId }) => ({ models: control.models(known(sessionId)) }),

    "session.setModel": async ({ sessionId, model }) => {
      if (typeof model !== "string") throw new Error("invalid model");
      await control.setModel(known(sessionId), model);
      return null;
    },

    "session.setThinking": async ({ sessionId, level }) => {
      if (typeof level !== "string") throw new Error("invalid thinking level");
      control.setThinking(known(sessionId), level);
      return null;
    },

    "session.removeQueued": async ({ sessionId, queue, text }) => {
      if ((queue !== "steering" && queue !== "followUp") || typeof text !== "string") {
        throw new Error("invalid queue entry");
      }
      return { removed: control.removeQueued(known(sessionId), queue, text) };
    },

    "session.files": async ({ sessionId, query }) => {
      if (typeof query !== "string" || query.length > MAX_FILE_QUERY_CHARS) {
        throw new Error("invalid query");
      }
      return { ...(await listFiles(control.cwdOf(known(sessionId)), query)) };
    },

    "session.cancel": async ({ sessionId }) => {
      const id = known(sessionId);
      // omp keeps the wire request of a permission open when the turn is cancelled (it only
      // sends `$/cancel_request` on a steer), so drop it here or the band would outlive the turn.
      requests.dismissSession(id);
      // A builtin that is still running (`/compact`) stops with the Stop control, like a turn.
      commands.cancel(id);
      await control.cancel(id);
      return null;
    },

    "session.commands": async ({ sessionId }) => {
      known(sessionId);
      return { commands: control.commands() };
    },

    "session.runCommand": async ({ sessionId, text, confirmed }) => {
      const id = known(sessionId);
      // Checked here so a typo is an error the person sees, not a message sent to the model.
      if (!isRunnableCommand(text)) throw new Error(`${UNKNOWN_COMMAND_MESSAGE}: ${text}`);
      // The question is the person's to answer, not the client's to remember: a line that
      // reaches beyond the session does not start without the answer in the request.
      if (confirmed !== true && confirmationFor(text) !== null) {
        throw new Error(`${CONFIRM_REQUIRED_MESSAGE}: ${text}`);
      }
      commands.start(id, text);
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
      store.subscribe(watched(sessionId), client, (event) => client.emit("session.op", event)),

    "session.unsubscribe": async ({ sessionId }, client) => {
      store.unsubscribe(store.current(sessionId), client);
      return null;
    },
  };
}
