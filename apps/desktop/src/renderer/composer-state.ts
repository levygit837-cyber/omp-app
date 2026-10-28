/** Where the engine is, as far as the input bar cares. */
export type EnginePhase = "starting" | "restarting" | "ready" | "failed";

export type ComposerView =
  | { readonly kind: "read-only" }
  | {
      readonly kind: "input";
      /**
       * A prompt may be sent now. While the agent works it joins the turn (steer) or waits for it
       * (follow-up), so a running turn does not stop sending; only the engine does. A draft typed
       * while this is false is kept.
       */
      readonly canSend: boolean;
      /** Why sending is paused because of the engine, for a draft that is waiting; else null. */
      readonly reason: string | null;
      readonly placeholder: string;
    };

export interface ComposerInputs {
  readonly readOnly: boolean;
  readonly engine: EnginePhase;
  readonly streaming: boolean;
}

const ENGINE_DOWN = "omp isn’t running. Restart it to send messages.";

/**
 * One place for what the input bar says and allows. The engine outranks the turn: while it is
 * not ready nothing can be sent, and the placeholder gives the reason where the text would go.
 * The field keeps taking text in every state, so a draft survives an engine restart.
 */
export function composerView({ readOnly, engine, streaming }: ComposerInputs): ComposerView {
  if (readOnly) return { kind: "read-only" };
  if (engine === "failed") {
    return { kind: "input", canSend: false, reason: "omp is stopped", placeholder: ENGINE_DOWN };
  }
  if (engine !== "ready") {
    const verb = engine === "restarting" ? "restarting" : "starting";
    return {
      kind: "input",
      canSend: false,
      reason: `omp is ${verb}`,
      placeholder: `omp is ${verb}. Your draft is kept.`,
    };
  }
  return {
    kind: "input",
    canSend: true,
    reason: null,
    placeholder: streaming
      ? "Steer the agent, or queue what comes next…"
      : "Ask omp to change something…",
  };
}

/**
 * Whether a key press stops the running turn. Only Esc does, and not while the input bar sits in
 * an `inert` subtree: the session view stays mounted under Settings, and the Esc that leaves
 * Settings must not also cancel what the agent is doing behind it.
 */
export function keyStopsTurn(key: string, underInert: boolean): boolean {
  return key === "Escape" && !underInert;
}

/**
 * What Esc does in the input bar. The `@` list closes first and stays a separate step from
 * stopping: the Esc that dismisses the list must never also stop the turn. `listShown` is whether
 * the list is on screen (it draws "Searching…" and "No matching files" as well as matches).
 */
export function escapeAction(state: {
  readonly listShown: boolean;
  readonly stopsTurn: boolean;
}): "close-list" | "stop" | "none" {
  if (state.listShown) return "close-list";
  return state.stopsTurn ? "stop" : "none";
}
