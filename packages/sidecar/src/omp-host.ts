import { homedir } from "node:os";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpConnection } from "@oh-my-pi/pi-coding-agent/modes/acp";
import type { AcpSessionFactory } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-mode";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { ensureTheme } from "@oh-my-pi/pi-tui/theme";
import {
  type AnyMessage,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Stream,
} from "@oh-my-pi/pi-utils/acp";

export interface OmpHostOptions {
  /**
   * Called inside session creation, before `createSession` resolves and before any prompt can
   * run, so a subscriber never misses the first event.
   */
  readonly onSessionCreated: (session: AgentSession) => void;
}

export interface OmpHost {
  /** Version reported by the hosted omp in its ACP `initialize` response. */
  readonly ompVersion: string;
  /** Creates a file-backed session in the shared omp session directory; returns its id. */
  createSession(cwd: string): Promise<string>;
  /** Resolves when the turn ends (answered, cancelled or failed) with ACP's stop reason. */
  prompt(sessionId: string, text: string): Promise<string>;
  /** Stops the session's running turn; resolves once it has unwound. */
  cancel(sessionId: string): Promise<void>;
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
 * Starts the omp control engine in this process. Sessions are created by a factory handed to
 * the in-process `AcpAgent`, which keeps ACP's prompt queue, steering and cancel machinery
 * between the app and the `AgentSession`. The timeline never comes from ACP: it comes from
 * `AgentSession.subscribe`, wired by `onSessionCreated`.
 *
 * Settings, credentials and the model registry are shared with the CLI (`~/.omp`), and
 * sessions use the default `SessionManager`, so they land where the CLI writes its own.
 *
 * Opening them touches `agent.db`, so it waits for the first session: a sidecar in `read_only`
 * mode refuses `session.create` before it gets here and never writes to a newer database.
 */
export async function startOmpHost(options: OmpHostOptions): Promise<OmpHost> {
  await ensureTheme();

  interface OmpContext {
    readonly settings: Settings;
    readonly authStorage: AuthStorage;
    readonly modelRegistry: ModelRegistry;
  }
  let context: Promise<OmpContext> | undefined;
  const openContext = (): Promise<OmpContext> => {
    context ??= (async () => {
      // Global settings only; each session clones them for its own cwd.
      const settings = await Settings.init({ cwd: homedir() });
      const authStorage = await discoverAuthStorage(undefined, { settings });
      const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
      await modelRegistry.refresh("offline");
      return { settings, authStorage, modelRegistry };
    })().catch((error: unknown) => {
      context = undefined; // let the next session retry
      throw error;
    });
    return context;
  };

  const factory: AcpSessionFactory = async (cwd, factoryOptions) => {
    const { settings, authStorage, modelRegistry } = await openContext();
    const sessionSettings = await settings.cloneForCwd(cwd);
    const sessionManager = SessionManager.create(cwd);
    const { session, setToolUIContext } = await createAgentSession({
      cwd,
      sessionManager,
      settings: sessionSettings,
      authStorage,
      modelRegistry,
      agentId: `acp:${sessionManager.getSessionId()}`,
      interactivePrompts: factoryOptions?.interactivePrompts,
      deferUsageReserveConfirmation: true,
      enableMCP: false,
      eventBus: new EventBus(),
      subagentEventBus: new EventBus(),
    });
    options.onSessionCreated(session);
    return { session, setToolUIContext };
  };

  const transport = createMemoryTransport();
  createAcpConnection(transport.agent, factory);
  const client = new ClientSideConnection(
    () => ({
      // Real permission and elicitation handling is a later ticket. Until then the safe answer
      // is "no", and it is logged so a silent refusal never looks like a hang.
      requestPermission: (params) => {
        console.error(
          `[sidecar] permission request cancelled: ${params.toolCall.title ?? params.toolCall.toolCallId}`,
        );
        return { outcome: { outcome: "cancelled" } };
      },
      unstable_createElicitation: (params) => {
        console.error(`[sidecar] elicitation cancelled: ${params.message}`);
        return { action: "cancel" };
      },
      // The timeline comes from AgentSession.subscribe, not from ACP updates.
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
    async createSession(cwd) {
      const created = await client.newSession({ cwd, mcpServers: [] });
      return created.sessionId;
    },
    async prompt(sessionId, text) {
      const result = await client.prompt({ sessionId, prompt: [{ type: "text", text }] });
      return result.stopReason;
    },
    cancel: (sessionId) => client.cancel({ sessionId }),
    close: async () => {
      await transport.client.writable.close().catch(() => {});
    },
  };
}
