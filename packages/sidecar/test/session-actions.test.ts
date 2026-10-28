import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import {
  ACTION_BUSY_MESSAGE,
  decodeFrame,
  FILE_OWNED_MESSAGE,
  FrameDecoder,
  isResponseEnvelope,
  type MethodName,
  type Methods,
  RequestCorrelator,
  type SessionViewModel,
} from "@omp-app/protocol";
import { COMMAND_ENTRY_TYPE } from "../src/command-entries";
import { type OmpHost, startOmpHost } from "../src/omp-host";
import { RequestRegistry } from "../src/request-registry";
import { type Server, startServer } from "../src/server";
import { attachSession } from "../src/session-bridge";
import { sessionHandlers } from "../src/session-handlers";
import { SessionStore } from "../src/session-store";
import { registerEchoModel, startEchoModel, useEchoModel } from "./fixtures/echo-model";

setDefaultTimeout(60_000);

let root: string;
let host: OmpHost;
let server: Server;
let readOnlyServer: Server;
let model: ReturnType<typeof startEchoModel>;
let hold: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let inModel: ReturnType<typeof Promise.withResolvers<void>>;
let modelCalls = 0;
const store = new SessionStore();
const requests = new RequestRegistry(store);
const sessions: AgentSession[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

interface Client {
  request<M extends MethodName>(m: M, p?: Methods[M]["params"]): Promise<Methods[M]["result"]>;
  close(): void;
}

async function connect(socketPath: string): Promise<Client> {
  const correlator = new RequestCorrelator();
  const decoder = new FrameDecoder();
  const text = new TextDecoder();
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        for (const line of decoder.push(text.decode(chunk, { stream: true }))) {
          const frame = decodeFrame(line);
          if (frame.ok && isResponseEnvelope(frame.envelope)) correlator.receive(frame.envelope);
        }
      },
    },
  });
  return {
    request(method, params) {
      const { frame, response } = correlator.create(method, params);
      socket.write(frame);
      return response;
    },
    close: () => void socket.end(),
  };
}

const errorMessage = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: Error) => e.message,
  );

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const view = (id: string): SessionViewModel => store.snapshot(id).snapshot;
const kinds = (id: string) => view(id).timeline.map((i) => i.kind);
const sessionOf = (id: string) =>
  sessions.find((s) => s.sessionManager.getSessionId() === id) as AgentSession;

async function openSession(name: string): Promise<string> {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  const id = await host.createSession(cwd);
  await useEchoModel(sessions.at(-1) as AgentSession);
  return id;
}

/** A session with one finished turn, so its file exists on disk. */
async function openWithTurn(client: Client, name: string): Promise<string> {
  const id = await openSession(name);
  await client.request("session.prompt", { sessionId: id, text: `hello ${name}` });
  await until(() => view(id).status === "idle" && kinds(id).includes("assistant"), "the turn");
  await sessionOf(id).sessionManager.flush();
  return id;
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-actions-")));
  const agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  inModel = Promise.withResolvers();
  model = startEchoModel(async () => {
    modelCalls++;
    inModel.resolve();
    await hold?.promise;
  });
  registerEchoModel(agentDir, model.port);
  setAgentDir(agentDir);
  resetSettingsForTest();
  host = await startOmpHost({
    requests,
    onSessionCreated: (session) => {
      sessions.push(session);
      attachSession(store, session, requests);
    },
    onMcpFailure: () => {},
  });
  const handlers = sessionHandlers(host, store, requests) as never;
  server = startServer(join(root, "s.sock"), handlers, false);
  readOnlyServer = startServer(join(root, "ro.sock"), handlers, true);
});

afterEach(() => {
  // The gate is process-wide: a test that left it engaged would freeze every later one.
  agentPauseGate.resume();
  hold?.resolve();
  hold = undefined;
});

afterAll(async () => {
  server?.stop();
  readOnlyServer?.stop();
  model?.stop(true);
  await host?.close();
  resetSettingsForTest();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

// -- Clear context ------------------------------------------------------------------------------

test("clearContext is refused without the person's answer, and changes nothing", async () => {
  const client = await connect(join(root, "s.sock"));
  const id = await openWithTurn(client, "clear-unconfirmed");
  const before = kinds(id);
  expect(await errorMessage(client.request("session.clearContext", { sessionId: id }))).toStartWith(
    "confirmation required",
  );
  expect(kinds(id)).toEqual(before);
  expect(sessionOf(id).agent.state.messages.length).toBeGreaterThan(0);
  client.close();
});

test("clearContext keeps the timeline above a boundary, empties the agent's memory and keeps the file and id", async () => {
  const client = await connect(join(root, "s.sock"));
  const id = await openWithTurn(client, "clear-ok");
  const session = sessionOf(id);
  const file = session.sessionManager.getSessionFile() as string;
  const messages = session.agent.state.messages.length;
  const seqBefore = store.snapshot(id).seq;

  const result = await client.request("session.clearContext", { sessionId: id, confirmed: true });
  expect(result.dropped).toBe(messages);

  // The chat stays; one line says where the agent's memory ends.
  expect(kinds(id)).toEqual(["user", "assistant", "boundary"]);
  expect(store.snapshot(id).seq).toBeGreaterThan(seqBefore);
  expect(session.agent.state.messages).toHaveLength(0);
  // Same session, same file, and the file says where the boundary is.
  expect(session.sessionManager.getSessionId()).toBe(id);
  expect(session.sessionManager.getSessionFile()).toBe(file);
  await session.sessionManager.flush();
  expect(readFileSync(file, "utf8")).toContain('"type":"reset_boundary"');

  // A turn after the clear sees none of the conversation before it, and the timeline continues.
  await client.request("session.prompt", { sessionId: id, text: "after the clear" });
  await until(() => view(id).status === "idle" && kinds(id).length === 5, "the turn after");
  expect(kinds(id)).toEqual(["user", "assistant", "boundary", "user", "assistant"]);

  // Opened again, the timeline reads the same: the boundary is replayed from the file.
  await client.request("session.close", { sessionId: id });
  const reopened = (await client.request("session.resume", { sessionId: id })).sessionId;
  expect(kinds(reopened)).toEqual(["user", "assistant", "boundary", "user", "assistant"]);
  const boundary = view(reopened).timeline.find((i) => i.kind === "boundary");
  expect(boundary?.kind === "boundary" && boundary.at).toBeGreaterThan(0);
  client.close();
});

test("clearContext is refused while a turn runs, with a sentence, and the turn goes on", async () => {
  const client = await connect(join(root, "s.sock"));
  const id = await openWithTurn(client, "clear-busy");
  hold = Promise.withResolvers();
  inModel = Promise.withResolvers();
  await client.request("session.prompt", { sessionId: id, text: "slow" });
  await inModel.promise;
  expect(view(id).status).toBe("streaming");

  expect(
    await errorMessage(client.request("session.clearContext", { sessionId: id, confirmed: true })),
  ).toBe(ACTION_BUSY_MESSAGE);
  expect(kinds(id)).not.toContain("boundary");

  hold.resolve();
  hold = undefined;
  await until(() => view(id).status === "idle", "the turn to end");
  expect(view(id).timeline.filter((i) => i.kind === "assistant")).toHaveLength(2);
  client.close();
});

test("clearContext answers an unknown id and a read-only sidecar with their own refusals", async () => {
  const client = await connect(join(root, "s.sock"));
  expect(
    await errorMessage(
      client.request("session.clearContext", { sessionId: "nope", confirmed: true }),
    ),
  ).toStartWith("unknown session");
  client.close();
  const ro = await connect(join(root, "ro.sock"));
  for (const [method, params] of [
    ["session.clearContext", { sessionId: "x", confirmed: true }],
    ["session.delete", { sessionId: "x", confirmed: true }],
    ["agents.setPaused", { sessionId: "x", paused: true, confirmed: true }],
  ] as const) {
    expect(await errorMessage(ro.request(method, params as never))).toBe(
      `${method} writes and the shared omp database is newer than this app supports`,
    );
  }
  // Reading is allowed: the question can still be worded.
  expect(await errorMessage(ro.request("agents.pauseState"))).toBeNull();
  ro.close();
});

// -- Delete session -----------------------------------------------------------------------------

test("delete is refused without the person's answer and leaves the file", async () => {
  const client = await connect(join(root, "s.sock"));
  const id = await openWithTurn(client, "delete-unconfirmed");
  const file = sessionOf(id).sessionManager.getSessionFile() as string;
  expect(await errorMessage(client.request("session.delete", { sessionId: id }))).toStartWith(
    "confirmation required",
  );
  expect(existsSync(file)).toBe(true);
  expect(store.has(id)).toBe(true);
  client.close();
});

test("delete removes the file, the artifacts and the subagent transcripts, and nothing brings them back", async () => {
  const client = await connect(join(root, "s.sock"));
  const id = await openWithTurn(client, "delete-ok");
  const session = sessionOf(id);
  const file = session.sessionManager.getSessionFile() as string;
  const artifacts = file.slice(0, -".jsonl".length);
  mkdirSync(join(artifacts, "sub"), { recursive: true });
  const line = (id: string) =>
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`;
  writeFileSync(join(artifacts, "0-First.jsonl"), line("0-First"));
  writeFileSync(join(artifacts, "1-Second.jsonl"), line("1-Second"));
  const settingsBefore = host.liveSessionSettings().length;

  expect(await client.request("session.deletePreview", { sessionId: id })).toEqual({
    subagents: 2,
  });
  const result = await client.request("session.delete", { sessionId: id, confirmed: true });
  expect(result).toEqual({ subagents: 2 });

  expect(existsSync(file)).toBe(false);
  expect(existsSync(artifacts)).toBe(false);
  // The session is gone from the sidecar: replica, host registries and the settings clone.
  expect(store.has(id)).toBe(false);
  expect(() => host.cwdOf(id)).toThrow("unknown session");
  expect(host.liveSessionSettings().length).toBe(settingsBefore - 1);
  expect((await host.list()).some((s) => s.id === id)).toBe(false);

  // A late write of the closed session does not recreate the file (part 1 had this bug).
  // Real wait on purpose: asserting that something does NOT happen has no event to await.
  await Bun.sleep(300);
  expect(existsSync(file)).toBe(false);
  expect(existsSync(artifacts)).toBe(false);

  // A second delete, and a delete of an id that never existed, are the same plain refusal.
  for (const sessionId of [id, "never-existed"]) {
    expect(
      await errorMessage(client.request("session.delete", { sessionId, confirmed: true })),
    ).toStartWith("unknown session");
  }
  client.close();
});

test("delete of a session that has no file yet only closes it", async () => {
  const client = await connect(join(root, "s.sock"));
  const id = await openSession("delete-draft");
  expect(await client.request("session.deletePreview", { sessionId: id })).toEqual({
    subagents: 0,
  });
  expect(await client.request("session.delete", { sessionId: id, confirmed: true })).toEqual({
    subagents: 0,
  });
  expect(store.has(id)).toBe(false);
  client.close();
});

test("delete is refused while a turn runs, and the turn finishes", async () => {
  const client = await connect(join(root, "s.sock"));
  const id = await openWithTurn(client, "delete-busy");
  const file = sessionOf(id).sessionManager.getSessionFile() as string;
  hold = Promise.withResolvers();
  inModel = Promise.withResolvers();
  await client.request("session.prompt", { sessionId: id, text: "slow" });
  await inModel.promise;

  expect(
    await errorMessage(client.request("session.delete", { sessionId: id, confirmed: true })),
  ).toBe(ACTION_BUSY_MESSAGE);
  expect(existsSync(file)).toBe(true);
  expect(store.has(id)).toBe(true);

  hold.resolve();
  hold = undefined;
  await until(() => view(id).status === "idle", "the turn to end");
  client.close();
});

test("delete of a session another omp process owns is refused and leaves its file alone", async () => {
  const client = await connect(join(root, "s.sock"));
  const cwd = join(root, "delete-owned");
  mkdirSync(cwd, { recursive: true });
  const other = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "hold-session.ts"),
      process.env.PI_CODING_AGENT_DIR as string,
      cwd,
    ],
    { stdout: "pipe", stdin: "ignore", stderr: "inherit", env: process.env },
  );
  try {
    const held = JSON.parse(
      new TextDecoder().decode((await other.stdout.getReader().read()).value),
    ) as { id: string; file: string };
    const bytes = readFileSync(held.file, "utf8");
    const id = (await client.request("session.resume", { sessionId: held.id })).sessionId;
    expect(id).toBe(held.id);

    expect(
      await errorMessage(client.request("session.delete", { sessionId: id, confirmed: true })),
    ).toBe(FILE_OWNED_MESSAGE);
    // Refused whole: still open, file untouched.
    expect(store.has(id)).toBe(true);
    expect(readFileSync(held.file, "utf8")).toBe(bytes);
  } finally {
    other.kill();
    await other.exited;
  }
  client.close();
});

test("delete follows a session that omp moved to a new file, and leaves the original alone", async () => {
  const client = await connect(join(root, "s.sock"));
  const cwd = join(root, "delete-moved");
  mkdirSync(cwd, { recursive: true });
  const other = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "hold-session.ts"),
      process.env.PI_CODING_AGENT_DIR as string,
      cwd,
    ],
    { stdout: "pipe", stdin: "ignore", stderr: "inherit", env: process.env },
  );
  try {
    const held = JSON.parse(
      new TextDecoder().decode((await other.stdout.getReader().read()).value),
    ) as { id: string; file: string };
    const bytes = readFileSync(held.file, "utf8");
    await client.request("session.resume", { sessionId: held.id });
    const session = sessions.at(-1) as AgentSession;
    await useEchoModel(session);
    // The app's first write: the file is owned elsewhere, so omp moves the session to a copy.
    session.sessionManager.appendMessage({ role: "user", content: "mine", timestamp: 3 });
    await session.sessionManager.flush();
    const copy = session.sessionManager.getSessionId();
    const copyFile = session.sessionManager.getSessionFile() as string;
    expect(copy).not.toBe(held.id);
    expect(store.current(held.id)).toBe(copy);

    // Asked by the id the person still holds: the copy goes, the other process keeps its file.
    await client.request("session.delete", { sessionId: held.id, confirmed: true });
    expect(existsSync(copyFile)).toBe(false);
    expect(store.has(copy)).toBe(false);
    expect(readFileSync(held.file, "utf8")).toBe(bytes);
  } finally {
    other.kill();
    await other.exited;
  }
  client.close();
});

test("delete of a session waiting on an approval rejects the request and deletes", async () => {
  const client = await connect(join(root, "s.sock"));
  const id = await openWithTurn(client, "delete-waiting");
  const file = sessionOf(id).sessionManager.getSessionFile() as string;
  hold = Promise.withResolvers();
  inModel = Promise.withResolvers();
  await client.request("session.prompt", { sessionId: id, text: "slow" });
  await inModel.promise;
  // The agent is blocked on a person: a permission request is pending on the streaming session.
  const answered = requests.permission(
    {
      sessionId: id,
      toolCall: { toolCallId: "t1", title: "bash", kind: "execute" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    } as never,
    undefined,
  );
  expect(view(id).pending).toHaveLength(1);

  await client.request("session.delete", { sessionId: id, confirmed: true });
  expect(await answered).toEqual({ outcome: { outcome: "cancelled" } });
  expect(store.has(id)).toBe(false);
  expect(existsSync(file)).toBe(false);
  client.close();
});

// -- Pause and resume ---------------------------------------------------------------------------

test("pausing needs the person's answer; resuming does not", async () => {
  const client = await connect(join(root, "s.sock"));
  const id = await openSession("pause-confirm");
  expect(
    await errorMessage(client.request("agents.setPaused", { sessionId: id, paused: true })),
  ).toStartWith("confirmation required");
  expect(agentPauseGate.paused).toBe(false);
  expect(await client.request("agents.pauseState")).toEqual({ paused: false });

  const paused = await client.request("agents.setPaused", {
    sessionId: id,
    paused: true,
    confirmed: true,
  });
  expect(paused.paused).toBe(true);
  expect(paused.since).toBeGreaterThan(0);
  expect(agentPauseGate.paused).toBe(true);
  expect((await client.request("agents.pauseState")).paused).toBe(true);

  const resumed = await client.request("agents.setPaused", { sessionId: id, paused: false });
  expect(resumed).toEqual({ paused: false });
  expect(agentPauseGate.paused).toBe(false);

  // One line in the timeline of the session the command ran from, for each change.
  const lines = view(id).timeline.filter((i) => i.kind === "command");
  expect(lines.map((i) => (i.kind === "command" ? [i.text, i.state] : []))).toEqual([
    ["/pause", "done"],
    ["/resume", "done"],
  ]);
  expect(lines[0]?.kind === "command" && lines[0].output).toContain("Resume all agents");
  client.close();
});

test("the trace of a pause is saved with the session and a repeat says nothing changed", async () => {
  const client = await connect(join(root, "s.sock"));
  const id = await openWithTurn(client, "pause-trace");
  await client.request("agents.setPaused", { sessionId: id, paused: true, confirmed: true });
  await client.request("agents.setPaused", { sessionId: id, paused: true, confirmed: true });
  await client.request("agents.setPaused", { sessionId: id, paused: false });

  const saved = sessionOf(id)
    .sessionManager.getBranch()
    .filter((e) => e.type === "custom" && e.customType === COMMAND_ENTRY_TYPE);
  expect(saved).toHaveLength(3);
  const outputs = view(id)
    .timeline.filter((i) => i.kind === "command")
    .map((i) => (i.kind === "command" ? i.output : ""));
  expect(outputs[1]).toBe("Every agent was already paused.");
  client.close();
});

test("a paused sidecar freezes a turn before its next model call, and resuming lets it finish", async () => {
  const client = await connect(join(root, "s.sock"));
  const id = await openSession("pause-turn");
  await client.request("agents.setPaused", { sessionId: id, paused: true, confirmed: true });
  const callsBefore = modelCalls;

  await client.request("session.prompt", { sessionId: id, text: "frozen question" });
  await until(() => view(id).status === "streaming", "the turn to start");
  // Real wait on purpose: asserting that the model is NOT called has no event to await.
  await Bun.sleep(500);
  // Parked at the turn boundary: the model has not been asked, nothing was cancelled.
  expect(modelCalls).toBe(callsBefore);
  expect(view(id).status).toBe("streaming");

  await client.request("agents.setPaused", { sessionId: id, paused: false });
  await until(() => view(id).status === "idle", "the turn to finish after the resume");
  expect(modelCalls).toBe(callsBefore + 1);
  const reply = view(id).timeline.find((i) => i.kind === "assistant");
  expect(reply?.kind === "assistant" && reply.text).toBe("echo frozen question");
  client.close();
});

test("Stop still ends a turn that is parked by the pause, and the pause stays", async () => {
  const client = await connect(join(root, "s.sock"));
  const id = await openSession("pause-stop");
  await client.request("agents.setPaused", { sessionId: id, paused: true, confirmed: true });
  await client.request("session.prompt", { sessionId: id, text: "never answered" });
  await until(() => view(id).status === "streaming", "the turn to start");
  const callsBefore = modelCalls;

  await client.request("session.cancel", { sessionId: id });
  await until(() => view(id).status === "idle", "the parked turn to unwind");
  expect(modelCalls).toBe(callsBefore);
  expect(agentPauseGate.paused).toBe(true);
  client.close();
});

test("a session opened while paused starts frozen too", async () => {
  const client = await connect(join(root, "s.sock"));
  const first = await openSession("pause-first");
  await client.request("agents.setPaused", { sessionId: first, paused: true, confirmed: true });
  const second = await openSession("pause-second");
  const callsBefore = modelCalls;
  await client.request("session.prompt", { sessionId: second, text: "late" });
  // Real wait on purpose: asserting that the model is NOT called has no event to await.
  await Bun.sleep(400);
  expect(modelCalls).toBe(callsBefore);

  await client.request("agents.setPaused", { sessionId: first, paused: false });
  await until(() => view(second).status === "idle", "the late session to finish");
  expect(modelCalls).toBe(callsBefore + 1);
  client.close();
});
