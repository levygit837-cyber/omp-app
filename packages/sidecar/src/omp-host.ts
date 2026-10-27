import { stat } from "node:fs/promises";
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
  type McpServer,
  PROTOCOL_VERSION,
  type Stream,
} from "@oh-my-pi/pi-utils/acp";
import type { StoredSession } from "@omp-app/protocol";
import { parseMcpFailure, resolveMcpServers } from "./mcp-config";
import type { RequestRegistry } from "./request-registry";
import { findStoredSession, listStoredSessions } from "./session-catalog";

export interface OmpHostOptions {
  /** Holds what the agent is blocked on (permissions, ask forms) until a person answers. */
  readonly requests: Pick<RequestRegistry, "permission" | "elicitation">;
  /**
   * Called once per opened session (new, resumed or forked) before the call that opened it
   * resolves and before any prompt can run, so a subscriber never misses the first event.
   */
  readonly onSessionCreated: (session: AgentSession) => void;
  /** An MCP server failed to connect for this session. The session carries on without it. */
  readonly onMcpFailure: (sessionId: string, server: string, message: string) => void;
  /**
   * Runs every tool without asking (`createAgentSession`'s `autoApprove`, `sdk.ts:947` [V]).
   * Only the recording script sets it, so a recorded run executes shell calls that the ACP
   * permission gate would otherwise hold back. The app never does.
   */
  readonly autoApprove?: boolean;
}

export interface OmpHost {
  /** Version reported by the hosted omp in its ACP `initialize` response. */
  readonly ompVersion: string;
  /** Sessions on disk, as the CLI picker lists them. Never touches `agent.db`. */
  list(): Promise<StoredSession[]>;
  /** Creates a file-backed session in the shared omp session directory; returns its id. */
  createSession(cwd: string): Promise<string>;
  /**
   * Opens a stored session with its history. Fails with `folder no longer exists: <path>` when
   * the session's folder is gone: omp would open it anyway and run in a path that is not there.
   */
  resumeSession(sessionId: string): Promise<string>;
  /** Opens a copy of a stored session, as it is on disk now; returns the copy's id. Same folder rule. */
  forkSession(sessionId: string): Promise<string>;
  /** Disposes the in-memory session (stopping a running turn). The file stays on disk. */
  closeSession(sessionId: string): Promise<void>;
  /** Resolves when the turn ends (answered, cancelled or failed) with ACP's stop reason. */
  prompt(sessionId: string, text: string): Promise<string>;
  /**
   * Asks the session to stop its running turn. ACP's `session/cancel` is a notification: this
   * resolves once it is sent, not once the turn has unwound. The stop shows up as ops
   * (`item.done`, `status.set` idle), and the pending `prompt` settles with `cancelled`.
   */
  cancel(sessionId: string): Promise<void>;
  /** Closes the in-memory transport; the AcpAgent disposes itself when it sees the close. */
  close(): Promise<void>;
  /**
   * The process-wide global settings every session clones. Opening them touches `agent.db`, so
   * only call this where a write is allowed.
   */
  globalSettings(): Promise<Settings>;
  /** The settings clone of every open session, for reloading after a config write. */
  liveSessionSettings(): readonly Settings[];
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

  /** The session the factory built during the current `open` call. */
  let built: AgentSession | undefined;
  /** Reads and clears {@link built}. A function, so TypeScript sees the factory's write. */
  const takeBuilt = (): AgentSession | undefined => {
    const session = built;
    built = undefined;
    return session;
  };
  /**
   * The settings clone of every open session, by the key ACP registered it under. `cloneForCwd`
   * copies the global layer, so a config write must reach each clone. The ACP key survives a
   * move to a new file (see `moved` below), so a moved session keeps being reloaded under it,
   * and `closeSession` drops the clone with the session.
   */
  const liveSettings = new Map<string, Settings>();
  /** The clone the factory made for a session, until `open` registers both under the key. */
  const cloneOf = new WeakMap<AgentSession, Settings>();
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
      autoApprove: options.autoApprove === true,
      enableMCP: false,
      eventBus: new EventBus(),
      subagentEventBus: new EventBus(),
    });
    cloneOf.set(session, sessionSettings);
    built = session;
    return { session, setToolUIContext };
  };

  /** Folder and MCP servers a stored session needs to be opened (ACP wants both with the id). */
  const storedSessionContext = async (
    sessionId: string,
  ): Promise<{ cwd: string; mcpServers: McpServer[] }> => {
    const stored = await findStoredSession(sessionId);
    if (!stored) throw new Error(`session not found: ${sessionId}`);
    if (
      !(await stat(stored.cwd).then(
        (info) => info.isDirectory(),
        () => false,
      ))
    )
      throw new Error(`folder no longer exists: ${stored.cwd}`);
    const { settings } = await openContext();
    return {
      cwd: stored.cwd,
      mcpServers: await resolveMcpServers(stored.cwd, await settings.cloneForCwd(stored.cwd)),
    };
  };

  const transport = createMemoryTransport();
  createAcpConnection(transport.agent, factory);
  const client = new ClientSideConnection(
    () => ({
      // Both wait for a person. The promise stays open while the request is pending; the signal
      // fires when omp withdraws it (`$/cancel_request`, sent when the user steers).
      requestPermission: (params, extra) => options.requests.permission(params, extra?.signal),
      unstable_createElicitation: (params) => options.requests.elicitation(params),
      // The timeline comes from AgentSession.subscribe, not from ACP updates. The one exception
      // is omp's notice that an MCP server did not connect: it exists nowhere else.
      sessionUpdate: (params) => {
        const update = params.update;
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text")
          return;
        const failure = parseMcpFailure(update.content.text);
        if (failure) options.onMcpFailure(params.sessionId, failure.server, failure.message);
      },
    }),
    transport.client,
  );

  const init = await client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    // Without `elicitation.form` omp answers every `ask` itself with "no answer"
    // (`acp-agent.ts:622`), so the form capability is what lets the agent ask at all.
    clientCapabilities: { elicitation: { form: {} } },
  });
  const ompVersion = init.agentInfo?.version;
  if (!ompVersion) throw new Error("omp ACP initialize returned no agentInfo.version");

  /**
   * ACP keeps a session under the id it was registered with. When omp moves a session to a new
   * file (another process owns the old one) the session gets a new id, but ACP's key stays: this
   * maps the current id to that key for the sessions that moved.
   */
  const moved = new Map<string, string>();
  const keyOf = (sessionId: string): string => moved.get(sessionId) ?? sessionId;
  const followMoves = (session: AgentSession, key: string): void => {
    let current = session.sessionId;
    // A move that already happened (omp replays past notices on subscribe) shows as an id that
    // differs from ACP's key.
    if (current !== key) moved.set(current, key);
    session.sessionManager.onPersistenceNotice(() => {
      const next = session.sessionId;
      if (next === current) return;
      moved.delete(current);
      moved.set(next, key);
      current = next;
    });
  };

  /**
   * Everything that changes which sessions are open runs one at a time, in call order: opening
   * relies on "the session the factory just built" being unambiguous, and a close must not
   * interleave with a resume of the same session.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  };

  /**
   * Runs one ACP call that may build a session and registers that session once its final id
   * is known. Resume and fork build a blank session in the factory and then switch it to the
   * stored file, which changes its id, so registering from the factory would use the wrong
   * one. No prompt can reach a session before this returns its id, so no event is missed.
   */
  const open = (call: () => Promise<string>): Promise<string> =>
    exclusive(async () => {
      takeBuilt();
      const key = await call();
      const session = takeBuilt();
      if (!session) return key;
      const clone = cloneOf.get(session);
      if (clone) liveSettings.set(key, clone);
      options.onSessionCreated(session);
      followMoves(session, key);
      // The session's own id: it differs from ACP's key when omp moved it while opening.
      return session.sessionId;
    });

  return {
    ompVersion,
    globalSettings: async () => (await openContext()).settings,
    liveSessionSettings: () => [...liveSettings.values()],
    list: listStoredSessions,
    createSession: (cwd) =>
      open(async () => {
        // omp ignores MCP config on disk in ACP sessions; the servers travel in the request.
        const { settings } = await openContext();
        const mcpServers = await resolveMcpServers(cwd, await settings.cloneForCwd(cwd));
        return (await client.newSession({ cwd, mcpServers })).sessionId;
      }),
    resumeSession: (sessionId) =>
      open(async () => {
        const { cwd, mcpServers } = await storedSessionContext(sessionId);
        // ACP registers a resumed session under the id it was asked for.
        await client.resumeSession({ sessionId, cwd, mcpServers });
        return sessionId;
      }),
    forkSession: (sessionId) =>
      open(async () => {
        const { cwd, mcpServers } = await storedSessionContext(sessionId);
        return (await client.unstable_forkSession({ sessionId, cwd, mcpServers })).sessionId;
      }),
    closeSession: (sessionId) =>
      exclusive(async () => {
        const key = keyOf(sessionId);
        await client.closeSession({ sessionId: key });
        liveSettings.delete(key);
        moved.delete(sessionId);
      }),
    async prompt(sessionId, text) {
      const result = await client.prompt({
        sessionId: keyOf(sessionId),
        prompt: [{ type: "text", text }],
      });
      return result.stopReason;
    },
    cancel: (sessionId) => client.cancel({ sessionId: keyOf(sessionId) }),
    close: async () => {
      await transport.client.writable.close().catch(() => {});
    },
  };
}
