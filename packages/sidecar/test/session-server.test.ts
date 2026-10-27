import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOp,
  decodeFrame,
  type EventEnvelope,
  FrameDecoder,
  isEventEnvelope,
  isResponseEnvelope,
  isSessionOpEvent,
  type MethodName,
  type Methods,
  RequestCorrelator,
  type SessionOpEvent,
} from "@omp-app/protocol";
import { emptyViewModel } from "../src/reducer";
import { RequestRegistry } from "../src/request-registry";
import { type Handlers, type Server, startServer } from "../src/server";
import { sessionHandlers } from "../src/session-handlers";
import { SessionStore } from "../src/session-store";
import { loadFixture, readGolden } from "./replay";

interface Client {
  request<M extends MethodName>(m: M, p?: Methods[M]["params"]): Promise<Methods[M]["result"]>;
  readonly events: SessionOpEvent[];
  close(): void;
}

async function connect(socketPath: string): Promise<Client> {
  const correlator = new RequestCorrelator();
  const decoder = new FrameDecoder();
  const text = new TextDecoder();
  const events: SessionOpEvent[] = [];
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        for (const line of decoder.push(text.decode(chunk, { stream: true }))) {
          const frame = decodeFrame(line);
          if (!frame.ok) throw new Error(`non-frame on the channel: ${line}`);
          if (isResponseEnvelope(frame.envelope)) correlator.receive(frame.envelope);
          else if (isEventEnvelope(frame.envelope)) {
            const event: EventEnvelope = frame.envelope;
            if (event.name === "session.op" && isSessionOpEvent(event.data))
              events.push(event.data);
          }
        }
      },
    },
  });
  return {
    events,
    request(method, params) {
      const { frame, response } = correlator.create(method, params);
      socket.write(frame);
      return response;
    },
    close: () => void socket.end(),
  };
}

let dir: string | undefined;
let server: Server | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A server whose "omp" replays a recorded fixture when prompted, one event per tick. */
async function replayServer(name: string, readOnly = false, pauseAt = -1) {
  const fixture = await loadFixture(name);
  const id = fixture.header.sessionId;
  const store = new SessionStore();
  let cancelled = false;
  const gate = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>();
  const control = {
    async createSession(cwd: string) {
      store.create(emptyViewModel({ id, cwd, model: fixture.header.model }));
      return id;
    },
    async prompt(sessionId: string) {
      for (const [index, event] of fixture.events.entries()) {
        if (cancelled) break;
        if (index === pauseAt) {
          paused.resolve();
          await gate.promise;
        }
        store.dispatch(sessionId, event);
        await Bun.sleep(0);
      }
      return "end_turn";
    },
    async cancel() {
      cancelled = true;
    },
  };
  dir = mkdtempSync(join(tmpdir(), "omp-app-sess-"));
  const socketPath = join(dir, "s.sock");
  server = startServer(
    socketPath,
    sessionHandlers(control, store, new RequestRegistry(store)) as Handlers,
    readOnly,
    {
      onClientClosed: (client) => store.unsubscribeAll(client),
    },
  );
  return { socketPath, store, id, fixture, atPause: paused.promise, release: gate.resolve };
}

describe("session.* over the socket", () => {
  test("create, subscribe, prompt: the pushed ops equal the golden and seq is contiguous", async () => {
    const { socketPath, id } = await replayServer("basic");
    const client = await connect(socketPath);

    const { sessionId } = await client.request("session.create", { cwd: "/work/project" });
    expect(sessionId).toBe(id);
    const sub = await client.request("session.subscribe", { sessionId });
    expect(sub.seq).toBe(0);
    await client.request("session.prompt", { sessionId, text: "hi" });
    await Bun.sleep(150);

    const golden = await readGolden("basic");
    expect(client.events).toEqual(golden.ops as SessionOpEvent[]);
    client.close();
  });

  test("a second client subscribing mid-stream gets a snapshot that joins the op stream", async () => {
    const { socketPath, id, store, atPause, release } = await replayServer("cancel", false, 10);
    const first = await connect(socketPath);
    await first.request("session.create", { cwd: "/work/project" });
    await first.request("session.subscribe", { sessionId: id });
    await first.request("session.prompt", { sessionId: id, text: "count" });

    await atPause;
    const second = await connect(socketPath);
    const sub = await second.request("session.subscribe", { sessionId: id });
    expect(sub.seq).toBeGreaterThan(0);
    expect(sub.snapshot.status).toBe("streaming");
    release();
    while (store.snapshot(id).snapshot.status !== "idle") await Bun.sleep(1);
    await Bun.sleep(50);

    expect(second.events[0]?.seq).toBe(sub.seq + 1);
    const replica = second.events.reduce((vm, e) => applyOp(vm, e.op), sub.snapshot);
    expect(replica).toEqual(store.snapshot(id).snapshot);
    first.close();
    second.close();
  });

  test("a closed connection stops receiving and unsubscribe is honoured", async () => {
    const { socketPath, id, store } = await replayServer("basic");
    const client = await connect(socketPath);
    await client.request("session.create", { cwd: "/work/project" });
    await client.request("session.subscribe", { sessionId: id });
    await client.request("session.unsubscribe", { sessionId: id });
    await client.request("session.prompt", { sessionId: id, text: "hi" });
    await Bun.sleep(150);
    expect(client.events).toEqual([]);
    expect(store.snapshot(id).seq).toBeGreaterThan(0);
    client.close();
  });

  test("unknown session ids are errors", async () => {
    const { socketPath } = await replayServer("basic");
    const client = await connect(socketPath);
    await expect(client.request("session.subscribe", { sessionId: "nope" })).rejects.toThrow(
      /unknown session/,
    );
    client.close();
  });

  test("read_only: session.create and session.prompt are refused, subscribe is not", async () => {
    const { socketPath, id } = await replayServer("basic", true);
    const client = await connect(socketPath);
    const code = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: Error & { code?: string }) => e.code,
      );
    expect(await code(client.request("session.create", { cwd: "/x" }))).toBe("read_only");
    expect(await code(client.request("session.prompt", { sessionId: id, text: "x" }))).toBe(
      "read_only",
    );
    expect(await code(client.request("session.cancel", { sessionId: id }))).toBe("read_only");
    // Not a write: reaches the handler, which says the session does not exist.
    expect(await code(client.request("session.subscribe", { sessionId: id }))).toBe("internal");
    client.close();
  });
});
