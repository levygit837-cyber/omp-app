import { describe, expect, test } from "bun:test";
import { PLAN_BUSY_MESSAGE } from "@omp-app/protocol";
import { PlanSessions, planHandlers } from "../src/plan-handlers";
import type { PlanSession } from "../src/plan-state";
import { emptyViewModel } from "../src/reducer";
import { SessionStore } from "../src/session-store";

type Mode = { enabled: boolean; planFilePath: string; reentry: boolean } | undefined;

// A stand-in for the AgentSession: the real one is exercised in plan-mode.test.ts.
function standIn(id: string): PlanSession & { mode: Mode; isStreaming: boolean } {
  const session = {
    sessionId: id,
    isStreaming: false,
    mode: undefined as Mode,
    getPlanModeState: () => session.mode,
    sessionManager: { getArtifactsDir: () => null, getSessionId: () => id },
  };
  return session;
}

function setup(id = "s1") {
  const store = new SessionStore();
  store.create(emptyViewModel({ id, cwd: "/work", model: null }));
  const session = standIn(id);
  const sessions = new PlanSessions((sid) => store.has(sid));
  sessions.add(session);
  const calls: [string, boolean][] = [];
  const dismissed: string[] = [];
  // Like omp's mode switch: it awaits, and entering again flags a re-entry.
  const control = {
    async setPlanMode(sessionId: string, enabled: boolean) {
      calls.push([sessionId, enabled]);
      await Bun.sleep(5);
      const previous = session.mode;
      session.mode = enabled
        ? { enabled: true, planFilePath: "local://PLAN.md", reentry: previous !== undefined }
        : undefined;
    },
  };
  const requests = { dismissSession: (sid: string) => void dismissed.push(sid) };
  const handlers = planHandlers(control, store, sessions, requests);
  return { store, session, sessions, calls, dismissed, handlers };
}
const client = {} as never;

describe("PlanSessions", () => {
  test("the newest registration of an id replaces the older: a resumed session is found, not the closed one", () => {
    const store = new SessionStore();
    store.create(emptyViewModel({ id: "s1", cwd: "/work", model: null }));
    const sessions = new PlanSessions((id) => store.has(id));
    const closed = standIn("s1");
    const resumed = standIn("s1");
    sessions.add(closed);
    // close, then resume: the store has the id again before the registry hears of it
    store.remove("s1");
    store.create(emptyViewModel({ id: "s1", cwd: "/work", model: null }));
    sessions.add(resumed);
    expect(sessions.find("s1")).toBe(resumed);
  });

  test("a session that left the store is forgotten", () => {
    const { store, sessions } = setup();
    store.remove("s1");
    expect(sessions.find("s1")).toBeUndefined();
  });
});

describe("session.setPlanMode", () => {
  test("a toggle reaches omp and the view model", async () => {
    const { store, calls, handlers } = setup();
    await handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client);
    expect(calls).toEqual([["s1", true]]);
    expect(store.snapshot("s1").snapshot.plan).toEqual({
      enabled: true,
      planFile: "local://PLAN.md",
    });
  });

  test("asking for the state the session is already in does not call omp", async () => {
    const { calls, handlers } = setup();
    await handlers["session.setPlanMode"]({ sessionId: "s1", enabled: false }, client);
    await handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client);
    await handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client);
    expect(calls).toEqual([["s1", true]]);
  });

  test("two enables at once are one entry, not a re-entry", async () => {
    const { session, calls, handlers } = setup();
    await Promise.all([
      handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client),
      handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client),
    ]);
    expect(calls).toEqual([["s1", true]]);
    expect(session.mode?.reentry).toBe(false);
  });

  test("a switch is refused while a turn runs, in either direction, and nothing changes", async () => {
    const { store, session, calls, handlers } = setup();
    store.dispatch("s1", { type: "agent_start" } as never);
    expect(store.snapshot("s1").snapshot.status).toBe("streaming");
    await expect(
      handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client),
    ).rejects.toThrow(PLAN_BUSY_MESSAGE);
    session.mode = { enabled: true, planFilePath: "local://PLAN.md", reentry: false };
    store.setPlan("s1", { enabled: true, planFile: "local://PLAN.md" });
    await expect(
      handlers["session.setPlanMode"]({ sessionId: "s1", enabled: false }, client),
    ).rejects.toThrow(PLAN_BUSY_MESSAGE);
    expect(calls).toEqual([]);
    expect(store.snapshot("s1").snapshot.plan.enabled).toBe(true);
  });

  test("a turn omp reports as running refuses the switch even before the store has seen it", async () => {
    const { store, session, calls, handlers } = setup();
    session.isStreaming = true;
    expect(store.snapshot("s1").snapshot.status).not.toBe("streaming");
    await expect(
      handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client),
    ).rejects.toThrow(PLAN_BUSY_MESSAGE);
    expect(calls).toEqual([]);
  });

  test("turning it off with a question waiting withdraws the question first and switches twice", async () => {
    const { store, calls, dismissed, handlers } = setup();
    await handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client);
    store.addRequest("s1", {
      kind: "ask",
      id: "r1",
      message: "Approve plan?",
      fields: [],
    } as never);
    calls.length = 0;
    await handlers["session.setPlanMode"]({ sessionId: "s1", enabled: false }, client);
    expect(dismissed).toEqual(["s1"]);
    expect(calls).toEqual([
      ["s1", false],
      ["s1", false],
    ]);
  });

  test("turning it off with nothing waiting leaves the requests alone and switches once", async () => {
    const { calls, dismissed, handlers } = setup();
    await handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client);
    calls.length = 0;
    await handlers["session.setPlanMode"]({ sessionId: "s1", enabled: false }, client);
    expect(dismissed).toEqual([]);
    expect(calls).toEqual([["s1", false]]);
  });

  test("when omp refuses, the view model is left alone and the error goes to the caller", async () => {
    const store = new SessionStore();
    store.create(emptyViewModel({ id: "s1", cwd: "/work", model: null }));
    const sessions = new PlanSessions((id) => store.has(id));
    sessions.add(standIn("s1"));
    const handlers = planHandlers(
      {
        setPlanMode: async () => {
          throw new Error("Unsupported ACP mode: plan");
        },
      },
      store,
      sessions,
      { dismissSession: () => {} },
    );
    await expect(
      handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client),
    ).rejects.toThrow("Unsupported ACP mode: plan");
    expect(store.snapshot("s1").snapshot.plan).toEqual({ enabled: false, planFile: null });
  });

  test("a failed switch does not block the next one on the same session", async () => {
    const store = new SessionStore();
    store.create(emptyViewModel({ id: "s1", cwd: "/work", model: null }));
    const sessions = new PlanSessions((id) => store.has(id));
    const session = standIn("s1");
    sessions.add(session);
    let fail = true;
    const handlers = planHandlers(
      {
        setPlanMode: async () => {
          if (fail) throw new Error("boom");
          session.mode = { enabled: true, planFilePath: "local://PLAN.md", reentry: false };
        },
      },
      store,
      sessions,
      { dismissSession: () => {} },
    );
    await expect(
      handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client),
    ).rejects.toThrow("boom");
    fail = false;
    await handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client);
    expect(store.snapshot("s1").snapshot.plan.enabled).toBe(true);
  });

  test("a session that moved to a new file is still found under the id the window holds", async () => {
    const { store, session, calls, handlers } = setup();
    // omp moves the session when another process owns its file (#13): both ids change.
    (session as { sessionId: string }).sessionId = "s2";
    store.rekey("s1", "s2");
    await handlers["session.setPlanMode"]({ sessionId: "s1", enabled: true }, client);
    expect(calls).toEqual([["s2", true]]);
    expect(store.snapshot("s2").snapshot.plan.enabled).toBe(true);
  });

  test("an unknown or closed session is refused with the shared message", async () => {
    const { store, handlers } = setup();
    await expect(
      handlers["session.setPlanMode"]({ sessionId: "nope", enabled: true }, client),
    ).rejects.toThrow("unknown session");
    store.remove("s1");
    await expect(handlers["session.readPlan"]({ sessionId: "s1" }, client)).rejects.toThrow(
      "unknown session",
    );
  });
});

describe("session.readPlan", () => {
  test("a session with no plan folder has no plan", async () => {
    const { handlers } = setup();
    expect(await handlers["session.readPlan"]({ sessionId: "s1" }, client)).toEqual({
      state: "missing",
    });
  });
});
