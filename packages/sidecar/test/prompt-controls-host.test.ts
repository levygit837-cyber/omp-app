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

// A real omp `AgentSession` with a local model held inside its call: the controls that must
// refuse while a turn runs, and the queue that only exists while one does.
setDefaultTimeout(60_000);

let root: string;
let host: OmpHost;
let stopModel: () => void = () => {};
const store = new SessionStore();
const requests = new RequestRegistry(store);
const sessions: AgentSession[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};
/** The model call a test holds the turn in. Each test arms a fresh one before it prompts. */
const arm = () => ({
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
});
let gate = arm();

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-prompt-host-")));
  const agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  const model = startEchoModel(async () => {
    const held = gate;
    held.entered.resolve();
    await held.release.promise;
  });
  stopModel = () => model.stop(true);
  registerEchoModel(agentDir, model.port);
  setAgentDir(agentDir);
  // Settings are a process-wide singleton: this file needs its own agent dir.
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
  gate.release.resolve();
  stopModel();
  await host?.close();
  resetSettingsForTest();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("model and thinking change between turns only, and a queued follow-up can be taken back", async () => {
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const id = await host.createSession(cwd);
  await useEchoModel(sessions.at(-1) as AgentSession);

  expect(host.models(id).map((m) => m.id)).toContain("local-echo/echo");
  host.setThinking(id, "off");

  gate = arm();
  const turn = host.prompt(id, "hold on");
  await gate.entered.promise;

  await expect(host.setModel(id, "local-echo/echo")).rejects.toThrow("session is busy");
  expect(() => host.setThinking(id, "auto")).toThrow("session is busy");

  expect(await host.join(id, "later", [], "followUp")).toBe(true);
  expect(host.removeQueued(id, "followUp", "later")).toBe(true);
  // Already out of the queue: a second removal says so instead of pretending.
  expect(host.removeQueued(id, "followUp", "later")).toBe(false);

  gate.release.resolve();
  expect(await turn).toBe("end_turn");

  // Between turns the same calls go through.
  await host.setModel(id, "local-echo/echo");
  host.setThinking(id, "auto");
  await expect(host.setModel(id, "nope/none")).rejects.toThrow("unknown model");
  expect(() => host.setThinking(id, "bogus")).toThrow("unknown thinking level");
  // A prompt after the turn is a turn of its own: the removed follow-up never ran.
  const users = store
    .snapshot(id)
    .snapshot.timeline.flatMap((i) => (i.kind === "user" ? [i.text] : []));
  expect(users).toEqual(["hold on"]);
});

const userTexts = (id: string) =>
  store.snapshot(id).snapshot.timeline.flatMap((i) => (i.kind === "user" ? [i] : []));

const fileMentions = (session: AgentSession) =>
  session.messages.filter((m) => m.role === "fileMention");

test("an @file in a prompt that starts a turn is read; the same @file in a steer is not", async () => {
  const cwd = join(root, "mentions");
  mkdirSync(cwd, { recursive: true });
  await Bun.write(join(cwd, "note.txt"), "BLUE-HERON-42\n");
  const id = await host.createSession(cwd);
  const session = sessions.at(-1) as AgentSession;
  await useEchoModel(session);

  gate = arm();
  const turn = host.prompt(id, "look at @note.txt");
  await gate.entered.promise;
  // Joined mid-turn: omp queues the raw text (`joinActiveTurn`) and never expands `@` in it.
  expect(await host.join(id, "and again @note.txt", [], "steer")).toBe(true);
  gate.release.resolve();
  expect(await turn).toBe("end_turn");

  // One fileMention, for the prompt that began the turn; none for the steer.
  expect(fileMentions(session)).toHaveLength(1);
  const [first, second] = userTexts(id);
  expect(first).toMatchObject({ text: "look at @note.txt", files: ["note.txt"] });
  expect(second).toMatchObject({ text: "and again @note.txt", steered: true });
  expect(second).not.toHaveProperty("files");
});

test("Stop leaves queued messages queued until they are taken back one by one", async () => {
  const cwd = join(root, "stop");
  mkdirSync(cwd, { recursive: true });
  const id = await host.createSession(cwd);
  const session = sessions.at(-1) as AgentSession;
  await useEchoModel(session);

  gate = arm();
  const turn = host.prompt(id, "hold on");
  await gate.entered.promise;
  expect(await host.join(id, "later", [], "followUp")).toBe(true);
  expect(await host.join(id, "later", [], "followUp")).toBe(true);
  expect(store.snapshot(id).snapshot.queue.followUp).toEqual(["later", "later"]);

  await host.cancel(id);
  gate.release.resolve();
  expect(await turn).toBe("cancelled");

  // The stop reaches the view model a moment after the prompt settles.
  for (let i = 0; i < 100 && store.snapshot(id).snapshot.status !== "idle"; i++)
    await Bun.sleep(20);
  await Bun.sleep(300); // a follow-up that started by itself would show by now

  // omp's cancel only aborts: both follow-ups are still queued and nothing started them.
  expect(store.snapshot(id).snapshot.status).toBe("idle");
  expect(store.snapshot(id).snapshot.queue.followUp).toEqual(["later", "later"]);
  expect(userTexts(id).map((u) => u.text)).toEqual(["hold on"]);

  // What the window does on Stop: take each one back. Duplicates go one per call.
  expect(host.removeQueued(id, "followUp", "later")).toBe(true);
  expect(host.removeQueued(id, "followUp", "later")).toBe(true);
  expect(host.removeQueued(id, "followUp", "later")).toBe(false);
  expect(store.snapshot(id).snapshot.queue.followUp).toEqual([]);
});
