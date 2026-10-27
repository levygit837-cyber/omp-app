/**
 * Stand-in for the sidecar, to exercise the supervisor's lifecycle and the UI without booting omp.
 * Behaviour is chosen by FAKE_SIDECAR: `ok` (default), `slow` (listens after 600 ms),
 * `silent` (listens, never answers), `read-only` (reports a newer schema on disk; refuses
 * `session.create`), `old-protocol` (answers with another protocolVersion).
 *
 * Every mode except `silent` also serves `session.create|subscribe|unsubscribe|prompt|cancel`
 * with in-memory sessions (`fake-<n>`) whose state is kept with `applyOp`, so snapshots match
 * the `session.op` stream. A prompt runs a scripted turn. Knobs, all optional:
 * - FAKE_REPLY: reply text of a turn (default: a short English paragraph).
 * - FAKE_CHUNK_MS: delay between reply chunks of ~12 chars (default 30).
 * - FAKE_HOLD=1: stop halfway through the reply and stay `streaming` until `session.cancel`.
 * - FAKE_FAIL=1: after the first chunks, set the status to `failed` ("fake failure").
 * - FAKE_ITEMS=<n>: preload n done timeline items at create, alternating user/assistant, of
 *   varied length (one-liners, multi-paragraph, ~1500 chars). Deterministic.
 * - FAKE_MODEL: model of new sessions (default anthropic/claude-opus-5-5).
 * - FAKE_WARN=1: emit one MCP `warning.add` right after the first subscribe of each session.
 */

import {
  applyOp,
  decodeFrame,
  encodeFrame,
  errorResponse,
  FrameDecoder,
  type Item,
  isRequestEnvelope,
  okResponse,
  PROTOCOL_VERSION,
  type ResponseEnvelope,
  type SessionOp,
  type SessionOpEvent,
  type SessionViewModel,
  UNKNOWN_SESSION_MESSAGE,
} from "@omp-app/protocol";

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

async function runTurn(session: FakeSession, text: string): Promise<void> {
  if (session.turn) return;
  const n = ++session.turns;
  const turn: Turn = { cancelled: false, wake: () => {}, openItemId: `a${n}` };
  session.turn = turn;
  emit(session, { type: "item.add", item: { kind: "user", id: `u${n}`, text } });
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
    if (process.env.FAKE_HOLD === "1" && i === holdAt) {
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
}

function cancelTurn(session: FakeSession): void {
  const turn = session.turn;
  if (!turn) return;
  turn.cancelled = true;
  session.turn = undefined;
  turn.wake();
  emit(session, { type: "item.done", itemId: turn.openItemId });
  emit(session, { type: "status.set", status: "idle" });
}

function param(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" ? value : "";
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
      vm: {
        id: sessionId,
        cwd: param(params, "cwd"),
        status: "idle",
        model: MODEL,
        timeline: preloadedItems(),
        warnings: [],
      },
      seq: 0,
      subs: new Set(),
      turns: 0,
      warned: false,
    });
    return okResponse(id, { sessionId });
  }

  if (!method.startsWith("session.")) return undefined;
  const sessionId = param(params, "sessionId");
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
      return okResponse(id, { snapshot: session.vm, seq: session.seq });
    }
    case "session.unsubscribe":
      session.subs.delete(conn);
      return okResponse(id, null);
    case "session.prompt":
      void runTurn(session, param(params, "text"));
      return okResponse(id, null);
    case "session.cancel":
      cancelTurn(session);
      return okResponse(id, null);
    default:
      return undefined;
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
          response = handleSession(method, id, params, socket);
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
