import { chmodSync, rmSync } from "node:fs";
import {
  decodeFrame,
  encodeFrame,
  errorResponse,
  FrameDecoder,
  isRequestEnvelope,
  type MethodName,
  type Methods,
  okResponse,
  type RequestEnvelope,
  type ResponseEnvelope,
  resultGuards,
} from "@omp-app/protocol";
import { removeRuntimeDir } from "./runtime-dir";

/** One handler per method. A method with no handler answers `disabled`. */
export type Handlers = {
  [M in MethodName]?: (params: Methods[M]["params"]) => Promise<Methods[M]["result"]>;
};

export interface Server {
  /** Fires when the last client disconnects after at least one had connected. */
  readonly idle: Promise<void>;
  stop(): void;
}

/** Every method the protocol defines. Derived, so a new method can never answer `unknown_method`. */
const METHOD_NAMES: readonly string[] = Object.keys(resultGuards);

async function dispatch(handlers: Handlers, req: RequestEnvelope): Promise<ResponseEnvelope> {
  if (!METHOD_NAMES.includes(req.method)) {
    return errorResponse(req.id, {
      code: "unknown_method",
      message: `unknown method: ${req.method}`,
    });
  }
  const handler = handlers[req.method as MethodName] as
    | ((params: unknown) => Promise<unknown>)
    | undefined;
  if (!handler) {
    return errorResponse(req.id, { code: "disabled", message: `${req.method} is disabled` });
  }
  try {
    return okResponse(req.id, await handler(req.params));
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
}

/** Listens on a Unix socket (mode 0600) and serves newline-delimited protocol frames. */
export function startServer(socketPath: string, handlers: Handlers): Server {
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
        socket.data = { decoder: new FrameDecoder(), text: new TextDecoder(), pending: null };
      },
      data(socket, chunk) {
        const state = socket.data;
        for (const line of state.decoder.push(state.text.decode(chunk, { stream: true }))) {
          const decoded = decodeFrame(line);
          if (!decoded.ok || !isRequestEnvelope(decoded.envelope)) {
            console.error(`[sidecar] dropped malformed frame: ${line.slice(0, 200)}`);
            continue;
          }
          void dispatch(handlers, decoded.envelope).then((response) =>
            send(socket, encodeFrame(response)),
          );
        }
      },
      drain(socket) {
        const state = socket.data;
        if (!state.pending) return;
        const written = socket.write(state.pending);
        state.pending = written < state.pending.length ? state.pending.subarray(written) : null;
      },
      close() {
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
