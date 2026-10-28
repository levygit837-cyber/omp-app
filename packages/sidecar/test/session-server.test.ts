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
  MAX_FRAME_CHARS,
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
import { noActions } from "./fixtures/no-actions";
import { noCommands } from "./fixtures/no-commands";
import { noPromptControls } from "./harness";
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
    ...noPromptControls,
    ...noCommands,
    ...noActions,
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
    async list() {
      return [];
    },
    async resumeSession(sessionId: string) {
      return sessionId;
    },
    async forkSession(sessionId: string) {
      return sessionId;
    },
    async closeSession() {},
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

  test("read_only: a builtin is refused (some write: /model, /compact, /move), listing them is not", async () => {
    const { socketPath, id } = await replayServer("basic", true);
    const client = await connect(socketPath);
    const code = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: Error & { code?: string }) => e.code,
      );
    expect(
      await code(client.request("session.runCommand", { sessionId: id, text: "/model" })),
    ).toBe("read_only");
    // Reaches the handler, which says the session does not exist: not refused as a write.
    expect(await code(client.request("session.commands", { sessionId: id }))).toBe("internal");
    client.close();
  });
});

/** Lets other work run: one turn of the event loop, not a duration. */
const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

/**
 * A server hosting several sessions at once. Each "omp" session replays its own recorded
 * fixture; `prompt` calls overlap, and every event yields to the event loop so the sessions'
 * ops interleave on the wire.
 */
async function multiServer(fixtureNames: readonly string[], readOnly = false) {
  const fixtures = await Promise.all(fixtureNames.map((name) => loadFixture(name)));
  const store = new SessionStore();
  const byId = new Map(fixtures.map((f) => [f.header.sessionId, f]));
  const cancelled = new Set<string>();
  const calls: string[] = [];
  const running: Promise<string>[] = [];
  let created = 0;
  const control = {
    ...noPromptControls,
    ...noCommands,
    ...noActions,
    async createSession(cwd: string) {
      const fixture = fixtures[created++];
      if (!fixture) throw new Error("no more fixtures");
      store.create(
        emptyViewModel({ id: fixture.header.sessionId, cwd, model: fixture.header.model }),
      );
      return fixture.header.sessionId;
    },
    prompt(sessionId: string) {
      const fixture = byId.get(sessionId);
      if (!fixture) return Promise.reject(new Error(`no fixture for ${sessionId}`));
      const run = (async () => {
        for (const event of fixture.events) {
          if (cancelled.has(sessionId)) break;
          store.dispatch(sessionId, event);
          await tick();
        }
        return "end_turn";
      })();
      running.push(run);
      return run;
    },
    async cancel(sessionId: string) {
      cancelled.add(sessionId);
    },
    async list() {
      calls.push("list");
      return [];
    },
    async resumeSession(sessionId: string) {
      calls.push(`resume:${sessionId}`);
      const fixture = byId.get(sessionId);
      if (fixture && !store.has(sessionId))
        store.create(
          emptyViewModel({ id: sessionId, cwd: "/work/a", model: fixture.header.model }),
        );
      return sessionId;
    },
    async forkSession(sessionId: string) {
      calls.push(`fork:${sessionId}`);
      return sessionId;
    },
    async closeSession(sessionId: string) {
      calls.push(`close:${sessionId}`);
    },
  };
  dir = mkdtempSync(join(tmpdir(), "omp-app-multi-"));
  const socketPath = join(dir, "s.sock");
  server = startServer(
    socketPath,
    sessionHandlers(control, store, new RequestRegistry(store)) as Handlers,
    readOnly,
    { onClientClosed: (client) => store.unsubscribeAll(client) },
  );
  // Prompts are done when their promises settle. Events and responses share one ordered socket,
  // so a round trip afterwards proves the client already holds every op sent before it.
  const settled = async (client: Client) => {
    await Promise.all(running);
    await client.request("session.list");
  };
  return { socketPath, store, ids: fixtures.map((f) => f.header.sessionId), calls, settled };
}

describe("several sessions in one sidecar", () => {
  test("interleaved events keep each session's ops, seq and state isolated", async () => {
    const { socketPath, store, ids, settled } = await multiServer(["basic", "cancel"]);
    const client = await connect(socketPath);
    const [a, b] = ids as [string, string];
    await client.request("session.create", { cwd: "/work/a" });
    await client.request("session.create", { cwd: "/work/b" });
    await client.request("session.subscribe", { sessionId: a });
    await client.request("session.subscribe", { sessionId: b });
    await client.request("session.prompt", { sessionId: a, text: "one" });
    await client.request("session.prompt", { sessionId: b, text: "two" });
    await settled(client);

    // Both streams were live at once: the wire alternates between the two sessions.
    const order = client.events.map((e) => e.sessionId);
    expect(order.indexOf(b)).toBeLessThan(order.lastIndexOf(a));

    for (const [id, name] of [
      [a, "basic"],
      [b, "cancel"],
    ] as const) {
      const golden = await readGolden(name);
      expect(client.events.filter((e) => e.sessionId === id)).toEqual(
        golden.ops as SessionOpEvent[],
      );
      expect(store.snapshot(id).snapshot).toEqual({
        ...golden.final.snapshot,
        cwd: id === a ? "/work/a" : "/work/b",
      });
      expect(store.snapshot(id).seq).toBe(golden.final.seq);
    }
    client.close();
  });

  test("cancel reaches only the session it names; the other one finishes", async () => {
    const { socketPath, store, ids, settled } = await multiServer(["basic", "cancel"]);
    const client = await connect(socketPath);
    const [a, b] = ids as [string, string];
    await client.request("session.create", { cwd: "/work/a" });
    await client.request("session.create", { cwd: "/work/b" });
    await client.request("session.subscribe", { sessionId: a });
    await client.request("session.subscribe", { sessionId: b });
    await client.request("session.prompt", { sessionId: a, text: "one" });
    await client.request("session.prompt", { sessionId: b, text: "two" });
    while (store.snapshot(a).seq < 2) await tick();
    await client.request("session.cancel", { sessionId: a });
    await settled(client);

    const goldenA = await readGolden("basic");
    const goldenB = await readGolden("cancel");
    expect(client.events.filter((e) => e.sessionId === b)).toEqual(goldenB.ops as SessionOpEvent[]);
    expect(store.snapshot(b)).toEqual({
      ...goldenB.final,
      snapshot: { ...goldenB.final.snapshot, cwd: "/work/b" },
    });
    expect(store.snapshot(a).seq).toBeLessThan(goldenA.final.seq);
    client.close();
  });

  test("close forgets the session; resume of an open session does not open it twice", async () => {
    const { socketPath, ids, calls } = await multiServer(["basic"]);
    const client = await connect(socketPath);
    const [a] = ids as [string];
    await client.request("session.create", { cwd: "/work/a" });

    expect(await client.request("session.resume", { sessionId: a })).toEqual({ sessionId: a });
    expect(calls).not.toContain(`resume:${a}`);

    await client.request("session.close", { sessionId: a });
    expect(calls).toContain(`close:${a}`);
    await expect(client.request("session.subscribe", { sessionId: a })).rejects.toThrow(
      /unknown session/,
    );
    // Closing again is a no-op, not an error.
    await client.request("session.close", { sessionId: a });
    expect(calls.filter((c) => c === `close:${a}`)).toHaveLength(1);

    // Not open any more: resume goes to omp.
    await client.request("session.resume", { sessionId: a });
    expect(calls).toContain(`resume:${a}`);
    client.close();
  });

  test("read_only: list and close are served, resume and fork are refused", async () => {
    const { socketPath } = await multiServer(["basic"], true);
    const client = await connect(socketPath);
    const code = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: Error & { code?: string }) => e.code,
      );
    expect(await client.request("session.list")).toEqual({ sessions: [] });
    expect(await code(client.request("session.resume", { sessionId: "x" }))).toBe("read_only");
    expect(await code(client.request("session.fork", { sessionId: "x" }))).toBe("read_only");
    expect(await code(client.request("session.close", { sessionId: "x" }))).toBeNull();
    client.close();
  });
  test("close and resume of one session run in call order, whichever settles first", async () => {
    const { socketPath, store, ids, calls } = await multiServer(["basic"]);
    const client = await connect(socketPath);
    const [a] = ids as [string];
    await client.request("session.create", { cwd: "/work/a" });

    // Sent together: resume must not see the session as open and skip, then lose it to the close.
    const settled = await Promise.allSettled([
      client.request("session.close", { sessionId: a }),
      client.request("session.resume", { sessionId: a }),
    ]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(calls.filter((c) => c === `close:${a}` || c === `resume:${a}`)).toEqual([
      `close:${a}`,
      `resume:${a}`,
    ]);
    expect(store.has(a)).toBe(true);

    // The other way round: the resume finds it open, then the close removes it.
    await Promise.allSettled([
      client.request("session.resume", { sessionId: a }),
      client.request("session.close", { sessionId: a }),
    ]);
    expect(store.has(a)).toBe(false);
    client.close();
  });

  test("a session omp moved to a new id answers to both ids", async () => {
    const { socketPath, store, ids, calls } = await multiServer(["basic"]);
    const client = await connect(socketPath);
    const [a] = ids as [string];
    await client.request("session.create", { cwd: "/work/a" });
    await client.request("session.subscribe", { sessionId: a });

    store.rekey(a, "moved-to");

    // The subscriber is told under the old id, then every later op arrives under the new one.
    await client.request("session.list");
    expect(client.events.at(-1)).toMatchObject({
      sessionId: a,
      op: { type: "session.moved", id: "moved-to" },
    });
    // A caller still holding the old id is sent to the successor.
    const snapshot = await client.request("session.subscribe", { sessionId: a });
    expect(snapshot.snapshot.id).toBe("moved-to");
    expect(await client.request("session.resume", { sessionId: a })).toEqual({
      sessionId: "moved-to",
    });
    expect(calls).not.toContain(`resume:${a}`);
    await client.request("session.close", { sessionId: a });
    expect(calls).toContain("close:moved-to");
    expect(store.has("moved-to")).toBe(false);
    client.close();
  });
});

describe("oversized frames", () => {
  test("a line past the cap closes only that connection; another one is still served", async () => {
    const { socketPath } = await replayServer("basic");
    const healthy = await connect(socketPath);
    const closed = Promise.withResolvers<void>();
    const chunk = new Uint8Array(1024 * 1024).fill(0x78);
    const total = Math.ceil(MAX_FRAME_CHARS / chunk.length) + 1;
    let sent = 0;
    let offset = 0;
    // `write` may accept only a prefix; resume from `offset` on drain.
    const pump = (socket: Bun.Socket<undefined>): void => {
      while (sent < total) {
        offset += socket.write(chunk.subarray(offset));
        if (offset < chunk.length) return;
        offset = 0;
        sent++;
      }
    };
    await Bun.connect({
      unix: socketPath,
      socket: {
        open: pump,
        drain: pump,
        close: () => closed.resolve(),
        error: () => closed.resolve(),
        data() {},
      },
    });

    await closed.promise;

    expect(await healthy.request("session.list")).toEqual({ sessions: [] });
    const second = await connect(socketPath);
    expect(await second.request("session.list")).toEqual({ sessions: [] });
    second.close();
    healthy.close();
  });
});
