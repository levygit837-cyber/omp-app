/**
 * App protocol between main and the sidecar. Newline-delimited JSON over a Unix domain socket.
 * Pure types and codecs: no runtime dependencies, safe to import from any package.
 */

import { isSessionListResult, type SessionListResult } from "./catalog";
import { isSessionCommandsResult, type SessionCommandsResult } from "./commands";
import {
  isMcpChange,
  isMcpListing,
  isSkillsChange,
  isSkillsListing,
  type McpChange,
  type McpListing,
  type McpSecretRef,
  type McpServerInput,
  type SkillsChange,
  type SkillsListing,
} from "./extensions";
import { isRecord } from "./guards";
import { isPlanReadResult, type PlanReadResult } from "./plan";
import {
  type Delivery,
  isRemoveQueuedResult,
  isSessionFilesResult,
  isSessionModelsResult,
  type PromptImage,
  type QueueName,
  type RemoveQueuedResult,
  type SessionFilesResult,
  type SessionModelsResult,
} from "./prompt";
import type { AskAction, AskContent } from "./requests";
import { isSessionSnapshot, type SessionOpEvent, type SessionSnapshot } from "./session";
import {
  isSettingsChange,
  isSettingsListing,
  isSettingsRevealResult,
  type SettingScope,
  type SettingsChange,
  type SettingsListing,
  type SettingsRevealResult,
} from "./settings";

export * from "./catalog";
export * from "./commands";
export * from "./extensions";
export * from "./plan";
export * from "./prompt";
export * from "./requests";
export * from "./session";
export * from "./settings";
export * from "./timeline";

/** Bumped on every incompatible change to the envelopes or to a method's params/result. */
export const PROTOCOL_VERSION = 1;

/**
 * Prefix of the error message for a session id the sidecar does not know. Shared because
 * Electron's IPC keeps only the message text, so the renderer has to match on it.
 */
export const UNKNOWN_SESSION_MESSAGE = "unknown session";

/**
 * Prefix of the error for an answer to a request that is not pending any more (answered in
 * another window, withdrawn by the agent, turn over). Shared for the same reason as above.
 */
export const STALE_REQUEST_MESSAGE = "stale request";

/** Machine-readable failure reasons. Extend as methods are added. */
export type ErrorCode =
  | "invalid_request"
  | "unknown_method"
  | "disabled"
  | "read_only"
  | "internal";

export interface ProtocolError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly data?: unknown;
}

/** Client → sidecar. `id` correlates the response. */
export interface RequestEnvelope<M extends string = string, P = unknown> {
  readonly kind: "request";
  readonly id: string;
  readonly method: M;
  readonly params?: P;
}

/** Sidecar → client, answering the request with the same `id`. */
export type ResponseEnvelope<R = unknown> = {
  readonly kind: "response";
  readonly id: string;
} & (
  | { readonly ok: true; readonly result: R }
  | { readonly ok: false; readonly error: ProtocolError }
);

/** Sidecar → client, unsolicited. */
export interface EventEnvelope<N extends string = string, D = unknown> {
  readonly kind: "event";
  readonly name: N;
  readonly data?: D;
}

export type Envelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;

/** Shared agent database schema versions, reported when the app must not write to it. */
export interface SchemaMismatch {
  /** Schema version found on disk, newer than the pinned omp supports. */
  readonly onDisk: number;
  /** Schema version the pinned omp expects. */
  readonly expected: number;
}

/** First request on every connection. */
export interface HandshakeResult {
  /** `PROTOCOL_VERSION` the sidecar speaks; main refuses a sidecar that differs from its own. */
  readonly protocolVersion: number;
  /** Version of the sidecar build (`@omp-app/sidecar`). */
  readonly sidecarVersion: string;
  /** Version reported by the pinned omp the sidecar hosts. */
  readonly ompVersion: string;
  /** Feature names the sidecar serves. */
  readonly capabilities: readonly string[];
  /** `read_only` when the shared agent database is newer than the pinned omp: writes are refused. */
  readonly mode: "normal" | "read_only";
  /** Present only in `read_only` mode. */
  readonly schema?: SchemaMismatch;
}

/** Result of the debug-only `debug.logStdout` request. */
export interface DebugLogStdoutResult {
  /** How many stray writes the sidecar made to its own stdout. */
  readonly writes: number;
}

/** Result of the debug-only `debug.write` request. */
export interface DebugWriteResult {
  readonly wrote: true;
}

/**
 * Methods of the app protocol, by name.
 * `debug.logStdout` and `debug.write` are served only when the sidecar runs with `OMP_APP_SIDECAR_DEBUG=1`.
 */
export interface Methods {
  handshake: { params: undefined; result: HandshakeResult };
  "debug.logStdout": { params: { readonly marker: string }; result: DebugLogStdoutResult };
  /** Stands in for a write-capable method, so the read-only gate is testable before real ones exist. */
  "debug.write": { params: undefined; result: DebugWriteResult };
  "session.create": { params: { readonly cwd: string }; result: SessionCreateResult };
  /**
   * Sends a prompt. While the agent works it joins the running turn: `delivery` `steer` (the
   * default) injects it into the turn, `followUp` queues it until the turn ends. Idle, it starts
   * a turn and `delivery` is ignored, so a click that races the end of a turn is not lost.
   */
  "session.prompt": {
    params: {
      readonly sessionId: string;
      readonly text: string;
      readonly images?: readonly PromptImage[];
      readonly delivery?: Delivery;
    };
    result: null;
  };
  /** Models the session can switch to (the ones with credentials), with the thinking levels each accepts. */
  "session.models": { params: { readonly sessionId: string }; result: SessionModelsResult };
  /** Applies to the next turn; omp records it in the session file. `model` is `provider/id` from `session.models`. */
  "session.setModel": {
    params: { readonly sessionId: string; readonly model: string };
    result: null;
  };
  /** `level` is `off`, `auto` or one of the levels `session.models` lists for the active model. */
  "session.setThinking": {
    params: { readonly sessionId: string; readonly level: string };
    result: null;
  };
  /** Takes a message back out of the queue. `removed: false` when it was already delivered. */
  "session.removeQueued": {
    params: { readonly sessionId: string; readonly queue: QueueName; readonly text: string };
    result: RemoveQueuedResult;
  };
  /** Files and folders under the session folder that match `query`, for `@` references. Reads only. */
  "session.files": {
    params: { readonly sessionId: string; readonly query: string };
    result: SessionFilesResult;
  };
  "session.cancel": { params: { readonly sessionId: string }; result: null };
  /** Idempotent. Starts `session.op` events for this connection and returns the current state. */
  "session.subscribe": { params: { readonly sessionId: string }; result: SessionSnapshot };
  "session.unsubscribe": { params: { readonly sessionId: string }; result: null };
  /**
   * Answers a pending permission with one of its options. Resolves `null` when the answer was
   * applied. Answering a request that is no longer pending is an error (`stale request`), so a
   * second window or a late click never reads as success.
   */
  "session.answerPermission": {
    params: { readonly sessionId: string; readonly requestId: string; readonly optionId: string };
    result: null;
  };
  /** Answers a pending ask form: `accept` with the values by field key, or `decline` (stops the turn). */
  "session.answerAsk": {
    params: {
      readonly sessionId: string;
      readonly requestId: string;
      readonly action: AskAction;
      readonly content?: AskContent;
    };
    result: null;
  };
  /**
   * Turns plan mode on or off for an open session, the way omp's own ACP mode switch does (it
   * also installs the approval handler). Fails when omp's `plan.enabled` setting is off.
   */
  "session.setPlanMode": {
    params: { readonly sessionId: string; readonly enabled: boolean };
    result: null;
  };
  /**
   * Reads the session's plan file. The caller names no path: the sidecar takes it from the plan
   * state omp reports and refuses anything outside the session's `local://` root.
   */
  "session.readPlan": { params: { readonly sessionId: string }; result: PlanReadResult };
  /** Every session on disk the CLI picker would list, across projects. Reads only. */
  "session.list": { params: undefined; result: SessionListResult };
  /** Opens a stored session with its full history. Already open: returns the same id. */
  "session.resume": { params: { readonly sessionId: string }; result: SessionCreateResult };
  /**
   * Copies the whole stored session, up to its current end, into a new session and opens it.
   * Fails while the source is running a turn: omp refuses it (acp-agent.ts:1775, [V]).
   */
  "session.fork": { params: { readonly sessionId: string }; result: SessionCreateResult };
  /** Closes an open session (a running turn stops). The session file stays on disk. */
  "session.close": { params: { readonly sessionId: string }; result: null };
  /** The omp builtins that run without a terminal, as this session's omp offers them. */
  "session.commands": { params: { readonly sessionId: string }; result: SessionCommandsResult };
  /**
   * Runs one builtin (`text` is the whole line, `/model sonnet`) and returns once it is accepted:
   * the answer arrives as a `command` item on the timeline (running, then done or failed).
   * A name that is not a builtin with a terminal-free handler is refused, never sent to the
   * model. Unlike `session.prompt` it does not interrupt a turn that is streaming.
   * A line that `confirmationOf` asks about is refused (`CONFIRM_REQUIRED_MESSAGE`) unless
   * `confirmed` is true: the person's answer travels with the request, so a client that skips
   * the question cannot run it.
   */
  "session.runCommand": {
    params: { readonly sessionId: string; readonly text: string; readonly confirmed?: true };
    result: null;
  };
  /** Registry-driven listing with effective values; secrets are withheld. */
  "settings.list": { params: SettingsTarget; result: SettingsListing };
  /** A refused value comes back as `{ ok: false, message }`, not as an error. */
  "settings.set": {
    params: SettingsTarget & { readonly id: string; readonly value: unknown };
    result: SettingsChange;
  };
  /** Removes the key from the scope's file, so the next layer (or the default) applies again. */
  "settings.reset": {
    params: SettingsTarget & { readonly id: string };
    result: SettingsChange;
  };
  /** The one way a secret leaves the sidecar: the value stored in the scope's file. */
  "settings.reveal": {
    params: SettingsTarget & { readonly id: string };
    result: SettingsRevealResult;
  };
  /**
   * The servers of one scope's `mcp.json` (`global` is `<agent dir>/mcp.json`, `project` is
   * `<cwd>/.omp/mcp.json` of the named session). Values of env and headers are withheld.
   */
  "mcp.list": { params: SettingsTarget; result: McpListing };
  /** Through omp's `addMCPServer`: its validation, its file lock, its bytes. */
  "mcp.add": { params: SettingsTarget & { readonly server: McpServerInput }; result: McpChange };
  /** Through omp's `updateMCPServer`. Fields the form does not carry (timeout, auth) are kept. */
  "mcp.update": { params: SettingsTarget & { readonly server: McpServerInput }; result: McpChange };
  "mcp.remove": { params: SettingsTarget & { readonly name: string }; result: McpChange };
  /** Through omp's `setMcpServerEnabled`, as `/mcp enable` and `/mcp disable` do. */
  "mcp.setEnabled": {
    params: SettingsTarget & { readonly name: string; readonly enabled: boolean };
    result: McpChange;
  };
  /** The one way a stored MCP secret leaves the sidecar. */
  "mcp.reveal": {
    params: SettingsTarget & { readonly name: string; readonly secret: McpSecretRef };
    result: SettingsRevealResult;
  };
  /** Skills as omp discovers them for the session's project, disabled ones included. */
  "skills.list": { params: { readonly sessionId?: string }; result: SkillsListing };
  /** Adds or removes `skill:<name>` in the global `disabledExtensions` setting. */
  "skills.setEnabled": {
    params: { readonly sessionId?: string; readonly name: string; readonly enabled: boolean };
    result: SkillsChange;
  };
}

/**
 * Which config a settings call reads or edits. `sessionId` names an open session; the sidecar
 * takes the project directory from that session, never from the caller. It is required for the
 * `project` scope and gives `layers.project` for `global` too, since a project file can
 * override the global value.
 */
export interface SettingsTarget {
  readonly scope: SettingScope;
  readonly sessionId?: string;
}

export interface SessionCreateResult {
  readonly sessionId: string;
}

/** Events the sidecar pushes, by name. */
export interface Events {
  "session.op": SessionOpEvent;
}
export type EventName = keyof Events;
export type MethodName = keyof Methods;

export function request<M extends MethodName>(
  id: string,
  method: M,
  params?: Methods[M]["params"],
): RequestEnvelope<M, Methods[M]["params"]> {
  return params === undefined
    ? { kind: "request", id, method }
    : { kind: "request", id, method, params };
}

/** What a result looks like on the wire: JSON has no `undefined`, so a void result is `null`. */
export type WireResult<R> = R extends undefined ? null : R;

export function okResponse<R>(id: string, result: R): ResponseEnvelope<WireResult<R>> {
  // JSON.stringify drops `result: undefined`, and a response without `result` is malformed.
  return { kind: "response", id, ok: true, result: (result ?? null) as WireResult<R> };
}

export function errorResponse(id: string, error: ProtocolError): ResponseEnvelope<never> {
  return { kind: "response", id, ok: false, error };
}

export function isProtocolError(v: unknown): v is ProtocolError {
  return isRecord(v) && typeof v.code === "string" && typeof v.message === "string";
}

export function isRequestEnvelope(v: unknown): v is RequestEnvelope {
  return (
    isRecord(v) && v.kind === "request" && typeof v.id === "string" && typeof v.method === "string"
  );
}

export function isResponseEnvelope(v: unknown): v is ResponseEnvelope {
  if (!isRecord(v) || v.kind !== "response" || typeof v.id !== "string") return false;
  return v.ok === true ? "result" in v : v.ok === false && isProtocolError(v.error);
}

export function isEventEnvelope(v: unknown): v is EventEnvelope {
  return isRecord(v) && v.kind === "event" && typeof v.name === "string";
}

export function isEnvelope(v: unknown): v is Envelope {
  return isRequestEnvelope(v) || isResponseEnvelope(v) || isEventEnvelope(v);
}

export function isSchemaMismatch(v: unknown): v is SchemaMismatch {
  return isRecord(v) && typeof v.onDisk === "number" && typeof v.expected === "number";
}

export function isHandshakeResult(v: unknown): v is HandshakeResult {
  return (
    isRecord(v) &&
    typeof v.protocolVersion === "number" &&
    typeof v.sidecarVersion === "string" &&
    typeof v.ompVersion === "string" &&
    Array.isArray(v.capabilities) &&
    v.capabilities.every((c) => typeof c === "string") &&
    (v.mode === "normal" || (v.mode === "read_only" && isSchemaMismatch(v.schema)))
  );
}

export function isDebugLogStdoutResult(v: unknown): v is DebugLogStdoutResult {
  return isRecord(v) && typeof v.writes === "number";
}

/**
 * Whether each method can write to the shared omp state (database, settings, credentials).
 * The sidecar answers `read_only` to a `true` method when the schema guard tripped. Typed over
 * every method so a new one cannot be added without deciding.
 */
export const methodWrites: { [M in MethodName]: boolean } = {
  handshake: false,
  "debug.logStdout": false,
  "debug.write": true,
  "session.create": true,
  "session.prompt": true,
  // Switching writes the session file and omp's model-usage table in `agent.db`.
  "session.models": false,
  "session.setModel": true,
  "session.setThinking": true,
  // Edits the in-memory queue; nothing on disk.
  "session.removeQueued": false,
  "session.files": false,
  "session.cancel": true,
  "session.subscribe": false,
  "session.unsubscribe": false,
  // Both only complete a call omp is already waiting on; omp itself writes (a gated tool runs,
  // or a session file grows), but the answer touches nothing of ours. Read-only mode cannot
  // have a pending request anyway because `session.create` and `session.prompt` are refused.
  "session.answerPermission": false,
  "session.answerAsk": false,
  // Both touch only the live session in memory; the plan file is read, never written.
  "session.setPlanMode": false,
  "session.readPlan": false,
  "session.list": false,
  "session.resume": true,
  "session.fork": true,
  // Frees memory and stops a turn; nothing in the shared database changes.
  "session.close": false,
  // Lists names and descriptions from omp's registry and the session's files; changes nothing.
  "session.commands": false,
  // Some builtins write (/model, /compact, /move, /rename, plugin changes), and which ones is
  // omp's business, not ours. No session can be open in read-only mode (create, resume and fork
  // are refused), so gating the whole method is the same as refusing every writing builtin.
  "session.runCommand": true,
  // Writes go to the shared config.yml / project config.yml. Reveal only reads.
  "settings.list": false,
  "settings.set": true,
  "settings.reset": true,
  "settings.reveal": false,
  // Writes go to the shared mcp.json files and to config.yml. List and reveal only read.
  "mcp.list": false,
  "mcp.add": true,
  "mcp.update": true,
  "mcp.remove": true,
  "mcp.setEnabled": true,
  "mcp.reveal": false,
  "skills.list": false,
  "skills.setEnabled": true,
};

export function isDebugWriteResult(v: unknown): v is DebugWriteResult {
  return isRecord(v) && v.wrote === true;
}

export function isSessionCreateResult(v: unknown): v is SessionCreateResult {
  return isRecord(v) && typeof v.sessionId === "string";
}

/** Void results travel as `null` (JSON has no `undefined`). */
const isNull = (v: unknown): v is null => v === null;
/** Runtime check for each method's result, so callers get typed results without casts. */
export const resultGuards: { [M in MethodName]: (v: unknown) => v is Methods[M]["result"] } = {
  handshake: isHandshakeResult,
  "debug.logStdout": isDebugLogStdoutResult,
  "debug.write": isDebugWriteResult,
  "session.create": isSessionCreateResult,
  "session.prompt": isNull,
  "session.models": isSessionModelsResult,
  "session.setModel": isNull,
  "session.setThinking": isNull,
  "session.removeQueued": isRemoveQueuedResult,
  "session.files": isSessionFilesResult,
  "session.cancel": isNull,
  "session.subscribe": isSessionSnapshot,
  "session.unsubscribe": isNull,
  "session.answerPermission": isNull,
  "session.answerAsk": isNull,
  "session.setPlanMode": isNull,
  "session.readPlan": isPlanReadResult,
  "session.list": isSessionListResult,
  "session.resume": isSessionCreateResult,
  "session.fork": isSessionCreateResult,
  "session.close": isNull,
  "session.commands": isSessionCommandsResult,
  "session.runCommand": isNull,
  "settings.list": isSettingsListing,
  "settings.set": isSettingsChange,
  "settings.reset": isSettingsChange,
  "settings.reveal": isSettingsRevealResult,
  "mcp.list": isMcpListing,
  "mcp.add": isMcpChange,
  "mcp.update": isMcpChange,
  "mcp.remove": isMcpChange,
  "mcp.setEnabled": isMcpChange,
  "mcp.reveal": isSettingsRevealResult,
  "skills.list": isSkillsListing,
  "skills.setEnabled": isSkillsChange,
};

/** A request that failed: the sidecar answered with an error, or the reply was malformed. */
export class ProtocolRequestError extends Error {
  readonly code: ErrorCode;
  constructor(error: ProtocolError) {
    super(error.message);
    this.name = "ProtocolRequestError";
    this.code = error.code;
  }
}

/**
 * Client-side request bookkeeping, independent of the transport: allocates ids, builds the
 * frame to send and settles the matching promise when the response arrives.
 */
export class RequestCorrelator {
  #next = 0;
  readonly #pending = new Map<
    string,
    { method: MethodName; resolve: (v: never) => void; reject: (e: Error) => void }
  >();

  /** Returns the frame to write and the promise for its typed result. */
  create<M extends MethodName>(
    method: M,
    params?: Methods[M]["params"],
  ): { frame: string; response: Promise<Methods[M]["result"]> } {
    const id = String(++this.#next);
    const response = new Promise<Methods[M]["result"]>((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
    });
    return { frame: encodeFrame(request(id, method, params)), response };
  }

  /** Settles the request a response belongs to. Returns false for unknown ids. */
  receive(response: ResponseEnvelope): boolean {
    const entry = this.#pending.get(response.id);
    if (!entry) return false;
    this.#pending.delete(response.id);
    if (!response.ok) {
      entry.reject(new ProtocolRequestError(response.error));
    } else if (resultGuards[entry.method](response.result)) {
      entry.resolve(response.result as never);
    } else {
      entry.reject(
        new ProtocolRequestError({
          code: "internal",
          message: `malformed ${entry.method} result`,
        }),
      );
    }
    return true;
  }

  /** Fails every in-flight request, e.g. when the connection closes. */
  rejectAll(error: Error): void {
    for (const entry of this.#pending.values()) entry.reject(error);
    this.#pending.clear();
  }
}

/** One frame: the envelope as JSON plus the `\n` terminator. JSON never contains a raw newline. */
export function encodeFrame(envelope: Envelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

export type DecodedFrame =
  | { readonly ok: true; readonly envelope: Envelope }
  | { readonly ok: false; readonly error: ProtocolError; readonly raw: string };

export function decodeFrame(line: string): DecodedFrame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return {
      ok: false,
      raw: line,
      error: { code: "invalid_request", message: "frame is not valid JSON" },
    };
  }
  if (!isEnvelope(value)) {
    return {
      ok: false,
      raw: line,
      error: { code: "invalid_request", message: "frame is not a protocol envelope" },
    };
  }
  return { ok: true, envelope: value };
}

/** Longest single frame line the decoder accepts, in UTF-16 code units. */
export const MAX_FRAME_CHARS = 32 * 1024 * 1024;

/**
 * Thrown by `FrameDecoder.push` when one line exceeds `MAX_FRAME_CHARS`. `complete` holds the
 * lines the same chunk finished before the oversized one: they arrived whole and are not lost.
 */
export class FrameTooLongError extends Error {
  constructor(readonly complete: readonly string[] = []) {
    super(`frame line exceeds ${MAX_FRAME_CHARS} characters`);
    this.name = "FrameTooLongError";
  }
}

/**
 * Reassembles frames from arbitrary text chunks. Keeps the trailing partial line
 * as parts joined once when the line completes, so decoding stays linear.
 */
export class FrameDecoder {
  #parts: string[] = [];
  #pending = 0;

  /**
   * Feed a chunk; returns every complete, non-empty line it finished.
   * Throws `FrameTooLongError` (after resetting) when a line passes `MAX_FRAME_CHARS`; the error
   * carries the lines this chunk had already completed.
   */
  push(chunk: string): string[] {
    const lines: string[] = [];
    let start = 0;
    while (true) {
      const newline = chunk.indexOf("\n", start);
      const end = newline === -1 ? chunk.length : newline;
      if (this.#pending + (end - start) > MAX_FRAME_CHARS) {
        this.#parts = [];
        this.#pending = 0;
        throw new FrameTooLongError(lines);
      }
      if (newline === -1) {
        if (end > start) {
          this.#parts.push(chunk.slice(start));
          this.#pending += end - start;
        }
        return lines;
      }
      const line = (
        this.#parts.length === 0
          ? chunk.slice(start, end)
          : this.#parts.join("") + chunk.slice(start, end)
      ).trimEnd();
      this.#parts = [];
      this.#pending = 0;
      if (line.length > 0) lines.push(line);
      start = newline + 1;
    }
  }
}
