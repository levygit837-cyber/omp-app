import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import type { SessionOpEvent } from "@omp-app/protocol";
import { type OmpHost, startOmpHost } from "../src/omp-host";
import { RequestRegistry } from "../src/request-registry";
import { attachSession } from "../src/session-bridge";
import { SessionStore } from "../src/session-store";
import { registerEchoModel, startEchoModel, useEchoModel } from "./fixtures/echo-model";

setDefaultTimeout(60_000);

let root: string;
let host: OmpHost;
let model: ReturnType<typeof startEchoModel>;
/** The turn of the test stays inside the model call until it is released. */
const inModel = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const store = new SessionStore();
const requests = new RequestRegistry(store);
const sessions: AgentSession[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-moved-")));
  const agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  model = startEchoModel(async () => {
    inModel.resolve();
    await release.promise;
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
  release.resolve();
  model?.stop(true);
  await host?.close();
  resetSettingsForTest();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("a session another live process holds moves to a new id; the app follows and keeps working", async () => {
  // The lease directory is shared with the child through the environment, and under bun test it
  // is a temp dir: the user's real state dir is never touched.
  expect(process.env.PI_TEST_SESSION_OWNERS_DIR).toBeTruthy();
  const cwd = join(root, "project");
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
    const reader = other.stdout.getReader();
    const first = await reader.read();
    const held = JSON.parse(new TextDecoder().decode(first.value)) as { id: string; file: string };
    const originalBytes = readFileSync(held.file, "utf8");

    // The app opens it: it has the full history, and nothing has moved yet.
    const openedAs = await host.resumeSession(held.id);
    expect(openedAs).toBe(held.id);
    expect(store.snapshot(held.id).snapshot.timeline.map((i) => i.kind)).toEqual([
      "user",
      "assistant",
    ]);
    const events: SessionOpEvent[] = [];
    store.subscribe(held.id, "test", (event) => events.push(event));

    await useEchoModel(sessions.at(-1) as AgentSession);

    // The app's first write: omp sees the other process owns the file and moves off it.
    const session = sessions.at(-1) as AgentSession;
    session.sessionManager.appendMessage({ role: "user", content: "from the app", timestamp: 3 });
    await session.sessionManager.flush();

    const movedTo = session.sessionId;
    expect(movedTo).not.toBe(held.id);
    // The store follows: the old id is gone, the new one holds the same session with a warning.
    expect(store.has(held.id)).toBe(false);
    expect(store.has(movedTo)).toBe(true);
    expect(store.current(held.id)).toBe(movedTo);
    const view = store.snapshot(movedTo).snapshot;
    expect(view.id).toBe(movedTo);
    expect(view.warnings.map((w) => (w.source === "session" ? w.title : w.source))).toContain(
      "This session moved to a new file",
    );
    // Subscribers were told under the old id, so the replica and the open set can move.
    expect(events.find((e) => e.op.type === "session.moved")).toMatchObject({
      sessionId: held.id,
      op: { type: "session.moved", id: movedTo },
    });
    // The other process's file is exactly as it left it; the app's turn is in the successor.
    expect(readFileSync(held.file, "utf8")).toBe(originalBytes);
    const listed = (await host.list()).map((s) => s.id);
    expect(listed).toContain(movedTo);
    expect(listed).toContain(held.id);

    // ACP still keys the session by the old id; the host maps the new one to it, so a prompt, a
    // cancel and a close under the new id reach the same session.
    const turn = host.prompt(movedTo, "after the move");
    // A prompt that cannot reach the session rejects here instead of waiting for a model call.
    await Promise.race([inModel.promise, turn]);
    expect(store.snapshot(movedTo).snapshot.status).toBe("streaming");
    await host.cancel(movedTo);
    expect(await turn).toBe("cancelled");
    release.resolve();
    expect(session.isDisposed).toBe(false);
    await host.closeSession(movedTo);
    expect(session.isDisposed).toBe(true);
    store.remove(movedTo);
    expect(store.has(movedTo)).toBe(false);
  } finally {
    other.kill();
    await other.exited;
  }
});

test("after /fresh the session keeps its id; a later forced move is still followed", async () => {
  const cwd = join(root, "fresh-project");
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
    const openedAs = await host.resumeSession(held.id);
    const session = sessions.at(-1) as AgentSession;

    // `/fresh` replaces the provider session id and moves nothing (`agent-session.ts:6245-6259`).
    const outcome = await host.runCommand(
      openedAs,
      "/fresh",
      () => {},
      new AbortController().signal,
    );
    expect(outcome).toEqual({ failed: false });
    expect(session.sessionId).not.toBe(held.id);
    expect(session.sessionManager.getSessionId()).toBe(held.id);
    expect(store.has(held.id)).toBe(true);

    // The first write now meets the other process's claim: omp moves the session. Selecting the
    // model is that first write.
    await useEchoModel(session);
    session.sessionManager.appendMessage({ role: "user", content: "after fresh", timestamp: 3 });
    await session.sessionManager.flush();
    const movedTo = session.sessionManager.getSessionId();
    expect(movedTo).not.toBe(held.id);
    expect(store.current(held.id)).toBe(movedTo);
    expect(store.has(movedTo)).toBe(true);
    expect(store.has(session.sessionId)).toBe(false);

    // The host maps the new id to ACP's key: a prompt under it reaches the session.
    expect(await host.prompt(movedTo, "still reachable")).toBe("end_turn");
    await host.closeSession(movedTo);
    store.remove(movedTo);
  } finally {
    other.kill();
    await other.exited;
  }
});
