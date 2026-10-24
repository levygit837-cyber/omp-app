/**
 * Stand-in for the sidecar, to exercise the supervisor's lifecycle without booting omp.
 * Behaviour is chosen by FAKE_SIDECAR: `ok` (default), `slow` (listens after 600 ms),
 * `silent` (listens, never answers), `read-only` (reports a newer schema on disk), `old-protocol` (answers with another protocolVersion).
 */

import {
  decodeFrame,
  encodeFrame,
  FrameDecoder,
  isRequestEnvelope,
  okResponse,
  PROTOCOL_VERSION,
} from "@omp-app/protocol";

const mode = process.env.FAKE_SIDECAR ?? "ok";
const socketPath = process.argv.find((a) => a.startsWith("--socket="))?.slice("--socket=".length);
if (!socketPath) throw new Error("missing --socket");

if (mode === "slow") await Bun.sleep(600);

const decoder = new FrameDecoder();
Bun.listen({
  unix: socketPath,
  socket: {
    data(socket, chunk) {
      if (mode === "silent") return;
      for (const line of decoder.push(new TextDecoder().decode(chunk))) {
        const frame = decodeFrame(line);
        if (!frame.ok || !isRequestEnvelope(frame.envelope)) continue;
        socket.write(
          encodeFrame(
            okResponse(frame.envelope.id, {
              protocolVersion: mode === "old-protocol" ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION,
              sidecarVersion: "fake",
              ompVersion: "fake-omp",
              capabilities: ["handshake"],
              mode: mode === "read-only" ? "read_only" : "normal",
              ...(mode === "read-only" ? { schema: { onDisk: 7, expected: 6 } } : {}),
            }),
          ),
        );
      }
    },
  },
});
console.error(`[fake-sidecar] ${mode} listening`);
