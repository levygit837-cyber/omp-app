import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { type OmpHost, startOmpHost } from "../src/omp-host";
import { RequestRegistry } from "../src/request-registry";
import { attachSession } from "../src/session-bridge";
import { SessionStore } from "../src/session-store";
import { registerEchoModel, startEchoModel, useEchoModel } from "./fixtures/echo-model";

setDefaultTimeout(60_000);

let root: string;
let host: OmpHost;
let model: ReturnType<typeof startEchoModel>;
const store = new SessionStore();
const requests = new RequestRegistry(store);
const sessions: AgentSession[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

/** Both turns are inside the model call before either is answered: the sessions truly overlap. */
const bothAsked = Promise.withResolvers<void>();
let asked = 0;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-turns-")));
  const agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  model = startEchoModel(() => {
    if (++asked === 2) bothAsked.resolve();
    return bothAsked.promise;
  });
  registerEchoModel(agentDir, model.port);
  setAgentDir(agentDir);
  // Settings are a process-wide singleton: this file needs its own agent dir, not the first one loaded.
  resetSettingsForTest();
  host = await startOmpHost({
    requests,
    onSessionCreated: (session) => {
      sessions.push(session);
      attachSession(store, session, requests);
    },
    onMcpFailure: () => {},
  });
});

afterAll(async () => {
  model?.stop(true);
  await host?.close();
  resetSettingsForTest();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("two real sessions run a turn each at the same time and keep their own timelines", async () => {
  const dirs = ["one", "two"].map((name) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  const [a, b] = await Promise.all(dirs.map((dir) => host.createSession(dir)));
  expect(a).not.toBe(b);
  for (const session of sessions.slice(-2)) {
    await useEchoModel(session);
  }

  // Prompt one, then the other: neither can finish until both are inside the model call.
  const stops = await Promise.all([
    host.prompt(a as string, "alpha question"),
    host.prompt(b as string, "beta question"),
  ]);
  expect(stops).toEqual(["end_turn", "end_turn"]);

  const textOf = (id: string) =>
    store
      .snapshot(id)
      .snapshot.timeline.map((i) =>
        i.kind === "user" || i.kind === "assistant" ? `${i.kind}:${i.text}` : i.kind,
      )
      .join("|");
  expect(textOf(a as string)).toBe("user:alpha question|assistant:echo alpha question");
  expect(textOf(b as string)).toBe("user:beta question|assistant:echo beta question");
  expect(store.snapshot(a as string).snapshot.status).toBe("idle");
  expect(store.snapshot(b as string).snapshot.status).toBe("idle");
});
