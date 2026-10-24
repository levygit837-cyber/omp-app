/** Where the sidecar is in its lifecycle, as the window sees it. */
export type SidecarStatus =
  | { readonly state: "starting" }
  | { readonly state: "ready"; readonly ompVersion: string; readonly sidecarVersion: string }
  | { readonly state: "failed"; readonly error: string; readonly logTail: readonly string[] };

/** Surface exposed by the preload script as `window.omp`. Types only: safe to import anywhere. */
export type OmpBridge = {
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
  };
  readonly sidecar: {
    /** Current status; subscribe with `onStatus` first, then read this, to avoid missing a change. */
    getStatus(): Promise<SidecarStatus>;
    /** Calls `listener` on every status change. Returns the unsubscribe function. */
    onStatus(listener: (status: SidecarStatus) => void): () => void;
    /** Stops the sidecar if running and starts a fresh one. Resolves once the new one is launching. */
    restart(): Promise<void>;
  };
};
