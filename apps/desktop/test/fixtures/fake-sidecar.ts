/**
 * Stand-in for the sidecar, to exercise the supervisor's lifecycle and the UI without booting omp.
 * Behaviour is chosen by FAKE_SIDECAR: `ok` (default), `slow` (listens after 600 ms),
 * `silent` (listens, never answers), `read-only` (reports a newer schema on disk; refuses
 * `session.create|resume|fork`), `old-protocol` (answers with another protocolVersion).
 *
 * Every mode except `silent` also serves
 * `session.create|list|resume|fork|close|subscribe|unsubscribe|prompt|cancel|commands|runCommand`
 * with in-memory sessions (`fake-<n>`) whose state is kept with `applyOp`, so snapshots match
 * the `session.op` stream. A prompt runs a scripted turn. Knobs, all optional:
 * - FAKE_REPLY: reply text of a turn (default: a short English paragraph).
 * - FAKE_CHUNK_MS: delay between reply chunks of ~12 chars (default 30).
 * - FAKE_HOLD=1: stop halfway through the reply and stay `streaming` until `session.cancel`.
 * - FAKE_FAIL=1: after the first chunks, set the status to `failed` ("fake failure").
 * - FAKE_ITEMS=<n>: preload n done timeline items at create, alternating user/assistant, of
 *   varied length (one-liners, multi-paragraph, ~1500 chars). Deterministic.
 * - FAKE_MIXED=1: with FAKE_ITEMS, preload a mixed timeline (reasoning, tools, diffs, markdown) instead.
 * - FAKE_MIXED=states: preload one of each state a live omp cannot produce on demand.
 * - FAKE_MODEL: model of new sessions (default anthropic/claude-opus-5-5).
 * - FAKE_WARN=1: emit one MCP `warning.add` right after the first subscribe of each session.
 * - FAKE_REQUEST=permission|ask|form|queue: halfway through the reply, raise that request and
 *   wait for its answer (see fake-requests.ts). Also serves `session.answerPermission|answerAsk`.
 * - FAKE_COMMAND_MS: how long a command runs before it prints (default 40).
 * - FAKE_COMMAND_HOLD=1: a command stays `running` until `session.cancel` (then `stopped`).
 * - FAKE_STORED=<n>: n sessions "on disk" (`stored-<i>`, see fake-catalog.ts) for list/resume/fork.
 * - FAKE_DELEGATION=1|running|frames: after the first subscribe of each session, two subagents
 *   (`sa-explore`, `sa-verify` with a nested `sa-clock`) and one job (`job-1`) appear, each
 *   subagent with its own read-only view (`view:<sessionId>:<id>`). Also serves
 *   `subagent.cancel|job.cancel`. `frames` also bursts FAKE_SUBAGENT_FRAMES (400) ops into
 *   `sa-verify`'s view on its first subscribe. FAKE_SUBAGENT_MS: `sa-explore` completes after
 *   that many ms (default never). FAKE_CANCEL_FAILS=1: `subagent.cancel` rejects. See
 *   fake-delegation.ts.
 *
 * `settings.*` is served from `fake-settings.ts` (in memory; `read-only` refuses the writes).
 * `mcp.*` and `skills.*` come from `fake-extensions.ts` (same; FAKE_MCP=empty|broken picks the state).
 */

import {
  type Attachment,
  applyOp,
  base64Bytes,
  decodeFrame,
  encodeFrame,
  errorResponse,
  FrameDecoder,
  type Item,
  isRequestEnvelope,
  okResponse,
  PROTOCOL_VERSION,
  type PromptImage,
  type ResponseEnvelope,
  type SessionOp,
  type SessionOpEvent,
  type SessionViewModel,
  UNKNOWN_SESSION_MESSAGE,
} from "@omp-app/protocol";
import { storedSessions, storedTimeline } from "./fake-catalog";
import {
  commandItem,
  FAKE_COMMANDS,
  fakeCommandOutput,
  missingConfirmation,
  unknownCommand,
} from "./fake-commands";
import { createDelegation } from "./fake-delegation";
import { handleExtensions } from "./fake-extensions";
import { handlePlan } from "./fake-plan";
import {
  drainFollowUp,
  fakeFiles,
  fakeModels,
  filesRead,
  joinTurn,
  type PromptTarget,
  removeQueued,
  requireIdle,
  setModel,
  setThinking,
} from "./fake-prompt";
import { answerRequest, dismissRequests, raiseRequests, scripted } from "./fake-requests";
import { handleSettings } from "./fake-settings";
import { fakeViewModel, mixedTimeline, stateTimeline } from "./fake-timeline";

const mode = process.env.FAKE_SIDECAR ?? "ok";
const socketPath = process.argv.find((a) => a.startsWith("--socket="))?.slice("--socket=".length);
if (!socketPath) throw new Error("missing --socket");

const REPLY =
  process.env.FAKE_REPLY ??
  "Sure, I can help with that. I looked at the project layout and the entry point is where " +
    "I would start. Let me know if you want me to go deeper into any part of it.";
const CHUNK_MS = Number(process.env.FAKE_CHUNK_MS ?? 30);
const CHUNK_SIZE = 12;
const PRELOADED = Number(process.env.FAKE_ITEMS ?? 0);
const MODEL = process.env.FAKE_MODEL ?? "anthropic/claude-opus-5-5";
const stored = storedSessions(Number(process.env.FAKE_STORED ?? 0));

/** The part of a Bun socket this fixture uses; typed here so the file imports nothing from "bun". */
type Conn = { write(data: Uint8Array): number };

interface Turn {
  cancelled: boolean;
  /** Releases a held turn so it can notice the cancellation. */
  wake: () => void;
  openItemId: string;
}

interface FakeSession {
  vm: SessionViewModel;
  seq: number;
  subs: Set<Conn>;
  turn?: Turn;
  /** Commands still running, by item id, with what ends them early. */
  commands: Map<string, () => void>;
  turns: number;
  warned: boolean;
}

const sessions = new Map<string, FakeSession>();
const decoders = new Map<Conn, FrameDecoder>();
/** Bytes a socket did not accept yet; `write` may take only part of a large frame. */
const outbox = new Map<Conn, Uint8Array>();
let created = 0;

function flush(conn: Conn, bytes: Uint8Array): void {
  const written = conn.write(bytes);
  if (written < bytes.length) outbox.set(conn, bytes.subarray(written));
  else outbox.delete(conn);
}

/** Writes a frame in full: the part the socket refuses waits for its `drain`, in order. */
function send(conn: Conn, frame: string): void {
  const bytes = new TextEncoder().encode(frame);
  const queued = outbox.get(conn);
  if (!queued) {
    flush(conn, bytes);
    return;
  }
  const joined = new Uint8Array(queued.length + bytes.length);
  joined.set(queued);
  joined.set(bytes, queued.length);
  outbox.set(conn, joined);
}

/** Deterministic text whose length depends on the index, so row heights vary. */
function preloadedText(i: number): string {
  switch (i % 5) {
    case 0:
      return `Item ${i}: a one-liner.`;
    case 1:
      return `Item ${i}: a couple of sentences. The second one runs a little longer than the first.`;
    case 2:
      return [
        `Item ${i}, first paragraph.`,
        "",
        `Second paragraph of item ${i}, with a bit more to say about the topic at hand.`,
        "",
        `Third paragraph of item ${i}.`,
      ].join("\n");
    case 3: {
      const sentence = `Long item ${i} keeps going with filler that wraps over many lines. `;
      return sentence.repeat(Math.ceil(1500 / sentence.length)).slice(0, 1500);
    }
    default:
      return `Item ${i}:\n- first point\n- second point`;
  }
}

function preloadedItems(): Item[] {
  if (process.env.FAKE_MIXED === "states") return stateTimeline();
  if (process.env.FAKE_MIXED === "1") return mixedTimeline(PRELOADED);
  return Array.from(
    { length: PRELOADED },
    (_, i): Item =>
      i % 2 === 0
        ? { kind: "user", id: `pre-${i}`, text: preloadedText(i) }
        : { kind: "assistant", id: `pre-${i}`, text: preloadedText(i), done: true },
  );
}

function emit(session: FakeSession, op: SessionOp): void {
  session.vm = applyOp(session.vm, op);
  session.seq += 1;
  if (session.subs.size === 0) return;
  const data: SessionOpEvent = { sessionId: session.vm.id, seq: session.seq, op };
  const frame = encodeFrame({ kind: "event", name: "session.op", data });
  for (const conn of session.subs) send(conn, frame);
}

async function runTurn(
  session: FakeSession,
  text: string,
  attachments: Attachment[] = [],
  files: string[] = [],
): Promise<void> {
  if (session.turn) return;
  const n = ++session.turns;
  const turn: Turn = { cancelled: false, wake: () => {}, openItemId: `a${n}` };
  session.turn = turn;
  emit(session, {
    type: "item.add",
    item: {
      kind: "user",
      id: `u${n}`,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(files.length > 0 ? { files } : {}),
    },
  });
  emit(session, { type: "status.set", status: "streaming" });
  emit(session, {
    type: "item.add",
    item: { kind: "assistant", id: turn.openItemId, text: "", done: false },
  });

  const chunks: string[] = [];
  for (let at = 0; at < REPLY.length; at += CHUNK_SIZE)
    chunks.push(REPLY.slice(at, at + CHUNK_SIZE));
  const holdAt = Math.max(1, Math.floor(chunks.length / 2));
  const failAt = Math.min(2, chunks.length);

  for (let i = 0; i < chunks.length; i++) {
    if (scripted() && i === holdAt) {
      await raiseRequests(session, (op) => emit(session, op));
    } else if (process.env.FAKE_HOLD === "1" && i === holdAt) {
      const gate = Promise.withResolvers<void>();
      turn.wake = gate.resolve;
      await gate.promise;
    } else {
      await Bun.sleep(CHUNK_MS);
    }
    if (turn.cancelled) return;
    if (process.env.FAKE_FAIL === "1" && i === failAt) {
      session.turn = undefined;
      emit(session, { type: "status.set", status: "failed", error: "fake failure" });
      return;
    }
    emit(session, { type: "item.appendText", itemId: turn.openItemId, text: chunks[i] ?? "" });
  }
  await Bun.sleep(CHUNK_MS);
  if (turn.cancelled) return;
  session.turn = undefined;
  emit(session, { type: "item.done", itemId: turn.openItemId });
  emit(session, { type: "status.set", status: "idle" });
  drainFollowUp(promptTarget(session));
}

/** What the prompt-control fake needs from a session. */
function promptTarget(session: FakeSession): PromptTarget {
  return {
    // `emit` replaces `session.vm` on every op, so a target kept across a timer must read it live.
    get vm() {
      return session.vm;
    },
    get turning() {
      return session.turn !== undefined;
    },
    emit: (op) => emit(session, op),
    start: (text) => void runTurn(session, text),
    nextId: () => `s${++session.turns}`,
  };
}

async function runCommand(session: FakeSession, line: string, output: string): Promise<void> {
  const itemId = `c${session.commands.size + session.vm.timeline.length}`;
  emit(session, { type: "item.add", item: commandItem(itemId, line, Date.now()) });
  const gate = Promise.withResolvers<"stopped" | "done">();
  session.commands.set(itemId, () => gate.resolve("stopped"));
  if (process.env.FAKE_COMMAND_HOLD !== "1") {
    setTimeout(() => gate.resolve("done"), Number(process.env.FAKE_COMMAND_MS ?? 40));
  }
  const state = await gate.promise;
  session.commands.delete(itemId);
  emit(session, {
    type: "item.patch",
    itemId,
    patch:
      state === "done" ? { state, output, endedAt: Date.now() } : { state, endedAt: Date.now() },
  });
}

function cancelTurn(session: FakeSession): void {
  for (const stop of session.commands.values()) stop();
  const turn = session.turn;
  if (!turn) return;
  turn.cancelled = true;
  session.turn = undefined;
  turn.wake();
  dismissRequests(session, (op) => emit(session, op));
  emit(session, { type: "item.done", itemId: turn.openItemId });
  emit(session, { type: "status.set", status: "idle" });
}

function param(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

/** A session in memory with the given history; `seq` starts at 0, as a fresh attach does. */
function openFake(sessionId: string, cwd: string, timeline: Item[]): void {
  sessions.set(sessionId, {
    vm: fakeViewModel({
      id: sessionId,
      cwd,
      model: MODEL,
      timeline,
      thinking: initialThinking(MODEL),
    }),
    seq: 0,
    subs: new Set(),
    commands: new Map(),
    turns: 0,
    warned: false,
  });
}

/** Thinking level a new session starts with: `off` for a model that has a control, else none. */
function initialThinking(model: string): string | null {
  return (fakeModels().find((m) => m.id === model)?.efforts.length ?? 0) > 0 ? "off" : null;
}
const delegation = createDelegation<FakeSession>({
  emit,
  get: (id) => sessions.get(id),
  open: (id, cwd, timeline, status) => {
    const session: FakeSession = {
      vm: { ...fakeViewModel({ id, cwd, model: MODEL, timeline }), status },
      seq: 0,
      subs: new Set(),
      commands: new Map(),
      turns: 0,
      warned: false,
    };
    sessions.set(id, session);
    return session;
  },
  remove: (id) => sessions.delete(id),
  chunkMs: CHUNK_MS,
});

function readOnlyError(id: string, method: string): ResponseEnvelope {
  return errorResponse(id, {
    code: "read_only",
    message: `${method} writes and the shared omp database is newer than this app supports`,
  });
}

/** list / resume / fork / close over the `FAKE_STORED` catalog; undefined for any other method. */
function handleCatalog(method: string, id: string, params: unknown): ResponseEnvelope | undefined {
  const notFound = (sessionId: string) =>
    errorResponse(id, { code: "internal", message: `session not found: ${sessionId}` });
  const sessionId = param(params, "sessionId");
  switch (method) {
    case "session.list":
      return okResponse(id, { sessions: stored });
    case "session.close":
      delegation.dispose(sessionId);
      sessions.delete(sessionId);
      return okResponse(id, null);
    case "session.resume": {
      if (mode === "read-only") return readOnlyError(id, method);
      if (sessions.has(sessionId)) return okResponse(id, { sessionId });
      const found = stored.find((s) => s.id === sessionId);
      if (!found) return notFound(sessionId);
      openFake(sessionId, found.cwd, storedTimeline(found));
      return okResponse(id, { sessionId });
    }
    case "session.fork": {
      if (mode === "read-only") return readOnlyError(id, method);
      const open = sessions.get(sessionId);
      const found = stored.find((s) => s.id === sessionId);
      const timeline = open?.vm.timeline ?? (found ? storedTimeline(found) : undefined);
      const cwd = open?.vm.cwd ?? found?.cwd;
      if (!timeline || !cwd) return notFound(sessionId);
      const copy = `fake-${++created}`;
      openFake(copy, cwd, [...timeline]);
      return okResponse(id, { sessionId: copy });
    }
    default:
      return undefined;
  }
}

function handleSession(
  method: string,
  id: string,
  params: unknown,
  conn: Conn,
): ResponseEnvelope | undefined {
  if (method === "session.create") {
    if (mode === "read-only") {
      return errorResponse(id, {
        code: "read_only",
        message: `${method} writes and the shared omp database is newer than this app supports`,
      });
    }
    const sessionId = `fake-${++created}`;
    sessions.set(sessionId, {
      vm: fakeViewModel({
        id: sessionId,
        cwd: param(params, "cwd"),
        model: MODEL,
        timeline: preloadedItems(),
        thinking: initialThinking(MODEL),
      }),
      seq: 0,
      subs: new Set(),
      commands: new Map(),
      turns: 0,
      warned: false,
    });
    return okResponse(id, { sessionId });
  }

  // A subagent view is read-only: only subscribe/unsubscribe accept it (close, resume and fork
  // included, so the catalog below never sees one).
  const sessionId = param(params, "sessionId");
  if (
    delegation.isView(sessionId) &&
    method.startsWith("session.") &&
    method !== "session.subscribe" &&
    method !== "session.unsubscribe"
  ) {
    return errorResponse(id, {
      code: "internal",
      message: `${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`,
    });
  }

  const catalog = handleCatalog(method, id, params);
  if (catalog) return catalog;

  if (!method.startsWith("session.")) return undefined;
  const session = sessions.get(sessionId);
  if (!session) {
    return errorResponse(id, {
      code: "internal",
      message: `${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`,
    });
  }

  switch (method) {
    case "session.subscribe": {
      session.subs.add(conn);
      if (process.env.FAKE_WARN === "1" && !session.warned) {
        session.warned = true;
        // After the response, so the snapshot's seq precedes the warning's.
        setTimeout(
          () =>
            emit(session, {
              type: "warning.add",
              warning: { source: "mcp", server: "linear", message: "spawn npx ENOENT" },
            }),
          0,
        );
      }
      delegation.onSubscribe(sessionId, session);
      return okResponse(id, { snapshot: session.vm, seq: session.seq });
    }
    case "session.unsubscribe":
      session.subs.delete(conn);
      return okResponse(id, null);
    case "session.commands":
      return okResponse(id, { commands: FAKE_COMMANDS });
    case "session.runCommand": {
      if (mode === "read-only") return readOnlyError(id, method);
      const line = param(params, "text");
      const output = fakeCommandOutput(line);
      if (output === null)
        return errorResponse(id, { code: "internal", message: unknownCommand(line).message });
      const refused = missingConfirmation(
        line,
        (params as { confirmed?: unknown }).confirmed === true,
      );
      if (refused) return errorResponse(id, { code: "internal", message: refused.message });
      void runCommand(session, line, output);
      return okResponse(id, null);
    }
    case "session.prompt": {
      // The real sidecar refuses a gated builtin on the prompt path too (`gatedPromptLine`).
      const refused = missingConfirmation(param(params, "text").trim(), false);
      if (refused) return errorResponse(id, { code: "internal", message: refused.message });
      const text = param(params, "text");
      const images = (params as { images?: PromptImage[] } | null)?.images ?? [];
      // Like the real reducer: type and decoded size, never the bytes.
      const attachments = images.map(
        (image): Attachment => ({
          kind: "image",
          mimeType: image.mimeType,
          bytes: base64Bytes(image.data),
        }),
      );
      if (session.turn) joinTurn(promptTarget(session), text, param(params, "delivery"));
      else void runTurn(session, text, attachments, filesRead(text));
      return okResponse(id, null);
    }
    case "session.models":
      return okResponse(id, { models: fakeModels() });
    case "session.files":
      return okResponse(id, {
        files: fakeFiles(param(params, "query")),
        ...(process.env.FAKE_FILES_TRUNCATED === "1" ? { truncated: true } : {}),
      });
    case "session.removeQueued":
      return okResponse(id, {
        removed: removeQueued(promptTarget(session), param(params, "queue"), param(params, "text")),
      });
    case "session.setModel":
    case "session.setThinking": {
      const target = promptTarget(session);
      try {
        requireIdle(target);
        if (method === "session.setModel") setModel(target, param(params, "model"));
        else setThinking(target, param(params, "level"));
      } catch (e) {
        return errorResponse(id, {
          code: "internal",
          message: e instanceof Error ? e.message : String(e),
        });
      }
      return okResponse(id, null);
    }
    case "session.cancel":
      cancelTurn(session);
      return okResponse(id, null);
    case "session.answerPermission": {
      const optionId = param(params, "optionId");
      const kind = (["allow_once", "allow_always", "reject_once", "reject_always"] as const).find(
        (k) => k === optionId,
      );
      const requestId = param(params, "requestId");
      if (
        !kind ||
        !answerRequest(session, (op) => emit(session, op), requestId, { permission: kind })
      ) {
        return errorResponse(id, { code: "internal", message: `stale request: ${requestId}` });
      }
      return okResponse(id, null);
    }
    case "session.answerAsk": {
      const requestId = param(params, "requestId");
      const action = param(params, "action") === "accept" ? "accept" : "decline";
      if (
        !answerRequest(session, (op) => emit(session, op), requestId, {
          ask: action,
          content: (params as { content?: unknown }).content,
        })
      ) {
        return errorResponse(id, { code: "internal", message: `stale request: ${requestId}` });
      }
      return okResponse(id, null);
    }
    default: {
      const plan = handlePlan(method, session, (op) => emit(session, op), params);
      return plan ? okResponse(id, plan.result) : undefined;
    }
  }
}

if (mode === "slow") await Bun.sleep(600);

Bun.listen<undefined>({
  unix: socketPath,
  socket: {
    open(socket) {
      decoders.set(socket, new FrameDecoder());
    },
    drain(socket) {
      const queued = outbox.get(socket);
      if (queued) flush(socket, queued);
    },
    close(socket) {
      decoders.delete(socket);
      outbox.delete(socket);
      for (const session of sessions.values()) session.subs.delete(socket);
    },
    data(socket, chunk) {
      if (mode === "silent") return;
      const decoder = decoders.get(socket);
      if (!decoder) return;
      for (const line of decoder.push(new TextDecoder().decode(chunk))) {
        const frame = decodeFrame(line);
        if (!frame.ok || !isRequestEnvelope(frame.envelope)) continue;
        const { id, method, params } = frame.envelope;
        let response: ResponseEnvelope | undefined;
        if (method === "handshake") {
          response = okResponse(id, {
            protocolVersion: mode === "old-protocol" ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION,
            sidecarVersion: "fake",
            ompVersion: "fake-omp",
            capabilities: ["handshake"],
            mode: mode === "read-only" ? "read_only" : "normal",
            ...(mode === "read-only" ? { schema: { onDisk: 7, expected: 6 } } : {}),
          });
        } else {
          const cwdOf = (sid: string) => sessions.get(sid)?.vm.cwd;
          response =
            handleSettings(method, id, params, mode === "read-only", cwdOf) ??
            handleExtensions(method, id, params, mode === "read-only", cwdOf) ??
            delegation.handle(method, id, params) ??
            handleSession(method, id, params, socket);
        }
        send(
          socket,
          encodeFrame(
            response ?? errorResponse(id, { code: "unknown_method", message: "unknown method" }),
          ),
        );
      }
    },
  },
});
console.error(`[fake-sidecar] ${mode} listening`);
