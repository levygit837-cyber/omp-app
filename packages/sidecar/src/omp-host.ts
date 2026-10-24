import { createAcpConnection } from "@oh-my-pi/pi-coding-agent/modes/acp";
import { ensureTheme } from "@oh-my-pi/pi-tui/theme";
import {
  type AnyMessage,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Stream,
} from "@oh-my-pi/pi-utils/acp";

export interface OmpHost {
  /** Version reported by the hosted omp in its ACP `initialize` response. */
  readonly ompVersion: string;
  /** Closes the in-memory transport; the AcpAgent disposes itself when it sees the close. */
  close(): Promise<void>;
}

/** Two cross-wired in-memory streams: what one end writes, the other reads. */
function createMemoryTransport(): { agent: Stream; client: Stream } {
  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>();
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>();
  return {
    agent: { readable: clientToAgent.readable, writable: agentToClient.writable },
    client: { readable: agentToClient.readable, writable: clientToAgent.writable },
  };
}

/**
 * Starts the omp control engine in this process: the `ask` tool reads the theme, so it is
 * initialised first; then an `AcpAgent` is served over an in-memory transport and initialised
 * once through a client connection. Sessions are out of scope: creating one is refused.
 */
export async function startOmpHost(): Promise<OmpHost> {
  await ensureTheme();

  const transport = createMemoryTransport();
  createAcpConnection(transport.agent, async () => {
    throw new Error("sessions are not available in this sidecar build");
  });
  const client = new ClientSideConnection(
    () => ({
      requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: () => {},
    }),
    transport.client,
  );

  const init = await client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const ompVersion = init.agentInfo?.version;
  if (!ompVersion) throw new Error("omp ACP initialize returned no agentInfo.version");

  return {
    ompVersion,
    close: async () => {
      await transport.client.writable.close().catch(() => {});
    },
  };
}
