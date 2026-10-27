import "./stdio";
import { writeSync } from "node:fs";
import { type HandshakeResult, PROTOCOL_VERSION } from "@omp-app/protocol";
import { startOmpHost } from "./omp-host";
import { RequestRegistry } from "./request-registry";
import { AgentDbUnreadableError, checkSchema } from "./schema-guard";
import { type Handlers, startServer } from "./server";
import { attachSession } from "./session-bridge";
import { SESSION_CAPABILITIES, sessionHandlers } from "./session-handlers";
import { SessionStore } from "./session-store";
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

  // Before omp opens the agent database: omp only warns about a newer schema, then writes.
  const guard = checkSchema();
  const store = new SessionStore();
  const requests = new RequestRegistry(store);
  const host = await startOmpHost({
    requests,
    onSessionCreated: (session) => attachSession(store, session, requests),
    onMcpFailure: (sessionId, server, message) => {
      if (store.has(sessionId)) store.warn(sessionId, { source: "mcp", server, message });
    },
  });
  const capabilities = [
    "handshake",
    ...SESSION_CAPABILITIES,
    ...(DEBUG ? ["debug.logStdout", "debug.write"] : []),
  ];
  const handlers: Handlers = {
    handshake: async (): Promise<HandshakeResult> => ({
      protocolVersion: PROTOCOL_VERSION,
      sidecarVersion: SIDECAR_VERSION,
      ompVersion: host.ompVersion,
      capabilities,
      mode: guard.mode,
      ...(guard.mode === "read_only" ? { schema: guard.schema } : {}),
    }),
    ...sessionHandlers(host, store, requests),
  };
  if (DEBUG) {
    handlers["debug.logStdout"] = async ({ marker }) => {
      process.stdout.write(`${marker} process.stdout.write\n`);
      console.log(`${marker} console.log`);
      writeSync(1, `${marker} fd1\n`);
      return { writes: 3 };
    };
    handlers["debug.write"] = async () => ({ wrote: true });
  }

  const server = startServer(socketPath, handlers, guard.mode === "read_only", {
    onClientClosed: (client) => store.unsubscribeAll(client),
  });
  console.error(
    `[sidecar] ready: sidecar ${SIDECAR_VERSION}, omp ${host.ompVersion}, mode ${guard.mode}, socket ${socketPath}`,
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
  if (error instanceof AgentDbUnreadableError) {
    console.error(`[sidecar] fatal: ${error.message}`);
    process.exit(1);
  }
  console.error(
    `[sidecar] fatal: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
  );
  process.exit(1);
});
