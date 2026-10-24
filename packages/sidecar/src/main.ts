import "./stdio";
import { writeSync } from "node:fs";
import type { HandshakeResult } from "@omp-app/protocol";
import { startOmpHost } from "./omp-host";
import { type Handlers, startServer } from "./server";
import { SIDECAR_VERSION } from "./version";

/** Debug-only requests exist so tests can prove stray output cannot reach the protocol. */
const DEBUG = process.env.OMP_APP_SIDECAR_DEBUG === "1";

function parseSocketPath(argv: readonly string[]): string {
  const arg = argv.find((a) => a.startsWith("--socket="));
  const path = arg?.slice("--socket=".length);
  if (!path) throw new Error("usage: omp-app-sidecar --socket=<path>");
  return path;
}

async function main(): Promise<void> {
  const socketPath = parseSocketPath(process.argv);
  const parentPid = process.ppid;

  const host = await startOmpHost();
  const capabilities = ["handshake", ...(DEBUG ? ["debug.logStdout"] : [])];
  const handlers: Handlers = {
    handshake: async (): Promise<HandshakeResult> => ({
      sidecarVersion: SIDECAR_VERSION,
      ompVersion: host.ompVersion,
      capabilities,
    }),
  };
  if (DEBUG) {
    handlers["debug.logStdout"] = async ({ marker }) => {
      process.stdout.write(`${marker} process.stdout.write\n`);
      console.log(`${marker} console.log`);
      writeSync(1, `${marker} fd1\n`);
      return { writes: 3 };
    };
  }

  const server = startServer(socketPath, handlers);
  console.error(
    `[sidecar] ready: sidecar ${SIDECAR_VERSION}, omp ${host.ompVersion}, socket ${socketPath}`,
  );

  const shutdown = async (reason: string): Promise<never> => {
    console.error(`[sidecar] exiting: ${reason}`);
    server.stop();
    await host.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // The app is gone when its connection drops or when it stops being our parent (crash).
  void server.idle.then(() => shutdown("client disconnected"));
  setInterval(() => {
    if (process.ppid !== parentPid) void shutdown("parent process exited");
  }, 1000);
}

main().catch((error) => {
  console.error(
    `[sidecar] fatal: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
  );
  process.exit(1);
});
