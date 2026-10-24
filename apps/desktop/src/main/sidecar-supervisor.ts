import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import {
  decodeFrame,
  type EventEnvelope,
  FrameDecoder,
  isEventEnvelope,
  isResponseEnvelope,
  type MethodName,
  type Methods,
  PROTOCOL_VERSION,
  RequestCorrelator,
} from "@omp-app/protocol";
import type { SidecarStatus } from "../shared/bridge";
import { LogTail } from "./log-tail";
import { createRuntimeDir, sweepStaleRuntimeDirs } from "./runtime-dirs";

export interface SupervisorOptions {
  /** Executable to run. It receives `--socket=<path>` as its last argument. */
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** How many recent stdout/stderr lines to keep for error display. */
  readonly logLines?: number;
  /** Budget for connecting and completing the handshake after spawn. */
  readonly startTimeoutMs?: number;
  /** After SIGTERM, how long to wait before SIGKILL. */
  readonly killGraceMs?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Owns one sidecar process at a time: spawns it, connects to its Unix socket, runs the
 * handshake, reports status, notices when it dies and can restart it. Contains no Electron
 * code so it can be exercised under `bun test`.
 *
 * Stdout and stderr of the sidecar are both logs; the protocol only travels on the socket.
 */
export class SidecarSupervisor {
  readonly #options: Required<Omit<SupervisorOptions, "env" | "args">> &
    Pick<SupervisorOptions, "env" | "args">;
  readonly #tail: LogTail;
  readonly #listeners = new Set<(status: SidecarStatus) => void>();
  readonly #eventListeners = new Set<(event: EventEnvelope) => void>();
  /** Correlator of the live connection; null until the socket is up and after it is torn down. */
  #correlator: RequestCorrelator | null = null;
  #status: SidecarStatus = { state: "starting" };
  /** Bumped on every launch and stop; callbacks from an older run compare and bail. */
  #run = 0;
  #child: ChildProcess | null = null;
  #socket: Socket | null = null;
  #dir: string | null = null;
  /** Serialises start/restart/stop so they never interleave. */
  #chain: Promise<void> = Promise.resolve();

  constructor(options: SupervisorOptions) {
    this.#options = {
      logLines: 200,
      startTimeoutMs: 60_000,
      killGraceMs: 3_000,
      ...options,
    };
    this.#tail = new LogTail(this.#options.logLines);
  }

  get status(): SidecarStatus {
    return this.#status;
  }

  onStatus(listener: (status: SidecarStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Calls `listener` for every event the sidecar pushes. Returns the unsubscribe function. */
  onEvent(listener: (event: EventEnvelope) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Sends a request over the live connection. Rejects unless the sidecar is `ready`. */
  request<M extends MethodName>(
    method: M,
    params?: Methods[M]["params"],
  ): Promise<Methods[M]["result"]> {
    const socket = this.#socket;
    const correlator = this.#correlator;
    if (this.#status.state !== "ready" || !socket || !correlator) {
      return Promise.reject(new Error("the sidecar is not ready"));
    }
    const { frame, response } = correlator.create(method, params);
    socket.write(frame);
    return response;
  }

  /**
   * Starts the sidecar and sweeps runtime dirs that dead app instances left behind.
   * Idempotent: while a sidecar is running (or failed, awaiting `restart`) it does nothing,
   * so a second call can never orphan the first child. Watch `onStatus` for the outcome.
   */
  start(): Promise<void> {
    return this.#enqueue(() => {
      if (this.#child) return;
      try {
        sweepStaleRuntimeDirs();
      } catch {
        // Best effort: an unreadable temp dir must not stop the sidecar from starting.
      }
      this.#launch();
    });
  }

  /** Stops the current sidecar (if any) and launches a new one. */
  restart(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#terminate();
      this.#launch();
    });
  }

  /** Stops the sidecar and resolves once the process is gone. Status is left as is. */
  stop(): Promise<void> {
    return this.#enqueue(() => this.#terminate());
  }

  /** Last-resort synchronous kill for `process.on("exit")`. */
  killNow(): void {
    this.#child?.kill("SIGKILL");
  }

  #enqueue(task: () => void | Promise<void>): Promise<void> {
    const next = this.#chain.then(task);
    this.#chain = next.catch(() => {});
    return next;
  }

  #setStatus(status: SidecarStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }

  #launch(): void {
    const run = ++this.#run;
    this.#tail.clear();
    this.#setStatus({ state: "starting" });

    const dir = createRuntimeDir();
    const socketPath = join(dir, "s.sock");
    this.#dir = dir;

    const child = spawn(
      this.#options.command,
      [...(this.#options.args ?? []), `--socket=${socketPath}`],
      { stdio: ["ignore", "pipe", "pipe"], env: this.#options.env ?? process.env },
    );
    this.#child = child;
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => this.#tail.push(chunk));
    }
    child.on("error", (error) => this.#fail(run, `cannot start sidecar: ${error.message}`));
    // `close` fires after the stdio streams end, so the log tail is complete by then.
    child.on("close", (code, signal) => {
      this.#fail(
        run,
        `sidecar exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`})`,
      );
    });

    void this.#connectAndHandshake(run, child, socketPath).catch((error: unknown) => {
      this.#fail(run, error instanceof Error ? error.message : String(error));
    });
  }

  async #connectAndHandshake(run: number, child: ChildProcess, socketPath: string): Promise<void> {
    const deadline = Date.now() + this.#options.startTimeoutMs;
    let socket: Socket | null = null;
    while (!socket) {
      if (run !== this.#run) return;
      if (child.exitCode !== null || child.signalCode !== null) return; // `close` reports it
      if (Date.now() > deadline) throw new Error("timed out waiting for the sidecar to listen");
      socket = await new Promise<Socket | null>((resolve) => {
        const attempt = connect(socketPath);
        attempt.once("connect", () => resolve(attempt));
        attempt.once("error", () => {
          attempt.destroy();
          resolve(null);
        });
      });
      if (!socket) await wait(100);
    }
    if (run !== this.#run) {
      socket.destroy();
      return;
    }
    this.#socket = socket;

    const correlator = new RequestCorrelator();
    this.#correlator = correlator;
    const decoder = new FrameDecoder();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const frame = decodeFrame(line);
        if (!frame.ok) continue;
        if (isResponseEnvelope(frame.envelope)) correlator.receive(frame.envelope);
        else if (isEventEnvelope(frame.envelope) && run === this.#run) {
          for (const listener of this.#eventListeners) listener(frame.envelope);
        }
      }
    });
    socket.on("close", () => {
      correlator.rejectAll(new Error("connection to the sidecar closed"));
      // A dying process usually reports through `close` on the child; give it a moment so the
      // user sees the exit reason rather than the symptom.
      void wait(500).then(() => this.#fail(run, "connection to the sidecar was lost"));
    });
    socket.on("error", () => {});

    const { frame, response } = correlator.create("handshake");
    socket.write(frame);
    const timeout = wait(Math.max(1, deadline - Date.now())).then(() => {
      throw new Error("sidecar did not answer the handshake in time");
    });
    const result = await Promise.race([response, timeout]);
    if (run !== this.#run) return;
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `sidecar speaks protocol ${result.protocolVersion}, this app speaks ${PROTOCOL_VERSION}`,
      );
    }
    this.#setStatus({
      state: "ready",
      ompVersion: result.ompVersion,
      sidecarVersion: result.sidecarVersion,
      mode: result.mode,
      ...(result.schema ? { schema: result.schema } : {}),
    });
  }

  /** Marks the run as failed unless it is stale or already failed, then tears the process down. */
  #fail(run: number, error: string): void {
    if (run !== this.#run || this.#status.state === "failed") return;
    this.#setStatus({ state: "failed", error, logTail: this.#tail.lines() });
    this.#child?.kill("SIGKILL");
    this.#socket?.destroy();
    this.#cleanupDir();
  }

  async #terminate(): Promise<void> {
    this.#run++; // invalidates every callback of the run being stopped
    const child = this.#child;
    this.#child = null;
    this.#socket?.destroy();
    this.#socket = null;
    this.#correlator?.rejectAll(new Error("the sidecar was stopped"));
    this.#correlator = null;
    // `pid` is undefined when spawn failed: there is no process and `close` will never fire.
    if (child && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      const escalate = setTimeout(() => child.kill("SIGKILL"), this.#options.killGraceMs);
      await closed;
      clearTimeout(escalate);
    }
    this.#cleanupDir();
  }

  #cleanupDir(): void {
    if (this.#dir) rmSync(this.#dir, { recursive: true, force: true });
    this.#dir = null;
  }
}
