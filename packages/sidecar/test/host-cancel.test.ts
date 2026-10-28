import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { type OmpHost, startOmpHost } from "../src/omp-host";
import { RequestRegistry } from "../src/request-registry";
import { SessionStore } from "../src/session-store";
import { registerEchoModel, startEchoModel, useEchoModel } from "./fixtures/echo-model";

setDefaultTimeout(60_000);

let root: string;
let host: OmpHost;
let model: ReturnType<typeof startEchoModel>;
const sessions: AgentSession[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

/** The model request arrived: the turn is running. */
const asked = Promise.withResolvers<void>();
/** Holds the turn inside the model call until the test is done looking. */
const hold = Promise.withResolvers<void>();

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-host-cancel-")));
  const agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  model = startEchoModel(() => {
    asked.resolve();
    return hold.promise;
  });
  registerEchoModel(agentDir, model.port);
  setAgentDir(agentDir);
  // Settings are a process-wide singleton: this file needs its own agent dir.
  resetSettingsForTest();
  host = await startOmpHost({
    requests: new RequestRegistry(new SessionStore()),
    onSessionCreated: (session) => {
      sessions.push(session);
    },
    onMcpFailure: () => {},
  });
});

afterAll(async () => {
  hold.resolve();
  model?.stop(true);
  await host?.close();
  resetSettingsForTest();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

// ADR 0001: Esc stops the session's own turn and nothing it delegated in the background (a
// `blocking` agent is inline and ends with the turn; not covered here). Every other test of this
// runs against stubs; this one goes through the real host `cancel` and the real ACP agent.
test("the host's cancel aborts the parent's turn once and leaves a running subagent alone", async () => {
  const dir = join(root, "project");
  mkdirSync(dir, { recursive: true });
  const id = await host.createSession(dir);
  const parent = sessions.at(-1) as AgentSession;
  await useEchoModel(parent);

  // A subagent the registry knows as running, owned by this session, with a session of its own.
  const subAbort = { calls: 0 };
  const subSession = {
    abort: async () => {
      subAbort.calls++;
    },
  } as unknown as AgentSession;
  const registry = AgentRegistry.global();
  const sub = registry.register({
    id: "Delegated",
    displayName: "Delegated",
    kind: "sub",
    parentId: `acp:${parent.sessionId}`,
    session: subSession,
    sessionFile: join(root, "sub.jsonl"),
    status: "running",
  });

  const abort = spyOn(parent, "abort");
  const turn = host.prompt(id, "keep going");
  await asked.promise;

  await host.cancel(id);
  expect(await turn).toBe("cancelled");

  expect(abort).toHaveBeenCalledTimes(1);
  expect(subAbort.calls).toBe(0);
  expect(sub.status).toBe("running");
  expect(sub.session).toBe(subSession);
  expect(registry.get("Delegated")).toBe(sub);
  registry.unregister("Delegated");
});
