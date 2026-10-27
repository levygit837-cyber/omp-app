import { describe, expect, test } from "bun:test";
import {
  type SessionOp,
  type SessionOpEvent,
  type SessionSnapshot,
  type SessionViewModel,
  UNKNOWN_SESSION_MESSAGE,
} from "@omp-app/protocol";
import {
  createSessionReplicas,
  type SessionApi,
  SessionLostError,
} from "../src/renderer/session-store";

const emptyVm = (id = "s1", patch: Partial<SessionViewModel> = {}): SessionViewModel => ({
  id,
  cwd: "/work",
  status: "idle",
  model: "p/m",
  timeline: [],
  warnings: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
  context: null,
  todo: [],
  pending: [],
  ...patch,
});

const op = (seq: number, o: SessionOp, sessionId = "s1"): SessionOpEvent => ({
  sessionId,
  seq,
  op: o,
});
const assistant = (id: string, text = "") => ({
  kind: "assistant" as const,
  id,
  text,
  done: false,
});

/** A bridge double: `snapshots` is what the next `subscribe` calls resolve with. */
function fakeApi(snapshots: SessionSnapshot[]) {
  const calls: string[] = [];
  const api: SessionApi = {
    async subscribe(sessionId) {
      calls.push(`subscribe:${sessionId}`);
      const next = snapshots.shift();
      if (!next) throw new Error("no snapshot queued");
      return next;
    },
    async unsubscribe(sessionId) {
      calls.push(`unsubscribe:${sessionId}`);
    },
  };
  return { api, calls };
}

/** Frames only run when the test says so. */
function manualFrames() {
  const queue: (() => void)[] = [];
  return {
    schedule: (cb: () => void) => void queue.push(cb),
    pending: () => queue.length,
    run() {
      for (const cb of queue.splice(0)) cb();
    },
  };
}

function setup(snapshots: SessionSnapshot[]) {
  const { api, calls } = fakeApi(snapshots);
  const frames = manualFrames();
  const replicas = createSessionReplicas(api, frames.schedule);
  let updates = 0;
  replicas.store.subscribe(() => updates++);
  return {
    replicas,
    calls,
    frames,
    updates: () => updates,
    vm: (id = "s1") => replicas.store.getState().sessions[id],
  };
}

describe("op application", () => {
  test("open stores the snapshot, then ops apply in order", async () => {
    const t = setup([{ snapshot: emptyVm(), seq: 0 }]);
    await t.replicas.open("s1");
    expect(t.vm()).toEqual(emptyVm());

    t.replicas.receive(op(1, { type: "status.set", status: "streaming" }));
    t.replicas.receive(op(2, { type: "item.add", item: { kind: "user", id: "i0", text: "hi" } }));
    t.replicas.receive(op(3, { type: "item.add", item: assistant("i1", "po") }));
    t.replicas.receive(op(4, { type: "item.appendText", itemId: "i1", text: "ng" }));
    t.replicas.receive(op(5, { type: "item.done", itemId: "i1" }));
    t.replicas.receive(op(6, { type: "status.set", status: "idle" }));
    t.frames.run();

    expect(t.vm()?.status).toBe("idle");
    expect(t.vm()?.timeline).toEqual([
      { kind: "user", id: "i0", text: "hi" },
      { kind: "assistant", id: "i1", text: "pong", done: true },
    ]);
  });

  test("duplicates (seq already seen) are dropped, not applied twice", async () => {
    const t = setup([{ snapshot: emptyVm(), seq: 0 }]);
    await t.replicas.open("s1");
    t.replicas.receive(op(1, { type: "item.add", item: assistant("i0", "a") }));
    t.replicas.receive(op(2, { type: "item.appendText", itemId: "i0", text: "b" }));
    t.replicas.receive(op(2, { type: "item.appendText", itemId: "i0", text: "b" }));
    t.replicas.receive(op(1, { type: "item.add", item: assistant("i0", "a") }));
    t.frames.run();
    expect(t.vm()?.timeline).toEqual([assistant("i0", "ab")]);
  });

  test("sessions are independent and events for unknown sessions are ignored", async () => {
    const t = setup([
      { snapshot: emptyVm("a"), seq: 0 },
      { snapshot: emptyVm("b"), seq: 0 },
    ]);
    await t.replicas.open("a");
    await t.replicas.open("b");
    t.replicas.receive(op(1, { type: "status.set", status: "streaming" }, "a"));
    t.replicas.receive(op(1, { type: "status.set", status: "failed" }, "zzz"));
    expect(t.vm("a")?.status).toBe("streaming");
    expect(t.vm("b")?.status).toBe("idle");
    expect(Object.keys(t.replicas.store.getState().sessions).sort()).toEqual(["a", "b"]);
  });

  test("untouched items keep their identity when another item changes", async () => {
    const t = setup([
      {
        snapshot: emptyVm("s1", {
          timeline: [{ kind: "user", id: "i0", text: "q" }, assistant("i1", "a")],
        }),
        seq: 4,
      },
    ]);
    await t.replicas.open("s1");
    const before = t.vm()?.timeline;
    t.replicas.receive(op(5, { type: "item.appendText", itemId: "i1", text: "b" }));
    t.frames.run();
    const after = t.vm()?.timeline;
    expect(after?.[0]).toBe(before?.[0]);
    expect(after?.[1]).not.toBe(before?.[1]);
  });

  test("unknown ops do not break the replica", async () => {
    const t = setup([{ snapshot: emptyVm(), seq: 0 }]);
    await t.replicas.open("s1");
    const future = { type: "plan.update", steps: [] } as unknown as SessionOp;
    t.replicas.receive(op(1, future));
    t.replicas.receive(op(2, { type: "status.set", status: "streaming" }));
    expect(t.vm()?.status).toBe("streaming");
  });
});

describe("gap detection", () => {
  test("a skipped seq re-subscribes and the snapshot replaces the local state", async () => {
    const t = setup([
      { snapshot: emptyVm("s1"), seq: 0 },
      {
        snapshot: emptyVm("s1", { status: "streaming", timeline: [assistant("i0", "hello wor")] }),
        seq: 7,
      },
    ]);
    await t.replicas.open("s1");
    t.replicas.receive(op(1, { type: "item.add", item: assistant("i0", "hello") }));
    t.replicas.receive(op(4, { type: "item.appendText", itemId: "i0", text: "lost 2 and 3" }));
    expect(t.calls).toEqual(["subscribe:s1", "subscribe:s1"]);

    await Promise.resolve();
    await Promise.resolve();
    t.frames.run();
    expect(t.vm()?.timeline).toEqual([assistant("i0", "hello wor")]);
    expect(t.vm()?.status).toBe("streaming");

    // The stream resumes right after the snapshot's seq.
    t.replicas.receive(op(8, { type: "item.appendText", itemId: "i0", text: "ld" }));
    t.frames.run();
    expect(t.vm()?.timeline).toEqual([assistant("i0", "hello world")]);
  });

  test("ops that arrive during the re-subscribe are held and replayed after the snapshot", async () => {
    const t = setup([
      { snapshot: emptyVm(), seq: 0 },
      { snapshot: emptyVm("s1", { timeline: [assistant("i0", "ab")] }), seq: 2 },
    ]);
    await t.replicas.open("s1");
    t.replicas.receive(op(3, { type: "item.appendText", itemId: "i0", text: "c" })); // gap: 1,2 missing
    t.replicas.receive(op(4, { type: "item.appendText", itemId: "i0", text: "d" })); // held
    t.replicas.receive(op(2, { type: "item.appendText", itemId: "i0", text: "b" })); // older than snapshot
    await Promise.resolve();
    await Promise.resolve();
    t.frames.run();
    expect(t.vm()?.timeline).toEqual([assistant("i0", "abcd")]);
    expect(t.calls.filter((c) => c === "subscribe:s1")).toHaveLength(2);
  });

  test("several gaps while a re-subscribe is in flight cause only one extra subscribe", async () => {
    const t = setup([
      { snapshot: emptyVm(), seq: 0 },
      { snapshot: emptyVm("s1", { status: "streaming" }), seq: 20 },
    ]);
    await t.replicas.open("s1");
    for (const seq of [5, 9, 12])
      t.replicas.receive(op(seq, { type: "status.set", status: "streaming" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(t.calls.filter((c) => c === "subscribe:s1")).toHaveLength(2);
  });

  test("a failed re-subscribe is reported in the store", async () => {
    const t = setup([{ snapshot: emptyVm(), seq: 0 }]); // no second snapshot queued
    await t.replicas.open("s1");
    t.replicas.receive(op(3, { type: "status.set", status: "streaming" }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.replicas.store.getState().error).toBe("no snapshot queued");
  });
});

describe("snapshot replaces state", () => {
  test("opening again (window reload) replaces local state and resets the seq", async () => {
    const t = setup([
      { snapshot: emptyVm("s1", { timeline: [assistant("i0", "old")] }), seq: 3 },
      {
        snapshot: emptyVm("s1", { status: "streaming", timeline: [assistant("i0", "fresh text")] }),
        seq: 10,
      },
    ]);
    await t.replicas.open("s1");
    t.replicas.receive(op(4, { type: "item.appendText", itemId: "i0", text: "!" })); // buffered, not yet applied
    await t.replicas.open("s1");
    t.frames.run();
    expect(t.vm()?.timeline).toEqual([assistant("i0", "fresh text")]);

    t.replicas.receive(op(11, { type: "item.appendText", itemId: "i0", text: "!" }));
    t.frames.run();
    expect(t.vm()?.timeline).toEqual([assistant("i0", "fresh text!")]);
  });

  test("close drops the replica, stops the stream and ignores later events", async () => {
    const t = setup([{ snapshot: emptyVm(), seq: 0 }]);
    await t.replicas.open("s1");
    await t.replicas.close("s1");
    t.replicas.receive(op(1, { type: "status.set", status: "streaming" }));
    expect(t.vm()).toBeUndefined();
    expect(t.calls).toEqual(["subscribe:s1", "unsubscribe:s1"]);
  });
});

describe("session lost after a sidecar restart", () => {
  // Electron wraps a rejected IPC call; only the message text reaches the renderer.
  const unknownSession = (id: string) =>
    new Error(
      `Error invoking remote method 'session:subscribe': Error: ${UNKNOWN_SESSION_MESSAGE}: ${id}`,
    );

  /** The first subscribe works; later ones fail the way a restarted sidecar answers. */
  function restartedSidecar() {
    const frames = manualFrames();
    let subscribes = 0;
    const api: SessionApi = {
      async subscribe(sessionId) {
        if (++subscribes > 1) throw unknownSession(sessionId);
        return { snapshot: emptyVm(sessionId, { timeline: [assistant("i0", "hi")] }), seq: 0 };
      },
      async unsubscribe() {},
    };
    return { replicas: createSessionReplicas(api, frames.schedule), frames };
  }

  test("opening a session the sidecar forgot rejects with SessionLostError and drops the replica", async () => {
    const { replicas } = restartedSidecar();
    await replicas.open("s1");
    expect(replicas.store.getState().sessions.s1).toBeDefined();

    await expect(replicas.open("s1")).rejects.toBeInstanceOf(SessionLostError);
    expect(replicas.store.getState().sessions.s1).toBeUndefined();
    expect(replicas.store.getState().error).toBeNull(); // a lost session is not a sync error
  });

  test("a lost session stops tracking: later events are ignored and nothing is buffered", async () => {
    const { replicas, frames } = restartedSidecar();
    await replicas.open("s1");
    replicas.receive(op(1, { type: "item.appendText", itemId: "i0", text: "!" })); // buffered
    await replicas.open("s1").catch(() => undefined);

    replicas.receive(op(2, { type: "status.set", status: "streaming" }));
    frames.run();
    expect(replicas.store.getState().sessions.s1).toBeUndefined();
  });

  test("a gap that resubscribes into an unknown session drops it quietly", async () => {
    const { replicas } = restartedSidecar();
    await replicas.open("s1");
    replicas.receive(op(5, { type: "status.set", status: "streaming" })); // gap -> resubscribe
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(replicas.store.getState().sessions.s1).toBeUndefined();
    expect(replicas.store.getState().error).toBeNull();
  });

  test("any other subscribe failure keeps its own message and is not 'lost'", async () => {
    const api: SessionApi = {
      async subscribe() {
        throw new Error("sidecar is not running");
      },
      async unsubscribe() {},
    };
    const replicas = createSessionReplicas(api, () => {});
    const failure = await replicas.open("s1").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SessionLostError);
    expect((failure as Error).message).toBe("sidecar is not running");
  });
});

describe("per-frame batching", () => {
  test("many text deltas in one frame cost one store update and one scheduled frame", async () => {
    const t = setup([{ snapshot: emptyVm("s1", { timeline: [assistant("i0")] }), seq: 0 }]);
    await t.replicas.open("s1");
    const base = t.updates();

    for (let i = 1; i <= 200; i++) {
      t.replicas.receive(op(i, { type: "item.appendText", itemId: "i0", text: `${i % 10}` }));
    }
    expect(t.updates()).toBe(base); // nothing applied yet
    expect(t.frames.pending()).toBe(1);
    expect(t.vm()?.timeline[0]).toEqual(assistant("i0"));

    t.frames.run();
    expect(t.updates()).toBe(base + 1);
    const item = t.vm()?.timeline[0];
    expect(item?.kind === "assistant" && item.text.length).toBe(200);
  });

  test("a non-text op applies the buffered text first, so order is preserved", async () => {
    const t = setup([
      { snapshot: emptyVm("s1", { status: "streaming", timeline: [assistant("i0")] }), seq: 0 },
    ]);
    await t.replicas.open("s1");
    t.replicas.receive(op(1, { type: "item.appendText", itemId: "i0", text: "abc" }));
    t.replicas.receive(op(2, { type: "item.done", itemId: "i0" }));
    t.replicas.receive(op(3, { type: "status.set", status: "idle" }));
    // No frame has run, yet the structural ops are visible and the text came first.
    expect(t.vm()?.timeline).toEqual([{ kind: "assistant", id: "i0", text: "abc", done: true }]);
    expect(t.vm()?.status).toBe("idle");
    t.frames.run(); // the leftover frame is a no-op
    expect(t.vm()?.timeline).toEqual([{ kind: "assistant", id: "i0", text: "abc", done: true }]);
  });

  test("deltas for different sessions flush together in one frame", async () => {
    const t = setup([
      { snapshot: emptyVm("a", { timeline: [assistant("i0")] }), seq: 0 },
      { snapshot: emptyVm("b", { timeline: [assistant("i0")] }), seq: 0 },
    ]);
    await t.replicas.open("a");
    await t.replicas.open("b");
    t.replicas.receive(op(1, { type: "item.appendText", itemId: "i0", text: "x" }, "a"));
    t.replicas.receive(op(1, { type: "item.appendText", itemId: "i0", text: "y" }, "b"));
    expect(t.frames.pending()).toBe(1);
    t.frames.run();
    expect(t.vm("a")?.timeline[0]).toMatchObject({ text: "x" });
    expect(t.vm("b")?.timeline[0]).toMatchObject({ text: "y" });
  });
});
