/** Where the engine is, as far as the input bar cares. */
export type EnginePhase = "starting" | "restarting" | "ready" | "failed";

export type ComposerView =
  | { readonly kind: "read-only" }
  | {
      readonly kind: "input";
      /** A prompt may be sent now. A draft typed while this is false is kept. */
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
    canSend: !streaming,
    reason: null,
    placeholder: streaming
      ? "Steer the agent, or queue what comes next…"
      : "Ask omp to change something…",
  };
}
