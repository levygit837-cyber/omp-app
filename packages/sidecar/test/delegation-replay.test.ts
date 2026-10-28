import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { applyOp, type SessionOpEvent, type SessionViewModel } from "@omp-app/protocol";
import { DelegationRegistry, trackDelegation } from "../src/delegation";
import { emptyViewModel } from "../src/reducer";
import { SessionStore } from "../src/session-store";
import { fixturesDir } from "./replay";

/** One tick per call from a fixed origin, so times in a replay are stable. */
function ticking(origin = 1_000_000, step = 100): () => number {
  let t = origin - step;
  return () => (t += step);
}

interface Line {
  readonly ch: string;
  readonly data: unknown;
}

async function load(
  name: string,
): Promise<{ header: { sessionId: string; cwd: string; model: string | null }; lines: Line[] }> {
  const rows = (await Bun.file(join(fixturesDir, `${name}.jsonl`)).text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const [header, ...lines] = rows;
  return { header, lines };
}

/** The part of `AgentSession` the tracker reads; a recorded run needs nothing else. */
function standIn(cwd: string, agentId: string | undefined): AgentSession {
  return {
    getAgentId: () => agentId,
    sessionManager: { getCwd: () => cwd },
    asyncJobManager: undefined,
  } as unknown as AgentSession;
}

/** Replays a recorded run: session events into the parent, bus frames onto the bus. */
async function replay(name: string, until = Number.POSITIVE_INFINITY) {
  const { header, lines } = await load(name);
  const store = new SessionStore(ticking());
  const id = header.sessionId;
  store.create(emptyViewModel({ id, cwd: header.cwd, model: header.model }));
  const bus = new EventBus();
  const registry = new DelegationRegistry();
  const parentOps: SessionOpEvent[] = [];
  store.subscribe(id, "test", (e) => parentOps.push(e));
  const delegation = trackDelegation(
    store,
    standIn(header.cwd, "parent-agent"),
    { bus, registry, now: ticking(5_000_000, 1000) },
    () => id,
  );
  registry.add(() => id, delegation, store);
  let n = 0;
  for (const line of lines) {
    if (n++ >= until) break;
    if (line.ch === "session") store.dispatch(id, line.data as AgentSessionEvent);
    else bus.emit(line.ch, line.data);
  }
  return { store, id, bus, registry, parentOps, header };
}

describe("subagent frames recorded from the pinned omp", () => {
  test("the parent lists the subagent, finished, with its description and tokens", async () => {
    const { store, id } = await replay("subagent");
    const { snapshot } = store.snapshot(id);
    expect(snapshot.subagents).toHaveLength(1);
    const sub = snapshot.subagents[0];
    expect(sub?.status).toBe("completed");
    expect(sub?.agent).toBe("task");
    // The wording is the model's, so it is read from the recorded frame that settles the run.
    const settled = (await load("subagent")).lines.find(
      (l) =>
        l.ch === "task:subagent:lifecycle" &&
        (l.data as { status?: string }).status === "completed",
    );
    const said = (settled?.data as { description?: string } | undefined)?.description;
    expect(said).toBeTruthy();
    expect(sub?.description).toBe(said ?? null);
    expect(sub?.tokens).toBeGreaterThan(0);
    expect(sub?.endedAt).toBeGreaterThanOrEqual(sub?.startedAt ?? Number.POSITIVE_INFINITY);
    expect(sub?.parentId).toBeUndefined();
  });

  test("the subagent has its own timeline built by the same reducer, and it ends idle", async () => {
    const { store, id } = await replay("subagent");
    const sub = store.snapshot(id).snapshot.subagents[0];
    if (!sub) throw new Error("no subagent");
    expect(store.isView(sub.viewId)).toBe(true);
    const view = store.snapshot(sub.viewId).snapshot;
    expect(view.status).toBe("idle");
    expect(view.timeline.some((i) => i.kind === "user")).toBe(true);
    const bash = view.timeline.find((i) => i.kind === "tool" && i.tool === "bash");
    expect(bash?.kind === "tool" && bash.calls.every((c) => c.status === "done")).toBe(true);
    const last = view.timeline.findLast((i) => i.kind === "assistant");
    expect(last?.kind === "assistant" && last.done && last.text.length > 0).toBe(true);
    // The main timeline holds none of the subagent's items.
    const main = store.snapshot(id).snapshot.timeline;
    expect(main.some((i) => i.kind === "tool" && i.tool === "bash")).toBe(false);
    expect(main.some((i) => i.kind === "tool" && i.tool === "task")).toBe(true);
  });

  test("a replica built from a late snapshot plus the ops that follow equals the final state, for the parent and the subagent", async () => {
    const reference = await replay("subagent");
    const total = (await load("subagent")).lines.length;
    for (let cut = 0; cut <= total; cut += 7) {
      const partial = await replay("subagent", cut);
      const subId = partial.store.snapshot(partial.id).snapshot.subagents[0]?.viewId;
      const late: SessionOpEvent[] = [];
      const start = partial.store.subscribe(partial.id, "late", (e) => late.push(e));
      const lateView: SessionOpEvent[] = [];
      const startView = subId
        ? partial.store.subscribe(subId, "late", (e) => lateView.push(e))
        : undefined;
      const { lines } = await load("subagent");
      for (const line of lines.slice(cut)) {
        if (line.ch === "session")
          partial.store.dispatch(partial.id, line.data as AgentSessionEvent);
        else partial.bus.emit(line.ch, line.data);
      }
      const rebuilt = late.reduce<SessionViewModel>((vm, o) => applyOp(vm, o.op), start.snapshot);
      expect(rebuilt).toEqual(reference.store.snapshot(reference.id).snapshot);
      expect(late.map((o) => o.seq)).toEqual(late.map((_, i) => start.seq + 1 + i));
      if (startView && subId) {
        const view = lateView.reduce<SessionViewModel>(
          (vm, o) => applyOp(vm, o.op),
          startView.snapshot,
        );
        const refSub = reference.store.snapshot(reference.id).snapshot.subagents[0];
        expect(view).toEqual(reference.store.snapshot(refSub?.viewId ?? "").snapshot);
      }
    }
  });

  test("closing the parent drops the subagent view and every bus listener", async () => {
    const { store, id, bus, registry } = await replay("subagent");
    const viewId = store.snapshot(id).snapshot.subagents[0]?.viewId ?? "";
    expect(store.has(viewId)).toBe(true);
    store.remove(id);
    expect(store.has(viewId)).toBe(false);
    expect(registry.of(id)).toBeUndefined();
    // A frame after the close reaches no one: nothing throws, nothing is created.
    const frames = (await load("subagent")).lines.filter((l) => l.ch !== "session");
    for (const f of frames) bus.emit(f.ch, f.data);
    expect(store.has(viewId)).toBe(false);
  });

  test("a view is not a session: nothing that drives a session accepts it", async () => {
    const { store, id } = await replay("subagent");
    const viewId = store.snapshot(id).snapshot.subagents[0]?.viewId ?? "";
    expect(store.isView(viewId)).toBe(true);
    expect(store.isView(id)).toBe(false);
  });
});
