import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  decodeFrame,
  type EventEnvelope,
  FrameDecoder,
  isEventEnvelope,
  isResponseEnvelope,
  type MethodName,
  type Methods,
  RequestCorrelator,
} from "@omp-app/protocol";

const entry = join(import.meta.dir, "../src/main.ts");

/** Version of the omp package installed in node_modules, read from its package.json on disk. */
export async function installedOmpVersion(): Promise<string> {
  const index = Bun.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"));
  const pkgPath = join(dirname(index), "..", "package.json");
  return (await Bun.file(pkgPath).json()).version;
}

export interface RawClient {
  /** Every byte received on the socket, verbatim. */
  readonly received: () => string;
  /** Every event the sidecar pushed, in order. */
  readonly events: () => readonly EventEnvelope[];
  request<M extends MethodName>(
    method: M,
    params?: Methods[M]["params"],
  ): Promise<Methods[M]["result"]>;
  /** Writes bytes as-is, bypassing the request builder. */
  writeRaw(text: string): void;
  close(): void;
}

export interface RunningSidecar {
  readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly socketPath: string;
  /** The per-launch dir holding the socket, named the way main names it. */
  readonly dir: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  connect(): Promise<RawClient>;
  stop(): Promise<void>;
}

async function collect(stream: ReadableStream<Uint8Array>, into: { text: string }): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) into.text += decoder.decode(chunk, { stream: true });
}

/** Spawns the sidecar from source, in debug mode, and waits for it to be listening. */
export async function startSidecar(extraEnv: Record<string, string> = {}): Promise<RunningSidecar> {
  const dir = mkdtempSync(join(tmpdir(), `omp-app-${process.pid}-`));
  const socketPath = join(dir, "s.sock");
  const proc = Bun.spawn([process.execPath, entry, `--socket=${socketPath}`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OMP_APP_SIDECAR_DEBUG: "1", ...extraEnv },
  });
  const out = { text: "" };
  const err = { text: "" };
  void collect(proc.stdout, out);
  void collect(proc.stderr, err);

  const deadline = Date.now() + 45_000;
  // `Bun.file().exists()` is false for sockets; `existsSync` stats the path.
  while (!existsSync(socketPath)) {
    if (proc.exitCode !== null) throw new Error(`sidecar exited early:\n${err.text}`);
    if (Date.now() > deadline) throw new Error(`sidecar did not listen in time:\n${err.text}`);
    await Bun.sleep(50);
  }

  return {
    proc,
    socketPath,
    dir,
    stdout: () => out.text,
    stderr: () => err.text,
    async connect() {
      const correlator = new RequestCorrelator();
      const decoder = new FrameDecoder();
      const text = new TextDecoder();
      const received = { text: "" };
      const events: EventEnvelope[] = [];
      const socket = await Bun.connect({
        unix: socketPath,
        socket: {
          data(_s, chunk) {
            const piece = text.decode(chunk, { stream: true });
            received.text += piece;
            for (const line of decoder.push(piece)) {
              const frame = decodeFrame(line);
              if (!frame.ok) throw new Error(`protocol channel carried a non-frame: ${line}`);
              if (isResponseEnvelope(frame.envelope)) correlator.receive(frame.envelope);
              else if (isEventEnvelope(frame.envelope)) events.push(frame.envelope);
            }
          },
          close() {
            correlator.rejectAll(new Error("socket closed"));
          },
        },
      });
      return {
        received: () => received.text,
        events: () => events,
        request(method, params) {
          const { frame, response } = correlator.create(method, params);
          socket.write(frame);
          return response;
        },
        writeRaw: (t) => void socket.write(t),
        close: () => void socket.end(),
      };
    },
    async stop() {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
