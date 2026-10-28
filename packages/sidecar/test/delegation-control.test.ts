import { describe, expect, test } from "bun:test";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { STOP_FAILED_MESSAGE, UNKNOWN_SESSION_MESSAGE } from "@omp-app/protocol";
import {
  createOmpSubagents,
  DelegationRegistry,
  JOB_POLL_MS,
  type LiveSubagent,
  type SubagentControl,
  trackDelegation,
} from "../src/delegation";
import { delegationHandlers } from "../src/delegation-handlers";
import { emptyViewModel } from "../src/reducer";
import { RequestRegistry } from "../src/request-registry";
import type { ClientHandle } from "../src/server";
import { SESSION_CAPABILITIES, sessionHandlers } from "../src/session-handlers";
import { SessionStore } from "../src/session-store";
import { noActions } from "./fixtures/no-actions";
import { noCommands } from "./fixtures/no-commands";
import { noPromptControls } from "./harness";

const LIFECYCLE = "task:subagent:lifecycle";
const SESSION_ID = "parent";
const AGENT_ID = "parent-agent";

const started = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent: "task",
  agentSource: "bundled",
  status: "started",
  sessionFile: `/work/${id}.jsonl`,
  index: 0,
  ...extra,
});

/** A scripted stand-in for the registry/lifecycle calls that stop a subagent. */
function fakeControl(live: Record<string, LiveSubagent>) {
  const killed: string[] = [];
  const control: SubagentControl = {
    find: (id) => live[id],
    kill: async (id) => {
      killed.push(id);
      return true;
    },
  };
  return { control, killed };
}

const running = (over: Partial<LiveSubagent> = {}): LiveSubagent => ({
  kind: "sub",
  status: "running",
  parentId: AGENT_ID,
  sessionFile: "/work/A.jsonl",
  hasSession: true,
  ...over,
});

function job(over: Partial<AsyncJob>): AsyncJob {
  return {
    id: "job-1",
    type: "bash",
    status: "running",
    startTime: 1000,
    label: "sleep 25",
    ownerId: AGENT_ID,
    ...over,
  } as AsyncJob;
}

function setup(options: { live?: Record<string, LiveSubagent>; jobs?: AsyncJob[] } = {}) {
  const store = new SessionStore();
  store.create(emptyViewModel({ id: SESSION_ID, cwd: "/work", model: null }));
  const bus = new EventBus();
  const registry = new DelegationRegistry();
  const jobs = options.jobs ?? [];
  const cancelled: string[] = [];
  const session = {
    getAgentId: () => AGENT_ID,
    sessionManager: { getCwd: () => "/work" },
    asyncJobManager: {
      getRunningJobs: () => jobs.filter((j) => j.status === "running"),
      getRecentJobs: () => jobs.filter((j) => j.status !== "running"),
    },
    // Records every call that reaches omp, whatever omp would answer.
    cancelAsyncJob: (id: string) => {
      cancelled.push(id);
      const target = jobs.find((j) => j.id === id);
      if (!target) return false;
      target.status = "cancelled";
      return true;
    },
  } as unknown as AgentSession;
  const { control, killed } = fakeControl(options.live ?? {});
  const delegation = trackDelegation(
    store,
    session,
    { bus, registry, subagents: control },
    () => SESSION_ID,
  );
  registry.add(() => SESSION_ID, delegation, store);
  const view = () => store.snapshot(SESSION_ID).snapshot;
  return { store, bus, registry, delegation, killed, cancelled, jobs, view };
}

describe("killing a subagent", () => {
  test("a running subagent of the session is released, ends aborted, and a late frame does not reopen it", () => {
    const t = setup({ live: { A: running() } });
    t.bus.emit(LIFECYCLE, started("A"));
    expect(t.view().subagents[0]?.status).toBe("running");
    return t.delegation.cancelSubagent("A").then((result) => {
      expect(result).toBe(true);
      expect(t.killed).toEqual(["A"]);
      expect(t.view().subagents[0]?.status).toBe("aborted");
      expect(t.view().subagents[0]?.endedAt).toBeDefined();
      // omp's executor still publishes its own final frame; the kill stands.
      t.bus.emit(LIFECYCLE, started("A", { status: "completed" }));
      expect(t.view().subagents[0]?.status).toBe("aborted");
    });
  });

  // omp announces `started` again when it runs a follow-up turn of a subagent it kept alive
  // (`executor.ts:3783` [V]): that is a new run, and the person must be able to stop it.
  test("a subagent that finished and starts again is running again and can be stopped", async () => {
    const t = setup({ live: { A: running() } });
    t.bus.emit(LIFECYCLE, started("A"));
    t.bus.emit(LIFECYCLE, started("A", { status: "completed" }));
    expect(t.view().subagents[0]?.status).toBe("completed");
    expect(t.view().subagents[0]?.endedAt).toBeDefined();

    t.bus.emit(LIFECYCLE, started("A"));
    expect(t.view().subagents[0]?.status).toBe("running");
    expect(t.view().subagents[0]?.endedAt).toBeUndefined();

    expect(await t.delegation.cancelSubagent("A")).toBe(true);
    expect(t.killed).toEqual(["A"]);
    expect(t.view().subagents[0]?.status).toBe("aborted");
  });

  test("a started frame after a kill does not bring the subagent back", async () => {
    const t = setup({ live: { A: running() } });
    t.bus.emit(LIFECYCLE, started("A"));
    await t.delegation.cancelSubagent("A");
    t.bus.emit(LIFECYCLE, started("A"));
    expect(t.view().subagents[0]?.status).toBe("aborted");
    expect(t.view().subagents[0]?.endedAt).toBeDefined();
    expect(await t.delegation.cancelSubagent("A")).toBe(false);
  });

  test("a view of a killed subagent is idle, not stuck streaming", async () => {
    const t = setup({ live: { A: running() } });
    t.bus.emit(LIFECYCLE, started("A"));
    t.bus.emit("task:subagent:event", { id: "A", event: { type: "agent_start" } });
    const viewId = t.view().subagents[0]?.viewId ?? "";
    expect(t.store.snapshot(viewId).snapshot.status).toBe("streaming");
    await t.delegation.cancelSubagent("A");
    expect(t.store.snapshot(viewId).snapshot.status).toBe("idle");
  });

  const refused: [string, Record<string, LiveSubagent>][] = [
    ["omp does not know it", {}],
    ["it is not a subagent", { A: running({ kind: "main" }) }],
    ["it already went idle", { A: running({ status: "idle" }) }],
    ["it holds no live session", { A: running({ hasSession: false }) }],
    ["another parent owns it", { A: running({ parentId: "someone-else" }) }],
    ["the id is reused by a different transcript", { A: running({ sessionFile: "/other.jsonl" }) }],
  ];
  for (const [name, live] of refused) {
    test(`is refused and kills nothing when ${name}`, async () => {
      const t = setup({ live });
      t.bus.emit(LIFECYCLE, started("A"));
      expect(await t.delegation.cancelSubagent("A")).toBe(false);
      expect(t.killed).toEqual([]);
      expect(t.view().subagents[0]?.status).toBe("running");
    });
  }

  test("a nested subagent can be killed through the one that spawned it", async () => {
    const t = setup({
      live: { A: running(), B: running({ parentId: "A", sessionFile: "/work/B.jsonl" }) },
    });
    t.bus.emit(LIFECYCLE, started("A"));
    t.bus.emit(LIFECYCLE, started("B"));
    expect(t.view().subagents.find((s) => s.id === "B")?.parentId).toBe("A");
    expect(await t.delegation.cancelSubagent("B")).toBe(true);
  });

  test("an id the session never saw is refused, and so is one that already ended", async () => {
    const t = setup({ live: { A: running() } });
    expect(await t.delegation.cancelSubagent("A")).toBe(false);
    t.bus.emit(LIFECYCLE, started("A"));
    t.bus.emit(LIFECYCLE, started("A", { status: "completed" }));
    expect(await t.delegation.cancelSubagent("A")).toBe(false);
    expect(t.killed).toEqual([]);
  });
});

describe("background jobs", () => {
  test("only the session's own jobs are listed, tasks are left to the subagent list, and a poll changes the view", async () => {
    const t = setup({
      jobs: [
        job({ id: "mine" }),
        job({ id: "as-subagent", type: "task" }),
        job({ id: "done", status: "completed", endTime: 3000, label: "make" }),
      ],
    });
    await Bun.sleep(JOB_POLL_MS + 200);
    expect(t.view().jobs.map((j) => [j.id, j.status])).toEqual([
      ["mine", "running"],
      ["done", "completed"],
    ]);
  });

  test("a cancel reaches omp only for a job the view shows running, and the list updates at once", async () => {
    const t = setup({ jobs: [job({ id: "mine" }), job({ id: "done", status: "completed" })] });
    await Bun.sleep(JOB_POLL_MS + 200);
    expect(t.delegation.cancelJob("nope")).toBe(false);
    expect(t.delegation.cancelJob("done")).toBe(false);
    expect(t.cancelled).toEqual([]);
    expect(t.delegation.cancelJob("mine")).toBe(true);
    expect(t.cancelled).toEqual(["mine"]);
    expect(t.view().jobs.find((j) => j.id === "mine")?.status).toBe("cancelled");
  });

  test("closing the session stops the polling", async () => {
    const t = setup({ jobs: [job({ id: "mine" })] });
    await Bun.sleep(JOB_POLL_MS + 200);
    t.store.remove(SESSION_ID);
    // A poll after the close would throw on the missing entry; the timer is gone instead.
    t.jobs.push(job({ id: "late" }));
    await Bun.sleep(JOB_POLL_MS + 200);
    expect(t.store.has(SESSION_ID)).toBe(false);
  });
});

describe("the requests", () => {
  const client = {} as ClientHandle;
  function wired() {
    const t = setup({ live: { A: running() } });
    t.bus.emit(LIFECYCLE, started("A"));
    const requests = new RequestRegistry(t.store);
    const control = {
      ...noPromptControls,
      ...noCommands,
      ...noActions,
      list: async () => [],
      createSession: async () => "x",
      resumeSession: async () => "x",
      forkSession: async () => "x",
      closeSession: async () => {},
      prompt: async () => "end_turn",
      cancel: async () => {},
    };
    return {
      ...t,
      session: sessionHandlers(control, t.store, requests),
      delegated: delegationHandlers(t.registry, t.store),
    };
  }

  test("kill goes through its own request; unknown sessions and views are refused", async () => {
    const t = wired();
    const viewId = t.view().subagents[0]?.viewId ?? "";
    expect(
      await t.delegated["subagent.cancel"]({ sessionId: SESSION_ID, subagentId: "A" }, client),
    ).toEqual({
      cancelled: true,
    });
    for (const sessionId of ["missing", viewId]) {
      await expect(
        t.delegated["subagent.cancel"]({ sessionId, subagentId: "A" }, client),
      ).rejects.toThrow(UNKNOWN_SESSION_MESSAGE);
      await expect(t.delegated["job.cancel"]({ sessionId, jobId: "j" }, client)).rejects.toThrow(
        UNKNOWN_SESSION_MESSAGE,
      );
    }
  });

  test("Esc on the parent does not touch its subagents; a view can be subscribed to", async () => {
    const t = wired();
    const viewId = t.view().subagents[0]?.viewId ?? "";
    await t.session["session.cancel"]({ sessionId: SESSION_ID }, client);
    expect(t.killed).toEqual([]);
    expect(t.view().subagents[0]?.status).toBe("running");

    const sub = await t.session["session.subscribe"]({ sessionId: viewId }, {
      emit: () => {},
    } as unknown as ClientHandle);
    expect(sub.snapshot.id).toBe(viewId);
  });

  // A subagent's view is read-only: every request that drives a session refuses its id as unknown.
  // One case per method, so a handler that stops checking is named by the test that fails.
  const drivingArgs: Record<string, object> = {
    "session.prompt": { text: "hi" },
    "session.cancel": {},
    "session.close": {},
    "session.fork": {},
    "session.resume": {},
    "session.answerPermission": { requestId: "r", optionId: "o" },
    "session.answerAsk": { requestId: "r", action: "cancel" },
    "session.models": {},
    "session.setModel": { model: "p/m" },
    "session.setThinking": { level: "low" },
    "session.removeQueued": { queue: "followUp", text: "x" },
    "session.files": { query: "" },
    "session.commands": {},
    "session.runCommand": { text: "/usage" },
    "session.clearContext": { confirmed: true },
    "session.deletePreview": {},
    "session.delete": { confirmed: true },
    "agents.setPaused": { paused: true, confirmed: true },
  };
  // Methods that take a session id and are allowed on a view, or take none.
  const notDriving = [
    "session.subscribe",
    "session.unsubscribe",
    "session.create",
    "session.list",
    "agents.pauseState",
  ];

  test("every session request is classified here, so a new one cannot skip the view check", () => {
    expect([...Object.keys(drivingArgs), ...notDriving].sort()).toEqual(
      [...SESSION_CAPABILITIES].sort(),
    );
  });

  for (const [method, args] of Object.entries(drivingArgs)) {
    test(`${method} refuses a subagent view as an unknown session`, async () => {
      const t = wired();
      const viewId = t.view().subagents[0]?.viewId ?? "";
      const handlers = t.session as unknown as Record<
        string,
        (params: object, client: ClientHandle) => Promise<unknown>
      >;
      await expect(handlers[method]?.({ sessionId: viewId, ...args }, client)).rejects.toThrow(
        UNKNOWN_SESSION_MESSAGE,
      );
    });
  }
});

/** A stand-in for omp's registry and lifecycle manager with the one behavior that matters here: `release` detaches the session before its first await. */
function fakeOmp(
  options: { releaseFails?: boolean; abortFails?: boolean; releases?: boolean } = {},
) {
  const aborts: string[] = [];
  const ref = {
    kind: "sub",
    status: "running",
    parentId: AGENT_ID,
    sessionFile: "/work/A.jsonl",
    session: {
      abort: async ({ reason }: { reason: string }) => {
        aborts.push(reason);
        if (options.abortFails) throw new Error("abort exploded");
      },
    } as { abort(o: { reason: string }): Promise<void> } | null,
  };
  const registry = new Map([["A", ref]]);
  const control = createOmpSubagents({
    registry: () => registry,
    lifecycle: () => ({
      release: async (id, expected) => {
        // Synchronous part of omp's release (agent-lifecycle.ts:567): detach, then publish.
        expected.session = null;
        expected.status = "aborted";
        await Promise.resolve();
        if (options.releaseFails) throw new Error("tombstone write failed");
        return options.releases ?? registry.has(id);
      },
    }),
    abortReason: "user",
  });
  return { control, ref, aborts };
}

describe("the real kill sequence", () => {
  test("aborts the run even though release detaches the session first", async () => {
    const omp = fakeOmp();
    expect(await omp.control.kill("A")).toBe(true);
    expect(omp.aborts).toEqual(["user"]);
  });

  test("an unknown or already detached subagent is not killed", async () => {
    const omp = fakeOmp();
    expect(await omp.control.kill("nope")).toBe(false);
    omp.ref.session = null;
    expect(await omp.control.kill("A")).toBe(false);
    expect(omp.aborts).toEqual([]);
  });

  test("a failed tombstone write or abort is thrown, not swallowed", async () => {
    await expect(fakeOmp({ releaseFails: true }).control.kill("A")).rejects.toThrow("tombstone");
    await expect(fakeOmp({ abortFails: true }).control.kill("A")).rejects.toThrow("abort exploded");
  });
});

describe("a kill that fails", () => {
  const failing = (kill: () => Promise<boolean>, after: () => LiveSubagent | undefined) => {
    let calls = 0;
    const control: SubagentControl = {
      find: () => (calls === 0 ? running() : after()),
      kill: async () => {
        calls++;
        return kill();
      },
    };
    return control;
  };
  const withControl = (control: SubagentControl) => {
    const store = new SessionStore();
    store.create(emptyViewModel({ id: SESSION_ID, cwd: "/work", model: null }));
    const bus = new EventBus();
    const delegation = trackDelegation(
      store,
      {
        getAgentId: () => AGENT_ID,
        sessionManager: { getCwd: () => "/work" },
      } as unknown as AgentSession,
      { bus, registry: new DelegationRegistry(), subagents: control },
      () => SESSION_ID,
    );
    bus.emit(LIFECYCLE, started("A"));
    return { delegation, status: () => store.snapshot(SESSION_ID).snapshot.subagents[0]?.status };
  };

  test("still running afterwards: the node stays running and the person gets a sentence key", async () => {
    const t = withControl(
      failing(
        () => Promise.reject(new Error("abort exploded")),
        () => running(),
      ),
    );
    await expect(t.delegation.cancelSubagent("A")).rejects.toThrow(STOP_FAILED_MESSAGE);
    expect(t.status()).toBe("running");
  });

  test("gone afterwards (omp detaches and disposes even when the tombstone write fails): the node ends aborted", async () => {
    const t = withControl(
      failing(
        () => Promise.reject(new Error("tombstone write failed")),
        () => running({ status: "aborted", hasSession: false }),
      ),
    );
    expect(await t.delegation.cancelSubagent("A")).toBe(true);
    expect(t.status()).toBe("aborted");
  });
});
