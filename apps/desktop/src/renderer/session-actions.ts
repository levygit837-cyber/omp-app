import { describeError } from "./errors";
import { add, focus, type OpenSessions, remove } from "./open-sessions";

/** What the user asked for; each one names its failure in its own words. */
export type Action = "new" | "resume" | "fork" | "close";

export interface ActionError {
  readonly action: Action;
  /** One phrase naming what failed. */
  readonly title: string;
  /** A sentence about why, never the raw error text. */
  readonly message: string;
}

const TITLES: Record<Action, string> = {
  new: "Couldn’t start a session",
  resume: "Couldn’t open that session",
  fork: "Couldn’t fork that session",
  close: "Couldn’t close that session",
};

export function actionError(action: Action, error: unknown): ActionError {
  return { action, title: TITLES[action], message: describeError(error) };
}

/** What an action changes in the controller. Everything an action can leave on screen is here. */
export interface Held {
  readonly sessions: OpenSessions;
  /** The session that was focused could not be brought back. */
  readonly lost: boolean;
  /** The last action that failed; stays until the next action starts or the user dismisses it. */
  readonly error: ActionError | null;
}

/** An action's outcome, applied to the state as it is when the action ends (others may have run). */
export type Patch = (held: Held) => Held;

export interface ActionApi {
  create(cwd: string): Promise<string>;
  resume(sessionId: string): Promise<string>;
  fork(sessionId: string): Promise<string>;
  /** Closes the session in the sidecar. The file stays on disk. */
  close(sessionId: string): Promise<void>;
  /** Attaches the window to a session the sidecar holds; resolves with the id it is under. */
  attach(sessionId: string): Promise<string>;
  /** Stops the window's op stream for a session. */
  detach(sessionId: string): Promise<void>;
}

export type Request =
  | { readonly action: "new"; readonly cwd: string }
  | { readonly action: "resume" | "fork" | "close"; readonly sessionId: string };

const opened =
  (id: string): Patch =>
  (held) => ({ ...held, sessions: add(held.sessions, id), lost: false, error: null });

/**
 * Runs one action and says how it ended. Never throws: a failure becomes `error` and leaves
 * everything else as it was, so the session on screen stays on screen and the failure is visible
 * wherever the user is looking.
 */
export async function perform(
  api: ActionApi,
  current: OpenSessions,
  request: Request,
): Promise<Patch> {
  try {
    switch (request.action) {
      case "new":
        return opened(await api.attach(await api.create(request.cwd)));
      case "resume": {
        if (current.open.includes(request.sessionId)) {
          return (held) => ({
            ...held,
            sessions: focus(held.sessions, request.sessionId),
            lost: false,
            error: null,
          });
        }
        return opened(await api.attach(await api.resume(request.sessionId)));
      }
      case "fork":
        return opened(await api.attach(await api.fork(request.sessionId)));
      case "close": {
        // The sidecar first: if it refuses, the session is still open and still attached.
        await api.close(request.sessionId);
        // Stop the op stream before the replica goes, so nothing arrives for a replica that is gone.
        await api.detach(request.sessionId).catch(() => undefined);
        return (held) => ({
          ...held,
          sessions: remove(held.sessions, request.sessionId),
          error: null,
        });
      }
    }
  } catch (error) {
    const failure = actionError(request.action, error);
    return (held) => ({ ...held, error: failure });
  }
}
