import type { CommandItem } from "@omp-app/protocol";
import { clampOutput } from "./command-entries";
import type { SessionStore } from "./session-store";

/** What the host reports when the builtin returned. */
export type CommandOutcome = { prompt: string } | { failed: boolean };

/** What the runner needs from the omp host. */
export interface CommandControl {
  /**
   * Runs the builtin against the live session; `output` receives each text it prints, and
   * `signal` fires when the person stops the command. The line was checked beforehand
   * (`isRunnableCommand`).
   */
  runCommand(
    sessionId: string,
    text: string,
    output: (text: string) => void,
    signal: AbortSignal,
  ): Promise<CommandOutcome>;
  /** Saves a finished command in the session file so a resumed session shows it. */
  saveCommand(sessionId: string, command: CommandItem): void;
}

export interface CommandRunnerDeps {
  readonly store: SessionStore;
  readonly control: CommandControl;
  /** Sends a line the builtin handed back (`/force`, `/ratchet`) down the ordinary prompt path. */
  readonly prompt: (sessionId: string, text: string) => void;
  /**
   * A sentence when the handed-back line must not be sent: omp dispatches it as a builtin again,
   * and the person confirmed the first command, not this one. Null lets it through.
   */
  readonly refusal: (text: string) => string | null;
}

/** One command the person started and omp has not finished with. */
interface Running {
  readonly sessionId: string;
  readonly abort: AbortController;
}

/**
 * Runs builtins for the sessions of one sidecar and writes what they print onto the timeline.
 * The line is accepted at once (the item appears running); the answer, the end state and the
 * cancel all happen on the item, because a builtin can take minutes (`/compact`, `/handoff`).
 */
export class CommandRunner {
  readonly #deps: CommandRunnerDeps;
  readonly #running = new Set<Running>();

  constructor(deps: CommandRunnerDeps) {
    this.#deps = deps;
  }

  /** Starts `text` on the session; the item is on the timeline when this returns. */
  start(sessionId: string, text: string): void {
    const { store, control } = this.#deps;
    const itemId = store.startCommand(sessionId, text);
    const running: Running = { sessionId, abort: new AbortController() };
    this.#running.add(running);

    // The session may move to a new id (another process owns its file) while this runs.
    const live = (): string | undefined => {
      const id = store.current(sessionId);
      return store.has(id) ? id : undefined;
    };
    let output = "";
    let truncated = false;
    const show = (): void => {
      const id = live();
      if (id) store.patchCommand(id, itemId, { output, ...(truncated ? { truncated: true } : {}) });
    };
    const append = (chunk: string): void => {
      const next = clampOutput(output === "" ? chunk : `${output}\n${chunk}`);
      output = next.output;
      truncated ||= next.truncated;
      show();
    };

    void (async () => {
      let state: CommandItem["state"] = "done";
      let handedBack: string | undefined;
      try {
        const outcome = await control.runCommand(
          store.current(sessionId),
          text,
          append,
          running.abort.signal,
        );
        if ("prompt" in outcome) {
          const refused = this.#deps.refusal(outcome.prompt);
          if (refused === null) handedBack = outcome.prompt;
          else {
            state = "failed";
            append(refused);
          }
        } else if (outcome.failed) state = running.abort.signal.aborted ? "stopped" : "failed";
      } catch (error) {
        state = running.abort.signal.aborted ? "stopped" : "failed";
        if (state === "failed") append(error instanceof Error ? error.message : String(error));
      } finally {
        this.#running.delete(running);
      }
      const id = live();
      if (!id) return;
      const finished = store.patchCommand(id, itemId, { state, endedAt: Date.now() });
      if (finished) {
        try {
          control.saveCommand(id, finished);
        } catch (error) {
          store.warn(id, {
            source: "session",
            title: "A command is not saved with the session",
            message: `It shows here, but it will be gone when the session is opened again. ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }
      if (handedBack !== undefined) this.#deps.prompt(id, handedBack);
    })();
  }

  /** Stops every command running on the session. True when there was one to stop. */
  cancel(sessionId: string): boolean {
    // Compared by current id: the session may have moved to a new file since the command began.
    const target = this.#deps.store.current(sessionId);
    let any = false;
    for (const running of this.#running) {
      if (this.#deps.store.current(running.sessionId) !== target) continue;
      running.abort.abort();
      any = true;
    }
    return any;
  }
}
