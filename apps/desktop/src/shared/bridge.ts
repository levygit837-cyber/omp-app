import type { SessionOpEvent, SessionSnapshot } from "@omp-app/protocol";

/** Where the sidecar is in its lifecycle, as the window sees it. */
export type SidecarStatus =
  | { readonly state: "starting" }
  | {
      readonly state: "ready";
      readonly ompVersion: string;
      readonly sidecarVersion: string;
      /** `read_only`: the shared omp database is newer than this app supports; writes are refused. */
      readonly mode: "normal" | "read_only";
      /** Both schema versions; present only in `read_only` mode. */
      readonly schema?: { readonly onDisk: number; readonly expected: number };
    }
  | { readonly state: "failed"; readonly error: string; readonly logTail: readonly string[] };

/** Surface exposed by the preload script as `window.omp`. Types only: safe to import anywhere. */
export type OmpBridge = {
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
  };
  readonly app: {
    /** Opens an http(s) address in the system browser. Resolves false when main refuses the address. */
    openLink(url: string): Promise<boolean>;
  };
  readonly sidecar: {
    /** Current status; subscribe with `onStatus` first, then read this, to avoid missing a change. */
    getStatus(): Promise<SidecarStatus>;
    /** Calls `listener` on every status change. Returns the unsubscribe function. */
    onStatus(listener: (status: SidecarStatus) => void): () => void;
    /** Stops the sidecar if running and starts a fresh one. Resolves once the new one is launching. */
    restart(): Promise<void>;
  };
  readonly session: {
    /** Native directory picker. Resolves with the chosen absolute path, or null if cancelled. */
    pickDirectory(): Promise<string | null>;
    /** Creates a session in `cwd` and resolves with its id. Rejects in read-only mode. */
    create(cwd: string): Promise<string>;
    /** Idempotent. Resolves with the current state; `session.op` events for it keep flowing. */
    subscribe(sessionId: string): Promise<SessionSnapshot>;
    unsubscribe(sessionId: string): Promise<void>;
    /** Resolves once the prompt is accepted; the answer arrives as ops. */
    prompt(sessionId: string, text: string): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    /** Calls `listener` for every op of every subscribed session. Returns the unsubscribe function. */
    onOp(listener: (event: SessionOpEvent) => void): () => void;
  };
};
