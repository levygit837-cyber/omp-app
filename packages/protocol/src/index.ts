/**
 * App protocol between main and the sidecar. Newline-delimited JSON over a Unix domain socket.
 * Pure types and codecs: no runtime dependencies, safe to import from any package.
 */

/** Bumped on every incompatible change to the envelopes or to a method's params/result. */
export const PROTOCOL_VERSION = 1;

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
}
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
};

export function isDebugWriteResult(v: unknown): v is DebugWriteResult {
  return isRecord(v) && v.wrote === true;
}

/** Runtime check for each method's result, so callers get typed results without casts. */
export const resultGuards: { [M in MethodName]: (v: unknown) => v is Methods[M]["result"] } = {
  handshake: isHandshakeResult,
  "debug.logStdout": isDebugLogStdoutResult,
  "debug.write": isDebugWriteResult,
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

/** Reassembles frames from arbitrary text chunks. Keeps the trailing partial line. */
export class FrameDecoder {
  #buffer = "";

  /** Feed a chunk; returns every complete, non-empty line it finished. */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines.map((line) => line.trimEnd()).filter((line) => line.length > 0);
  }
}
