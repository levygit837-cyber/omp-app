import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  clearPluginRootsAndCaches,
  resolveActiveProjectRegistryPath,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { createAcpConnection } from "@oh-my-pi/pi-coding-agent/modes/acp";
import type { AcpSessionFactory } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-mode";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { refreshAgentDiscovery } from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { ensureTheme } from "@oh-my-pi/pi-tui/theme";
import {
  type AnyMessage,
  ClientSideConnection,
  type McpServer,
  PROTOCOL_VERSION,
  type Stream,
} from "@oh-my-pi/pi-utils/acp";
import {
  ACTION_BUSY_MESSAGE,
  ACTION_COMMAND_MESSAGE,
  ACTION_SHELL_MESSAGE,
  CONFIRM_REQUIRED_MESSAGE,
  type CommandItem,
  type Delivery,
  FILE_OWNED_MESSAGE,
  type ModelOption,
  type PauseState,
  type PromptImage,
  type QueueName,
  SESSION_BUSY_MESSAGE,
  type StoredSession,
  UNKNOWN_SESSION_MESSAGE,
} from "@omp-app/protocol";
import { gatedPromptLine, listBuiltinCommands } from "./command-catalog";
import { COMMAND_ENTRY_TYPE, readResetBoundaries, storedCommandOf } from "./command-entries";
import type { CommandControl } from "./command-runner";
import { readContextFill } from "./context-fill";
import { parseMcpFailure, resolveMcpServers } from "./mcp-config";
import { countPersistedSubagents } from "./persisted-subagents";
import type { RequestRegistry } from "./request-registry";
import { findStoredSession, listStoredSessions } from "./session-catalog";
import type { ClearedState } from "./session-store";
import { todoPhases } from "./tool-output";

/** omp refuses the plan mode while its `plan.enabled` setting is off (acp-agent.ts:2236-2239 [V]). */
const PLAN_MODE_OFF = /^Unsupported ACP mode: plan/;

export interface OmpHostOptions {
  /** Holds what the agent is blocked on (permissions, ask forms) until a person answers. */
  readonly requests: Pick<RequestRegistry, "permission" | "elicitation">;
  /**
   * Called once per opened session (new, resumed or forked) before the call that opened it
   * resolves and before any prompt can run, so a subscriber never misses the first event.
   */
  readonly onSessionCreated: (session: AgentSession, subagentBus: EventBus) => void;
  /** An MCP server failed to connect for this session. The session carries on without it. */
  readonly onMcpFailure: (sessionId: string, server: string, message: string) => void;
  /**
   * Runs every tool without asking (`createAgentSession`'s `autoApprove`, `sdk.ts:947` [V]).
   * Only the recording script sets it, so a recorded run executes shell calls that the ACP
   * permission gate would otherwise hold back. The app never does.
   */
  readonly autoApprove?: boolean;
}

export interface OmpHost extends CommandControl {
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
  prompt(sessionId: string, text: string, images?: readonly PromptImage[]): Promise<string>;
  /**
   * Hands a prompt to the turn that is running. Resolves true when the turn took it (`steer`
   * injects it at the next model call, `followUp` queues it for after the turn). False when no
   * turn the app started is running, which is the caller's cue to start one with `prompt`: an
   * idle session, an autonomous run nobody watches, or a turn being cancelled
   * (`joinActiveTurn`, `agent-session.ts:8896-8960` [V]).
   */
  join(
    sessionId: string,
    text: string,
    images: readonly PromptImage[],
    delivery: Delivery,
  ): Promise<boolean>;
  /** Models with credentials, as `getAvailableModels()` lists them (`model-controls.ts:502` [V]). */
  models(sessionId: string): ModelOption[];
  /** Switches the model for the next turn. Refused while a turn runs. */
  setModel(sessionId: string, model: string): Promise<void>;
  /** `auto`, `off` or a level the active model accepts. Refused while a turn runs. */
  setThinking(sessionId: string, level: string): void;
  /** `removeQueuedMessage` (`agent-session.ts:9971` [V]): false once the message left the queue. */
  removeQueued(sessionId: string, queue: QueueName, text: string): boolean;
  /** Working folder of an open session. */
  cwdOf(sessionId: string): string;
  /**
   * Asks the session to stop its running turn. ACP's `session/cancel` is a notification: this
   * resolves once it is sent, not once the turn has unwound. The stop shows up as ops
   * (`item.done`, `status.set` idle), and the pending `prompt` settles with `cancelled`.
   */
  cancel(sessionId: string): Promise<void>;
  /** The builtins omp runs without a terminal, with what the palette needs to show them. */
  commands(): ReturnType<typeof listBuiltinCommands>;
  /**
   * Switches omp's ACP mode of an open session to `plan` or `default`. It is the path that
   * installs the proposal handler, which plan mode needs to ask for approval (see `PlanControl`).
   * Fails with omp's `Unsupported ACP mode: plan` when the `plan.enabled` setting is off.
   */
  setPlanMode(sessionId: string, enabled: boolean): Promise<void>;
  /** Closes the in-memory transport; the AcpAgent disposes itself when it sees the close. */
  close(): Promise<void>;
  /**
   * The process-wide global settings every session clones. Opening them touches `agent.db`, so
   * only call this where a write is allowed.
   */
  globalSettings(): Promise<Settings>;
  /** The settings clone of every open session, for reloading after a config write. */
  liveSessionSettings(): readonly Settings[];
  /**
   * Drops the agent's memory and keeps the session (omp's `resetSessionContext`). Refused with the
   * `ACTION_*` sentences while a turn, a shell command or a compaction runs. Answers with what the
   * view must take over from omp afterwards.
   */
  clearContext(sessionId: string): Promise<{ dropped: number; cleared: ClearedState }>;
  /** Persisted subagent sessions that `deleteSession` removes with the session. */
  deletePreview(sessionId: string): Promise<number>;
  /**
   * Closes the session and removes its file, its artifacts and its subagent transcripts. Refused
   * with `FILE_OWNED_MESSAGE` while another omp process owns the file. Resolves with the number
   * of subagent sessions removed. `beforeClose` runs once the lease is held and the session is about
   * to close, so what a refusal must leave alone is touched only after the refusals.
   */
  deleteSession(sessionId: string, beforeClose: () => void): Promise<number>;
  /** Whether omp's process-wide pause gate is engaged. */
  pauseState(): PauseState;
  /** Engages or releases the gate, which freezes (or releases) every agent loop of the process. */
  setPaused(paused: boolean): PauseState;
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
  /** The bus the session's subagents publish their frames on; `AgentSession` exposes no getter. */
  const busOf = new WeakMap<AgentSession, EventBus>();
  const factory: AcpSessionFactory = async (cwd, factoryOptions) => {
    const { settings, authStorage, modelRegistry } = await openContext();
    const sessionSettings = await settings.cloneForCwd(cwd);
    const sessionManager = SessionManager.create(cwd);
    const subagentEventBus = new EventBus();
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
      subagentEventBus,
    });
    cloneOf.set(session, sessionSettings);
    busOf.set(session, subagentEventBus);
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
  /** The open sessions by ACP key: the controls that ACP does not carry go straight to them. */
  const sessions = new Map<string, AgentSession>();
  const sessionOf = (sessionId: string): AgentSession => {
    const session = sessions.get(keyOf(sessionId));
    if (!session) throw new Error(`${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`);
    return session;
  };
  const idle = (session: AgentSession): void => {
    if (session.isStreaming) throw new Error(SESSION_BUSY_MESSAGE);
  };
  const followMoves = (session: AgentSession, key: string): void => {
    // The manager's id is the session's identity. `session.sessionId` is the provider session id,
    // which `/fresh` replaces without moving anything (`agent-session.ts:6245-6259` [V]).
    let current = session.sessionManager.getSessionId();
    // A move that already happened (omp replays past notices on subscribe) shows as an id that
    // differs from ACP's key.
    if (current !== key) moved.set(current, key);
    session.sessionManager.onPersistenceNotice(() => {
      const next = session.sessionManager.getSessionId();
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
      sessions.set(key, session);
      const bus = busOf.get(session);
      if (!bus) throw new Error("omp built a session without the subagent bus the factory set");
      options.onSessionCreated(session, bus);
      followMoves(session, key);
      // The session's own id: it differs from ACP's key when omp moved it while opening.
      return session.sessionManager.getSessionId();
    });

  /**
   * Every open session reads its own clone of the settings (`cloneOf`). A builtin writes through
   * its session's clone (`/browser visible`, `omp-host` `settings: session.settings`): save it,
   * then make the other clones take what is on disk, as `settings.set` does.
   */
  const shareSettingsWrites = async (written: Settings): Promise<void> => {
    await written.flush();
    for (const settings of liveSettings.values()) {
      if (settings === written) continue;
      try {
        await settings.reloadFromDisk();
      } catch (error) {
        console.error(
          `[sidecar] settings reload failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  };

  /** Closes one session in ACP and forgets everything the host keeps for it. Run inside `exclusive`. */
  const closeKey = async (sessionId: string): Promise<void> => {
    const key = keyOf(sessionId);
    await client.closeSession({ sessionId: key });
    liveSettings.delete(key);
    sessions.delete(key);
    moved.delete(sessionId);
  };

  const pauseStateOf = (): PauseState => {
    const since = agentPauseGate.pausedAt;
    return since === undefined ? { paused: false } : { paused: true, since };
  };

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
    closeSession: (sessionId) => exclusive(() => closeKey(sessionId)),
    async prompt(sessionId, text, images = []) {
      // The one door to ACP's builtin dispatch: `session.prompt` (the composer) and the text a
      // builtin hands back both come here, and a gated builtin only starts through
      // `session.runCommand` with the person's answer.
      const gated = gatedPromptLine(text);
      if (gated !== null) throw new Error(`${CONFIRM_REQUIRED_MESSAGE}: ${gated}`);
      const result = await client.prompt({
        sessionId: keyOf(sessionId),
        prompt: [
          ...(text === "" ? [] : [{ type: "text" as const, text }]),
          ...images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
      });
      return result.stopReason;
    },
    join: (sessionId, text, images, delivery) =>
      sessionOf(sessionId).joinActiveTurn(
        text,
        images.map((image) => ({ type: "image" as const, ...image })),
        { queue: delivery === "followUp" ? "followUp" : "steering" },
      ),
    models: (sessionId) =>
      sessionOf(sessionId)
        .getAvailableModels()
        .map((model) => ({
          id: `${model.provider}/${model.id}`,
          provider: model.provider,
          name: model.name,
          // `getSupportedEfforts` (`pi-catalog/model-thinking.ts:23` [V]), read from the model.
          efforts: model.reasoning ? [...(model.thinking?.efforts ?? [])] : [],
        })),
    async setModel(sessionId, id) {
      const session = sessionOf(sessionId);
      idle(session);
      const model = session.getAvailableModels().find((m) => `${m.provider}/${m.id}` === id);
      if (!model) throw new Error(`unknown model: ${id}`);
      // Like ACP's `#setModelById`: appends a `model_change` to the session file and leaves the
      // global default alone (only `persist: true` writes settings).
      await session.setModel(model);
    },
    setThinking(sessionId, level) {
      const session = sessionOf(sessionId);
      idle(session);
      const accepted: readonly string[] = ["off", "auto", ...session.getAvailableThinkingLevels()];
      if (!accepted.includes(level)) throw new Error(`unknown thinking level: ${level}`);
      session.setThinkingLevel(level as Parameters<AgentSession["setThinkingLevel"]>[0]);
    },
    removeQueued: (sessionId, queue, text) => sessionOf(sessionId).removeQueuedMessage(text, queue),
    cwdOf: (sessionId) => sessionOf(sessionId).sessionManager.getCwd(),
    cancel: (sessionId) => client.cancel({ sessionId: keyOf(sessionId) }),
    commands: listBuiltinCommands,
    async clearContext(sessionId) {
      const session = sessionOf(sessionId);
      // Same refusals as `resetSessionContext`, which returns undefined without touching anything
      // while a response streams or a foreground shell runs (`agent-session.ts:6279-6283` [V]),
      // said in a sentence. A running compaction or handoff would write its result after the
      // boundary, so it is refused too (the TUI aborts it first, `command-controller.ts:1350` [V]).
      if (session.isStreaming) throw new Error(ACTION_BUSY_MESSAGE);
      if (session.isBashRunning || session.isEvalRunning) throw new Error(ACTION_SHELL_MESSAGE);
      if (session.isCompacting) throw new Error(ACTION_COMMAND_MESSAGE);
      const result = await session.resetSessionContext();
      if (!result) throw new Error(ACTION_BUSY_MESSAGE);
      const manager = session.sessionManager;
      return {
        dropped: result.droppedCount,
        cleared: {
          at: readResetBoundaries(manager.getBranch()).at(-1) ?? Date.now(),
          context: readContextFill(session),
          queue: session.getQueuedMessages(),
          // omp keeps its todo list across a reset (`resetSessionContext` never touches it), so
          // the view shows what omp holds, not an empty list.
          todo: todoPhases({ phases: session.getTodoPhases() }) ?? [],
        },
      };
    },
    async deletePreview(sessionId) {
      const file = sessionOf(sessionId).sessionManager.getSessionFile();
      return file === undefined ? 0 : await countPersistedSubagents(file);
    },
    deleteSession: (sessionId, beforeClose) =>
      exclusive(async () => {
        const manager = sessionOf(sessionId).sessionManager;
        const file = manager.getSessionFile();
        // A session that never wrote has no file: closing it is all there is to delete.
        const onDisk = file !== undefined && manager.isSessionOnDisk();
        const storage = new FileSessionStorage();
        // The ownership lease, taken the way the session manager takes it for its first write
        // (`session-storage.ts:1292` [V]): null while another live omp process holds the session
        // (typically the CLI), and re-entrant for this process, which holds it itself once it has
        // written. Kept until the files are gone, so nobody claims the session in between.
        const lease = onDisk ? storage.claimSession(manager.getSessionId(), file) : undefined;
        if (lease === null) throw new Error(FILE_OWNED_MESSAGE);
        try {
          const subagents = onDisk ? await countPersistedSubagents(file) : 0;
          beforeClose();
          // Closed before the files go: closing flushes the writer, and a write after the delete
          // would bring the file back (part 1 hit this with `saveCommand`).
          await closeKey(sessionId);
          if (onDisk) {
            try {
              await storage.deleteSessionWithArtifacts(file);
            } catch (error) {
              if ((error as { code?: unknown } | null)?.code !== "ENOENT") throw error;
            }
          }
          return subagents;
        } finally {
          lease?.();
        }
      }),
    pauseState: () => pauseStateOf(),
    setPaused(paused) {
      if (paused) agentPauseGate.pause();
      else agentPauseGate.resume();
      return pauseStateOf();
    },
    async runCommand(sessionId, text, output, signal) {
      const session = sessionOf(sessionId);
      // Called directly, not through `session/prompt`: a prompt cancels the running turn
      // (`acp-agent.ts:1014-1034` [V]) and builtins must not. This is the runtime the ACP agent
      // builds (`acp-agent.ts:1195-1250` [V]) minus what only exists on its connection:
      // `output` is the timeline instead of `sessionUpdate`, and the title and config pushes
      // are not needed because the model comes from `model_changed` and titles from the catalog.
      const result = await executeAcpBuiltinSlashCommand(text, {
        session,
        sessionManager: session.sessionManager,
        settings: session.settings,
        cwd: session.sessionManager.getCwd(),
        signal,
        output,
        refreshCommands: () => {},
        reloadPlugins: async () => {
          const cwd = session.sessionManager.getCwd();
          const projectPath = await resolveActiveProjectRegistryPath(cwd);
          clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
          await refreshAgentDiscovery(cwd, session.effectiveExtensionRoots);
          await session.refreshSkillsAndCommands();
        },
      });
      if (result === false) throw new Error("not a builtin");
      await shareSettingsWrites(session.settings);
      return "prompt" in result ? { prompt: result.prompt } : { failed: result.failed === true };
    },
    saveCommand(sessionId, command: CommandItem) {
      const manager = sessionOf(sessionId).sessionManager;
      // `/session delete` removes the file while the session stays open; an append now would
      // write it back (`session-manager.ts:2432-2439`, `3179-3181` [V]).
      if (!manager.isSessionOnDisk()) return;
      manager.appendCustomEntry(COMMAND_ENTRY_TYPE, storedCommandOf(command));
    },
    async setPlanMode(sessionId, enabled) {
      try {
        await client.setSessionMode({
          sessionId: keyOf(sessionId),
          modeId: enabled ? "plan" : "default",
        });
      } catch (error) {
        // The ACP layer answers a thrown error with "Internal error" and keeps omp's own message in
        // `data.details` (pi-utils acp/transport.ts:330 [V]). Only the one the window has a
        // sentence for is passed on; any other failure stays as generic as omp made it.
        const details = (error as { data?: { details?: unknown } } | null)?.data?.details;
        throw typeof details === "string" && PLAN_MODE_OFF.test(details)
          ? new Error(details)
          : error;
      }
    },
    close: async () => {
      await transport.client.writable.close().catch(() => {});
    },
  };
}
