import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import type { AskRequest } from "@omp-app/protocol";
import { type OmpHost, startOmpHost } from "../src/omp-host";
import { PlanSessions, planHandlers } from "../src/plan-handlers";
import { planOf } from "../src/plan-state";
import { RequestRegistry } from "../src/request-registry";
import { attachSession } from "../src/session-bridge";
import { SessionStore } from "../src/session-store";

// Real omp, no model: the proposal handler `xd://propose` calls is invoked the way the tool
// calls it, so the approval question travels the same ACP elicitation the app answers.
setDefaultTimeout(60_000);

let root: string;
let host: OmpHost;
const store = new SessionStore();
const requests = new RequestRegistry(store);
const live: AgentSession[] = [];
const planSessions = new PlanSessions((id) => store.has(id));
const savedEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };

// One instance, as in the sidecar: the per-session ordering and the time plan mode was turned on
// live in it.
let built: ReturnType<typeof planHandlers> | undefined;
const handlers = () => {
  built ??= planHandlers(host, store, planSessions, requests);
  return built;
};
const fake = {} as never;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-plan-")));
  const agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  setAgentDir(agentDir);
  resetSettingsForTest();
  host = await startOmpHost({
    requests,
    onSessionCreated: (session) => {
      live.push(session);
      attachSession(store, session, requests);
      planSessions.add(session);
    },
    onMcpFailure: () => {},
  });
});

afterAll(async () => {
  await host?.close();
  resetSettingsForTest();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function newSession() {
  const cwd = join(root, `project-${live.length}`);
  mkdirSync(cwd, { recursive: true });
  const id = await host.createSession(cwd);
  const session = live.at(-1) as AgentSession;
  return { id, session };
}

const planOfStore = (id: string) => store.snapshot(id).snapshot.plan;

/**
 * Writes the plan the agent would have written, in the session's own local root. `modifiedAt`
 * (epoch ms) sets the file's mtime outright: `readPlan` tells an earlier plan from a new one by
 * comparing that mtime with `Date.now()` at the moment plan mode was turned on, and a write in
 * the same millisecond as the toggle can land on either side of it. Pinning the mtime far from
 * the toggle makes the answer independent of the clock and of the file system's timestamp lag.
 */
function writePlan(session: AgentSession, slug: string, body: string, modifiedAt?: number): void {
  const dir = resolveLocalRoot({
    getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
    getSessionId: () => session.sessionManager.getSessionId(),
  });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug}-plan.md`);
  writeFileSync(file, body);
  if (modifiedAt !== undefined) utimesSync(file, modifiedAt / 1000, modifiedAt / 1000);
}

const MINUTE = 60_000;

/** Calls the handler omp installed for `xd://propose` and answers its question. */
async function propose(id: string, session: AgentSession, slug: string, choice: string) {
  const handler = session.peekPlanProposalHandler();
  if (!handler) throw new Error("plan mode has no proposal handler");
  const result = handler(slug);
  let ask: AskRequest | undefined;
  for (let i = 0; i < 200 && !ask; i++) {
    ask = store.snapshot(id).snapshot.pending.find((r): r is AskRequest => r.kind === "ask");
    if (!ask) await Bun.sleep(10);
  }
  if (!ask) throw new Error("the approval question never reached the view model");
  requests.answerAsk(id, ask.id, "accept", { value: choice });
  return { ask, result: await result };
}

describe("plan mode of a real session", () => {
  test("turning it on reaches omp, installs the approval handler and the view model", async () => {
    const { id, session } = await newSession();
    expect(planOfStore(id)).toEqual({ enabled: false, planFile: null });
    expect(session.peekPlanProposalHandler()).toBeUndefined();

    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake);

    expect(session.getPlanModeState()).toMatchObject({ enabled: true });
    // Without this handler a proposal has no approval path (acp-agent.ts:2249, issue #1869 [V]).
    expect(session.peekPlanProposalHandler()).toBeDefined();
    expect(planOfStore(id)).toEqual({ enabled: true, planFile: "local://PLAN.md" });
  });

  test("turning it off clears omp's state, the handler and the view model", async () => {
    const { id, session } = await newSession();
    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake);
    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: false }, fake);

    expect(session.getPlanModeState()).toBeUndefined();
    expect(session.peekPlanProposalHandler()).toBeUndefined();
    expect(planOfStore(id)).toEqual({ enabled: false, planFile: null });
  });

  test("turning it on twice is one entry, not a re-entry", async () => {
    const { id, session } = await newSession();
    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake);
    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake);
    expect(session.getPlanModeState()?.reentry).toBe(false);
  });

  test("the state of each session is its own", async () => {
    const a = await newSession();
    const b = await newSession();
    await handlers()["session.setPlanMode"]({ sessionId: a.id, enabled: true }, fake);
    expect(planOfStore(a.id).enabled).toBe(true);
    expect(planOfStore(b.id).enabled).toBe(false);
    expect(b.session.getPlanModeState()).toBeUndefined();
  });

  test("with omp's plan.enabled setting off, turning it on fails with omp's own message and changes nothing", async () => {
    const { id, session } = await newSession();
    cfgPlanEnabled.override(session.settings, false);
    try {
      await expect(
        handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake),
      ).rejects.toThrow("Unsupported ACP mode: plan");
      expect(session.getPlanModeState()).toBeUndefined();
      expect(planOfStore(id)).toEqual({ enabled: false, planFile: null });
    } finally {
      cfgPlanEnabled.clearOverride(session.settings);
    }
  });

  test("an unknown session is refused with the shared message", async () => {
    await expect(
      handlers()["session.setPlanMode"]({ sessionId: "nope", enabled: true }, fake),
    ).rejects.toThrow("unknown session");
    await expect(handlers()["session.readPlan"]({ sessionId: "nope" }, fake)).rejects.toThrow(
      "unknown session",
    );
  });
});

/** A session on disk with one user turn, the way the CLI would leave it, closed again. */
async function onDisk(cwd: string): Promise<string> {
  const manager = SessionManager.create(cwd);
  await manager.ensureOnDisk();
  manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  await manager.flush();
  const id = manager.getSessionId();
  await manager.close();
  return id;
}

describe("a session closed and resumed under the same id", () => {
  test("plan mode is switched and read on the new session, not the closed one", async () => {
    const cwd = join(root, "resumed");
    mkdirSync(cwd, { recursive: true });
    const id = await onDisk(cwd);
    await host.resumeSession(id);
    const closed = live.at(-1) as AgentSession;
    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake);
    expect(closed.getPlanModeState()).toMatchObject({ enabled: true });

    await host.closeSession(id);
    store.remove(id);
    await host.resumeSession(id);
    const resumed = live.at(-1) as AgentSession;
    expect(resumed).not.toBe(closed);
    expect(resumed.sessionId).toBe(id);
    // omp does not restore plan mode on resume, so the new session starts out of it.
    expect(planOfStore(id)).toEqual({ enabled: false, planFile: null });

    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake);
    expect(resumed.getPlanModeState()).toMatchObject({ enabled: true });
    expect(planOfStore(id).enabled).toBe(true);

    writePlan(resumed, "after-resume", "# After resume\n");
    expect(await handlers()["session.readPlan"]({ sessionId: id }, fake)).toMatchObject({
      state: "ok",
      file: "local://after-resume-plan.md",
    });

    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: false }, fake);
    expect(resumed.getPlanModeState()).toBeUndefined();
    expect(planOfStore(id).enabled).toBe(false);
    await host.closeSession(id);
    store.remove(id);
  });
});

describe("switching while a proposal waits", () => {
  test("turning plan mode off withdraws the question and a late Refine cannot turn it back on", async () => {
    const { id, session } = await newSession();
    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake);
    writePlan(session, "off-while-asked", "# Off while asked\n");
    const result = session.peekPlanProposalHandler()?.("off-while-asked");
    for (let i = 0; i < 200 && store.snapshot(id).snapshot.pending.length === 0; i++) {
      await Bun.sleep(10);
    }
    expect(store.snapshot(id).snapshot.pending).toHaveLength(1);

    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: false }, fake);
    await result;
    await Bun.sleep(100);

    expect(store.snapshot(id).snapshot.pending).toHaveLength(0);
    expect(session.getPlanModeState()).toBeUndefined();
    expect(session.peekPlanProposalHandler()).toBeUndefined();
    expect(planOfStore(id)).toEqual({ enabled: false, planFile: null });
  });

  test("two enables at once leave omp out of re-entry", async () => {
    const { id, session } = await newSession();
    await Promise.all([
      handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake),
      handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake),
    ]);
    expect(session.getPlanModeState()).toMatchObject({ enabled: true, reentry: false });
  });
});

describe("a plan omp re-entered", () => {
  test("is read as earlier when it was written before plan mode was turned on", async () => {
    const { id, session } = await newSession();
    writePlan(session, "old-news", "# Old news\n", Date.now() - MINUTE);
    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake);
    expect(await handlers()["session.readPlan"]({ sessionId: id }, fake)).toMatchObject({
      state: "ok",
      earlier: true,
    });
    writePlan(session, "old-news", "# Old news, rewritten\n", Date.now() + MINUTE);
    expect(await handlers()["session.readPlan"]({ sessionId: id }, fake)).toMatchObject({
      state: "ok",
      earlier: false,
    });
  });
});

describe("a proposal", () => {
  test("the question carries the plan and both choices; reading the plan finds the agent's file", async () => {
    const { id, session } = await newSession();
    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake);
    expect(await handlers()["session.readPlan"]({ sessionId: id }, fake)).toEqual({
      state: "missing",
    });

    // The agent writes its plan a whole turn after the toggle; pin an mtime after `enabledAt`.
    writePlan(session, "rename-loader", "# Rename the loader\n\n1. do it\n", Date.now() + MINUTE);
    const read = await handlers()["session.readPlan"]({ sessionId: id }, fake);
    expect(read).toEqual({
      state: "ok",
      file: "local://rename-loader-plan.md",
      content: "# Rename the loader\n\n1. do it\n",
      earlier: false,
    });

    const { ask } = await propose(id, session, "rename-loader", "Refine plan");
    expect(ask.message).toContain('Approve plan "rename-loader"');
    expect(ask.message).toContain("# Rename the loader");
    expect(ask.fields[0]?.choices?.map((c) => c.value)).toEqual([
      "Approve and execute",
      "Refine plan",
    ]);
  });

  test("approve and execute leaves plan mode and removes the handler", async () => {
    const { id, session } = await newSession();
    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake);
    writePlan(session, "approve-me", "# Approve me\n");

    const { result } = await propose(id, session, "approve-me", "Approve and execute");

    expect(JSON.stringify(result.content)).toContain("Plan mode exited");
    expect(session.getPlanModeState()).toBeUndefined();
    expect(session.peekPlanProposalHandler()).toBeUndefined();
    // omp emits no event for this; the sidecar reads the state after the answer settles.
    store.setPlan(id, planOf(session));
    expect(planOfStore(id)).toEqual({ enabled: false, planFile: null });
    // The file stays where it was and the plan stays the session's reference for the next turn.
    expect(session.getPlanReferencePath()).toBe("local://approve-me-plan.md");
  });

  test("refine keeps plan mode, the handler, and points the next proposal at the reviewed file", async () => {
    const { id, session } = await newSession();
    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake);
    writePlan(session, "refine-me", "# Refine me\n");

    const { result } = await propose(id, session, "refine-me", "Refine plan");

    expect(JSON.stringify(result.content)).toContain("Plan refinement requested");
    expect(session.getPlanModeState()).toMatchObject({
      enabled: true,
      planFilePath: "local://refine-me-plan.md",
    });
    expect(session.peekPlanProposalHandler()).toBeDefined();
  });

  test("declining the question keeps plan mode too", async () => {
    const { id, session } = await newSession();
    await handlers()["session.setPlanMode"]({ sessionId: id, enabled: true }, fake);
    writePlan(session, "decline-me", "# Decline me\n");
    const handler = session.peekPlanProposalHandler();
    const result = handler?.("decline-me");
    let ask: AskRequest | undefined;
    for (let i = 0; i < 200 && !ask; i++) {
      ask = store.snapshot(id).snapshot.pending.find((r): r is AskRequest => r.kind === "ask");
      if (!ask) await Bun.sleep(10);
    }
    requests.answerAsk(id, ask?.id as string, "decline", undefined);
    await result;
    // Closing the dialog never grants write access (acp-agent.ts:2399-2403 [V]).
    expect(session.getPlanModeState()).toMatchObject({ enabled: true });
  });
});
