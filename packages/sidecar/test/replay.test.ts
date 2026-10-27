import { describe, expect, test } from "bun:test";
import { applyOp, type SessionOpEvent } from "@omp-app/protocol";
import { emptyViewModel } from "../src/reducer";
import { SessionStore } from "../src/session-store";
import { type Fixture, loadFixture, readGolden, updatingGoldens, writeGolden } from "./replay";

const SCENARIOS = [
  "basic",
  "cancel",
  "tools",
  "failures",
  "search",
  "todo",
  "thinking",
  "compaction",
] as const;

/** One tick per event, from a fixed origin: durations in the goldens are stable. */
export function tickingClock(origin = 1_000_000, step = 100): () => number {
  let t = origin - step;
  return () => (t += step);
}

export function newStore(fixture: Fixture): SessionStore {
  const store = new SessionStore(tickingClock());
  store.create(
    emptyViewModel({
      id: fixture.header.sessionId,
      cwd: fixture.header.cwd,
      model: fixture.header.model,
    }),
  );
  return store;
}

describe("reducer replay of events recorded from the pinned omp", () => {
  for (const name of SCENARIOS) {
    test(`${name}: op sequence and final snapshot match the golden`, async () => {
      const fixture = await loadFixture(name);
      const id = fixture.header.sessionId;
      const store = newStore(fixture);
      const ops: SessionOpEvent[] = [];
      store.subscribe(id, "test", (event) => ops.push(event));

      for (const event of fixture.events) store.dispatch(id, event);

      if (updatingGoldens) await writeGolden(name, { ops, final: store.snapshot(id) });
      const golden = await readGolden(name);
      expect(ops).toEqual(golden.ops as SessionOpEvent[]);
      expect(store.snapshot(id)).toEqual(golden.final);
      expect(ops.map((o) => o.seq)).toEqual(ops.map((_, i) => i + 1));
    });

    test(`${name}: snapshot taken at any point plus the following ops equals the final state`, async () => {
      const fixture = await loadFixture(name);
      const id = fixture.header.sessionId;
      const reference = newStore(fixture);
      for (const event of fixture.events) reference.dispatch(id, event);

      for (let cut = 0; cut <= fixture.events.length; cut++) {
        const store = newStore(fixture);
        for (const event of fixture.events.slice(0, cut)) store.dispatch(id, event);
        const late: SessionOpEvent[] = [];
        const start = store.subscribe(id, "late", (event) => late.push(event));
        for (const event of fixture.events.slice(cut)) store.dispatch(id, event);

        // No op is lost or repeated across the snapshot boundary.
        expect(late.map((o) => o.seq)).toEqual(late.map((_, i) => start.seq + 1 + i));
        const replica = late.reduce((vm, o) => applyOp(vm, o.op), start.snapshot);
        expect(replica).toEqual(reference.snapshot(id).snapshot);
      }
    });
  }

  test("cancelled run ends idle with the partial answer kept and closed", async () => {
    const fixture = await loadFixture("cancel");
    const id = fixture.header.sessionId;
    const store = newStore(fixture);
    for (const event of fixture.events) store.dispatch(id, event);
    const { snapshot } = store.snapshot(id);
    expect(snapshot.status).toBe("idle");
    const last = snapshot.timeline.at(-1);
    expect(last).toMatchObject({ kind: "assistant", done: true });
    expect(last?.kind === "assistant" && last.text.startsWith("1\n2\n3")).toBe(true);
  });

  test("an unsubscribed sink gets nothing and a throwing sink does not stop the others", async () => {
    const fixture = await loadFixture("basic");
    const id = fixture.header.sessionId;
    const store = newStore(fixture);
    const got: number[] = [];
    store.subscribe(id, "bad", () => {
      throw new Error("sink failure");
    });
    store.subscribe(id, "good", (e) => got.push(e.seq));
    store.subscribe(id, "gone", () => got.push(-1));
    store.unsubscribe(id, "gone");
    for (const event of fixture.events) store.dispatch(id, event);
    expect(got.length).toBeGreaterThan(0);
    expect(got).not.toContain(-1);
  });
});
