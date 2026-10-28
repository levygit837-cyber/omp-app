import type {
  AskAction,
  AskContent,
  McpChange,
  McpListing,
  McpSecretRef,
  McpServerInput,
  SessionOpEvent,
  SessionSnapshot,
  SettingsChange,
  SettingsListing,
  SettingsTarget,
  SkillsChange,
  SkillsListing,
  StoredSession,
} from "@omp-app/protocol";

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
    /** Picks one of the options of a pending permission. Rejects if it is no longer pending. */
    answerPermission(sessionId: string, requestId: string, optionId: string): Promise<void>;
    /** Submits (`accept`, with the values by field key) or closes (`decline`) a pending form. */
    answerAsk(
      sessionId: string,
      requestId: string,
      action: AskAction,
      content?: AskContent,
    ): Promise<void>;
    /** Sessions on disk, as the CLI picker lists them, newest first. Works in read-only mode. */
    list(): Promise<readonly StoredSession[]>;
    /** Opens a stored session with its full history; resolves with its id. Rejects in read-only mode. */
    resume(sessionId: string): Promise<string>;
    /** Opens a copy of a stored session as it is on disk now; resolves with the copy's id. */
    fork(sessionId: string): Promise<string>;
    /** Closes an open session in the sidecar. The session file stays on disk. */
    close(sessionId: string): Promise<void>;
    /** Calls `listener` for every op of every subscribed session. Returns the unsubscribe function. */
    onOp(listener: (event: SessionOpEvent) => void): () => void;
  };
  readonly settings: {
    /** Every registry setting with its effective value in `target`'s scope. Secrets are masked. */
    list(target: SettingsTarget): Promise<SettingsListing>;
    /** A value the sidecar refuses comes back as `{ ok: false, message }`. Rejects in read-only mode. */
    set(target: SettingsTarget, id: string, value: unknown): Promise<SettingsChange>;
    /** Removes the key from the target scope's file. Rejects in read-only mode. */
    reset(target: SettingsTarget, id: string): Promise<SettingsChange>;
    /** The stored value of one secret setting, on demand. */
    reveal(target: SettingsTarget, id: string): Promise<string>;
    /** Opens the global config.yml in the system's editor (main picks the path, not the window). */
    openConfigFile(): Promise<void>;
    /** Calls `listener` when the application menu asks for settings. Returns the unsubscribe function. */
    onOpenRequested(listener: () => void): () => void;
  };
  readonly mcp: {
    /** The servers of one scope's mcp.json. Env and header values are withheld; see `reveal`. */
    list(target: SettingsTarget): Promise<McpListing>;
    /** A refusal comes back as `{ ok: false, message }`. Rejects in read-only mode. */
    add(target: SettingsTarget, server: McpServerInput): Promise<McpChange>;
    update(target: SettingsTarget, server: McpServerInput): Promise<McpChange>;
    remove(target: SettingsTarget, name: string): Promise<McpChange>;
    setEnabled(target: SettingsTarget, name: string, enabled: boolean): Promise<McpChange>;
    /** One stored value (an env or header value, or the full URL), on demand. */
    reveal(target: SettingsTarget, name: string, secret: McpSecretRef): Promise<string>;
  };
  readonly skills: {
    /** Skills as omp lists them for `sessionId`'s project (or only the user's when omitted). */
    list(sessionId?: string): Promise<SkillsListing>;
    setEnabled(name: string, enabled: boolean, sessionId?: string): Promise<SkillsChange>;
  };
};
