import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { type DelegationHooks, DelegationRegistry, trackDelegation } from "../src/delegation";
import { loadPersistedSubagents, type PersistedSubagent } from "../src/persisted-subagents";
import { emptyViewModel } from "../src/reducer";
import { SessionStore } from "../src/session-store";
import { fixturesDir } from "./replay";

let root: string;
let n = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "omp-app-resume-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A root session file path whose artifacts directory exists, laid out like omp's. */
function newSession(): { sessionFile: string; dir: string } {
  const base = join(root, `s${n++}`);
  mkdirSync(base, { recursive: true });
  const dir = join(base, "2026-01-01T00-00-00-000Z_root");
  mkdirSync(dir);
  return { sessionFile: `${dir}.jsonl`, dir };
}

const withTranscript = (name: string): { sessionFile: string } => {
  const { sessionFile, dir } = newSession();
  copyFileSync(join(fixturesDir, "subagent-transcript.jsonl"), join(dir, `${name}.jsonl`));
  return { sessionFile };
};

function standIn(sessionFile: string | undefined): AgentSession {
  return {
    getAgentId: () => "parent-agent",
    sessionManager: { getCwd: () => "/work/project", getSessionFile: () => sessionFile },
    asyncJobManager: undefined,
  } as unknown as AgentSession;
}

/** Waits until the parent lists `count` subagents (the real loader reads files). */
async function until(store: SessionStore, id: string, count: number): Promise<void> {
  for (let i = 0; i < 400 && store.snapshot(id).snapshot.subagents.length < count; i++) {
    await Bun.sleep(5);
  }
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Bun.sleep(0);
};

function track(
  sessionFile: string | undefined,
  extra: Partial<DelegationHooks> = {},
  prepare?: (store: SessionStore, id: string) => void,
) {
  const store = new SessionStore();
  const id = "parent";
  store.create(emptyViewModel({ id, cwd: "/work/project", model: null }));
  prepare?.(store, id);
  const bus = new EventBus();
  const registry = new DelegationRegistry();
  const delegation = trackDelegation(
    store,
    standIn(sessionFile),
    { bus, registry, ...extra },
    () => id,
  );
  return { store, id, bus, delegation };
}

async function liveLines(): Promise<{ ch: string; data: unknown }[]> {
  const rows = (await Bun.file(join(fixturesDir, "subagent.jsonl")).text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  return rows.slice(1);
}

describe("hydrating subagents of a resumed session", () => {
  test("a persisted subagent appears as a finished, read-only view that leaves with the parent", async () => {
    const { sessionFile } = withTranscript("UnitedRaccoon");
    const { store, id } = track(sessionFile);
    await until(store, id, 1);
    const { subagents } = store.snapshot(id).snapshot;
    expect(subagents).toHaveLength(1);
    const sub = subagents[0];
    expect(sub?.id).toBe("UnitedRaccoon");
    expect(sub?.status).toBe("completed");
    expect(sub?.tokens).toBeGreaterThan(0);
    expect(sub?.endedAt).toBeGreaterThanOrEqual(sub?.startedAt ?? Number.POSITIVE_INFINITY);
    expect(sub?.parentId).toBeUndefined();
    const viewId = sub?.viewId ?? "";
    expect(store.isView(viewId)).toBe(true);
    const view = store.snapshot(viewId).snapshot;
    expect(view.status).toBe("idle");
    expect(view.timeline.some((i) => i.kind === "tool" && i.tool === "bash")).toBe(true);
    const last = view.timeline.at(-1);
    expect(last?.kind === "assistant" && last.text).toContain("hello");
    store.remove(id);
    expect(store.has(viewId)).toBe(false);
  });

  test("a failed persisted subagent shows its view as failed", async () => {
    const { store, id } = track("/x/s.jsonl", {
      load: async () => [persisted("Bad", { status: "failed" })],
    });
    await tick();
    const sub = store.snapshot(id).snapshot.subagents[0];
    expect(sub?.status).toBe("failed");
    expect(store.snapshot(sub?.viewId ?? "").snapshot.status).toBe("failed");
  });

  test("the description is the parent's task row label when it has one, else the loader's summary", async () => {
    const lines = await liveLines();
    const label = "Check that echo prints hello";
    /** Replays the parent's session events; `labelled` adds the label omp's HUD generates to the task result. */
    const replayParent = (labelled: boolean) => (store: SessionStore, id: string) => {
      for (const l of lines) {
        if (l.ch !== "session") continue;
        const event = structuredClone(l.data) as {
          type: string;
          toolName?: string;
          result?: { details?: { progress?: { description?: string }[] } };
        };
        if (labelled && event.type === "tool_execution_end" && event.toolName === "task") {
          for (const p of event.result?.details?.progress ?? []) p.description = label;
        }
        store.dispatch(id, event as unknown as AgentSessionEvent);
      }
    };

    // The row holds a label: it wins over the loader's summary.
    const a = track(withTranscript("EchoHello").sessionFile, {}, replayParent(true));
    await until(a.store, a.id, 1);
    expect(a.store.snapshot(a.id).snapshot.subagents[0]?.description).toBe(label);

    // The row only repeats the task text (no label landed): the summary wins.
    const c = track(withTranscript("EchoHello").sessionFile, {}, replayParent(false));
    await until(c.store, c.id, 1);
    expect(c.store.snapshot(c.id).snapshot.subagents[0]?.description).toBe("None; read-only.");

    // No row for this id: the summary.
    const b = track(withTranscript("UnitedRaccoon").sessionFile, {}, replayParent(true));
    await until(b.store, b.id, 1);
    expect(b.store.snapshot(b.id).snapshot.subagents[0]?.description).toBe("None; read-only.");
  });

  test("an id already seen live is neither duplicated nor overwritten, and the others still load", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const gate = gated();
      const { store, id, bus } = track("/x/s.jsonl", { load: gate.load });
      bus.emit("task:subagent:lifecycle", { id: "Live", agent: "task", status: "started" });
      expect(store.snapshot(id).snapshot.subagents[0]?.status).toBe("running");
      gate.open([persisted("Live", { tokens: 99 }), persisted("Old")]);
      await until(store, id, 2);
      const { subagents } = store.snapshot(id).snapshot;
      expect(subagents.map((s) => s.id)).toEqual(["Live", "Old"]);
      expect(subagents[0]?.status).toBe("running");
      expect(subagents[0]?.tokens).toBe(0);
      expect(subagents[1]?.status).toBe("completed");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("a parent closed before the load resolves leaves no view and no write", async () => {
    const { sessionFile } = withTranscript("UnitedRaccoon");
    const gate = gated();
    const { store, id } = track(sessionFile, { load: gate.load });
    const before = store.snapshot(id).snapshot.subagents;
    store.remove(id);
    gate.open(await loadPersistedSubagents(sessionFile));
    await tick();
    expect(before).toEqual([]);
    expect(store.has("view:parent-agent:UnitedRaccoon")).toBe(false);
  });

  test("a throwing loader is logged and the session keeps working", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { store, id } = track("/x/s.jsonl", {
        load: async () => {
          throw new Error("disk gone");
        },
      });
      await tick();
      expect(spy).toHaveBeenCalled();
      expect(store.snapshot(id).snapshot.subagents).toEqual([]);
      store.dispatch(id, { type: "agent_start" } as AgentSessionEvent);
      expect(store.snapshot(id).snapshot.status).toBe("streaming");
    } finally {
      spy.mockRestore();
    }
  });

  test("a session without a file on disk reads nothing", async () => {
    let calls = 0;
    const { store, id } = track(undefined, {
      load: async () => {
        calls++;
        return [];
      },
    });
    await tick();
    expect(calls).toBe(0);
    expect(store.snapshot(id).snapshot.subagents).toEqual([]);
  });
});

function gated() {
  let open!: (v: readonly PersistedSubagent[]) => void;
  const gate = new Promise<readonly PersistedSubagent[]>((r) => {
    open = r;
  });
  return { open, load: () => gate };
}

function persisted(id: string, over: Partial<PersistedSubagent> = {}): PersistedSubagent {
  return {
    id,
    agent: "task",
    description: "summary",
    task: "the task",
    status: "completed",
    startedAt: 1,
    endedAt: 2,
    tokens: 3,
    model: null,
    timeline: [],
    ...over,
  };
}
