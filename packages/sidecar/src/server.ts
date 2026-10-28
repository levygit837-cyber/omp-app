import { chmodSync, rmSync } from "node:fs";
import {
  decodeFrame,
  type EventEnvelope,
  type EventName,
  type Events,
  encodeFrame,
  errorResponse,
  FrameDecoder,
  FrameTooLongError,
  isRequestEnvelope,
  type MethodName,
  type Methods,
  methodWrites,
  okResponse,
  type RequestEnvelope,
  type ResponseEnvelope,
  resultGuards,
} from "@omp-app/protocol";
import { removeRuntimeDir } from "./runtime-dir";

/** One connected client, as handlers see it. The object identity is stable for the connection. */
export interface ClientHandle {
  /** Pushes an unsolicited event to this client. */
  emit<N extends EventName>(name: N, data: Events[N]): void;
}

/** One handler per method. A method with no handler answers `disabled`. */
export type Handlers = {
  [M in MethodName]?: (
    params: Methods[M]["params"],
    client: ClientHandle,
  ) => Promise<Methods[M]["result"]>;
};

export interface ServerHooks {
  /** Called once when a client's connection closes, so per-client state can be dropped. */
  readonly onClientClosed?: (client: ClientHandle) => void;
}

export interface Server {
  /** Fires when the last client disconnects after at least one had connected. */
  readonly idle: Promise<void>;
  stop(): void;
}

/** Every method the protocol defines. Derived, so a new method can never answer `unknown_method`. */
const METHOD_NAMES: readonly string[] = Object.keys(resultGuards);

async function dispatch(
  handlers: Handlers,
  req: RequestEnvelope,
  readOnly: boolean,
  client: ClientHandle,
): Promise<ResponseEnvelope> {
  if (!METHOD_NAMES.includes(req.method)) {
    return errorResponse(req.id, {
      code: "unknown_method",
      message: `unknown method: ${req.method}`,
    });
  }
  if (readOnly && methodWrites[req.method as MethodName]) {
    return errorResponse(req.id, {
      code: "read_only",
      message: `${req.method} writes and the shared omp database is newer than this app supports`,
    });
  }
  const handler = handlers[req.method as MethodName] as
    | ((params: unknown, client: ClientHandle) => Promise<unknown>)
    | undefined;
  if (!handler) {
    return errorResponse(req.id, { code: "disabled", message: `${req.method} is disabled` });
  }
  try {
    return okResponse(req.id, await handler(req.params, client));
  } catch (error) {
    return errorResponse(req.id, {
      code: "internal",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

interface Connection {
  decoder: FrameDecoder;
  text: TextDecoder;
  /** Bytes the kernel has not accepted yet; flushed on `drain`. */
  pending: Uint8Array | null;
  closed: boolean;
  client: ClientHandle;
}

/** Listens on a Unix socket (mode 0600) and serves newline-delimited protocol frames. */
export function startServer(
  socketPath: string,
  handlers: Handlers,
  readOnly = false,
  hooks: ServerHooks = {},
): Server {
  rmSync(socketPath, { force: true });
  let connected = 0;
  let sawClient = false;
  const { promise: idle, resolve: resolveIdle } = Promise.withResolvers<void>();

  const send = (socket: Bun.Socket<Connection>, frame: string): void => {
    const bytes = new TextEncoder().encode(frame);
    const state = socket.data;
    if (state.pending) {
      const merged = new Uint8Array(state.pending.length + bytes.length);
      merged.set(state.pending);
      merged.set(bytes, state.pending.length);
      state.pending = merged;
      return;
    }
    const written = socket.write(bytes);
    if (written < bytes.length) state.pending = bytes.subarray(written);
  };

  const listener = Bun.listen<Connection>({
    unix: socketPath,
    socket: {
      open(socket) {
        connected++;
        sawClient = true;
        const client: ClientHandle = {
          emit: (name, data) => {
            if (socket.data.closed) return;
            const event: EventEnvelope = { kind: "event", name, data };
            send(socket, encodeFrame(event));
          },
        };
        socket.data = {
          decoder: new FrameDecoder(),
          text: new TextDecoder(),
          pending: null,
          closed: false,
          client,
        };
      },
      data(socket, chunk) {
        const state = socket.data;
        if (state.closed) return;
        let lines: readonly string[];
        let tooLong = false;
        try {
          lines = state.decoder.push(state.text.decode(chunk, { stream: true }));
        } catch (error) {
          if (!(error instanceof FrameTooLongError)) throw error;
          console.error("[sidecar] closing connection: frame line too long");
          // Requests this chunk completed before the oversized line are still answered.
          lines = error.complete;
          tooLong = true;
          state.closed = true;
        }
        const answers: Promise<void>[] = [];
        for (const line of lines) {
          const decoded = decodeFrame(line);
          if (!decoded.ok || !isRequestEnvelope(decoded.envelope)) {
            console.error(`[sidecar] dropped malformed frame: ${line.slice(0, 200)}`);
            continue;
          }
          answers.push(
            dispatch(handlers, decoded.envelope, readOnly, state.client).then((response) =>
              send(socket, encodeFrame(response)),
            ),
          );
        }
        if (tooLong) void Promise.allSettled(answers).then(() => socket.end());
      },
      drain(socket) {
        const state = socket.data;
        if (!state.pending) return;
        const written = socket.write(state.pending);
        state.pending = written < state.pending.length ? state.pending.subarray(written) : null;
      },
      close(socket) {
        socket.data.closed = true;
        hooks.onClientClosed?.(socket.data.client);
        connected--;
        if (sawClient && connected === 0) resolveIdle();
      },
      error(_socket, error) {
        console.error(`[sidecar] socket error: ${error.message}`);
      },
    },
  });
  chmodSync(socketPath, 0o600);

  return {
    idle,
    stop() {
      listener.stop(true);
      removeRuntimeDir(socketPath);
    },
  };
}
